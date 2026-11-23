// Pull requests of the repository a chat's project works in, read with the GitHub CLI (gh) that
// the person already signed in to on this computer. Nothing here talks to GitHub itself.
import { folderFor } from "./project-folders.mjs";
import { findTool, inherit, runTool, searchDirs, toolEnv } from "./tools.mjs";

const TIMEOUT = 15_000;
const CACHE_MS = 30_000;
const CACHE_MAX = 50;
const FIELDS = "number,title,url,state,isDraft,author,headRefName,baseRefName,updatedAt";

// Search qualifiers that would reach other repositories, people or organizations than the project's own.
const OTHER_REPOS = /-?\b(repo|org|user|owner):("[^"]*"|[^\s()]*)/gi;
const none = (reason) => ({ available: false, reason, items: [] });
const text = (value, limit = 300) => (typeof value === "string" && value ? value.slice(0, limit) : undefined);

/** One pull request as gh prints it, as the phone shows it. */
function toPullRequest(raw) {
  const number = Number(raw?.number);
  if (!Number.isInteger(number) || number < 1) return null;
  const state = String(raw.state ?? "").toLowerCase();
  const repository = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(String(raw.url ?? ""))?.[1];
  const author = text(raw.author?.login, 100);
  return {
    number,
    title: text(raw.title, 300) ?? "Untitled",
    url: text(raw.url, 500) ?? "",
    state: state === "merged" || state === "closed" ? state : "open",
    draft: raw.isDraft === true,
    ...(author && { author }),
    ...(text(raw.headRefName, 200) && { head: text(raw.headRefName, 200) }),
    ...(text(raw.baseRefName, 200) && { base: text(raw.baseRefName, 200) }),
    ...(text(raw.updatedAt, 40) && { updatedAt: text(raw.updatedAt, 40) }),
    ...(repository && { repository }),
  };
}

/** gh's own words, sorted into a few reasons a person can act on. The words themselves are not passed on. */
function why(error) {
  if (error.kind === "busy") return "Your computer is busy. Try again.";
  if (error.kind === "timeout") return "GitHub took too long to answer.";
  const said = String(error.detail ?? "");
  if (/auth login|not logged in|authentication|GH_TOKEN|HTTP 401/i.test(said)) return "Sign in to the GitHub CLI on your computer (gh auth login).";
  if (/not a git repository|known GitHub host|git remotes|determine base repo|no GitHub remote/i.test(said)) return "This project isn't a GitHub repository.";
  return "GitHub couldn't be reached.";
}

export class PullRequests {
  /** `backend.snapshot()` gives the chats and projects; `searchPath` is where to look for gh. */
  constructor({ backend, searchPath, now = Date.now }) {
    Object.assign(this, { backend, dirs: searchDirs(searchPath), now, cache: new Map(), running: new Map() });
  }
  /** The folder of the chat's project (or the given one), or a reason there is none. */
  folderOf({ chatId, projectId }) {
    const state = this.backend.snapshot();
    const chat = typeof chatId === "string" ? (state.chats ?? []).find((c) => c.id === chatId) : null;
    const id = chat?.projectId ?? (typeof projectId === "string" ? projectId : null);
    const project = id ? (state.projects ?? []).find((p) => p.id === id) : null;
    if (!project?.folder || typeof project.folder !== "string") return { reason: "This chat isn't in a project folder." };
    const folder = folderFor(project, chat);
    return folder ? { folder } : { reason: "The project's folder can't be found on this computer." };
  }
  /** `where` is { chatId?, projectId? }. A number as the query looks that pull request up as well. */
  async lookup(where, query) {
    const q = typeof query === "string" ? query.replace(OTHER_REPOS, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";
    const found = this.folderOf(where ?? {});
    if (!found.folder) return none(found.reason);
    const key = found.folder + "\0" + q;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < CACHE_MS) return cached.value;
    // Two phones, or one phone typing fast, share a lookup that is already running.
    if (!this.running.has(key)) {
      const run = this.fetch(found.folder, q)
        .then((value) => {
          // A failed lookup is remembered too, so a phone that keeps asking doesn't keep starting gh.
          if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
          this.cache.set(key, { at: this.now(), value });
          return value;
        })
        .finally(() => this.running.delete(key));
      this.running.set(key, run);
    }
    return this.running.get(key);
  }
  async fetch(folder, query) {
    const gh = findTool("gh", this.dirs);
    if (!gh) return none("Install the GitHub CLI (gh) on your computer and sign in.");
    const env = toolEnv(this.dirs, { ...inherit(["GH_", "GITHUB_"]), GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" });
    // gh keeps its sign-in in the person's home folder, which HOME covers, or under XDG_CONFIG_HOME.
    for (const name of ["XDG_CONFIG_HOME", "SSH_AUTH_SOCK"]) if (process.env[name]) env[name] = process.env[name];
    const run = (args) => runTool("GitHub", gh, args, { env, cwd: folder, timeout: TIMEOUT, keepError: true });
    const number = /^#?(\d{1,9})$/.exec(query)?.[1];
    try {
      const items = [];
      if (number) {
        // A number is also looked up directly, so a pull request older than the list still shows.
        const one = await run(["pr", "view", number, "--json", FIELDS]).then((out) => toPullRequest(JSON.parse(out))).catch(() => null);
        if (one) items.push(one);
      }
      const list = ["pr", "list", "--state", "all", "--limit", "30", "--json", FIELDS];
      // The "=" form keeps a search such as "-label:bug" from being read as an option.
      if (query && !number) list.push("--search=" + query);
      const raw = JSON.parse(await run(list));
      for (const entry of Array.isArray(raw) ? raw : []) {
        const pr = toPullRequest(entry);
        if (pr && !items.some((other) => other.number === pr.number)) items.push(pr);
      }
      return { available: true, items };
    } catch (error) {
      return none(error.kind ? why(error) : "GitHub sent back something unexpected.");
    }
  }
}
