// The featured shelf of Marketplace › Skills: permissively licensed skills, each read from its own
// repository at a pinned commit and installed through the catalog's preview, conflict and install
// path (desktop/skills-catalog.mjs). Nothing here is copied into this repository: the files come
// from GitHub at `commit`, and the license file goes with the installed skill (`license.path`,
// added as LICENSE when it sits outside the skill's folder).
//
// The listing words (`summary`) are Botkins' own. Each path was checked at its commit on 2026-11-24.

/** The repositories, each pinned to one commit, with its license and who wrote it. */
const SOURCES = {
  openai: { repo: "openai/skills", commit: "49f948faa9258a0c61caceaf225e179651397431", license: "Apache-2.0", author: "OpenAI" },
  anthropic: { repo: "anthropics/skills", commit: "3b3fad96af16a10759d930941b4520ba0c40edae", license: "Apache-2.0", author: "Anthropic" },
  pstack: { repo: "cursor/plugins", commit: "792440e8a560a4a3f63748cdee70491ecd412982", license: "MIT", author: "Lauren Tan", pack: "pstack", licensePath: "pstack/LICENSE" },
};

const openai = (skill, summary) => ({ source: "openai", skill, path: "skills/.curated/" + skill, licensePath: "skills/.curated/" + skill + "/LICENSE.txt", summary, group: "Security" });
const anthropic = (skill, summary) => ({ source: "anthropic", skill, path: "skills/" + skill, licensePath: "skills/" + skill + "/LICENSE.txt", summary, group: "Writing and design" });
const pstack = (skill, summary) => ({ source: "pstack", skill, path: "pstack/skills/" + skill, summary, group: "Engineering habits" });

const LIST = [
  openai("security-best-practices", "Reviews code in Python, JavaScript, TypeScript or Go for security mistakes and suggests safer defaults."),
  openai("security-threat-model", "Maps a repository's trust boundaries and abuse paths, and writes a short threat model."),
  anthropic("frontend-design", "Helps a bot pick a clear visual direction for a new screen instead of a template look."),
  anthropic("internal-comms", "Status updates, incident notes and newsletters in the shapes teams expect."),
  anthropic("discernment-nudge", "Ends a plan or draft with two or three questions that help you check it before you act."),
  pstack("architect", "Sketches types, signatures and modules before any code is written."),
  pstack("blast-radius", "Finds what a change could break outside the diff, and proves the riskiest part by running it."),
  pstack("interrogate", "Has reviewers try to break a change; only findings that a run proves are kept."),
  pstack("sharpen", "Rewrites a task so it goes deeper rather than wider."),
  pstack("tdd", "Writes the failing test first when the test target is cheap and clear."),
  pstack("technical-writing", "Docs and explanations that are plain, short and correct."),
  pstack("typescript-best-practices", "Type-safe TypeScript habits for everyday code."),
  pstack("unslop", "Cuts filler and stock phrasing from writing."),
  pstack("statechart", "Models tricky behavior as a statechart before coding it."),
  pstack("show-me-your-work", "Makes a bot show the evidence behind each claim it makes."),
  pstack("teach", "Explains a topic step by step and checks that it landed."),
];

/** The catalog id of a featured skill: `owner/repo/skill@commit7`. The "@" keeps it apart from a skills.sh id. */
const idOf = (item) => SOURCES[item.source].repo + "/" + item.skill + "@" + SOURCES[item.source].commit.slice(0, 7);

/** Every featured skill, with its source pinned. Frozen: the shelf is the same on every computer. */
export const FEATURED_SKILLS = Object.freeze(
  LIST.map((item) => {
    const source = SOURCES[item.source];
    return Object.freeze({
      id: idOf(item),
      name: item.skill,
      summary: item.summary,
      group: item.group,
      author: source.author,
      license: source.license,
      repo: source.repo,
      commit: source.commit,
      path: item.path,
      licensePath: item.licensePath ?? source.licensePath,
      ...(source.pack && { pack: source.pack }),
      url: "https://github.com/" + source.repo + "/tree/" + source.commit + "/" + item.path,
    });
  }),
);

/**
 * Names this shelf was asked for under another name, and the upstream name used instead
 * (checked at each commit on 2026-11-24). `decision-quality-check` is not in anthropics/skills by
 * that name; `discernment-nudge` is the skill that does that job there.
 */
export const RENAMED = Object.freeze({
  "secure-code-guidance": "security-best-practices",
  "repository-threat-model": "security-threat-model",
  "distinctive-frontend-design": "frontend-design",
  "internal-communications": "internal-comms",
  "decision-quality-check": "discernment-nudge",
});

const byId = new Map(FEATURED_SKILLS.map((item) => [item.id, item]));
export const featuredSkill = (id) => byId.get(id);
