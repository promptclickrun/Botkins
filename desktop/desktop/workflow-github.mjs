// Local GitHub CLI (`gh`) auth manager and multi-stream poller for Workflow GitHub triggers.
// Zero relay or inbound tunnel required: runs `gh` directly on this computer.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { findTool, inherit, searchDirs, toolEnv } from "./link/tools.mjs";

const execFileAsync = promisify(execFile);

export const GH_INSTALL_URL = "https://cli.github.com/";
export const GH_DEVICE_URL = "https://github.com/login/device";
export const DEFAULT_BOT_MENTION = "@botkins-agent";

export const GITHUB_EVENT_KINDS = [
  "issue.opened",
  "issue.closed",
  "issue.labeled",
  "pr.opened",
  "pr.updated",
  "pr.reviewRequested",
  "pr.reviewSubmitted",
  "pr.checksFailed",
  "pr.merged",
  "comment",
  "mention",
  "assigned",
];

export const LEGACY_GITHUB_EVENT_KINDS = [
  "pr_opened",
  "pr_updated",
  "pr_review",
  "ci_status",
  "issue_opened",
  "issue_updated",
  "issue_comment",
  "user_mentioned",
  "bot_mentioned",
];

const PR_EVENTS = new Set([
  "pr.opened",
  "pr.updated",
  "pr.reviewrequested",
  "pr.reviewsubmitted",
  "pr.checksfailed",
  "pr.merged",
  "mention",
  "assigned",
  "pr_opened",
  "pr_updated",
  "pr_review",
  "ci_status",
  "user_mentioned",
  "bot_mentioned",
]);
const ISSUE_EVENTS = new Set([
  "issue.opened",
  "issue.closed",
  "issue.labeled",
  "mention",
  "assigned",
  "issue_opened",
  "issue_updated",
  "user_mentioned",
  "bot_mentioned",
]);
const COMMENT_EVENTS = new Set(["comment", "mention", "issue_comment", "user_mentioned", "bot_mentioned"]);

const GH_ENV_PREFIXES = ["GH_", "GITHUB_", "XDG_CONFIG_HOME", "NO_COLOR"];
const SIGN_IN_START_TIMEOUT_MS = 15_000;
const SIGN_IN_MAX_MS = 10 * 60_000;
const VIEWER_CACHE_MS = 5 * 60_000;

function ghBinary(searchPath) {
  return findTool("gh", searchDirs(searchPath));
}

function ghProcessEnv(searchPath, extra = {}) {
  const dirs = searchDirs(searchPath);
  return toolEnv(dirs, { ...inherit(GH_ENV_PREFIXES), NO_COLOR: "1", ...extra });
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parses a comma- or whitespace-separated mention handle string into normalized `@handle` tokens. */
export function parseMentionHandles(raw, fallback = DEFAULT_BOT_MENTION) {
  const source = typeof raw === "string" && raw.trim() ? raw : fallback;
  if (!source || typeof source !== "string") return [];
  const seen = new Set();
  const out = [];
  for (const part of source.split(/[\s,]+/)) {
    const cleaned = part.trim().replace(/^@+/, "").toLowerCase();
    if (!cleaned || !/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(cleaned)) continue;
    const handle = `@${cleaned}`;
    if (!seen.has(handle)) {
      seen.add(handle);
      out.push(handle);
    }
  }
  return out;
}

/**
 * Finds the first matching `@handle` mention in `text` (case-insensitive, word-bounded so emails
 * like `foo@botkins-agent.com` and longer handles like `@botkins-agent-dev` do not false-match).
 */
export function findMentionInText(text, handles) {
  if (typeof text !== "string" || !text || !Array.isArray(handles) || !handles.length) return null;
  for (const raw of handles) {
    const handle = String(raw || "").trim();
    if (!handle) continue;
    const atHandle = handle.startsWith("@") ? handle : `@${handle}`;
    // Reject preceding identifier/email chars and trailing GitHub handle chars or dot-domain suffix.
    const re = new RegExp(`(^|[^a-zA-Z0-9_.-])(${escapeRegExp(atHandle)})(?![a-zA-Z0-9_-]|\\.[a-zA-Z])`, "i");
    if (re.test(text)) return atHandle.toLowerCase();
  }
  return null;
}

/** Parses `gh auth status` output across old and new GitHub CLI versions. */
export function parseGhAuthStatus(output) {
  const text = String(output || "");
  if (!text.trim()) return { authenticated: false, login: null, scopes: [] };
  if (/not logged into any github hosts|you are not logged in|failed to log in/i.test(text)) {
    return { authenticated: false, login: null, scopes: [] };
  }
  const loggedIn = /logged in to [^\s]+/i.test(text);
  const accountMatch =
    /logged in to [^\s]+ account\s+([a-zA-Z0-9-]+)\b/i.exec(text) ||
    /logged in to [^\s]+ as\s+([a-zA-Z0-9-]+)\b/i.exec(text);
  const scopesMatch = /token scopes:\s*([^\n]+)/i.exec(text);
  const scopes = scopesMatch
    ? scopesMatch[1]
        .split(",")
        .map((s) => s.replace(/['"\s]/g, "").trim())
        .filter(Boolean)
    : [];
  return {
    authenticated: loggedIn || Boolean(accountMatch),
    login: accountMatch ? accountMatch[1] : null,
    scopes,
  };
}

/** Parses the one-time device code and verification URL from `gh auth login --web` output. */
export function parseGhDeviceOutput(output) {
  const text = String(output || "");
  const urlMatch = /https:\/\/github\.com\/login\/device[^\s)'"]*/i.exec(text);
  const preferredCode =
    /one-time code[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(text) ||
    /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(text);
  const code = preferredCode ? preferredCode[1].toUpperCase() : null;
  const url = urlMatch ? urlMatch[0] : code ? GH_DEVICE_URL : null;
  return { code, url };
}

function extractLabels(labels) {
  if (!Array.isArray(labels)) return "";
  return labels
    .map((l) => (typeof l === "string" ? l : l?.name || ""))
    .filter(Boolean)
    .join(", ");
}

function issueNumberFromUrl(url) {
  const m = /\/(?:issues|pull|pulls)\/(\d+)\b/.exec(String(url || ""));
  return m ? Number(m[1]) : 0;
}

/**
 * Manages local GitHub CLI (`gh`) authentication status and interactive device-code sign-in
 * so desktop and mobile users can sign in directly inside Botkins.
 */
export class WorkflowGithubAuth {
  constructor(options = {}) {
    this.searchPath = options.searchPath;
    this.findGh = options.findGh ?? (() => ghBinary(this.searchPath));
    this.execGh =
      options.execGh ??
      (async (bin, args, opts = {}) => {
        try {
          const res = await execFileAsync(bin, args, {
            timeout: opts.timeout ?? 15_000,
            maxBuffer: opts.maxBuffer ?? 1024 * 1024,
            env: ghProcessEnv(this.searchPath),
          });
          return { ok: true, stdout: res.stdout || "", stderr: res.stderr || "" };
        } catch (err) {
          return {
            ok: false,
            code: err?.code,
            stdout: err?.stdout || "",
            stderr: err?.stderr || "",
            message: err?.message || String(err),
          };
        }
      });
    this.spawnGh =
      options.spawnGh ??
      ((bin, args, opts) => spawn(bin, args, opts));

    this.signIn = { status: "idle", code: null, url: null, error: null, login: null };
    this.child = null;
    this.childTimer = null;
    this.viewerCache = { login: null, at: 0 };
  }

  signInSnapshot() {
    return { ...this.signIn };
  }

  /** Resolves and briefly caches the signed-in GitHub login for `user_mentioned` matching. */
  async getViewerLogin({ force = false } = {}) {
    if (!force && this.viewerCache.login && Date.now() - this.viewerCache.at < VIEWER_CACHE_MS) {
      return this.viewerCache.login;
    }
    const bin = this.findGh();
    if (!bin) return null;
    const res = await this.execGh(bin, ["api", "user", "--jq", ".login"], { timeout: 10_000 });
    const login = res.ok ? String(res.stdout || "").trim().replace(/^@/, "") : "";
    if (login && /^[a-zA-Z0-9-]+$/.test(login)) {
      this.viewerCache = { login, at: Date.now() };
      return login;
    }
    return this.viewerCache.login;
  }

  /** Returns GitHub CLI installation status, active account, optional repo list, and sign-in state. */
  async status({ includeRepos = false } = {}) {
    const bin = this.findGh();
    if (!bin) {
      return {
        installed: false,
        authenticated: false,
        login: null,
        scopes: [],
        repos: [],
        installUrl: GH_INSTALL_URL,
        signIn: this.signInSnapshot(),
      };
    }

    const res = await this.execGh(bin, ["auth", "status", "--hostname", "github.com"], { timeout: 12_000 });
    const parsed = parseGhAuthStatus(`${res.stdout}\n${res.stderr}`);
    let login = parsed.login;
    const authenticated = res.ok || parsed.authenticated;

    if (authenticated && !login) {
      login = await this.getViewerLogin({ force: true });
    } else if (login) {
      this.viewerCache = { login, at: Date.now() };
    }

    if (authenticated && this.signIn.status === "waiting" && !this.child) {
      this.signIn = { status: "done", code: null, url: null, error: null, login };
    }

    let repos = [];
    let repoAccess = [];
    if (authenticated && includeRepos) {
      const repoRes = await this.execGh(
        bin,
        ["repo", "list", "--limit", "100", "--json", "nameWithOwner,isPrivate,viewerPermission"],
        { timeout: 12_000 },
      );
      if (repoRes.ok) {
        try {
          const list = JSON.parse(repoRes.stdout || "[]");
          if (Array.isArray(list)) {
            for (const r of list) {
              const name = typeof r?.nameWithOwner === "string" ? r.nameWithOwner.trim() : "";
              if (!name) continue;
              repos.push(name);
              const perm = String(r?.viewerPermission || "").toUpperCase();
              repoAccess.push({
                fullName: name,
                ...(perm ? { writable: perm === "ADMIN" || perm === "MAINTAIN" || perm === "WRITE" } : {}),
                ...(typeof r?.isPrivate === "boolean" ? { isPrivate: r.isPrivate } : {}),
              });
            }
          }
        } catch {}
      }
    }

    return {
      installed: true,
      authenticated,
      login: login || null,
      scopes: parsed.scopes,
      repos,
      repoAccess,
      installUrl: GH_INSTALL_URL,
      signIn: this.signInSnapshot(),
    };
  }

  /**
   * Starts a local `gh auth login --web` device-code sign-in flow and resolves with the one-time
   * verification code and GitHub device URL as soon as `gh` prints them.
   */
  async startSignIn() {
    const bin = this.findGh();
    if (!bin) {
      throw new Error("GitHub CLI (gh) is not installed on this computer. Install it from https://cli.github.com/ first.");
    }

    // Reuse an already-active waiting session so rapid taps don't invalidate the displayed code.
    if (this.child && this.signIn.status === "waiting" && this.signIn.code && this.signIn.url) {
      return this.signInSnapshot();
    }

    this.killChild();
    this.signIn = { status: "starting", code: null, url: null, error: null, login: null };

    const noopBrowser = process.platform === "win32" ? "cmd /c rem" : "true";
    const env = ghProcessEnv(this.searchPath, {
      BROWSER: noopBrowser,
      GH_BROWSER: noopBrowser,
      GH_PROMPT_DISABLED: "0",
    });

    const args = [
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--git-protocol",
      "https",
      "--web",
      "--scopes",
      "repo,read:org",
    ];

    const child = this.spawnGh(bin, args, { stdio: ["pipe", "pipe", "pipe"], env });
    this.child = child;

    let combined = "";
    let sentEnter = false;
    let settled = false;

    const sendEnter = () => {
      if (sentEnter || !child.stdin || child.stdin.destroyed) return;
      sentEnter = true;
      try {
        child.stdin.write("\n");
      } catch {}
    };

    return await new Promise((resolve, reject) => {
      const finishStart = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        fn(val);
      };

      const startTimer = setTimeout(() => {
        this.killChild();
        this.signIn = {
          status: "failed",
          code: null,
          url: null,
          error: "Timed out waiting for GitHub sign-in code. Try again.",
          login: null,
        };
        finishStart(reject, new Error(this.signIn.error));
      }, SIGN_IN_START_TIMEOUT_MS);

      this.childTimer = setTimeout(() => {
        if (this.child === child) {
          this.killChild();
          if (this.signIn.status === "waiting" || this.signIn.status === "starting") {
            this.signIn = {
              status: "failed",
              code: null,
              url: null,
              error: "GitHub sign-in expired before it was completed.",
              login: null,
            };
          }
        }
      }, SIGN_IN_MAX_MS);

      const onChunk = (chunk) => {
        combined += String(chunk || "");
        if (/press enter/i.test(combined)) {
          sendEnter();
        }
        const { code, url } = parseGhDeviceOutput(combined);
        if (code && url && this.signIn.status !== "waiting") {
          this.signIn = { status: "waiting", code, url, error: null, login: null };
          // Nudge `gh` past "Press Enter to open github.com in your browser..." so it polls GitHub right away.
          setTimeout(sendEnter, 150);
          finishStart(resolve, this.signInSnapshot());
        }
      };

      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);

      child.on("error", (err) => {
        if (this.child === child) this.clearChildRefs();
        const msg = err?.message || "Could not start GitHub CLI sign-in.";
        this.signIn = { status: "failed", code: null, url: null, error: msg, login: null };
        finishStart(reject, new Error(msg));
      });

      child.on("close", async (exitCode) => {
        const wasCurrent = this.child === child;
        if (wasCurrent) this.clearChildRefs();
        if (exitCode === 0) {
          this.viewerCache = { login: null, at: 0 };
          const login = await this.getViewerLogin({ force: true }).catch(() => null);
          this.signIn = { status: "done", code: null, url: null, error: null, login: login || null };
          finishStart(resolve, this.signInSnapshot());
        } else if (this.signIn.status !== "idle") {
          const detail = combined
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-2)
            .join(" ");
          this.signIn = {
            status: "failed",
            code: null,
            url: null,
            error: detail || `GitHub sign-in ended (code ${exitCode ?? "unknown"}).`,
            login: null,
          };
          finishStart(reject, new Error(this.signIn.error));
        } else {
          finishStart(resolve, this.signInSnapshot());
        }
      });
    });
  }

  /**
   * Resolves a short-lived local GitHub read token (preferring `gh auth token`, falling back to
   * `GH_TOKEN`/`GITHUB_TOKEN` env) used solely as a proof of repository read access when subscribing
   * to the relay. Never persisted or logged.
   */
  async getAuthToken() {
    const bin = this.findGh();
    if (bin) {
      const res = await this.execGh(bin, ["auth", "token"], { timeout: 6_000 });
      if (res.ok) {
        const tok = String(res.stdout || "").trim();
        if (tok && !/\s/.test(tok)) return tok;
      }
    }
    const envTok = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
    return envTok && !/\s/.test(envTok) ? envTok : null;
  }

  /**
   * Lists repository labels (up to 500) using local `gh api` pagination.
   * Used by the trigger label picker and GitHub output catalog validation.
   */
  async listRepoLabels(repo) {
    const bin = this.findGh();
    if (!bin || !repo) return [];
    const res = await this.execGh(
      bin,
      ["api", "--paginate", `repos/${repo}/labels?per_page=100`],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    if (!res.ok) return [];
    try {
      const parsed = JSON.parse(res.stdout || "[]");
      if (!Array.isArray(parsed)) return [];
      const seen = new Set();
      const out = [];
      for (const l of parsed) {
        const name = typeof l === "string" ? l.trim() : String(l?.name || "").trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        out.push({ name, color: typeof l?.color === "string" ? l.color : "", description: typeof l?.description === "string" ? l.description : "" });
        if (out.length >= 500) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Lists repository assignees / collaborators (up to 500) using local `gh api`.
   */
  async listRepoAssignees(repo) {
    const bin = this.findGh();
    if (!bin || !repo) return [];
    const res = await this.execGh(
      bin,
      ["api", "--paginate", `repos/${repo}/assignees?per_page=100`],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    if (!res.ok) return [];
    try {
      const parsed = JSON.parse(res.stdout || "[]");
      if (!Array.isArray(parsed)) return [];
      const seen = new Set();
      const out = [];
      for (const u of parsed) {
        const login = typeof u === "string" ? u.trim() : String(u?.login || "").trim();
        if (!login || seen.has(login.toLowerCase())) continue;
        seen.add(login.toLowerCase());
        out.push({ login, type: typeof u?.type === "string" ? u.type : "User" });
        if (out.length >= 500) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Cancels an in-progress `gh auth login` device-code sign-in. */
  async cancelSignIn() {
    this.signIn = { status: "idle", code: null, url: null, error: null, login: null };
    this.killChild();
    return await this.status();
  }

  clearChildRefs() {
    if (this.childTimer) {
      clearTimeout(this.childTimer);
      this.childTimer = null;
    }
    this.child = null;
  }

  killChild() {
    const child = this.child;
    this.clearChildRefs();
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {}
  }

  stop() {
    this.killChild();
  }
}

/**
 * Default local `gh` poller for Workflow GitHub triggers.
 * Only fetches the GitHub streams required by `config.events` so polling stays fast and rate-limit friendly.
 */
export function createDefaultGithubPoller(auth, options = {}) {
  const searchPath = options.searchPath;
  const runGhJson = async (args) => {
    const bin = (auth?.findGh ? auth.findGh() : ghBinary(searchPath)) || "gh";
    const { stdout } = await execFileAsync(bin, args, {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      env: ghProcessEnv(searchPath),
    });
    return JSON.parse(stdout || "[]");
  };

  return async function defaultGithubPoller(repo, config = {}) {
    const events = Array.isArray(config?.events)
      ? config.events.map((s) => String(s).toLowerCase().trim()).filter(Boolean)
      : typeof config?.events === "string" && config.events.trim()
        ? config.events.split(",").map((s) => s.toLowerCase().trim()).filter(Boolean)
        : [];

    const wantsAny = events.length === 0;
    const needPrs = wantsAny || events.some((e) => PR_EVENTS.has(e));
    const needAllPrStates = events.some((e) => ["pr_updated", "pr.updated", "pr.merged"].includes(e));
    const needIssues = wantsAny || events.some((e) => ISSUE_EVENTS.has(e));
    const needComments = events.some((e) => COMMENT_EVENTS.has(e));
    const needViewer = events.some((e) => e === "user_mentioned" || e === "mention");

    const tasks = [];
    let prs = [];
    let issues = [];
    let comments = [];
    let viewerLogin = "";

    if (needPrs) {
      tasks.push(
        runGhJson([
          "pr",
          "list",
          "--repo",
          repo,
          "--state",
          needAllPrStates ? "all" : "open",
          "--limit",
          "25",
          "--json",
          "number,title,body,author,authorAssociation,url,headRefName,baseRefName,headRefOid,state,mergedAt,reviewDecision,reviewRequests,assignees,statusCheckRollup,labels,createdAt,updatedAt",
        ]).then((data) => {
          if (Array.isArray(data)) prs = data;
        }),
      );
    }

    if (needIssues) {
      tasks.push(
        runGhJson([
          "issue",
          "list",
          "--repo",
          repo,
          "--state",
          "all",
          "--limit",
          "25",
          "--json",
          "number,title,body,author,authorAssociation,url,state,assignees,labels,createdAt,updatedAt",
        ]).then((data) => {
          if (Array.isArray(data)) issues = data;
        }),
      );
    }

    if (needComments) {
      tasks.push(
        runGhJson([
          "api",
          `repos/${repo}/issues/comments?sort=updated&direction=desc&per_page=30`,
        ]).then((data) => {
          if (!Array.isArray(data)) return;
          for (const c of data) {
            comments.push({
              id: `issue:${c.id}`,
              number: issueNumberFromUrl(c.issue_url || c.html_url),
              title: "",
              body: c.body || "",
              author: c.user?.login || "",
              url: c.html_url || "",
              branch: "",
              state: "open",
              createdAt: c.created_at || "",
              updatedAt: c.updated_at || c.created_at || "",
              labels: "",
            });
          }
        }),
      );
      tasks.push(
        runGhJson([
          "api",
          `repos/${repo}/pulls/comments?sort=updated&direction=desc&per_page=20`,
        ])
          .then((data) => {
            if (!Array.isArray(data)) return;
            for (const c of data) {
              comments.push({
                id: `review:${c.id}`,
                number: issueNumberFromUrl(c.pull_request_url || c.html_url),
                title: "",
                body: c.body || "",
                author: c.user?.login || "",
                url: c.html_url || "",
                branch: "",
                state: "open",
                createdAt: c.created_at || "",
                updatedAt: c.updated_at || c.created_at || "",
                labels: "",
              });
            }
          })
          .catch(() => {
            // Pull review comments are best-effort; don't block issue comments if empty/unavailable.
          }),
      );
    }

    if (needViewer && auth?.getViewerLogin) {
      tasks.push(
        auth.getViewerLogin().then((login) => {
          if (login) viewerLogin = login;
        }).catch(() => {}),
      );
    }

    await Promise.all(tasks);

    // Enrich comment titles from the PR/issue lists we already fetched when available.
    if (comments.length && (prs.length || issues.length)) {
      const metaByNum = new Map();
      for (const issue of issues) metaByNum.set(issue.number, { title: issue.title || "", branch: "", state: String(issue.state || "open").toLowerCase(), labels: extractLabels(issue.labels) });
      for (const pr of prs) metaByNum.set(pr.number, { title: pr.title || "", branch: pr.headRefName || pr.branch || "", state: String(pr.state || "open").toLowerCase(), labels: extractLabels(pr.labels) });
      for (const c of comments) {
        const meta = metaByNum.get(c.number);
        if (meta) {
          if (!c.title) c.title = meta.title;
          if (!c.branch) c.branch = meta.branch;
          c.state = meta.state;
          if (!c.labels) c.labels = meta.labels;
        }
      }
    }

    return { prs, issues, comments, viewerLogin };
  };
}
