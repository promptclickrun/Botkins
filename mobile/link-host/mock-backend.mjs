// A stand-in for the desktop app, for developing and testing the phone app without it.
// It keeps a small workspace in memory, shaped like the desktop's, and answers a message with a
// scripted reply: thinking, one tool step, then streamed text. A message with "approve" in it asks
// for an approval first; one with "which" asks a question.
import { addUserMessage, recordVoiceLine } from "./voice-history.mjs";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { DemoSignIns } from "./mock-signin.mjs";
import { DemoUpdates } from "./mock-update.mjs";
import { botVoiceField } from "./voice.mjs";

const now = () => Date.now();
/** The demo computer's owner, as a person. */
const OWNER_NAME = "Alex";
const BUILTIN_SPACES = [["today", "Today"], ["feed", "Feed"], ["ideas", "Ideas"], ["goals", "Goals"]];
const CARD_SPACE = { feed: "feed", idea: "ideas", goal: "goals" };
const SPACE_LIMIT = { spaces: 60, panels: 40, notes: 50 };
// The two seeded projects work in this repository, so pull requests have a folder to look in.
const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const MIN = 60_000;
const HOUR = 60 * MIN;

const MODELS = [
  { id: "auto", name: "Auto", provider: "copilot", providerName: "GitHub Copilot", efforts: [], available: true, recommended: true },
  { id: "gpt-5.5", name: "GPT-5.5", provider: "copilot", providerName: "GitHub Copilot", efforts: ["low", "medium", "high"], defaultEffort: "medium", available: true },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "copilot", providerName: "GitHub Copilot", efforts: ["low", "medium", "high"], defaultEffort: "medium", available: true },
  { id: "gpt-5.5-codex", name: "GPT-5.5 Codex", provider: "codex", providerName: "ChatGPT", description: "Best for coding and long tasks", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", available: true, recommended: true },
  { id: "gpt-5.5", name: "GPT-5.5", provider: "codex", providerName: "ChatGPT", efforts: ["minimal", "low", "medium", "high"], defaultEffort: "medium", available: true },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", provider: "claude", providerName: "Claude", description: "Most capable", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", available: true, recommended: true },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "claude", providerName: "Claude", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", available: true },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "claude", providerName: "Claude", description: "Fast and capable", efforts: ["low", "medium", "high"], defaultEffort: "medium", available: true },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "claude", providerName: "Claude", efforts: [], available: true },
  { id: "big-pickle", name: "Big Pickle", provider: "opencode", providerName: "OpenCode", group: "OpenCode Zen", efforts: ["low", "medium", "high"], available: true },
  { id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "opencode", providerName: "OpenCode", group: "Google", efforts: ["low", "high"], available: false },
];

const PROVIDERS = [
  { id: "copilot", name: "GitHub Copilot", description: "Your GitHub Copilot plan, or Copilot Free.", default: true, installed: true, connected: true, account: "octocat", plan: "Copilot Pro", signIn: "browser", signOut: true },
  { id: "codex", name: "ChatGPT", description: "Your ChatGPT plan, through the Codex CLI.", default: false, installed: true, version: "0.98.0", connected: true, account: "you@example.com", plan: "Plus", signIn: "browser", signOut: true },
  { id: "claude", name: "Claude", description: "Your Claude plan, through Claude Code.", default: false, installed: true, version: "2.1.280", connected: true, account: "you@example.com", plan: "Max", signIn: "browser", signOut: true },
  { id: "opencode", name: "OpenCode", description: "Free models, and the model services you connect.", default: false, installed: true, version: "2.3.1", connected: true, signIn: "services", signOut: false },
  { id: "grok", name: "Grok", description: "Grok, through the Grok CLI.", default: false, installed: false, connected: false, signIn: null, signOut: false, install: { url: "https://x.ai/cli", command: "curl -fsSL https://example.com/demo/grok-install.sh | bash" }, message: "Install the Grok CLI on your computer." },
];

// The harnesses that are programs of their own (harnesses()): Pi, not on the demo computer until the phone installs it.
const HARNESS_TOOLS = [
  { id: "pi", name: "Pi", description: "The Pi coding agent, as the harness for ChatGPT and Claude plans.", harness: true, enabled: true, default: false, installed: false, connected: false, signIn: null, signOut: false, install: { url: "https://pi.dev", command: "curl -fsSL https://pi.dev/install.sh | sh" }, message: "Install Pi on your computer to use it as the harness." },
];

const SKILLS = [
  { name: "weekly-review", description: "Run a weekly review: wins, misses and next steps.", path: "/skills/weekly-review", origin: "botkins", enabled: true, editable: true, instructions: "# Weekly review\n\n1. List what shipped.\n2. List what slipped and why.\n3. Propose three priorities for next week." },
  { name: "meeting-notes", description: "Turn a transcript into decisions and action items.", path: "/skills/meeting-notes", origin: "botkins", enabled: true, editable: true, instructions: "# Meeting notes\n\nSummarize decisions first, then action items with owners." },
  { name: "wiki", description: "Read and keep the shared wiki.", path: "/built-in/wiki", origin: "built-in", enabled: true },
  { name: "html-apps", description: "Show a small interactive page in a chat.", path: "/built-in/html-apps", origin: "built-in", enabled: true },
  // From a linked folder (state.skills.folders), so the phone has more than eight skills to filter.
  { name: "release-notes", description: "Write release notes from a list of changes.", path: "/Users/demo/team-skills/release-notes", origin: "folder", folderId: "folder-team", enabled: true, editable: false },
  { name: "bug-triage", description: "Sort new bug reports by how bad they are.", path: "/Users/demo/team-skills/bug-triage", origin: "folder", folderId: "folder-team", enabled: true, editable: false },
  { name: "standup", description: "Write a short standup from yesterday's work.", path: "/Users/demo/team-skills/standup", origin: "folder", folderId: "folder-team", enabled: true, editable: false },
  { name: "pricing-check", description: "Compare our prices with the closest competitors.", path: "/Users/demo/team-skills/pricing-check", origin: "folder", folderId: "folder-team", enabled: true, editable: false },
  { name: "brand-voice", description: "Keep copy in the brand's voice.", path: "/Users/demo/team-skills/brand-voice", origin: "folder", folderId: "folder-team", enabled: true, editable: false },
];

// What a project with a folder shows as changed (projectChanges). Made up; nothing on disk is read.
const MADE_UP_CHANGES = [
  { path: "src/pricing/Plans.tsx", kind: "modified", staged: false, added: 14, removed: 6 },
  { path: "src/pricing/copy.ts", kind: "added", staged: false, added: 32, removed: 0 },
  { path: "docs/old-pricing.md", kind: "deleted", staged: false, added: 0, removed: 21 },
  { path: "src/hero/Hero.tsx", from: "src/Hero.tsx", kind: "renamed", staged: true, added: 2, removed: 2 },
];
const MADE_UP_DIFFS = {
  "src/pricing/Plans.tsx": [
    "--- a/src/pricing/Plans.tsx",
    "+++ b/src/pricing/Plans.tsx",
    "@@ -12,9 +12,17 @@ export function Plans({ annual }: { annual: boolean }) {",
    "   const plans = usePlans();",
    "-  const price = annual ? plan.yearly / 12 : plan.monthly;",
    "+  // Yearly plans show their monthly price, rounded the way the checkout rounds it.",
    "+  const price = annual ? Math.round((plan.yearly / 12) * 100) / 100 : plan.monthly;",
    "   return (",
    "     <section className=\"plans\">",
    "-      <h2>Pricing</h2>",
    "+      <h2>{copy.title}</h2>",
    "+      <p className=\"lede\">{copy.lede}</p>",
  ].join("\n"),
  "src/pricing/copy.ts": ["--- /dev/null", "+++ b/src/pricing/copy.ts", "@@ -0,0 +1,4 @@", "+export const copy = {", "+  title: \"Simple pricing\",", "+  lede: \"One plan for every team. Cancel any time.\",", "+};"].join("\n"),
};

// "long answer": a reply taller than a phone's screen, with its heading at the top, for Settings ›
// Chat › Position after response completes.
const LONG_ANSWER = [
  "## Moving the team to the new relay",
  "",
  "Here is the whole plan, from the first check to the last switch. It's long, so it starts with what matters most.",
  "",
  "**The short version:** move one computer at a time, keep the old path open for a day, and watch the error count after each move. Nothing needs a new phone build.",
  "",
  "### Before the move",
  "",
  "1. Check that every computer runs the release from this week. An older one keeps working, but it can't hold two sockets, so a restart of the relay drops its phones for a few seconds.",
  "2. Write down which phones each computer serves. The list on each computer's page is enough; there's no need to export it.",
  "3. Pick a quiet hour. Routines that run on the hour are the busiest moment, so half past is better.",
  "",
  "### The move itself",
  "",
  "For each computer, turn the relay off and on again in its settings. It opens its new pair of sockets at once, and phones that were connected stay on the same session. Watch the computer's page: the relay line should say connected within a few seconds. If it doesn't, leave it for a minute before you try again, because the relay counts quick retries from one place.",
  "",
  "Then send a message from a phone that is away from home, on cellular. A reply within a few seconds means the path works end to end. If the reply is slow, look at the relay line again before anything else.",
  "",
  "### After the move",
  "",
  "- Keep the old path open for a day. Phones that were asleep during the move find the new one by themselves when they wake.",
  "- Look at the error count the next morning. A handful of retries is normal; dozens from one computer means its clock is off, and the relay refuses a computer whose clock is more than five minutes out.",
  "- Tell the team when it's done, so nobody restarts a computer halfway through the day just in case.",
  "",
  "### If something goes wrong",
  "",
  "Turn the relay off on the computer that misbehaves. Its phones fall back to the home network, which is slower to find away from home but keeps working. Nothing is lost: chats, routines and settings live on the computer, not on the relay.",
  "",
  "That's everything. Tell me which computer you'd like to start with, and I'll walk you through it.",
].join("\n");

const REPLY = [
  "Here's a quick plan for the launch week:\n\n",
  "1. **Monday:** freeze the copy and send it to review.\n",
  "2. **Wednesday:** publish the changelog and the walkthrough.\n",
  "3. **Friday:** post the recap and collect feedback.\n\n",
  "| Day | Owner | Status |\n| --- | --- | --- |\n| Mon | Mira | Ready |\n| Wed | Patch | Drafting |\n| Fri | Scout | Planned |\n\n",
  "I can turn this into tasks on the board. Run `launch-check` any time to see where things stand.",
].join("");

export function seed() {
  const t = now();
  const bots = [
    { id: "bot-mira", name: "Mira", role: "Chief of staff", summary: "Keeps the week on track.", instructions: "Help me plan the week. Keep lists short and flag risks early.", face: "idle", avatar: { body: "bighelp.biggie" }, pinned: true, access: { all: true, projects: [] } },
    { id: "bot-patch", name: "Patch", role: "Coding partner", summary: "Reads the code first.", instructions: "Help me write, review and debug code. Keep changes small.", face: "coding", avatar: { body: "bighelp.patch" }, model: { model: "claude-fable-5-2", provider: "claude", reasoningEffort: "high" }, access: { all: false, projects: ["p1"] } },
    { id: "bot-scout", name: "Scout", role: "Research assistant", summary: "Finds and cites sources.", instructions: "Find and summarize reliable information. Cite your sources.", face: "searching", avatar: { body: "bighelp.scout", eyes: "wide" }, model: { model: "gpt-5.5-codex", provider: "codex", reasoningEffort: "medium" }, sectionId: "sec-work" },
    { id: "bot-quill", name: "Quill", role: "Writing partner", summary: "Plain words, tight edits.", instructions: "Help me draft and tighten writing. Match my voice.", face: "idle", avatar: { body: "pocket-curios.quill", mouth: "smile", cheeks: true } },
    { id: "bot-tally", name: "Tally", role: "Data analyst", summary: "Shows the method.", instructions: "Analyze data and numbers. State assumptions.", face: "searching", avatar: { body: "pocket-curios.tally", main: "#14B8A6" }, sectionId: "sec-work" },
    // Hidden: left out of the bot list until the "Hidden" filter shows it.
    { id: "bot-echo", name: "Echo", role: "Meeting notes", summary: "Turns transcripts into decisions.", instructions: "Summarize meetings: decisions first, then action items with owners.", face: "idle", avatar: { body: "bitty-bots.hoot" }, hidden: true },
  ];
  const message = (role, text, minutesAgo, extra = {}) => ({ role, text, time: t - minutesAgo * MIN, ...extra });
  const chats = [
    {
      id: "chat-launch", botId: "bot-mira", title: "Launch week plan", time: t - 12 * MIN, pinned: true, unread: true,
      // What fills the model's context, as the real app measures it after each turn.
      context: { current: 84_000, limit: 200_000, system: 12_000, tools: 30_000, conversation: 40_000, messages: 14, updatedAt: t - 12 * MIN },
      messages: [
        message("user", "What's left before the launch?", 14, { runId: "run-launch" }),
        message("assistant", "Three things are still open:\n\n- **Pricing page** copy needs a final pass\n- The **changelog** is drafted but not reviewed\n- Support macros aren't written yet\n\nWant me to add them to the board?", 12, { runId: "run-launch" }),
      ],
    },
    {
      id: "chat-auth", botId: "bot-patch", title: "Token refresh bug", time: t - 3 * HOUR, projectId: "p1",
      // Schedules made in the chat with /every and /after (Work › Routines › Chat schedules).
      schedules: [
        { id: 2, prompt: "Run the auth tests and tell me if anything broke", recurring: true, intervalMs: 2 * HOUR, enabled: true, nextAt: t + 70 * MIN, createdAt: t - 2 * 24 * HOUR },
        { id: 3, prompt: "Check whether the token fix shipped", recurring: false, enabled: false, nextAt: null, createdAt: t - 5 * HOUR },
      ],
      messages: [
        message("user", "The refresh token rotates twice when two tabs wake up. Can you find where?", 185, { runId: "run-auth" }),
        message("assistant", "Found it. Both tabs call `renew()` before either writes the new token.\n\n```ts\nconst running = renewals.get(id);\nif (running) return running;\n```\n\nSharing one in-flight renewal per server fixes the race.", 180, { runId: "run-auth" }),
      ],
    },
    {
      id: "chat-market", botId: "bot-scout", title: "Competitor pricing", time: t - 26 * HOUR,
      messages: [
        message("user", "Compare the three closest competitors on price.", 26 * 60 + 4, { runId: "run-market" }),
        message("assistant", "All three sit between $12 and $20 per seat. Two bill yearly only.", 26 * 60, { runId: "run-market" }),
      ],
    },
    // The refreshes of the Pipeline panel, which its Manage menu opens as "Open refresh history".
    { id: "chat-refresh-pipeline", botId: "bot-tally", title: "Pipeline · Refreshes", panelId: "panel-pipeline", time: t - 40 * MIN, messages: [message("assistant", "Refreshed the pipeline: 14 leads, 9 demos, 6 trials, 3 won.", 40)] },
    { id: "chat-blog", botId: "bot-quill", title: "Blog post intro", time: t - 3 * 24 * HOUR, messages: [message("user", "Tighten this intro for me.", 3 * 24 * 60 + 2, { runId: "run-blog" }), message("assistant", "Here's a shorter version that leads with the result.", 3 * 24 * 60, { runId: "run-blog" })] },
    {
      id: "chat-routine-brief", botId: "bot-mira", title: "Routine · Morning brief", time: t - 5 * HOUR, messages: [message("assistant", "**Today:** two reviews due, launch copy freeze at noon.", 5 * 60, { runId: "run-brief" })],
      lastScheduleId: 1,
      schedules: [{ id: 1, routine: true, enabled: true, name: "Morning brief", prompt: "Summarize my day: meetings, deadlines and anything at risk.", cadence: { kind: "weekdays", time: "08:30" }, cron: "30 8 * * 1-5", timezone: "America/Chicago", recurring: true, nextAt: t + 15 * HOUR, createdAt: t - 9 * 24 * HOUR }],
    },
    {
      id: "chat-routine-digest", botId: "bot-scout", title: "Routine · Friday digest", time: t - 4 * 24 * HOUR, messages: [],
      lastScheduleId: 1,
      schedules: [{ id: 1, routine: true, enabled: false, name: "Friday digest", prompt: "Collect this week's industry news in five bullets.", cadence: { kind: "weekly", time: "16:00", days: [5] }, cron: "0 16 * * 5", timezone: "America/Chicago", recurring: true, nextAt: t + 2 * 24 * HOUR, createdAt: t - 20 * 24 * HOUR }],
    },
  ];
  const run = (id, chatId, title, minutesAgo, extra = {}) => ({ id, chatId, title, time: t - minutesAgo * MIN, status: "Completed", detail: "", finished: t - minutesAgo * MIN + 9000, summary: "Worked for 9s · 2 steps", ...extra });
  const runs = [
    run("run-launch", "chat-launch", "What's left before the launch?", 14, {
      steps: [
        { id: "s1", name: "wiki_search", label: "Searched the wiki for launch", status: "Done", started: t - 14 * MIN, finished: t - 14 * MIN + 1200, input: '{"query":"launch"}', output: "3 pages" },
        { id: "s2", name: "task_list", label: "Read the task board", status: "Done", started: t - 14 * MIN + 1500, finished: t - 14 * MIN + 2100 },
      ],
      usage: { input: 4200, output: 310, model: "auto" },
    }),
    run("run-auth", "chat-auth", "The refresh token rotates twice", 185, { summary: "Worked for 41s · 5 steps", steps: [{ id: "s1", name: "grep", label: "Searched for renew(", status: "Done", started: t - 185 * MIN, finished: t - 185 * MIN + 800 }] }),
    run("run-market", "chat-market", "Compare the three closest competitors", 26 * 60 + 4),
    run("run-blog", "chat-blog", "Tighten this intro", 3 * 24 * 60 + 2),
    run("run-brief", "chat-routine-brief", "Morning brief", 5 * 60, { trigger: "scheduled", scheduleId: 1 }),
  ];
  return {
    bots,
    chats,
    runs,
    panels: [
      { id: "panel-goal", key: "writing", botId: "bot-quill", chatId: "chat-blog", title: "Writing goal", hidden: false, size: "small", revision: 3, updatedAt: t - 2 * HOUR, routine: null, projectId: "p1", blocks: [{ type: "metric", label: "Words this week", value: "3,420", note: "Goal 5,000" }, { type: "progress", label: "Progress", value: 3420, max: 5000 }] },
      { id: "panel-pipeline", key: "pipeline", botId: "bot-tally", chatId: "chat-market", title: "Pipeline", hidden: false, size: "wide", revision: 8, updatedAt: t - 40 * MIN, routine: { cron: "0 9 * * 1-5", timezone: "America/Chicago", prompt: "Refresh the pipeline", nextAt: t + 16 * HOUR, enabled: true }, refreshChatId: "chat-refresh-pipeline", lastCheck: { time: t - 40 * MIN, status: "ok" }, blocks: [{ type: "bars", label: "Deals by stage", items: [{ label: "Lead", value: 14 }, { label: "Demo", value: 9 }, { label: "Trial", value: 6 }, { label: "Won", value: 3 }] }, { type: "badges", items: [{ label: "2 at risk", tone: "warning" }, { label: "On pace", tone: "positive" }] }] },
    ],
    streams: {},
    intents: {},
    thinking: {},
    queued: {},
    speakers: {},
    requests: [],
    sections: [{ id: "sec-work", name: "Work" }],
    templates: [{ id: "tpl-standup", name: "Standup host", role: "Daily standup", summary: "Runs a two-minute standup.", instructions: "Ask each person what they did, what's next and what's in the way. Keep it to two minutes.", avatar: { body: "bighelp.tock" }, source: "saved", createdAt: t - 5 * 24 * HOUR }],
    board: [
      { id: "b1", botId: "bot-scout", kind: "feed", title: "Two competitors raised prices", body: "Both moved their team plan from $15 to $18 per seat this week.", status: "open", read: false, createdAt: t - 50 * MIN, updatedAt: t - 50 * MIN, links: [{ url: "https://example.com/pricing", title: "Pricing changes" }] },
      { id: "b2", botId: "bot-mira", kind: "idea", title: "Batch the launch emails", body: "Send the three launch emails as one sequence so replies thread together.", status: "open", read: true, createdAt: t - 5 * HOUR, updatedAt: t - 5 * HOUR },
      { id: "b3", botId: "bot-mira", kind: "goal", title: "Ship the pricing page", body: "Final copy, review, publish.", status: "open", read: true, createdAt: t - 2 * 24 * HOUR, updatedAt: t - 2 * 24 * HOUR },
      // Finished ones, for Show finished (Reopen, Delete).
      { id: "b4", botId: "bot-scout", kind: "feed", title: "A new pricing page teardown", body: "Someone took apart ten SaaS pricing pages.", status: "cleared", read: true, rating: "up", createdAt: t - 3 * 24 * HOUR, updatedAt: t - 2 * 24 * HOUR },
      { id: "b5", botId: "bot-mira", kind: "idea", title: "Record a two-minute walkthrough", body: "", status: "done", answer: "goal", read: true, createdAt: t - 4 * 24 * HOUR, updatedAt: t - 3 * 24 * HOUR },
      { id: "b6", botId: "bot-mira", kind: "goal", title: "Write the changelog", body: "", category: "career", status: "done", read: true, createdAt: t - 6 * 24 * HOUR, updatedAt: t - 24 * HOUR },
    ],
    tasks: [
      { id: "t1", title: "Write support macros", body: "Five macros for the most common launch questions.", botId: "bot-quill", priority: "high", status: "ready", createdBy: "person", createdAt: t - 3 * HOUR, updatedAt: t - 3 * HOUR },
      { id: "t2", title: "Review the changelog", body: "", botId: "bot-patch", priority: "normal", status: "review", createdBy: "person", createdAt: t - 8 * HOUR, updatedAt: t - HOUR, result: "The changelog reads well. Two entries need issue links." },
      { id: "t3", title: "Benchmark the new parser", body: "", botId: "bot-patch", priority: "normal", status: "later", createdBy: "person", createdAt: t - 30 * HOUR, updatedAt: t - 30 * HOUR },
      { id: "t4", title: "Collect launch metrics", body: "", botId: "bot-tally", priority: "low", status: "done", createdBy: "bot-mira", createdAt: t - 50 * HOUR, updatedAt: t - 20 * HOUR },
    ],
    projects: [
      { id: "p1", name: "Website", description: "Marketing site and pricing page", color: "coral", folder: REPO, todos: [{ id: "td1", text: "Final pass on pricing copy", done: false, createdAt: t - 6 * HOUR }, { id: "td2", text: "Compress hero images", done: true, createdAt: t - 30 * HOUR, doneAt: t - 20 * HOUR }], lastUsed: t - 2 * HOUR, createdAt: t - 30 * 24 * HOUR },
      { id: "p2", name: "Mobile app", color: "blue", folder: REPO, todos: [], lastUsed: t - 3 * 24 * HOUR, createdAt: t - 12 * 24 * HOUR },
      // A project with no folder: no modes, nothing to unlink.
      { id: "p3", name: "Garden plans", description: "Beds, seeds and the watering rota", color: "green", todos: [{ id: "td3", text: "Order seed potatoes", done: false, createdAt: t - 26 * HOUR }, { id: "td4", text: "Fix the rain barrel", done: false, createdAt: t - 20 * HOUR }, { id: "td5", text: "Sketch the new bed", done: false, createdAt: t - 4 * HOUR }], lastUsed: t - 6 * 24 * HOUR, createdAt: t - 40 * 24 * HOUR },
    ],
    mcpServers: [
      { id: "mcp-linear", name: "linear", type: "http", enabled: true, url: "https://mcp.linear.app/mcp", auth: { type: "oauth", signedIn: true, signingIn: false, canRenew: true, clientSecret: false } },
      { id: "mcp-files", name: "filesystem", type: "stdio", enabled: true, command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"], env: [] },
      { id: "mcp-docs", name: "docs", type: "http", enabled: false, url: "https://docs.example.com/mcp", headers: ["Authorization"], auth: { type: "header" } },
    ],
    skills: { folders: [{ id: "folder-team", path: "/Users/demo/team-skills" }], plugins: [{ id: "plugin-review", path: "/Users/demo/.plugins/code-review" }], disabled: [] },
    wiki: { revision: 1 },
    providers: { revision: 1 },
    settings: {
      model: { model: "auto" },
      appearance: { theme: "system", lightBackground: "cream", darkBackground: "charcoal", bubble: "theme", colorTheme: "ink", themePicked: false, font: "system", fontPicked: false, textSize: "default" },
      foldTools: true,
      showThinking: true,
      linkPreviews: false,
      readAloud: false,
      onboarded: true,
      approval: "ask",
      clarify: ["missing"],
      clarificationInstructions: "",
      notifications: { replies: true, routines: true, requests: true, quietHours: { enabled: false, from: "22:00", to: "07:00" } },
      access: { allBots: true },
      background: { keepRunning: true, runAtStartup: false },
      sidebar: { order: ["Home", "Today", "Chats", "Work", "Wiki"], collapsed: true },
      teamwork: true,
      harness: "copilot",
      providers: { copilot: { enabled: true }, codex: { enabled: true }, claude: { enabled: true }, opencode: { enabled: false }, grok: { enabled: false } },
    },
  };
}

// ── A small wiki, in the shapes the desktop's wiki uses (the desktop app's desktop/wiki.mjs) ───────────

const GUIDE = "WIKI.md";
const GENERATED = new Set(["index.md", "log.md"]);
const CHANGED = "This page changed while you were editing it.";
const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const slug = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const humanize = (name) => {
  const words = name.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
};
const clip = (value, max) => (value.length <= max ? value : value.slice(0, max - 1).replace(/\s+\S*$/, "") + "…");
const isTemplate = (path) => posix.basename(path) === "_template.md";
const LINK = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s]+)\s*\)/g;

/** A path inside the wiki. Hidden names and ".." are refused, like the real one. */
function wikiPath(value) {
  if (typeof value !== "string") throw new Error("Give a wiki path, such as projects/website.md.");
  const path = value.trim().replace(/\\/g, "/").replace(/^(\.?\/)+/, "").replace(/\/+$/, "");
  const parts = path.split("/");
  if (!path || path.length > 240 || parts.length > 6 || parts.some((p) => !p || p.startsWith(".") || /[\0-\x1f<>:"|?*]/.test(p))) throw new Error("“" + value.trim().slice(0, 80) + "” isn't a wiki path. Use one such as projects/website.md.");
  return path;
}
const pagePath = (value) => (/\.md$/i.test(wikiPath(value)) ? wikiPath(value) : wikiPath(value) + ".md");

class MockWiki {
  constructor(state) {
    this.state = state;
    this.pages = new Map(); // path → { content, updatedAt, history: [{ id, time, by, content }] }
    this.folders = new Set(["projects", "people", "goals"]);
    this.log = [];
    const t = now();
    const put = (path, content, ago) => this.pages.set(path, { content, updatedAt: t - ago * HOUR, history: [] });
    put(GUIDE, "# Wiki guide\n\nThis wiki holds what the team knows. Put projects in `projects/`, people in `people/` and goals in `goals/`. Link pages with ordinary Markdown links.\n", 200);
    put("projects/_template.md", "# {{title}}\n\n## Summary\n\n## Status\n", 200);
    put("projects/website.md", "# Website\n\nThe marketing site and pricing page. Jo owns the copy.\n\n- Owner: [Jo](../people/jo.md)\n- Goal: [Launch week](../goals/launch.md)\n- See also: [Botkins app](botkins-app.md)\n", 30);
    put("projects/botkins-app.md", "# Botkins app\n\nThe phone app that pairs with the desktop. The next release waits on the [launch](../goals/launch.md).\n\n## Open questions\n\n- Do we ship the screen viewer in the first release? See [security notes](../goals/security.md).\n", 6);
    put("people/jo.md", "# Jo\n\nWrites the copy and keeps the launch calendar. Prefers short lists.\n\nWorks on the [Website](../projects/website.md).\n", 72);
    put("goals/launch.md", "# Launch week\n\nShip the pricing page, the changelog and the walkthrough by the 24th.\n\nProjects: [Website](../projects/website.md), [Botkins app](../projects/botkins-app.md).\n", 12);
    this.pages.get("projects/website.md").history.push({ id: String(t - 40 * HOUR) + "-You", time: t - 40 * HOUR, by: "You", content: "# Website\n\nThe marketing site.\n" });
  }
  bump(by, what) {
    this.state.wiki.revision++;
    this.log.unshift({ time: now(), by, what });
  }
  /** Pages with what lists need: title, summary, and the links that point in and out. */
  scan() {
    const infos = new Map();
    for (const [path, page] of this.pages) {
      let title = "";
      let summary = "";
      for (const line of page.content.split("\n")) {
        const trimmed = line.trim();
        const heading = /^#\s+(.+?)\s*#*$/.exec(trimmed);
        if (heading && !title) title = heading[1];
        else if (trimmed && !trimmed.startsWith("#") && !summary) summary = clip(trimmed.replace(/[*_`]/g, ""), 180);
      }
      const links = [];
      const missing = [];
      for (const m of page.content.matchAll(LINK)) {
        const target = m[3].startsWith("<") ? m[3].slice(1, -1) : m[3];
        if (m[1] || /^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
        const resolved = posix.normalize(posix.join(posix.dirname(path), target.split("#")[0]));
        if (resolved.startsWith("..") || !resolved.endsWith(".md")) continue;
        if (this.pages.has(resolved)) links.push(resolved);
        else missing.push({ path: resolved, label: m[2] });
      }
      infos.set(path, { path, title: title || humanize(posix.basename(path)), summary, updatedAt: page.updatedAt, links: [...new Set(links)], backlinks: [], missing, ...(isTemplate(path) && { template: true }) });
    }
    for (const info of infos.values()) for (const target of info.links) infos.get(target)?.backlinks.push(info.path);
    return infos;
  }
  tree() {
    const pages = [...this.scan().values()];
    const has = (name) => pages.some((p) => !p.template && p.path.startsWith("projects/") && p.title.toLowerCase() === name.toLowerCase());
    return {
      folders: [...this.folders].sort(),
      pages,
      guide: GUIDE,
      revision: this.state.wiki.revision,
      suggested: { projects: (this.state.projects ?? []).filter((p) => !has(p.name)).map((p) => ({ id: p.id, name: p.name })) },
    };
  }
  generated(path) {
    const content =
      path === "index.md"
        ? "# Index\n\n" + [...this.scan().values()].filter((p) => !p.template).map((p) => "- [" + p.title + "](" + p.path + ")").join("\n") + "\n"
        : "# Log\n\n" + (this.log.map((e) => "- " + new Date(e.time).toISOString().slice(0, 16).replace("T", " ") + " · " + e.by + " " + e.what).join("\n") || "Nothing yet.") + "\n";
    return { path, title: path === "index.md" ? "Index" : "Log", summary: "", updatedAt: now(), links: [], backlinks: [], missing: [], content, base: hash(content), versions: 0, generated: true };
  }
  page(value) {
    const path = pagePath(value);
    if (GENERATED.has(path)) return this.generated(path);
    const page = this.pages.get(path);
    if (!page) throw new Error("There is no wiki page at " + path + ".");
    const info = this.scan().get(path);
    const record = path.startsWith("projects/") ? (this.state.projects ?? []).find((p) => p.name.toLowerCase() === info.title.toLowerCase()) : null;
    return { ...info, content: page.content, base: hash(page.content), versions: page.history.length, ...(record && { record: { kind: "project", id: record.id, name: record.name } }) };
  }
  write(path, content, { by = "You", base } = {}) {
    if (GENERATED.has(path)) throw new Error("Botkins keeps " + path + " itself. Change the pages and it follows.");
    if (typeof content !== "string" || !content.trim()) throw new Error("A page needs some text. To remove a page, delete it.");
    if (content.length > 200000) throw new Error("A page holds up to 200,000 characters. Split this one into several pages.");
    const before = this.pages.get(path);
    if (base !== undefined && before && hash(before.content) !== base) throw new Error(CHANGED);
    const text = content.replace(/\r\n?/g, "\n").trimEnd() + "\n";
    if (before && before.content === text) return path;
    if (before) {
      const time = now();
      before.history.unshift({ id: String(time) + "-" + by.replace(/\W+/g, "-"), time, by, content: before.content });
      before.history.length = Math.min(before.history.length, 20);
    }
    this.pages.set(path, { content: text, updatedAt: now(), history: before?.history ?? [] });
    this.bump(by, (before ? "updated " : "created ") + path);
    return path;
  }
  save(path, content, base) {
    const page = pagePath(path);
    this.write(page, content, { base });
    return this.page(page);
  }
  create({ folder = "", title } = {}) {
    if (typeof title !== "string" || !title.trim() || title.length > 120) throw new Error("Give the page a title of up to 120 characters.");
    const dir = folder ? wikiPath(folder) : "";
    if (dir && !this.folders.has(dir)) throw new Error("There is nothing in the wiki at " + dir + ".");
    const name = slug(title) || "page";
    let path = (dir ? dir + "/" : "") + name + ".md";
    for (let n = 2; this.pages.has(path); n++) path = (dir ? dir + "/" : "") + name + "-" + n + ".md";
    const template = (dir && this.pages.get(dir + "/_template.md")?.content) || "# {{title}}\n";
    return this.write(path, template.replaceAll("{{title}}", () => title.trim()));
  }
  createFor({ kind, id } = {}) {
    const project = kind === "project" ? (this.state.projects ?? []).find((p) => p.id === id) : null;
    if (!project) throw new Error("That project no longer exists.");
    return this.create({ folder: "projects", title: project.name });
  }
  createFolder({ parent = "", name } = {}) {
    if (typeof name !== "string" || !slug(name)) throw new Error("Give the section a name.");
    const path = wikiPath((parent ? wikiPath(parent) + "/" : "") + slug(name));
    if (this.folders.has(path)) throw new Error("There is already a section named " + humanize(slug(name)) + " there.");
    this.folders.add(path);
    this.bump("You", "added the section " + path + "/");
    return path;
  }
  move(from, to) {
    const folder = this.folders.has(wikiPath(from));
    from = folder ? wikiPath(from) : pagePath(from);
    to = folder ? wikiPath(to) : pagePath(to);
    if (!folder && !this.pages.has(from)) throw new Error("There is nothing in the wiki at " + from + ".");
    if (folder && !this.folders.has(from)) throw new Error("There is nothing in the wiki at " + from + ".");
    if ([from, to].some((p) => p === GUIDE || GENERATED.has(p))) throw new Error("The guide, the index and the log stay where they are.");
    if (from === to) return to;
    if (folder && (to + "/").startsWith(from + "/")) throw new Error("A section can't be moved into itself.");
    if (folder ? this.folders.has(to) : this.pages.has(to)) throw new Error("There is already something at " + to + ". Choose another name.");
    const map = new Map();
    if (folder) {
      for (const path of this.pages.keys()) if (path.startsWith(from + "/")) map.set(path, to + path.slice(from.length));
      this.folders = new Set([...this.folders].map((f) => (f === from || f.startsWith(from + "/") ? to + f.slice(from.length) : f)));
      if (posix.dirname(to) !== ".") this.folders.add(posix.dirname(to));
    } else map.set(from, to);
    const pages = new Map();
    for (const [path, page] of this.pages) {
      const next = map.get(path) ?? path;
      // Links to moved pages follow them, written relative to the page that holds them.
      const content = page.content.replace(LINK, (all, bang, label, target) => {
        const raw = target.startsWith("<") ? target.slice(1, -1) : target;
        if (bang || /^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(raw)) return all;
        const resolved = posix.normalize(posix.join(posix.dirname(path), raw.split("#")[0]));
        const moved = map.get(resolved);
        if (!moved && next === path) return all;
        const there = moved ?? resolved;
        const rel = posix.relative(posix.dirname(next), there);
        return "[" + label + "](" + (rel.startsWith("..") ? rel : posix.dirname(next) === "." ? there : "./" + rel) + ")";
      });
      pages.set(next, { ...page, content });
    }
    this.pages = pages;
    this.bump("You", "moved " + from + " to " + to);
    return to;
  }
  remove(value) {
    const path = this.folders.has(wikiPath(value)) ? wikiPath(value) : pagePath(value);
    if (path === GUIDE || GENERATED.has(path)) throw new Error("The guide, the index and the log can't be removed.");
    if (this.folders.has(path)) {
      for (const key of [...this.pages.keys()]) if (key.startsWith(path + "/")) this.pages.delete(key);
      this.folders = new Set([...this.folders].filter((f) => f !== path && !f.startsWith(path + "/")));
      this.bump("You", "removed the section " + path + "/");
    } else {
      if (!this.pages.has(path)) throw new Error("There is nothing in the wiki at " + path + ".");
      this.pages.delete(path);
      this.bump("You", "removed " + path);
    }
  }
  search(query) {
    if (typeof query !== "string" || !query.trim()) throw new Error("Give some words to search for.");
    const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 12);
    const hits = [];
    for (const info of this.scan().values()) {
      if (info.template) continue;
      const body = this.pages.get(info.path).content.toLowerCase();
      const title = info.title.toLowerCase();
      if (!words.every((w) => title.includes(w) || body.includes(w) || info.path.includes(w))) continue;
      const score = words.reduce((sum, w) => sum + (title.includes(w) ? 10 : 0) + Math.min(body.split(w).length - 1, 5), 0);
      const line = this.pages.get(info.path).content.split("\n").find((l) => !/^#\s/.test(l.trim()) && words.some((w) => l.toLowerCase().includes(w)));
      hits.push({ path: info.path, title: info.title, snippet: clip((line ?? info.summary).replace(/\s+/g, " ").trim(), 200), score });
    }
    return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, 12).map(({ score: _score, ...hit }) => hit);
  }
  history(path) {
    const page = this.pages.get(pagePath(path));
    return (page?.history ?? []).map(({ id, time, by }) => ({ id, time, by }));
  }
  version(path, id) {
    const found = this.pages.get(pagePath(path))?.history.find((v) => v.id === id);
    if (!found) throw new Error("That version is no longer kept.");
    return found.content;
  }
  restore(path, id) {
    const page = pagePath(path);
    this.write(page, this.version(page, id));
    return this.page(page);
  }
  /** The pages a chat may mention with "#", newest first. */
  mentionable() {
    return [...this.scan().values()]
      .filter((p) => !p.template)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({ path: p.path, title: p.title, hint: p.path.includes("/") ? humanize(p.path.split("/")[0]) : "Wiki", modified: p.updatedAt }));
  }
}

const text = (value, limit, what) => {
  const out = String(value ?? "").trim();
  if (!out) throw new Error("Enter a " + what + ".");
  if (out.length > limit) throw new Error("Use up to " + limit + " characters for the " + what + ".");
  return out;
};

// A custom view the demo bot shows when asked for a chart: one self-contained page, as a real bot
// writes one for the desktop app. It reads its numbers with botkins.getData(), follows the app's
// colors, and has one button that hands text to the message box and one link.
// An app panel's page ("spaces-v1"): a checklist people tick together. What they tick is kept in the
// panel's state with botkins.state, each change under a short label ("Ticked Press kit").
const CHECKLIST_VIEW = String.raw`<style>
  body { margin: 0; font: 15px/1.4 -apple-system, system-ui, sans-serif; color: var(--ink); }
  label { display: flex; gap: 10px; align-items: center; padding: 8px 2px; }
  input { width: 20px; height: 20px; }
  .done { opacity: 0.55; text-decoration: line-through; }
</style>
<div id="list"></div>
<script>
  const list = document.getElementById("list");
  let items = [];
  const draw = (state) => {
    const ticked = (state && state.ticked) || {};
    list.textContent = "";
    for (const item of items) {
      const row = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!ticked[item];
      box.onchange = () => {
        const next = Object.assign({}, ticked, { [item]: box.checked });
        botkins.state.set({ ticked: next }, (box.checked ? "Ticked " : "Unticked ") + item).then((saved) => { if (!saved) box.checked = !box.checked; });
      };
      const text = document.createElement("span");
      text.textContent = item;
      if (box.checked) text.className = "done";
      row.append(box, text);
      list.append(row);
    }
  };
  botkins.getData().then((data) => {
    items = (data && data.items) || [];
    return botkins.state.get();
  }).then(draw);
  botkins.state.onChange(draw);
</script>`;

const DEMO_VIEW = String.raw`<style>
  body { padding: 4px 2px; }
  h3 { margin: 0 0 10px; font-size: 15px; }
  .row { display: flex; align-items: center; gap: 8px; margin: 7px 0; }
  .name { width: 96px; font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .track { flex: 1; height: 14px; border-radius: 7px; background: var(--sunken); overflow: hidden; }
  .bar { display: block; height: 100%; width: 0; border-radius: 7px; background: var(--accent); transition: width .7s ease; }
  .n { width: 22px; text-align: right; font-size: 13px; font-weight: 600; }
  .row.on .name { color: var(--ink); }
  #note { min-height: 20px; margin-top: 8px; font-size: 13px; color: var(--muted); }
  button { margin-top: 10px; font: inherit; font-size: 14px; padding: 9px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
  a { color: var(--ink); margin-left: 12px; font-size: 14px; }
</style>
<h3 id="title"></h3>
<div id="rows"></div>
<div id="note">Tap a bar.</div>
<button id="ask">Ask about the busiest</button><a href="https://example.com/issues">Open the list</a>
<script>
  botkins.getData().then((data) => {
    document.getElementById("title").textContent = data.title;
    const max = Math.max(1, ...data.items.map((item) => item.value));
    const rows = document.getElementById("rows");
    for (const item of data.items) {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = '<span class="name"></span><span class="track"><span class="bar"></span></span><span class="n"></span>';
      row.querySelector(".name").textContent = item.label;
      row.querySelector(".n").textContent = item.value;
      row.onclick = () => {
        for (const other of rows.children) other.classList.remove("on");
        row.classList.add("on");
        document.getElementById("note").textContent = item.label + " was last pushed " + item.pushed + ".";
      };
      rows.appendChild(row);
      requestAnimationFrame(() => requestAnimationFrame(() => (row.querySelector(".bar").style.width = (item.value / max) * 100 + "%")));
    }
    const top = data.items.reduce((a, b) => (b.value > a.value ? b : a));
    document.getElementById("ask").onclick = () => botkins.sendAnswer("Tell me more about " + top.label + ".").catch((e) => (document.getElementById("note").textContent = e.message));
  });
</script>`;
const DEMO_VIEW_DATA = {
  title: "Open issues by repo",
  items: [
    { label: "website", value: 6, pushed: "in October" },
    { label: "mobile", value: 4, pushed: "yesterday" },
    { label: "relay", value: 2, pushed: "this morning" },
    { label: "docs", value: 1, pushed: "last week" },
  ],
};

// A view that tries to get out, for checking a phone's web view by hand ("sandbox" in a message).
// Each line says whether one way out was blocked. It tries example.com, which is reserved, or the
// address in BOTKINS_DEV_PROBE (a listener of your own, with a STUN port one below its port and a
// TURN port over TCP one above it), which shows for certain what left the view.
const PROBE = process.env.BOTKINS_DEV_PROBE || "https://example.com";
const SANDBOX_VIEW = String.raw`<pre id="out" style="font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;margin:0"></pre>
<script>
(() => {
  const lines = [];
  const log = (name, blocked) => { lines.push(name + ": " + (blocked ? "blocked" : "ALLOWED")); document.getElementById("out").textContent = lines.join("\n"); };
  const base = __PROBE__;
  const to = (what) => base + "/" + what;
  const at = new URL(base);
  const ws = (at.protocol === "https:" ? "wss://" : "ws://") + at.host + "/";
  const stun = "stun:" + at.hostname + ":" + (at.port ? Number(at.port) - 1 : 3478);
  try { fetch(to("fetch"), { mode: "no-cors" }).then(() => log("fetch", false), () => log("fetch", true)); } catch (e) { log("fetch", true); }
  try { const x = new XMLHttpRequest(); x.open("GET", to("xhr")); x.onload = () => log("xhr", false); x.onerror = () => log("xhr", true); x.send(); } catch (e) { log("xhr", true); }
  const img = new Image(); img.onload = () => log("image", false); img.onerror = () => log("image", true); img.src = to("image?" + Date.now());
  // (sendBeacon answers true even when the policy drops the request: only a listener shows the truth.)
  try { const said = !!navigator.sendBeacon && navigator.sendBeacon(to("beacon"), "x"); lines.push("beacon: answered " + said + ", see the listener"); } catch (e) { log("beacon", true); }
  log("WebSocket", typeof WebSocket === "undefined");
  log("RTCPeerConnection", typeof RTCPeerConnection === "undefined");
  log("Worker", typeof Worker === "undefined");
  try {
    const f = document.createElement("iframe"); document.body.appendChild(f);
    const w = f.contentWindow || window[0];
    log("frame has RTCPeerConnection", !w || typeof w.RTCPeerConnection === "undefined");
    log("frame has WebSocket", !w || typeof w.WebSocket === "undefined");
    if (w && w.fetch) w.fetch(to("frame-fetch"), { mode: "no-cors" }).then(() => log("frame fetch", false), () => log("frame fetch", true)); else log("frame fetch", true);
    if (w && w.WebSocket) { try { const s = new w.WebSocket(ws + "frame-ws"); s.onopen = () => log("frame WebSocket connects", false); s.onerror = () => log("frame WebSocket connects", true); } catch (e) { log("frame WebSocket connects", true); } }
    if (w && w.RTCPeerConnection) {
      try {
        const pc = new w.RTCPeerConnection({ iceServers: [{ urls: stun }] });
        pc.createDataChannel("x");
        let found = 0;
        pc.onicecandidate = (event) => { if (event.candidate) found++; };
        pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => {});
        setTimeout(() => log("frame WebRTC gathers addresses (" + found + ")", found === 0), 3000);
      } catch (e) { log("frame WebRTC gathers addresses", true); }
    }
  } catch (e) { log("frame", true); }
  // A frame with a page of its own (srcdoc), and one whose address is code (javascript:). Each says
  // whether it ran and whether it has WebRTC, and tries STUN (UDP) and TURN over TCP at the listener.
  const turn = "turn:" + at.hostname + ":" + (at.port ? Number(at.port) + 1 : 3479) + "?transport=tcp";
  const inner = "(function(via){var r={via:via,rtc:typeof RTCPeerConnection};try{var pc=new RTCPeerConnection({iceServers:[{urls:" + JSON.stringify(stun) + "},{urls:" + JSON.stringify(turn) + ",username:via,credential:'x'}]});pc.createDataChannel('x');pc.createOffer().then(function(o){return pc.setLocalDescription(o)})}catch(e){}parent.postMessage({sandboxProbe:r},'*')})";
  const ran = {};
  addEventListener("message", (event) => { const r = event.data && event.data.sandboxProbe; if (r) { ran[r.via] = true; log(r.via + " frame has RTCPeerConnection", r.rtc === "undefined"); } });
  try { const f = document.createElement("iframe"); f.srcdoc = "<scr" + "ipt>" + inner + "('srcdoc')</scr" + "ipt>"; document.body.appendChild(f); } catch (e) {}
  try { const f = document.createElement("iframe"); f.src = "javascript:" + inner + "('javascript')"; document.body.appendChild(f); } catch (e) {}
  setTimeout(() => { for (const via of ["srcdoc", "javascript"]) if (!ran[via]) log(via + " frame runs", true); }, 2500);
  try { localStorage.setItem("a", "b"); log("localStorage", false); } catch (e) { log("localStorage", true); }
  try { document.cookie = "a=b"; log("cookie", document.cookie === ""); } catch (e) { log("cookie", true); }
  lines.push("app handle offers: " + (Object.keys(window.ReactNativeWebView || {}).join(", ") || "nothing"));
  botkins.sendAnswer("/compact").then(() => log("slash answer", false), () => log("slash answer", true));
  botkins.openLink("javascript:alert(1)").then((opened) => log("script link", !opened), () => log("script link", true));
  setTimeout(() => { let w = null; try { w = window.open(to("popup")); } catch (e) {} log("window.open", !w); }, 400);
  setTimeout(() => { const form = document.createElement("form"); form.method = "post"; form.action = to("form"); document.body.appendChild(form); try { form.submit(); } catch (e) {} setTimeout(() => log("form post", true), 900); }, 700);
  setTimeout(() => { try { location.href = to("navigation"); } catch (e) {} setTimeout(() => log("navigation", true), 1500); }, 3500);
})();
</script>`.replace("__PROBE__", () => JSON.stringify(PROBE));

const today = () => new Date().toISOString().slice(0, 10);

// The folders a phone can browse on the demo computer: a home folder and one plugged-in disk. All
// made up: the demo never reads a real disk.
const DEMO_PLACES = [
  { name: "Home", path: "/Users/demo", folders: { "": ["Code", "Desktop", "Documents", "team-skills"], "/Code": ["mobile", "relay", "review-kit", "website"], "/Code/website": ["content", "src"], "/Documents": ["Notes", "Plans"] } },
  { name: "Backup", path: "/Volumes/Backup", folders: { "": ["Archive", "Projects"], "/Projects": ["old-site"] } },
];
const OUTSIDE = "Only folders in your home folder or on a plugged-in disk can be chosen from here. Choose another folder, or choose this one on the computer itself.";
const GONE = "That folder doesn't exist on the computer.";
/** Where a path is in the made-up places, as { place, at }. Null when it is outside them, undefined when it is gone. */
function demoFolder(path) {
  if (typeof path !== "string") return null;
  const place = DEMO_PLACES.find((item) => path === item.path || path.startsWith(item.path + "/"));
  if (!place) return null;
  let at = "";
  for (const step of path.slice(place.path.length).split("/").filter(Boolean)) {
    if (!(place.folders[at] ?? []).includes(step)) return undefined;
    at += "/" + step;
  }
  return { place, at };
}
/** A folder a person chose in the browser, or the sentence that says why it can't be used. */
function chosenFolder(path) {
  if (typeof path !== "string" || !path) throw new Error("Choose a folder.");
  const found = demoFolder(path);
  if (!found) throw new Error(found === null ? OUTSIDE : GONE);
  return path;
}
/** A file name from a title: nothing a file system refuses. */
const fileName = (value, fallback) => String(value ?? "").replace(/[\\/:*?"<>|\0-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || fallback;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** A .zip of text files, stored without compression: [{ path, text }]. Enough for the demo's wiki export. */
function storedZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const item of files) {
    const name = Buffer.from(item.path, "utf8");
    const data = Buffer.from(item.text, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + data.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
/** A one-page PDF that shows a few lines of plain text. The real app prints the whole document. */
function tinyPdf(lines) {
  const safe = (line) => String(line).replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, "\\$&").slice(0, 90);
  const stream = "BT /F1 14 Tf 72 720 Td 18 TL " + lines.slice(0, 30).map((line) => "(" + safe(line) + ") Tj T*").join(" ") + " ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => {
    const at = out.length;
    out += index + 1 + " 0 obj\n" + body + "\nendobj\n";
    return at;
  });
  const xref = out.length;
  out += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n" + offsets.map((at) => String(at).padStart(10, "0") + " 00000 n \n").join("");
  out += "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  return Buffer.from(out, "latin1");
}
/** One second of a quiet tone as a .wav file: something real for the demo to play. */
function tinyWav() {
  const rate = 8000;
  const samples = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i++) samples.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 6000 * Math.min(1, i / 400, (rate - i) / 400)), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + samples.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(samples.length, 40);
  return Buffer.concat([head, samples]);
}
const ARTIFACT_PAGE = 50;
const ARTIFACT_CHUNK = 512 * 1024;
const MEDIA_KINDS = ["image", "video", "audio"];

/**
 * What the demo's bots "made": pictures from this repo, text, code, a PDF, a sound, a folder with
 * files in it, and enough reports to need a second page. Every path is made up (under /Users/demo);
 * what is read comes from memory or from this repo's own files, never from the path.
 */
function demoArtifacts(state) {
  const t = now();
  const chatOf = (botId) => state.chats.find((chat) => chat.botId === botId && !chat.botIds);
  const repoFile = (path) => (existsSync(REPO + "/" + path) ? readFileSync(REPO + "/" + path) : Buffer.from("(missing in this copy of the repo)\n"));
  const items = [];
  const add = (botId, path, kind, mime, bytes, source, ago, more = {}) => {
    const chat = more.noChat ? undefined : chatOf(botId);
    const data = bytes === null ? null : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
    const item = { id: "art-" + createHash("sha256").update(botId + path).digest("hex").slice(0, 12), botId, ...(chat && { chatId: chat.id, chatTitle: chat.title, ...(more.messageIndex !== undefined && { messageIndex: more.messageIndex }) }), path, name: posix.basename(path), kind, mime, size: data ? data.length : null, time: t - ago * MIN, source };
    items.push({ item, data, parent: more.parent });
    return item;
  };
  for (const [botId, head] of [["bot-mira", "beacon"], ["bot-patch", "patch"], ["bot-scout", "scout"]]) {
    if (!state.bots.some((bot) => bot.id === botId)) continue;
    const picture = ["original", "honey", "fern"].map((palette) => "assets/botkins/" + head + "-" + palette + ".webp").filter((path) => existsSync(REPO + "/" + path));
    picture.forEach((path, index) => add(botId, "/Users/demo/Pictures/botkins/" + posix.basename(path), "image", "image/webp", repoFile(path), "media", 12 + index * 30, { messageIndex: 1 }));
    add(botId, "/Users/demo/Code/website/README.md", "file", "text/markdown", repoFile("README.md"), "tool", 45, { messageIndex: 1 });
    add(botId, "/Users/demo/Code/website/src/grant.mjs", "file", "text/javascript", repoFile("link-host/grant.mjs"), "tool", 70);
    add(botId, "/Users/demo/Documents/Plans/launch plan.pdf", "file", "application/pdf", tinyPdf(["Launch plan", "", "1. Pricing page", "2. Changelog", "3. Walkthrough"]), "export", 95, { noChat: true });
    add(botId, "/Users/demo/Documents/Notes/prices.csv", "file", "text/csv", "plan,price\nTeam,18\nSolo,12\nStudio,20\n", "upload", 130);
    add(botId, "/Users/demo/Music/standup tone.wav", "audio", "audio/wav", tinyWav(), "media", 150);
    add(botId, "/Users/demo/Downloads/archive.bin", "file", "application/octet-stream", Buffer.from([0, 1, 2, 3, 254, 255]), "upload", 200);
    const folder = add(botId, "/Users/demo/Code/website/out", "folder", "inode/directory", null, "tool", 20);
    add(botId, "/Users/demo/Code/website/out/index.html", "file", "text/html", "<!doctype html><title>Demo</title><h1>Built page</h1>\n", "tool", 20, { parent: folder.id });
    add(botId, "/Users/demo/Code/website/out/notes.txt", "file", "text/plain", "Built by the demo bot.\n", "tool", 20, { parent: folder.id });
    add(botId, "/Users/demo/Code/website/out/assets", "folder", "inode/directory", null, "tool", 20, { parent: folder.id });
    // Enough of them for a second page.
    for (let n = 1; n <= 55; n++) add(botId, "/Users/demo/Documents/Reports/report-" + String(n).padStart(2, "0") + ".md", "file", "text/markdown", "# Report " + n + "\n\nMade up by the demo computer.\n", "tool", 300 + n * 60);
  }
  return items;
}
const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
/** Words in a message that make the demo bot use the person's phone, and the tool it calls. */
// The demo turns of docs/turn-timeline.md (MockBackend.timelineTurn).
const TIMELINE_TURN = /long turn|ask midway|time ?out|interrupt me/i;

const PHONE_ASKS = [
  { when: /calendar|schedule|meeting/i, tool: "phone_calendar_events", label: "Reading your calendar", args: () => ({ from: today(), to: today(), limit: 10 }) },
  { when: /contact/i, tool: "phone_contacts_search", label: "Searching your contacts", args: () => ({ query: "a", limit: 5 }) },
  { when: /where am i|location/i, tool: "phone_location", label: "Checking where you are", args: () => ({}) },
  { when: /photo/i, tool: "phone_photos_recent", label: "Listing your photos", args: () => ({ limit: 5 }) },
  { when: /steps|health|sleep/i, tool: "phone_health_summary", label: "Reading your Health summary", args: () => ({}) },
  { when: /email|mail /i, tool: "phone_mail_compose", label: "Opening an email on your phone", args: () => ({ to: ["someone@example.com"], subject: "Hello from Botkins", body: "Written by your bot, for you to send." }) },
];

const DELIVER_TO = ["none", "routine", "chat", "feed", "idea", "goal"];
/** A routine's destination as it may be saved. */
function delivery(value) {
  if (!DELIVER_TO.includes(value?.to)) throw new Error("That destination isn't one a routine can use.");
  return { to: value.to, ...(value.to === "chat" && typeof value.chatId === "string" && { chatId: value.chatId }) };
}

// ── Plugins ("plugins-v1", docs/plugins.md) ──────────────────────────────────────────────────────
// Two made-up catalogs in GitHub's shape, read from nowhere: the demo never fetches GitHub. A plugin's
// `revision` is a hash of what it holds, so a phone that reviewed one version can't install another.
// BOTKINS_DEV_PLUGINS=off leaves the capability out, as an older computer would. "old" keeps
// "plugins-v1" and leaves "plugin-starts-v1" out: descriptions in the old shape, with no mark.
// "held" starts with plugins the computer switched off: one whose folder was linked for its skills,
// one an earlier version did not show whole, and one whose copy is not the reviewed files.
const PLUGIN_PAGE = 50;
const pluginField = (key, label, { secret = false, required = true, ...rest } = {}) => ({ key, label, secret, required, ...rest });
const contents = ({ skills = [], agents = [], commands = [], mcpServers = [], hooks = [], lspServers, notRun, otherFiles } = {}) => ({
  skills,
  agents,
  commands,
  // As the app's one reading gives them: a local tool with its words apart, a remote one with its headers, a hook with its limit.
  mcpServers: mcpServers.map((server) => (server.kind === "local" ? { args: [], env: [], ...server } : { type: "http", headers: [], ...server })),
  hooks: hooks.map((hook) => ({ env: [], timeoutSec: 10, ...hook })),
  ...(lspServers && { lspServers }),
  ...(notRun && { notRun }),
  otherFiles: otherFiles ?? { count: 0, bytes: 0, files: [] },
});
const setting = (name) => ({ name, value: "${" + name + "}" });
const DEMO_MARKETPLACES = [
  { id: "awesome-copilot", name: "GitHub", source: "github/awesome-copilot", builtIn: true },
  { id: "copilot-plugins", name: "Copilot plugins", source: "github/copilot-plugins", builtIn: true },
];
const demoPlugin = (marketplace, name, entry) => ({ id: name + "@" + marketplace, name, marketplace, version: "1.0.0", license: "MIT", config: [], ...entry, contents: contents(entry.contents) });
/** The plugin a refresh of the catalogs finds the first time ("market-refresh-v1"). */
const FRESH_PLUGIN = demoPlugin("awesome-copilot", "daily-digest", {
  description: "A skill for a short morning summary of what changed since yesterday.",
  version: "0.1.0",
  author: "GitHub",
  keywords: ["summary", "daily"],
  contents: { skills: ["daily-digest"] },
});
const DEMO_PLUGINS = [
  demoPlugin("awesome-copilot", "keepsake-memory", {
    description: "Long-term memory for your bots: recalls what matters before each message and keeps what was learned after each reply.",
    version: "0.9.2",
    author: "Keepsake",
    homepage: "https://keepsake.example.com",
    repository: "https://github.com/example/keepsake-memory",
    keywords: ["memory", "recall", "context"],
    contents: {
      skills: ["memory-hygiene"],
      mcpServers: [{ name: "keepsake", kind: "remote", url: "https://memory.example.com/mcp", headers: [{ name: "Authorization", value: "Bearer ${MEMORY_API_KEY}" }, { name: "X-Memory-Bank", value: "${MEMORY_BANK_ID}" }] }],
      hooks: [
        { event: "sessionStart", command: 'node "${PLUGIN_ROOT}/hooks/brief.mjs"', env: [setting("MEMORY_API_KEY"), setting("MEMORY_BANK_ID")] },
        { event: "userPromptSubmitted", command: 'node "${PLUGIN_ROOT}/hooks/recall.mjs"', env: [setting("MEMORY_API_KEY"), setting("MEMORY_BANK_ID")], timeoutSec: 5 },
        { event: "agentStop", command: 'node "${PLUGIN_ROOT}/hooks/retain.mjs"', env: [setting("MEMORY_API_KEY"), setting("MEMORY_BANK_ID"), { name: "RETAIN_MODE", value: "summary" }], timeoutSec: 30 },
      ],
      otherFiles: { count: 9, bytes: 48_200, files: [{ path: "package.json", bytes: 640, config: true }, { path: "hooks/brief.mjs", bytes: 3_100 }, { path: "hooks/recall.mjs", bytes: 5_400 }, { path: "hooks/retain.mjs", bytes: 6_900 }] },
    },
    config: [
      pluginField("MEMORY_API_KEY", "Memory API key", { secret: true, description: "From your Keepsake account." }),
      pluginField("MEMORY_BANK_ID", "Memory bank ID", { description: "One bank per person or team." }),
    ],
    postInstallMessage: "Your bots now remember across chats. Start a new chat to try it.",
  }),
  demoPlugin("awesome-copilot", "writing-skills", {
    description: "Skills for clear writing: plain summaries, release notes and friendly emails.",
    version: "1.2.0",
    author: "GitHub",
    repository: "https://github.com/github/awesome-copilot",
    keywords: ["writing", "docs"],
    contents: { skills: ["plain-summary", "release-notes", "friendly-email"] },
    // After it is installed the catalog moves on once, so "Update" has something new to show.
    later: { version: "1.3.0", contents: { skills: ["plain-summary", "release-notes", "friendly-email", "headlines"] } },
  }),
  demoPlugin("awesome-copilot", "tracker", {
    description: "Read and update issues in your team's tracker.",
    author: "Tracker Inc.",
    homepage: "https://tracker.example.com",
    keywords: ["issues", "project management"],
    contents: { mcpServers: [{ name: "tracker", kind: "remote", type: "sse", url: "https://mcp.tracker.example.com/mcp", oauth: true, oauthClientId: "botkins-demo" }], commands: ["triage"] },
  }),
  demoPlugin("awesome-copilot", "sqlite-explorer", {
    description: "Look inside SQLite databases on your computer and ask questions of them.",
    version: "2.1.0",
    author: "Data Folks",
    repository: "https://github.com/example/sqlite-explorer",
    keywords: ["database", "sql"],
    contents: {
      mcpServers: [
        {
          name: "sqlite",
          kind: "local",
          command: "npx",
          args: ["-y", "@example/sqlite-mcp", "--read-only", "--label", "My databases"],
          cwd: "server",
          env: [setting("DATABASE_PATH"), { name: "SQLITE_TIMEOUT", value: "5000" }],
          envNotSet: [{ name: "NODE_OPTIONS", why: "Botkins does not set NODE_OPTIONS. Such a name can make a program load or start more than its command says." }],
        },
      ],
      skills: ["sql-help"],
      otherFiles: { count: 214, bytes: 3_355_443, files: [{ path: "package.json", bytes: 1_840, config: true }, { path: ".npmrc", bytes: 62, config: true }, { path: "node_modules/", bytes: 3_100_000, files: 180, config: true }, { path: "README.md", bytes: 2_100 }] },
    },
    config: [pluginField("DATABASE_PATH", "Database path", { default: "~/Documents/data.db" })],
  }),
  demoPlugin("awesome-copilot", "legacy-formatter", {
    description: "Formats code on save. An old plugin whose hooks file no longer reads.",
    version: "0.3.1",
    author: "Someone",
    keywords: ["format"],
    contents: { commands: ["format"] },
    readError: "Its hooks file couldn't be read: hooks/hooks.json isn't valid JSON.",
  }),
  demoPlugin("awesome-copilot", "code-review", {
    description: "A reviewer agent and commands to review a change before it merges.",
    author: "GitHub",
    keywords: ["review", "git"],
    contents: { agents: ["reviewer", "security-reviewer"], commands: ["review", "review-pr"] },
  }),
  demoPlugin("awesome-copilot", "git-guard", {
    description: "Stops a bot before it force-pushes or rewrites history.",
    author: "Safe Ops",
    keywords: ["git", "safety"],
    contents: { hooks: [{ event: "preToolUse", command: "sh ${PLUGIN_ROOT}/guard.sh" }] },
  }),
  demoPlugin("awesome-copilot", "test-runner", {
    description: "Runs the tests after a bot edits a file, and tells it what failed.",
    author: "Test Lab",
    keywords: ["testing"],
    contents: { skills: ["fix-failing-test"], hooks: [{ event: "postToolUse", command: "npm test --silent" }, { event: "postToolUseFailure", command: "node ${PLUGIN_ROOT}/explain.mjs" }] },
  }),
  demoPlugin("awesome-copilot", "cloud-docs", {
    description: "Search a cloud provider's documentation while you work.",
    author: "Cloud Docs",
    keywords: ["docs", "cloud"],
    contents: { mcpServers: [{ name: "cloud-docs", kind: "remote", url: "https://docs.cloud.example.com/mcp" }] },
  }),
  demoPlugin("awesome-copilot", "frontend-design", {
    description: "A designer agent and skills for accessible, good-looking web pages.",
    author: "Pixel Co.",
    keywords: ["design", "css", "accessibility"],
    contents: { skills: ["accessible-forms", "color-contrast"], agents: ["designer"] },
  }),
  demoPlugin("awesome-copilot", "typescript-lsp", {
    description: "TypeScript language smarts for bots: go to definition, find references, type errors.",
    author: "Lang Tools",
    keywords: ["typescript", "lsp"],
    contents: { lspServers: ["typescript-language-server"] },
  }),
  demoPlugin("awesome-copilot", "notify-me", {
    description: "Sends a note to your chat app when a long turn ends.",
    author: "Ping",
    keywords: ["notifications", "slack"],
    contents: {
      hooks: [{ event: "sessionEnd", command: 'curl -s -X POST "$WEBHOOK_URL"', env: [setting("WEBHOOK_URL"), { name: "SLACK_TOKEN", value: "${SLACK_TOKEN}" }] }],
      // A hook for an event the app does not know is not run, and is said so.
      notRun: { count: 1, items: [{ what: "hook", name: "notification", why: "Botkins does not know the event notification, so this hook does not run." }] },
    },
    config: [pluginField("WEBHOOK_URL", "Webhook URL"), pluginField("SLACK_TOKEN", "Slack token", { secret: true, required: false })],
  }),
  demoPlugin("copilot-plugins", "actions-helper", {
    description: "Write and fix GitHub Actions workflows.",
    author: "GitHub",
    keywords: ["ci", "actions"],
    contents: { skills: ["workflow-syntax", "fix-workflow"], commands: ["new-workflow"] },
  }),
  demoPlugin("copilot-plugins", "dependency-doctor", {
    description: "Finds outdated and vulnerable packages and proposes upgrades.",
    author: "GitHub",
    keywords: ["dependencies", "security"],
    contents: { agents: ["upgrader"], mcpServers: [{ name: "advisories", kind: "remote", url: "https://api.advisories.example.com/mcp" }] },
  }),
  demoPlugin("copilot-plugins", "spark-docs", {
    description: "Keeps a project's README and docs in step with its code.",
    author: "GitHub",
    keywords: ["docs"],
    contents: { skills: ["readme"], hooks: [{ event: "agentStop", command: "node ${PLUGIN_ROOT}/check-docs.mjs" }] },
  }),
];
/** What a folder on the demo computer holds as a plugin. Any other made-up folder holds one skill. */
const DEMO_FOLDER_PLUGINS = {
  "/Users/demo/team-skills": { description: "Our team's own skills.", contents: { skills: ["release-checklist", "standup-summary"], hooks: [{ event: "sessionStart", command: 'node "${PLUGIN_ROOT}/hooks/today.mjs"' }] } },
  // A plugin folder: picked under Skills it is installed as a plugin, switched off, never linked.
  "/Users/demo/Code/review-kit": { description: "Review skills, and a check that runs before a tool does.", contents: { skills: ["review-a-change"], hooks: [{ event: "preToolUse", command: "sh ${PLUGIN_ROOT}/check.sh", timeoutSec: 5 }] } },
  "/Users/demo/.plugins/code-review": { description: "Skills to review a change.", contents: { skills: ["review-checklist", "security-pass"], hooks: [{ event: "agentStop", command: 'node "${PLUGIN_ROOT}/hooks/notes.mjs"' }] } },
};
/** A revision is the hash of what was looked at: 64 hex characters, as the app's. */
const revisionOf = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pluginRevision = (entry) => revisionOf({ version: entry.version, contents: entry.contents, config: entry.config });
/** The app's own sentences (desktop/docs/PLUGINS.md), so a phone meets the words it will meet. */
const HELD_BACK = {
  unseen: "Botkins switched this plugin off. An earlier version of Botkins did not show everything that this plugin starts on this computer. Look at what it starts, and switch it on again if you agree.",
  linked: "This plugin folder was linked for its skills. Botkins now keeps a copy of it and shows what it starts on this computer. It is off until you switch it on.",
};
const CHANGED_COPY = "The installed files of this plugin are not the files that were reviewed. Update the plugin: Botkins writes its files again and keeps your settings.";
const NO_REVISION = "Look at the plugin first. An install or an update names the revision that was looked at.";
const OTHER_REVISION = "This plugin is not the one that was looked at: its revision is another one now. Look at it again.";
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const BUILT_IN_VALUES = ["PLUGIN_ROOT", "PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "BOTKINS_DIR", "BOTKINS_CHAT_ID", "BOTKINS_BOT_ID"];
/** Where each setting's value goes: only into an environment value (a local tool's, a hook's) and a header's value. */
function sentTo(shown) {
  const places = new Map();
  const goes = (value, where) => {
    for (const [, key] of String(value).matchAll(PLACEHOLDER)) if (!BUILT_IN_VALUES.includes(key)) places.set(key, [...(places.get(key) ?? []), where]);
  };
  for (const server of shown.mcpServers) {
    if (server.kind === "local") for (const { name, value } of server.env ?? []) goes(value, { tool: server.name, env: name });
    else for (const { name, value } of server.headers ?? []) goes(value, { tool: server.name, header: name, url: server.url });
  }
  for (const hook of shown.hooks) for (const { name, value } of hook.env ?? []) goes(value, { hook: hook.event, env: name });
  return places;
}
const withSentTo = (config, shown) => {
  const places = sentTo(shown);
  return structuredClone(config).map((field) => (places.has(field.key) ? { ...field, sentTo: places.get(field.key) } : field));
};
/** A description as a computer from before "plugin-starts-v1" sends it: a tool by one line, a hook's command cut at 300 characters, no settings' places. */
const oldContents = ({ notRun: _notRun, otherFiles: _files, ...shown }) => ({
  ...structuredClone(shown),
  mcpServers: shown.mcpServers.map((server) => ({ name: server.name, kind: server.kind, ...(server.kind === "local" ? { command: [server.command, ...(server.args ?? [])].join(" ") } : { url: server.url }), ...(server.oauth && { oauth: true }) })),
  hooks: shown.hooks.map((hook) => ({ event: hook.event, command: hook.command.slice(0, 300) })),
});
const STALE_INSTALL = "This plugin changed since you looked at it. Look at it again before you install it.";
const STALE_UPDATE = "This plugin changed since you looked at it. Look at it again before you update it.";
const LISTING_KEYS = ["id", "name", "marketplace", "description", "version", "author", "homepage", "repository", "license", "keywords"];
const listingOf = (entry) => Object.fromEntries(LISTING_KEYS.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]));
const HOOK_SENTENCES = {
  sessionStart: "when a chat starts",
  userPromptSubmitted: "at each message you send",
  preToolUse: "before a tool runs",
  postToolUse: "after a tool runs",
  postToolUseFailure: "after a tool fails",
  agentStop: "when a reply ends",
  sessionEnd: "when a chat ends",
  notification: "when a bot sends a notification",
};
/** What a plugin runs on the computer, in the app's sentences. `old`: the sentences of an app from before "plugin-starts-v1". */
function pluginWarnings(entry, old = false) {
  const { hooks, mcpServers, notRun } = entry.contents;
  if (old) {
    const out = [];
    for (const event of [...new Set(hooks.map((hook) => hook.event))]) out.push("Runs a command on your computer " + (HOOK_SENTENCES[event] ?? "at " + event) + ".");
    for (const server of mcpServers) if (server.kind === "local") out.push("Starts " + server.name + " on your computer.");
    return out;
  }
  const local = mcpServers.some((server) => server.kind === "local");
  return [
    ...(hooks.length ? ["Runs a command on your computer through plugin hooks."] : []),
    ...(local ? ["Runs a local MCP server on your computer."] : []),
    ...(hooks.length || local ? ["A command runs with the plugin's own files. Botkins shows each command it starts, and cannot show all that those files make it do. Install a plugin only from a source you trust."] : []),
    ...(mcpServers.some((server) => server.kind === "remote") ? ["Connects to a remote MCP server."] : []),
    ...([...mcpServers, ...hooks].some((item) => item.envNotSet?.length) ? ["Botkins does not set some environment names that this plugin asks for. Its tools or hooks may not work."] : []),
    ...(notRun?.count ? ["Botkins does not run some hooks or tools of this plugin."] : []),
  ];
}

// ── Agent templates ("agent-templates-v1", docs/agent-templates.md) ─────────────────────────────────
// Made-up templates from two marketplaces, read from nowhere: the built-in "Botkins" and a team's own
// ("Team picks", not built in). The order is the catalogs' own, Botkins first. BOTKINS_DEV_AGENTS=off
// leaves the capability out, as an older computer would.
const AGENT_CATEGORIES = { writing: "Writing", research: "Research", productivity: "Productivity", work: "Work", dev: "Development", learning: "Learning", health: "Health", finance: "Finance", home: "Home", media: "Media", life: "Life", other: "Other" };
const agentTemplate = (marketplace, marketplaceName, builtIn, name, entry) => ({ id: name + "@" + marketplace, marketplace, marketplaceName, builtIn, ...entry, ...(entry.category && { categoryName: AGENT_CATEGORIES[entry.category] ?? "Other" }) });
const DEMO_AGENTS = [
  agentTemplate("botkins", "Botkins", true, "inbox-triage", {
    name: "Inbox Triage",
    role: "Email sorter",
    summary: "Reads your new mail, sorts what matters from what can wait, and drafts short replies for you to check.",
    look: { head: "beacon", palette: "tidepool" },
    category: "productivity",
    version: "1.0.0",
    author: "Botkins",
    keywords: ["email", "inbox", "mail"],
    instructions: "You help the person keep their inbox under control.\n\n- Sort new mail into: needs a reply today, can wait, and can be archived.\n- For each that needs a reply, draft a short answer in the person's own tone.\n- Never send anything yourself. Show the drafts and wait.\n- When you are not sure what a message wants, say so in one line.",
  }),
  agentTemplate("botkins", "Botkins", true, "meeting-prep", {
    name: "Meeting Prep",
    role: "Briefing writer",
    summary: "Before each meeting, gathers who is coming, what was said last time and what to decide, on one page.",
    look: { head: "spool", palette: "honey" },
    category: "productivity",
    version: "1.2.0",
    author: "Botkins",
    keywords: ["calendar", "meetings", "notes"],
    instructions: "Before a meeting, write a one-page brief:\n\n1. Who is coming, and what each of them cares about.\n2. What was agreed or left open last time.\n3. The decisions this meeting should make.\n\nKeep it short enough to read in two minutes.",
  }),
  agentTemplate("botkins", "Botkins", true, "plain-editor", {
    name: "Plain Editor",
    role: "Editor",
    summary: "Makes your writing shorter and clearer without changing what you mean.",
    look: { head: "muse", palette: "fig" },
    category: "writing",
    version: "1.0.0",
    author: "Botkins",
    keywords: ["editing", "clarity", "style"],
    instructions: "Edit the person's text for clarity.\n\n- Cut words that add nothing.\n- Prefer short sentences and common words.\n- Keep the person's meaning and voice.\n- Show the edited text first, then a short list of what you changed and why.",
  }),
  agentTemplate("botkins", "Botkins", true, "story-spark", {
    name: "Story Spark",
    role: "Writing partner",
    summary: "Helps you start a story: a premise, a few characters and the first scene, then follows your lead.",
    look: { head: "luna", palette: "bluebell" },
    category: "writing",
    version: "0.9.1",
    author: "Botkins",
    keywords: ["fiction", "stories", "ideas"],
    instructions: "You are a writing partner for fiction.\n\nOffer three short premises when asked to start. Once the person picks one, suggest characters and a first scene. Follow the person's choices; never take the story over.",
  }),
  agentTemplate("botkins", "Botkins", true, "habit-coach", {
    name: "Habit Coach",
    role: "Coach",
    summary: "Checks in each day on the habits you chose, keeps count, and helps you plan around a missed day.",
    look: { head: "sprig", palette: "fern" },
    category: "health",
    version: "1.0.0",
    author: "Botkins",
    keywords: ["habits", "fitness", "routine"],
    instructions: "Help the person keep the habits they chose.\n\n- Ask once a day how each habit went.\n- Keep a running count, and say it plainly.\n- When a day is missed, help plan the next one. No guilt.\n- You are not a doctor: for anything medical, suggest they ask one.",
  }),
  agentTemplate("team-picks", "Team picks", false, "release-notes", {
    name: "Release Notes",
    role: "Changelog writer",
    summary: "Turns a list of merged pull requests into release notes people want to read.",
    look: { head: "tinker", palette: "terracotta" },
    category: "dev",
    version: "2.0.0",
    author: "Acme platform team",
    keywords: ["github", "changelog", "releases"],
    instructions: "Write release notes from the merged pull requests you are given.\n\n- Group them as New, Better and Fixed.\n- One line each, in plain words a customer understands.\n- Leave out internal changes (tests, CI, refactors).\n- End with the list of contributors.",
  }),
];
const marketAgentOf = ({ instructions: _instructions, ...listing }) => listing;
const agentMatches = (agent, words) => words.every((word) => [agent.name, agent.role, agent.summary, agent.category ?? "", agent.categoryName ?? "", ...(agent.keywords ?? [])].some((part) => part.toLowerCase().includes(word)));

export class MockBackend {
  constructor({ state = seed(), speed = 1, appends = process.env.BOTKINS_DEV_APPENDS !== "off", timeline = process.env.BOTKINS_DEV_TIMELINE !== "off", pluginPage = PLUGIN_PAGE } = {}) {
    // "turn-timeline-v1" (docs/turn-timeline.md). BOTKINS_DEV_TIMELINE=off is an older computer.
    this.streamAppends = appends;
    this.timeline = timeline;
    // A computer nobody has set up yet: no bots, and nothing that belongs to one.
    if (process.env.BOTKINS_DEV_EMPTY === "1") Object.assign(state, { bots: [], chats: [], runs: [], routines: [], tasks: [], board: [], panels: [], sections: [], requests: [] });
    Object.assign(this, { state, speed, listeners: new Set(), turns: new Map(), waiting: new Map(), memory: new Map(), skillList: SKILLS.map((s) => ({ ...s })) });
    this.wiki = new MockWiki(state);
    // What this stand-in app supports itself, beyond the link's own list.
    // "files-v1": a file out and in as text, without a dialog. "folders-v1": the folder browser.
    // "artifacts-v1": what the bots made or were given, from an index the app keeps (here: made up).
    this.capabilities = ["voice-history-v1", "quiet-replies-v1", "routine-delivery-v1", ...(process.env.BOTKINS_DEV_NO_OUTPUT === "off" ? [] : ["routine-no-output-v1"]), "models-v2", "side-pane-v1", "files-v1", "folders-v1", "project-artifacts-v1", "artifacts-v1", "secure-input-v1", ...(process.env.BOTKINS_DEV_USAGE === "off" ? [] : ["provider-usage-v1"])];
    if (this.timeline) this.capabilities.push("turn-timeline-v1");
    // "bot-voice-v1": a bot may have a voice of its own. BOTKINS_DEV_BOT_VOICE=off is an older computer.
    this.botVoice = process.env.BOTKINS_DEV_BOT_VOICE !== "off";
    if (this.botVoice) this.capabilities.push("bot-voice-v1");
    // "provider-signin-v1": signing a model provider in, and installing one, from a phone (mock-signin.mjs).
    this.signIns = new DemoSignIns(this);
    if (process.env.BOTKINS_DEV_SIGNIN !== "off") this.capabilities.push("provider-signin-v1");
    // "spaces-v1" (docs/spaces.md): pages of panels. The owner's four built-in spaces hold what was on
    // Today; "Launch" has an app panel people tick together, with notes; "Money" is private.
    this.spacesOn = process.env.BOTKINS_DEV_SPACES !== "off";
    this.spaceRecords = [];
    if (this.spacesOn) {
      this.capabilities.push("spaces-v1");
      // The app's own half, host-side (link-host/spaces.mjs): built-in spaces for a person, and a member who left.
      this.spaces = {
        ensure: (person) => void this.ensureSpaces(person),
        release: (person) => this.releaseSpaces(person),
        snapshot: (id) => this.snapshotSpace(id),
      };
    }
    // "app-update-v1": made-up updates of this computer's own Botkins (mock-update.mjs, BOTKINS_DEV_UPDATE).
    this.updates = new DemoUpdates(this, process.env.BOTKINS_DEV_UPDATE);
    if (this.updates.capable) this.capabilities.push("app-update-v1");
    // "agent-templates-v1" (docs/agent-templates.md): made-up templates. Left out with BOTKINS_DEV_AGENTS=off.
    if (process.env.BOTKINS_DEV_AGENTS !== "off") this.capabilities.push("agent-templates-v1");
    // "plugins-v1" (docs/plugins.md): made-up catalogs and installs. One plugin starts installed.
    this.pluginsOn = process.env.BOTKINS_DEV_PLUGINS !== "off";
    this.pluginPage = pluginPage;
    this.plugins = { marketplaces: DEMO_MARKETPLACES.map((market) => ({ ...market, updatedAt: now() - 20 * MIN })), catalog: structuredClone(DEMO_PLUGINS), installed: [] };
    // "plugin-starts-v1": what a description says a plugin starts is what starts, whole. Left out with BOTKINS_DEV_PLUGINS=old.
    this.pluginStarts = this.pluginsOn && process.env.BOTKINS_DEV_PLUGINS !== "old";
    if (this.pluginsOn) {
      this.capabilities.push("plugins-v1");
      if (this.pluginStarts) this.capabilities.push("plugin-starts-v1");
      // "market-refresh-v1": the catalogs read again on request. Left out with BOTKINS_DEV_PLUGINS=old.
      if (this.pluginStarts) this.capabilities.push("market-refresh-v1");
      this.installPlugin("writing-skills@awesome-copilot", { revision: pluginRevision(this.pluginEntry("writing-skills@awesome-copilot")) });
      if (process.env.BOTKINS_DEV_PLUGINS === "held") this.holdPluginsBack();
    }
    this.cache = { bytes: 48_340_992, catalogs: 6 };
    this.callContexts = [];
    state.artifacts = { revision: 1 };
    this.artifacts = demoArtifacts(state);
    // A server with no window of its own: a phone may set what phones do with its screen (grant.mjs).
    // BOTKINS_DEV_DISPLAY=off says its display isn't running.
    if (process.env.BOTKINS_DEV_HEADLESS === "1") {
      this.headless = true;
      this.displayStatus = () => (process.env.BOTKINS_DEV_DISPLAY === "off" ? { available: false, kind: "xvfb", note: "The virtual display isn't running. Start it on the server." } : { available: true, kind: "xvfb" });
    }
    /** How many test notifications the demo computer was asked to show. */
    this.tested = 0;
    // Custom views (html blocks): the pages, kept apart from the state a phone is sent, as the desktop app does.
    this.pages = new Map();
    this.frames = {
      page: (id) => {
        const page = this.pages.get(id);
        if (!page) throw new Error("This view no longer exists.");
        return { html: page.html, data: page.data };
      },
      chatFor: (id) => this.pages.get(id)?.chatId ?? null,
    };
    if (this.spacesOn) this.seedSpaces();
    this.extras = {
      adoptMcpSignIn: (serverId) => {
        const server = this.server(serverId);
        server.auth = { type: "oauth", signedIn: true, signingIn: false, canRenew: true, clientSecret: false };
        this.changed();
        return { status: "connected", tools: ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL"] };
      },
    };
  }
  info() {
    return { app: "botkins", version: this.updates?.current ?? "0.8.0-demo", platform: process.platform };
  }
  snapshot() {
    // The installed plugins as a phone sees them: a secret setting says only that it is set.
    if (this.pluginsOn) this.state.plugins = this.plugins.installed.map((record) => this.pluginView(record));
    // Each space with what the link needs to count for a person: its panels and open cards (docs/spaces.md).
    if (this.spacesOn) {
      this.state.spaces = this.spaceRecords.map((space) => ({
        ...space,
        items: [
          ...this.state.panels.filter((panel) => panel.spaceId === space.id && !panel.hidden).map((panel) => ({ id: panel.id, botId: panel.botId, updatedAt: panel.updatedAt, ...(panel.last && panel.last.at >= panel.updatedAt && { by: panel.last.by }) })),
          ...this.state.board.filter((item) => item.spaceId === space.id && item.status === "open").map((item) => ({ id: item.id, botId: item.botId, updatedAt: item.updatedAt })),
        ],
      }));
    }
    return this.state;
  }
  /**
   * What a live voice may know of the bot and the person (server.mjs `liveNotes`): the person's
   * name, the bot's identity file and the person's user file, as the app keeps them. Made up here.
   */
  async liveContext({ botId }) {
    const bot = this.state.bots.find((item) => item.id === botId);
    const name = bot?.name ?? "Bot";
    return {
      userName: "Alex Demo",
      identity: `# ${name}\n\nI am ${name}, ${bot?.role ? "the " + bot.role.toLowerCase() : "a bot"} on Alex's demo computer. I keep answers short and say when I'm not sure.`,
      user: "# Alex Demo\n\n- Prefers short, direct answers.\n- Works on the Botkins launch this month.\n- Time zone: Europe/Stockholm.",
    };
  }
  // ── Plugins ──
  pluginEntry(id) {
    const entry = this.plugins.catalog.find((item) => item.id === id);
    if (!entry) throw new Error("That plugin isn't in any marketplace any more.");
    return entry;
  }
  /**
   * What the update to the app left behind (BOTKINS_DEV_PLUGINS=held): a folder that was linked for
   * its skills is now a plugin that is off; a plugin an earlier version did not show whole is off;
   * and one plugin's copy is not the reviewed files, so an update is its repair.
   */
  holdPluginsBack() {
    const linked = "/Users/demo/.plugins/code-review";
    this.state.skills = { ...this.state.skills, plugins: this.state.skills.plugins.filter((plugin) => plugin.path !== linked) };
    this.addPluginFolder(linked).heldBack = "linked";
    for (const [id, more] of [["git-guard@awesome-copilot", { enabled: false, heldBack: "unseen" }], ["test-runner@awesome-copilot", { changed: true }]]) {
      this.installPlugin(id, { revision: pluginRevision(this.pluginEntry(id)) });
      Object.assign(this.installedPlugin(id), more);
    }
  }
  /** A folder as an installed plugin, switched off: a copy of what the folder holds now. */
  addPluginFolder(path) {
    if (this.plugins.installed.some((record) => record.folder === path)) throw new Error("That folder is already added.");
    const name = posix.basename(path);
    const made = DEMO_FOLDER_PLUGINS[path] ?? { contents: { skills: [slug(name) || "skill"] } };
    const record = { id: name + "@folder", listing: { id: name + "@folder", name, marketplace: "folder", ...(made.description && { description: made.description }) }, contents: contents(made.contents), config: [], values: {}, enabled: false, bots: "all", installedAt: now(), folder: path };
    record.revision = revisionOf(record.contents);
    if (this.plugins.installed.some((item) => item.id === record.id)) throw new Error("A plugin called " + name + " is already installed.");
    this.plugins.installed.push(record);
    return record;
  }
  /** A description as this computer sends it: whole and marked, or in the old shape with no mark. */
  described(shown, config) {
    const warnings = pluginWarnings({ contents: shown }, !this.pluginStarts);
    if (!this.pluginStarts) return { contents: oldContents(shown), config: structuredClone(config), ...(warnings.length && { warnings }) };
    return { contents: structuredClone(shown), config: withSentTo(config, shown), ...(warnings.length && { warnings }), starts: 1 };
  }
  /** What a folder plugin's folder holds now, as a preview with its revision. */
  folderPreview(record) {
    const made = DEMO_FOLDER_PLUGINS[record.folder] ?? { contents: { skills: [slug(posix.basename(record.folder)) || "skill"] } };
    const now = contents(made.contents);
    return { ...record.listing, installed: true, ...this.described(now, record.config), revision: revisionOf(now) };
  }
  installedPlugin(id) {
    const record = this.plugins.installed.find((item) => item.id === id);
    if (!record) throw new Error("That plugin isn't installed.");
    return record;
  }
  /** "all", or bot ids that exist. */
  pluginBots(bots) {
    if (bots === undefined || bots === "all") return "all";
    if (!Array.isArray(bots) || !bots.length) throw new Error("Choose which bots use it.");
    for (const id of bots) this.bot(id);
    return [...new Set(bots)];
  }
  /** Settings into a record. A secret is kept nowhere: the demo notes only that it is set, as a vault would hold it apart. */
  applyPluginValues(record, values) {
    for (const [key, value] of Object.entries(values ?? {})) {
      const field = record.config.find((item) => item.key === key);
      if (!field) throw new Error("That plugin has no setting called " + key + ".");
      if (value === null || value === "") delete record.values[key];
      else if (typeof value === "string" || (value && typeof value === "object" && typeof value.$credential === "string")) record.values[key] = field.secret || typeof value !== "string" ? { set: true } : { set: true, value };
      else throw new Error("That value can't be saved.");
    }
  }
  /** A tool server for each of the plugin's tools that signs in with OAuth, so "Sign in on your computer" has one to sign in. */
  pluginServers(record) {
    record.serverIds ??= {};
    for (const server of record.contents.mcpServers) {
      if (!server.oauth || record.serverIds[server.name]) continue;
      const id = "mcp-plugin-" + slug(record.listing.name + "-" + server.name);
      this.state.mcpServers.push({ id, name: server.name, type: "http", enabled: true, url: server.url, auth: { type: "oauth", signedIn: false, signingIn: false, canRenew: false, clientSecret: false } });
      record.serverIds[server.name] = id;
    }
  }
  pluginView(record) {
    const entry = record.folder ? null : this.plugins.catalog.find((item) => item.id === record.id);
    // A copy that is not the reviewed files is not read: its description is the kept one, with no mark.
    const shown = record.changed ? { contents: structuredClone(record.contents), config: structuredClone(record.config) } : this.described(record.contents, record.config);
    const mcpServers = shown.contents.mcpServers.map((server) => (record.serverIds?.[server.name] ? { ...server, serverId: record.serverIds[server.name] } : { ...server }));
    const config = shown.config.map((field) => ({ ...field, set: !!record.values[field.key]?.set, ...(!field.secret && record.values[field.key]?.value !== undefined && { value: record.values[field.key].value }) }));
    const signIn = mcpServers.find((server) => server.serverId && !this.state.mcpServers.find((item) => item.id === server.serverId)?.auth?.signedIn);
    const [status, said] = record.changed
      ? ["error", CHANGED_COPY]
      : record.readError
        ? ["error", record.readError]
        : config.some((field) => field.required && !field.set)
          ? ["needs-config"]
          : signIn
            ? ["needs-sign-in", "Sign in to " + signIn.name + " on your computer."]
            : ["ready"];
    // A plugin the app itself switched off says why, with any status but an error's own sentence.
    const detail = status === "error" ? said : record.heldBack && !record.enabled ? HELD_BACK[record.heldBack] : said;
    const { skills, ...rest } = record.contents;
    const more = Object.values(rest).some((list) => Array.isArray(list) && list.length > 0);
    return {
      ...record.listing,
      installed: true,
      enabled: record.enabled,
      bots: record.bots === "all" ? "all" : [...record.bots],
      contents: { ...shown.contents, mcpServers },
      config,
      ...(shown.warnings && { warnings: shown.warnings }),
      ...(shown.starts && { starts: shown.starts }),
      status,
      ...(detail && { detail }),
      ...(record.changed && this.pluginStarts && { repair: "update" }),
      ...(more && skills && { limits: "Bots on Claude, Codex, OpenCode or ACP get only this plugin's skills." }),
      ...(entry && pluginRevision(entry) !== record.revision && { updateAvailable: true }),
      ...(record.folder && { folder: record.folder }),
      installedAt: record.installedAt,
      ...(this.pluginStarts && { revision: record.revision }),
    };
  }
  /** An install and an update name the revision that was looked at; an app from before the rule took one with none. */
  lookedAt(revision) {
    if (this.pluginStarts && typeof revision !== "string") throw new Error(NO_REVISION);
  }
  /** A switch-on or a choice of bots that names a revision is for that one: another one now is refused. */
  sameRevision(record, options) {
    if (options?.revision !== undefined && options.revision !== record.revision) throw new Error(OTHER_REVISION);
  }
  installPlugin(id, { bots, config, revision } = {}) {
    const entry = this.pluginEntry(id);
    if (this.plugins.installed.some((item) => item.id === id)) throw new Error("That plugin is already installed.");
    this.lookedAt(revision);
    if (revision !== undefined && revision !== pluginRevision(entry)) throw new Error(STALE_INSTALL);
    const record = { id, listing: listingOf(entry), contents: structuredClone(entry.contents), config: structuredClone(entry.config), values: {}, enabled: true, bots: this.pluginBots(bots), installedAt: now(), revision: pluginRevision(entry), ...(entry.readError && { readError: entry.readError }) };
    for (const field of record.config) if (!field.secret && field.default !== undefined) record.values[field.key] = { set: true, value: field.default };
    this.applyPluginValues(record, config);
    this.pluginServers(record);
    this.plugins.installed.push(record);
    // The catalog moves on once after this install, so "Update" has a new version to show.
    if (entry.later) {
      Object.assign(entry, entry.later, { contents: contents(entry.later.contents) });
      delete entry.later;
    }
    return this.pluginView(record);
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  changed() {
    for (const fn of this.listeners) fn();
  }
  async call(method, args, context = {}) {
    this.callContexts.push({ method, principal: context.principal ? structuredClone(context.principal) : null });
    if (this.callContexts.length > 100) this.callContexts.shift();
    const fn = this.handlers[method];
    if (!fn) throw new Error("The demo computer doesn't do " + method + " yet.");
    // The person a call is made for (spaces are a person's): "owner", or a member's id and name.
    this.caller = context.principal?.kind === "member" ? { id: context.principal.memberId, name: context.principal.name || "A member" } : { id: "owner", name: OWNER_NAME };
    const callArgs = method === "send"
      ? [args[0], args[1], { ...args[2], author: this.caller.id === "owner" ? undefined : { memberId: this.caller.id, name: this.caller.name } }]
      : args;
    const result = await fn.apply(this, callArgs);
    const principal = context.principal;
    if (principal?.kind === "member") {
      if (method === "createChat" || method === "createGroupChat" || method === "forkChat" || method === "spaces.newPanel" || method === "spaces.ask") {
        const chat = this.state.chats.find((item) => item.id === (result?.chatId ?? result));
        if (chat) chat.createdBy = principal.memberId;
      }

    }
    this.changed();
    return result;
  }
  // ── Spaces ("spaces-v1") ──
  newSpace(name, more = {}) {
    const at = now();
    const space = { id: "s_" + randomUUID().replace(/-/g, "").slice(0, 10), name, createdAt: at, updatedAt: at, rev: 1, ...more };
    this.spaceRecords.push(space);
    return space;
  }
  /** A person's built-in space of one kind. */
  builtin(person, kind) {
    return this.spaceRecords.find((space) => space.builtin === kind && (space.createdBy || "owner") === person);
  }
  /** The four built-in spaces every person has. Safe to repeat. */
  ensureSpaces(person) {
    let made = false;
    for (const [kind, name] of BUILTIN_SPACES) {
      if (this.builtin(person, kind)) continue;
      this.newSpace(name, { builtin: kind, ...(person !== "owner" && { createdBy: person }) });
      made = true;
    }
    if (made) this.changed();
  }
  /** A member was removed: what they made passes to the owner, and the routines they set are paused. */
  /**
   * The copy of a space for a link (docs/spaces.md, `SpaceSnapshot`): its panels that are not hidden and
   * its open cards, with no id of anything, no chat, no note and no person's name but `from`.
   */
  snapshotSpace(id) {
    const space = this.spaceRecords.find((item) => item.id === id);
    if (!space) return null;
    const botOf = (botId) => {
      const bot = this.state.bots.find((item) => item.id === botId);
      return { name: bot?.name ?? "Bot", look: bot?.look ?? { head: "beacon", palette: "original" } };
    };
    const blockOf = (block) => {
      if (block.type !== "html") return block;
      const page = this.pages.get(block.frame);
      return { type: "html", height: block.height, page: page?.html ?? "", ...(page?.data !== undefined && { data: page.data }) };
    };
    return {
      v: 1,
      name: space.name,
      from: OWNER_NAME,
      kind: space.builtin && space.builtin !== "today" ? space.builtin : "panels",
      updatedAt: space.updatedAt,
      panels: this.state.panels
        .filter((panel) => panel.spaceId === id && !panel.hidden)
        .map((panel) => ({ title: panel.title, size: panel.size, bot: botOf(panel.botId), updatedAt: panel.updatedAt, blocks: panel.blocks.map(blockOf), ...(panel.state && { state: panel.state }) })),
      cards: this.state.board
        .filter((item) => item.spaceId === id && item.status === "open")
        .map((item) => ({ kind: item.kind, title: item.title, body: item.body ?? "", links: (item.links ?? []).map((link) => link.url), ...(item.category && { category: item.category }), bot: botOf(item.botId), createdAt: item.createdAt })),
    };
  }
  releaseSpaces(person) {
    for (const space of this.spaceRecords) if (space.createdBy === person) delete space.createdBy;
    // The owner already has the four built-in ones; a second set would be named the same.
    const seen = new Set();
    this.spaceRecords = this.spaceRecords.filter((space) => {
      if (!space.builtin || space.createdBy) return true;
      if (seen.has(space.builtin) && !this.state.panels.some((panel) => panel.spaceId === space.id) && !this.state.board.some((item) => item.spaceId === space.id)) return false;
      if (seen.has(space.builtin)) delete space.builtin;
      seen.add(space.builtin);
      return true;
    });
    for (const panel of this.state.panels) {
      if (panel.createdBy === person) delete panel.createdBy;
      if (panel.routine?.setBy === person) Object.assign(panel.routine, { enabled: false, nextAt: null });
    }
    this.changed();
  }
  seedSpaces() {
    this.ensureSpaces("owner");
    const t = now();
    for (const panel of this.state.panels) panel.spaceId = this.builtin("owner", "today").id;
    for (const item of this.state.board) item.spaceId = this.builtin("owner", CARD_SPACE[item.kind]).id;
    if (!this.state.bots.length) return;
    const bot = this.state.bots[0];
    const launch = this.newSpace("Launch", { createdAt: t - 30 * HOUR, updatedAt: t - 2 * MIN, rev: 12 });
    const frame = randomUUID();
    const items = ["Pricing page copy", "Changelog reviewed", "Press kit", "Support macros", "Status page"];
    this.pages.set(frame, { html: CHECKLIST_VIEW, data: { items }, chatId: null });
    this.state.panels.push(
      {
        id: "panel-checklist", spaceId: launch.id, key: "launch-checklist", botId: bot.id, chatId: this.state.chats[0]?.id ?? "", title: "Launch checklist", hidden: false, size: "tall", revision: 4, updatedAt: t - 2 * MIN, routine: null,
        blocks: [{ type: "html", frame, height: 260 }],
        state: { ticked: { "Pricing page copy": true, "Press kit": true } }, stateRev: 3,
        notes: [{ id: "n1", by: "owner", name: OWNER_NAME, text: "Changelog needs one more pass before Thursday.", at: t - 3 * HOUR }],
        last: { by: "owner", name: OWNER_NAME, label: "Ticked Press kit", at: t - 2 * MIN },
      },
      { id: "panel-signups", spaceId: launch.id, key: "signups", botId: this.state.bots[2]?.id ?? bot.id, chatId: this.state.chats[0]?.id ?? "", title: "Signups", hidden: false, size: "small", revision: 9, updatedAt: t - 50 * MIN, routine: { cron: "0 8 * * *", timezone: "America/Chicago", prompt: "Refresh the signup count", nextAt: t + 14 * HOUR, enabled: true }, blocks: [{ type: "metric", label: "This week", value: "1,284", note: "+12% on last week" }, { type: "line", label: "Daily", labels: ["Mon", "Tue", "Wed", "Thu", "Fri"], series: [{ name: "Signups", values: [180, 210, 260, 290, 344] }] }], asks: ["Compare with last month", "Split signups by source"] },
    );
    const money = this.newSpace("Money", { createdAt: t - 80 * HOUR, updatedAt: t - 26 * HOUR, rev: 3, ...(this.state.projects[0] && { projectId: this.state.projects[0].id }) });
    this.state.panels.push({ id: "panel-runway", spaceId: money.id, key: "runway", botId: this.state.bots[2]?.id ?? bot.id, chatId: this.state.chats[0]?.id ?? "", title: "Runway", hidden: false, size: "wide", revision: 2, updatedAt: t - 26 * HOUR, routine: null, blocks: [{ type: "bars", label: "Months of runway", items: [{ label: "Now", value: 14 }, { label: "With hire", value: 11 }] }] });
  }
  spaceOf(id) {
    const space = this.spaceRecords.find((item) => item.id === id);
    if (!space) throw new Error("This space no longer exists.");
    return space;
  }
  panelOf(id) {
    const panel = this.state.panels.find((item) => item.id === id);
    if (!panel) throw new Error("This panel no longer exists.");
    return panel;
  }
  /** Something in a space changed: its `rev` goes up, so an app reads it again. */
  touch(spaceId) {
    const space = this.spaceRecords.find((item) => item.id === spaceId);
    if (space) Object.assign(space, { rev: space.rev + 1, updatedAt: now() });
  }
  bot(id) {
    const bot = this.state.bots.find((b) => b.id === id);
    if (!bot) throw new Error("This bot no longer exists.");
    return bot;
  }
  chat(id) {
    const chat = this.state.chats.find((c) => c.id === id);
    if (!chat) throw new Error("This chat no longer exists.");
    return chat;
  }
  server(id) {
    const server = this.state.mcpServers.find((s) => s.id === id);
    if (!server) throw new Error("Unknown MCP server");
    return server;
  }
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms * this.speed));
  }
  ask(request) {
    const id = randomUUID();
    this.state.requests.push({ id, ...request });
    this.changed();
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }
  /**
   * The turns of docs/turn-timeline.md. "long turn": thinking, text, steps and two helpers, and it
   * takes a steer while it runs. "ask midway": a question in the middle, and more work after the
   * answer. "time out" and "interrupt me": some text and steps, then the turn ends without a reply.
   * With "turn-timeline-v1" the text before a step, a steer or a question becomes an interim message,
   * an answer becomes a message, each helper's own steps are marked, and a turn that ends without a
   * reply keeps what it wrote. As an older computer (BOTKINS_DEV_TIMELINE=off) it does what the
   * desktop app does today: one growing text, the reply is only the last part of it and has no time,
   * and a turn that ends without a reply drops its text.
   */
  async timelineTurn(chat, run, prompt) {
    const id = chat.id;
    const timeline = this.timeline;
    const turn = { stopped: false, steers: [] };
    this.turns.set(id, turn);
    const live = () => !turn.stopped;
    const kind = /long turn/i.test(prompt) ? "long" : /ask midway/i.test(prompt) ? "ask" : /interrupt me/i.test(prompt) ? "interrupt" : "timeout";
    this.state.steerable ??= {};
    this.state.steerable[id] = kind === "long";
    this.state.streams[id] = "";
    this.state.thinking[id] = "";
    this.state.intents[id] = "Thinking it through";
    run.steps = [];
    this.changed();
    // The text since the last interim message, and when its first words came.
    let said = "";
    let began = 0;
    const commit = () => {
      if (!said.trim()) return;
      if (timeline) {
        chat.messages.push({ role: "assistant", text: said.trim(), runId: run.id, time: began, interim: true });
        this.state.streams[id] = "";
      }
      said = "";
      this.changed();
    };
    const say = async (words) => {
      const pieces = words.split(/(?<=\s)/);
      for (let i = 0; i < pieces.length && live(); i += 2) {
        if (!said) {
          began = now();
          // An older computer keeps one text: a new part starts a new paragraph, as the desktop app does.
          if (this.state.streams[id]) this.state.streams[id] += "\n\n";
        }
        const piece = pieces.slice(i, i + 2).join("");
        said += piece;
        this.state.streams[id] += piece;
        this.changed();
        await this.sleep(60);
      }
    };
    const think = async (words) => {
      const thought = { id: randomUUID(), text: "", started: now() };
      (run.reasoning ??= []).push(thought);
      for (const piece of words.split(/(?<=\s)/)) {
        if (!live()) break;
        thought.text += piece;
        this.state.thinking[id] = run.reasoning.map((entry) => entry.text).join("\n\n");
        this.changed();
        await this.sleep(35);
      }
      thought.finished = now();
    };
    const step = async (name, label, input, ms, output, agentId) => {
      // The turn's own step ends the text before it; a helper's step doesn't.
      if (!agentId) commit();
      const entry = { id: randomUUID(), name, label, status: "Running", started: now(), input: JSON.stringify(input, null, 2), ...(agentId && timeline && { agentId }) };
      run.steps.push(entry);
      if (!agentId) this.state.intents[id] = label;
      this.changed();
      await this.sleep(ms);
      if (!live()) return entry;
      Object.assign(entry, { status: "Done", finished: now(), ...(output && { output }) });
      this.changed();
      return entry;
    };
    // A helper: the step that starts it has its id, and its own steps run beside the turn's.
    const helper = (name, description, asked, intent, work, result) => {
      commit();
      const helperId = "task-" + randomUUID().slice(0, 8);
      const task = { id: helperId, name: "task", label: description, status: "Running", started: now(), input: JSON.stringify({ description, prompt: asked }, null, 2) };
      run.steps.push(task);
      const agent = { id: helperId, name, description, status: "Running", started: now(), ...(timeline && { prompt: asked, intent }) };
      (run.agents ??= []).push(agent);
      this.changed();
      return (async () => {
        for (const [tool, label, input, ms, output] of work) {
          if (!live()) break;
          await step(tool, label, input, ms, output, helperId);
        }
        const finished = now();
        if (!live()) Object.assign(agent, { status: "Failed", detail: "Stopped with the reply", finished });
        else {
          Object.assign(agent, { status: "Done", finished, ...(timeline && { result }) });
          delete agent.intent;
          Object.assign(task, { status: "Done", finished, output: result });
        }
        this.changed();
      })();
    };
    // What the person sent while the turn ran, said back in the next words.
    const steered = async () => {
      while (turn.steers.length && live()) await say("Noted: " + turn.steers.shift().replace(/[.!?\s]+$/, "") + ". ");
    };

    let reply = "";
    let ended = null;
    if (kind === "long") {
      // A steer is delivered at once, as the desktop app delivers it to a provider that takes one.
      turn.steer = (words) => {
        if (!live()) return false;
        commit();
        chat.messages.push({ role: "user", text: words, steeredRunId: run.id, time: now() });
        turn.steers.push(words);
        this.changed();
        return true;
      };
      await think("A long job: read the code, run the tests, write it up. Two helpers can look in parallel. ");
      await say("I'll start by looking at how the project is laid out. ");
      await step("view", "Reading README.md", { path: "README.md" }, 900, "# Botkins\nThe phone app for the Botkins app on your computer.");
      await step("grep", "Searching for open sockets", { query: "new WebSocket" }, 900, "4 matches in 3 files");
      await say("Two places need a closer look, so I'm asking two helpers to dig in while I run the tests. ");
      const helpers = [
        helper("Explore", "Find tests that open sockets", "Find every test in tests/ that opens a socket, and say which ones close it again.", "Reading the tests", [["grep", "Searching tests/ for listen(", { query: "listen(" }, 1200, "6 matches"], ["view", "Reading tests/link.test.ts", { path: "tests/link.test.ts" }, 1500, "…"], ["view", "Reading tests/relay.test.ts", { path: "tests/relay.test.ts" }, 1500, "…"]], "Six tests open a socket. All of them close it in a finally block, except relay.test.ts at line 88."),
        helper("Review", "Check the relay's limits", "Read relay/README.md and check that the limits there match the code.", "Comparing the limits", [["view", "Reading relay/README.md", { path: "relay/README.md" }, 1800, "…"], ["grep", "Searching relay/src for MAX_", { query: "MAX_" }, 1400, "5 matches"]], "The limits match, except the frame size: the README says 1 MiB and the code allows 2 MiB."),
      ];
      await think("While they work I can run the tests. ");
      await step("bash", "npm test", { command: "npm test" }, 2600, "360 passing");
      await steered();
      await step("bash", "npx tsc --noEmit", { command: "npx tsc --noEmit" }, 1600, "");
      await steered();
      await say("The tests pass. Waiting for the helpers to finish. ");
      await Promise.all(helpers);
      await steered();
      await step("edit", "Editing relay/README.md", { path: "relay/README.md" }, 1100, "1 line changed");
      await steered();
      reply = "All done. The tests pass, the typecheck is clean, and I fixed the frame size in relay/README.md. One test (relay.test.ts, line 88) leaves a socket open; tell me if you'd like me to close it.";
    } else if (kind === "ask") {
      await think("I need to know where this goes before I deploy it. ");
      await say("I'll get the build ready first. ");
      await step("bash", "npm run build", { command: "npm run build" }, 1400, "Built in 12s");
      await say("The build is ready. Before I deploy it, I need to know where to. ");
      commit();
      const title = "Where should I deploy the build?";
      const asking = this.ask({ chatId: id, botId: chat.botId, kind: "question", title, choices: ["Staging", "Production"], freeform: true });
      const requestId = this.state.requests.at(-1)?.id;
      this.state.intents[id] = "Waiting for you";
      const answer = await asking;
      const value = typeof answer.value === "string" ? answer.value.trim() : "";
      if (answer.action !== "answer" || !value || !live()) reply = "No problem. I'll leave the build where it is.";
      else {
        // What the person answered is an entry of the chat, in its place (never a secret: this question asks for none).
        if (timeline) chat.messages.push({ role: "user", text: value, time: now(), answer: { runId: run.id, requestId, kind: "question", title } });
        this.changed();
        await step("bash", "Deploying to " + value, { command: "npm run deploy -- --env " + value.toLowerCase() }, 1600, "Deployed");
        await step("web_fetch", "Checking the site", { url: "https://example.com/" }, 900, "200 OK");
        reply = "Deployed to **" + value + "**, and the site answers.";
      }
    } else {
      await think("Three config files to compare. ");
      await say("I'm comparing the three config files now. ");
      await step("view", "Reading config/base.json", { path: "config/base.json" }, 800, "{ … }");
      await step("view", "Reading config/production.json", { path: "config/production.json" }, 800, "{ … }");
      await say("The base and production files differ in two places: the log level and the cache size. Next I'll check the staging file and");
      // Nothing more comes: the computer gives up on the turn after a while.
      await this.sleep(3000);
      ended =
        kind === "interrupt"
          ? { status: "Interrupted", detail: "Botkins closed during this reply.", ending: "interrupted" }
          : { status: "Needs you", detail: "Copilot session stalled without an event for 600 seconds.", ending: "timed-out" };
    }

    if (!ended && live()) await say(reply);
    if (!ended && turn.stopped) ended = { status: "Stopped", detail: "", ending: "stopped" };
    const finished = now();
    if (ended) {
      // With the capability, what the bot wrote before the turn ended stays in the chat.
      commit();
      for (const entry of run.steps) if (entry.status === "Running") entry.status = "Interrupted";
      for (const agent of run.agents ?? []) if (agent.status === "Running") Object.assign(agent, { status: "Failed", detail: "Stopped with the reply", finished });
      Object.assign(run, { status: ended.status, detail: ended.detail, finished, ...(timeline && { ending: ended.ending }) });
    } else {
      Object.assign(run, { status: "Completed", finished, usage: { input: 5200, output: 640 } });
      // The reply is what came after the last interim message. An older computer sends it without a time.
      chat.messages.push({ role: "assistant", text: said.trim() || reply, runId: run.id, ...(timeline && { time: began }) });
    }
    for (const key of ["streams", "thinking", "intents", "steerable"]) delete this.state[key][id];
    this.turns.delete(id);
    chat.time = finished;
    chat.unread = true;
    this.changed();
    const next = this.state.queued[id]?.shift();
    if (next) {
      if (!this.state.queued[id].length) delete this.state.queued[id];
      this.handlers.send.call(this, id, next.text, { voiceId: next.voiceId, author: next.author });
    }
  }
  /** A scripted turn: thinking, a tool step, an approval or question when asked for, then the reply. */
  async turn(chat, run, prompt) {
    if (TIMELINE_TURN.test(prompt)) return this.timelineTurn(chat, run, prompt);
    const id = chat.id;
    const turn = { stopped: false };
    this.turns.set(id, turn);
    const live = () => !turn.stopped;
    this.state.streams[id] = "";
    this.state.thinking[id] = "";
    this.state.intents[id] = "Thinking it through";
    this.changed();
    for (const piece of ["The person wants a plan. ", "I should check the wiki first, ", "then keep the answer short."]) {
      await this.sleep(260);
      if (!live()) break;
      this.state.thinking[id] += piece;
      this.changed();
    }
    if (live()) {
      const step = { id: randomUUID(), name: "wiki_search", label: "Searching the wiki", status: "Running", started: now(), input: JSON.stringify({ query: prompt.slice(0, 40) }) };
      run.steps = [step];
      this.state.intents[id] = "Searching the wiki";
      this.changed();
      await this.sleep(700);
      Object.assign(step, { status: "Done", finished: now(), label: "Searched the wiki", output: "2 pages matched" });
      this.changed();
    }
    let reply = REPLY;
    // A bot that uses the person's phone: the tool runs there (device.mjs) when the phone allows it.
    const wanted = PHONE_ASKS.find((ask) => ask.when.test(prompt));
    if (live() && wanted && this.phone) {
      const step = { id: randomUUID(), name: wanted.tool, label: wanted.label, status: "Running", started: now(), input: JSON.stringify(wanted.args()) };
      run.steps = [...(run.steps ?? []), step];
      this.state.intents[id] = wanted.label;
      this.changed();
      try {
        const result = await this.phone.call(wanted.tool, wanted.args(), { botId: chat.botId, chatId: id });
        Object.assign(step, { status: "Done", finished: now(), output: JSON.stringify(result).slice(0, 4000) });
        reply = "Here is what your phone says:\n\n```json\n" + JSON.stringify(result, null, 2).slice(0, 1200) + "\n```";
      } catch (error) {
        Object.assign(step, { status: "Failed", finished: now(), output: error.message });
        reply = "I couldn't use your phone for that. " + error.message;
      }
      this.changed();
    } else if (live() && /show me the screen/i.test(prompt)) {
      // The bot shows the computer's screen: a side pane tab of kind "screen", and an ask to show it.
      // The chat draws a card for each such tab at the time it was made.
      const chatNow = this.chat(id);
      const before = chatNow.pane ?? { panels: [], active: null };
      const at = now();
      const screen = { id: randomUUID(), kind: "screen", title: "Screen", botId: chat.botId, createdAt: at, updatedAt: at };
      chatNow.pane = { panels: [...before.panels, screen].slice(-8), active: screen.id, ask: { seq: (before.ask?.seq ?? 0) + 1, panelId: screen.id, runId: run.id, botId: chat.botId, at } };
      reply = "Here is your computer's screen. Tap it to see it larger.";
      this.changed();
    } else if (live() && /side pane/i.test(prompt)) {
      // The bot opens the pane beside this chat (the desktop app's docs/SIDE_PANE.md): a table, a
      // custom view and a website as tabs, and an ask (a rising `seq`) to show the table. "close
      // the side pane" asks for it to close instead.
      const chatNow = this.chat(id);
      const before = chatNow.pane ?? { panels: [], active: null };
      const seq = (before.ask?.seq ?? 0) + 1;
      if (/close/i.test(prompt)) {
        chatNow.pane = { ...before, ask: { seq, close: true, runId: run.id, botId: chat.botId, at: now() } };
        reply = "I asked for the side pane to close.";
      } else if (before.closed?.runId === run.id) {
        reply = "You closed the side pane, so I left it closed. The panel is there as a tab.";
      } else {
        const frame = randomUUID();
        this.pages.set(frame, { html: DEMO_VIEW, data: DEMO_VIEW_DATA, chatId: id });
        const at = now();
        const made = (kind, title, more) => ({ id: randomUUID(), kind, title, botId: chat.botId, createdAt: at, updatedAt: at, ...more });
        const table = made("table", "Seed order", { columns: ["Plant", "Bed", "Seeds"], rows: [["Beans", "North", "40"], ["Chard", "East", "25"], ["Marigold", "Border", "60"]] });
        const panels = [table, made("rich_ui", "Open issues", { frame }), made("web", "Example site", { url: "https://example.com/" }), made("screen", "Screen", {})];
        chatNow.pane = { panels: [...before.panels.filter((panel) => panel.pinned), ...panels].slice(-8), active: table.id, ask: { seq, panelId: table.id, runId: run.id, botId: chat.botId, at } };
        reply = "I opened the side pane with a table, a chart, a website and the screen.";
      }
      this.changed();
    } else if (live() && /mockups?|pictures/i.test(prompt)) {
      // Several pictures, each under a line of its own, as a bot sends mockups: each is drawn in the
      // reply where its MEDIA: line is. The last one names a file the computer does not know.
      const pictures = this.artifacts.filter((entry) => entry.item.botId === chat.botId && !entry.parent && entry.item.kind === "image").map((entry) => entry.item).slice(0, 3);
      reply = ["Here are the mockups, one image each:", "", ...pictures.flatMap((item, at) => ["**" + (at + 1) + ". " + item.name.replace(/\.\w+$/, "") + ".** As it looks today.", "MEDIA:" + item.path, ""]), "**" + (pictures.length + 1) + ". One I can't show**", "MEDIA:/Users/demo/secret/draft.png"].join("\n");
      this.changed();
    } else if (live() && /artifact|what did you make|show.*files/i.test(prompt)) {
      // Paths and a MEDIA: attachment in the reply, for the links a chat makes of them. One path is not in the index.
      const mine = this.artifacts.filter((entry) => entry.item.botId === chat.botId && !entry.parent).map((entry) => entry.item);
      const picture = mine.find((item) => item.kind === "image");
      reply = ["Here is what I made.", "", "- The notes: /Users/demo/Code/website/README.md", "- The plan: \"/Users/demo/Documents/Plans/launch plan.pdf\"", "- The build folder: /Users/demo/Code/website/out/", "- The prices: ~/Documents/Notes/prices.csv", "- Not something I can show: /Users/demo/secret/keys.txt", "", ...(picture ? ["MEDIA:" + picture.path, ""] : []), "```", "/Users/demo/Code/website/src/grant.mjs", "cat /Users/demo/Code/website/README.md", "```"].join("\n");
      this.state.artifacts.revision++;
      this.changed();
    } else if (live() && /long answer/i.test(prompt)) {
      reply = LONG_ANSWER;
    } else if (live() && /sandbox/i.test(prompt)) {
      const frame = randomUUID();
      this.pages.set(frame, { html: SANDBOX_VIEW, data: null, chatId: id });
      run.cards = [...(run.cards ?? []), { id: randomUUID(), title: "Sandbox check", blocks: [{ type: "html", frame, height: 200 }], replies: [] }];
      reply = "Each line says whether one way out of the view was blocked.";
      this.changed();
    } else if (live() && /chart|graph|rich/i.test(prompt)) {
      // A card with a custom view: the page stays here, and only the frame's id is in the state.
      const frame = randomUUID();
      this.pages.set(frame, { html: DEMO_VIEW, data: DEMO_VIEW_DATA, chatId: id });
      run.cards = [...(run.cards ?? []), { id: randomUUID(), title: "Open issues by repo", blocks: [{ type: "html", frame, height: 240 }, { type: "markdown", text: "Made-up numbers from the demo computer." }], replies: [] }];
      reply = "That's a bar chart of open issues by repo. Tap a bar to see when that repo was last pushed.";
      this.changed();
    } else if (live() && /approve/i.test(prompt)) {
      const bot = this.bot(chat.botId);
      const answer = await this.ask({ chatId: id, botId: bot.id, kind: "permission", title: "Run a command", label: "npm run deploy", preview: "npm run deploy -- --env production", detail: "Deploys the website to production.", remember: "npm run deploy" });
      reply = answer.action === "deny" || answer.action === "cancel" ? "Okay, I won't run that. Tell me if you'd like another way." : "Done. The deploy finished without errors.";
    } else if (live() && /long question/i.test(prompt)) {
      // Three choices of a full sentence each, and a free answer, for the request card's layout.
      const choices = [
        "Ship the release tonight and watch the error rate closely, rolling back at the first sign of trouble.",
        "Wait until tomorrow morning, when the whole team is online and can step in if something goes wrong.",
        "Ship only the server changes tonight, and hold the app update until the store review comes back.",
      ];
      const answer = await this.ask({ chatId: id, botId: chat.botId, kind: "question", title: "The release is ready, but two tests are flaky. How should we go ahead?", choices, freeform: true });
      reply = answer.action === "answer" && typeof answer.value === "string" ? "Okay. " + answer.value : "No problem. Ask again when you're ready.";
    } else if (live() && /which/i.test(prompt)) {
      const answer = await this.ask({ chatId: id, botId: chat.botId, kind: "question", title: "Which environment should I use?", choices: ["Staging", "Production"], freeform: true });
      reply = answer.action === "answer" ? "Got it: **" + answer.value + "**. I'll use that from here on." : "No problem. Ask again when you're ready.";
    } else if (live() && /secure (password|login)/i.test(prompt)) {
      // A secure input ("secure-input-v1"): "secure password" asks for one value, "secure login" for
      // three. The values go to the computer only. The demo reads which fields came back, names them
      // by their labels, and keeps no value anywhere (tests/secure-input.test.ts proves it).
      const login = /login/i.test(prompt);
      const fields = login
        ? [
            { key: "username", label: "Username", kind: "text" },
            { key: "password", label: "Password", kind: "password" },
            { key: "code", label: "One-time code", kind: "code", hint: "From your authenticator app", optional: true },
          ]
        : [{ key: "password", label: "Password", kind: "password" }];
      const answer = await this.ask({ chatId: id, botId: chat.botId, kind: "secure", title: login ? "Sign in to the registry" : "The registry's password", detail: "So I can publish the package. I'll use it for this sign-in only.", fields });
      const got = answer.action === "accept" ? fields.filter((field) => answer.content?.[field.key] !== undefined).map((field) => field.label) : [];
      const one = got.length === 1;
      reply = got.length ? "I have " + got.length + (one ? " value: " : " values: ") + got.join(", ") + ". I can use " + (one ? "it" : "them") + " without seeing " + (one ? "it" : "them") + "." : "No problem. I'll leave it for now.";
    } else if (live() && /sign in|password|api key/i.test(prompt)) {
      // A form with a secret in it: the phone masks the key and may send a saved credential instead.
      const answer = await this.ask({
        chatId: id,
        botId: chat.botId,
        kind: "form",
        title: "Sign in to the staging server",
        schema: { properties: { username: { type: "string", title: "Username" }, api_key: { type: "string", title: "API key" } }, required: ["username", "api_key"] },
      });
      const name = typeof answer.content?.username === "string" ? answer.content.username : "";
      reply = answer.action === "accept" && answer.content ? "Thanks. I'm signed in" + (name ? " as **" + name + "**" : "") + ". The key stays on your computer." : "No problem. I'll leave it for now.";
    }
    this.state.intents[id] = "Writing the reply";
    const words = reply.split(/(?<=\s)/);
    for (let i = 0; i < words.length && live(); i += 2) {
      this.state.streams[id] += words.slice(i, i + 2).join("");
      this.changed();
      await this.sleep(55);
    }
    const said = this.state.streams[id];
    for (const key of ["streams", "thinking", "intents"]) delete this.state[key][id];
    this.turns.delete(id);
    const finished = now();
    if (turn.stopped) Object.assign(run, { status: "Stopped", finished });
    else Object.assign(run, { status: "Completed", finished, summary: "Worked for " + Math.max(1, Math.round((finished - run.time) / 1000)) + "s · " + (run.steps?.length ?? 0) + " step", usage: { input: 1800, output: 240 } });
    if (said) chat.messages.push({ role: "assistant", text: said, runId: run.id, time: finished });
    chat.time = finished;
    chat.unread = true;
    this.changed();
    const next = this.state.queued[id]?.shift();
    if (next) {
      if (!this.state.queued[id].length) delete this.state.queued[id];
      this.handlers.send.call(this, id, next.text, { voiceId: next.voiceId, author: next.author });
    }
  }
  handlers = {
    appInfo: () => ({ version: this.updates?.current ?? "0.8.0-demo", electron: "42", chrome: "148", platform: process.platform }),
    setPreferences(patch) {
      const { appearance, ...rest } = patch ?? {};
      if ("harness" in rest && !["copilot", "provider", "pi"].includes(rest.harness)) throw new Error("Choose a harness");
      if (typeof rest.clarificationInstructions === "string" && rest.clarificationInstructions.length > 4000) throw new Error("Keep the instructions under 4,000 characters.");
      if (appearance?.bubble !== undefined && !(appearance.bubble === "theme" || /^#[0-9a-f]{6}$/i.test(appearance.bubble))) throw new Error("Invalid appearance choice");
      const settings = this.state.settings;
      // The side menu and Background take part of their setting, as the desktop's do (its desktop/preferences.mjs).
      if (rest.sidebar) {
        const places = ["Home", "Today", "Chats", "Work", "Wiki"];
        const named = [...new Set((rest.sidebar.order ?? settings.sidebar.order).filter((place) => places.includes(place)))];
        rest.sidebar = { order: [...named, ...places.filter((place) => !named.includes(place))], collapsed: rest.sidebar.collapsed ?? settings.sidebar.collapsed };
      }
      if (rest.background) {
        const next = { ...settings.background, ...rest.background };
        // BOTKINS_DEV_STARTUP=refuse: the system won't change what starts with the computer, so the choice goes back.
        if (process.env.BOTKINS_DEV_STARTUP === "refuse" && next.runAtStartup !== settings.background.runAtStartup) throw new Error("This computer wouldn't change what starts with it.");
        rest.background = next;
      }
      Object.assign(settings, rest);
      if (appearance) Object.assign(settings.appearance, appearance, appearance.colorTheme !== undefined && { themePicked: true }, appearance.font !== undefined && { fontPicked: true });
    },
    // Bots
    addBot(data) {
      const bot = { id: "bot-" + randomUUID().slice(0, 8), name: text(data.name, 48, "name"), role: String(data.role ?? "").slice(0, 90), instructions: String(data.instructions ?? ""), face: data.face ?? "idle", ...(data.summary && { summary: data.summary }), avatar: data.avatar ?? { body: "bighelp.biggie" } };
      this.state.bots.push(bot);
      return bot.id;
    },
    updateBot(id, patch) {
      const bot = this.bot(id);
      // A bot's own voice ("bot-voice-v1"): checked as the desktop app checks it, and null clears it.
      const { voice, ...rest } = patch;
      if (voice !== undefined && !this.botVoice) throw new Error("This computer doesn't keep a voice for each bot.");
      Object.assign(bot, rest);
      if (voice !== undefined) {
        const next = botVoiceField(voice);
        if (next) bot.voice = next;
        else delete bot.voice;
      }
    },
    setBotFlags(id, flags) {
      Object.assign(this.bot(id), flags);
    },
    makePrimary(id) {
      const bot = this.bot(id);
      this.state.bots = [bot, ...this.state.bots.filter((b) => b !== bot)];
    },
    // As the desktop app (desktop/agents.mjs): every bot once, hidden ones too; the first is the primary and is shown.
    reorderBots(ids) {
      const bots = this.state.bots;
      if (!Array.isArray(ids) || ids.length !== bots.length || new Set(ids).size !== ids.length) throw new Error("List every bot once to reorder.");
      this.state.bots = ids.map((id) => this.bot(id));
      if (this.state.bots[0]) this.state.bots[0].hidden = false;
    },
    deleteBot(id) {
      this.bot(id);
      this.state.bots = this.state.bots.filter((b) => b.id !== id);
      this.state.chats = this.state.chats.filter((c) => c.botId !== id);
    },
    duplicateBot(id) {
      const { id: _id, pinned: _pinned, ...copy } = this.bot(id);
      const bot = { ...structuredClone(copy), id: "bot-" + randomUUID().slice(0, 8), name: copy.name + " copy" };
      this.state.bots.push(bot);
      return bot.id;
    },
    // Made-up agents in the person's GitHub Copilot setup. A bot made from one is marked `added`.
    importableAgents() {
      const agents = [
        { key: "copilot:backend-development", provider: "copilot", providerName: "GitHub Copilot", agent: "backend-development", name: "Backend", role: "Backend developer", summary: "APIs, data and services.", instructions: "Design and build backend services. Keep APIs small and document every change.", modelName: "Claude Sonnet 5.5", ownTools: true },
        { key: "copilot:release-notes", provider: "copilot", providerName: "GitHub Copilot", agent: "release-notes", name: "Release notes", role: "Release writer", summary: "", instructions: "Write release notes from merged pull requests, grouped by area.", missingModel: "gpt-4.1" },
        { key: "copilot:broken", provider: "copilot", providerName: "GitHub Copilot", agent: "broken", name: "Broken agent", role: "", summary: "", instructions: "", problem: "Its file has no instructions." },
      ];
      return agents.map((agent) => ({ ...agent, added: this.state.bots.some((bot) => bot.origin?.agent === agent.agent) }));
    },
    importAgents(keys) {
      const agents = this.handlers.importableAgents.call(this);
      return (Array.isArray(keys) ? keys : []).map((key) => {
        const agent = agents.find((a) => a.key === key);
        if (!agent) throw new Error("That agent is gone.");
        if (agent.problem) throw new Error(agent.problem);
        const bot = { id: "bot-" + randomUUID().slice(0, 8), name: agent.name, role: agent.role, instructions: agent.instructions, face: "idle", ...(agent.summary && { summary: agent.summary }), origin: { provider: agent.provider, agent: agent.agent } };
        this.state.bots.push(bot);
        return bot.id;
      });
    },
    setBotAccess(id, grant) {
      this.bot(id).access = grant;
    },
    setBotIntegrations(id, { skillsOff, mcpOff }) {
      const bot = this.bot(id);
      if (skillsOff) bot.skillsOff = skillsOff;
      if (mcpOff) bot.mcpOff = mcpOff;
    },
    botMemory(id) {
      return this.memory.get(id) ?? (id === "bot-mira" ? "- Prefers short lists\n- Launch is on the 24th\n- Weekly review happens on Fridays" : "");
    },
    setBotMemory(id, value) {
      this.memory.set(id, String(value ?? ""));
    },
    addSection(name) {
      const section = { id: "sec-" + randomUUID().slice(0, 6), name: text(name, 40, "name") };
      this.state.sections.push(section);
      return section.id;
    },
    renameSection(id, name) {
      Object.assign(this.state.sections.find((s) => s.id === id) ?? {}, { name });
    },
    deleteSection(id) {
      this.state.sections = this.state.sections.filter((s) => s.id !== id);
    },
    saveTemplate(botId, name) {
      const bot = this.bot(botId);
      const template = { id: randomUUID(), name: name || bot.name, role: bot.role, summary: bot.summary ?? "", instructions: bot.instructions, avatar: bot.avatar, source: "saved", createdAt: now() };
      this.state.templates.push(template);
      return template.id;
    },
    renameTemplate(id, name) {
      Object.assign(this.state.templates.find((t) => t.id === id) ?? {}, { name });
    },
    deleteTemplate(id) {
      this.state.templates = this.state.templates.filter((t) => t.id !== id);
    },
    // A template, or a bot as one, as the text of its file ("Export template…" without a save dialog).
    exportTemplateText(target) {
      const source = target?.templateId ? this.state.templates.find((t) => t.id === target.templateId) : this.bot(target?.botId);
      if (!source) throw new Error("This template no longer exists.");
      const { name, role, summary = "", instructions = "", avatar } = source;
      return { name: fileName(name, "Bot template") + ".json", text: JSON.stringify({ botkinsTemplate: 1, name, role, summary, instructions, avatar }, null, 2) + "\n" };
    },
    // A template from the text of a file someone shared ("Import…" without an open dialog).
    importTemplateText(file) {
      let data;
      try {
        data = JSON.parse(file?.text);
      } catch {
        data = null;
      }
      if (!data || typeof data !== "object" || typeof data.name !== "string" || !data.name.trim()) throw new Error("That file isn't a bot template.");
      const template = { id: randomUUID(), name: data.name.trim().slice(0, 48), role: String(data.role ?? ""), summary: String(data.summary ?? ""), instructions: String(data.instructions ?? ""), avatar: data.avatar, source: "imported", createdAt: now() };
      this.state.templates.push(template);
      return template.id;
    },
    // Chats
    createChat(botId) {
      this.bot(botId);
      const chat = { id: "chat-" + randomUUID().slice(0, 8), botId, title: "New chat", time: now(), messages: [] };
      this.state.chats.unshift(chat);
      return chat.id;
    },
    createGroupChat(botIds, title) {
      if (!Array.isArray(botIds) || botIds.length < 2 || botIds.length > 6) throw new Error("Choose two to six bots.");
      const chat = { id: "chat-" + randomUUID().slice(0, 8), botId: botIds[0], botIds, title: title || "Group chat", time: now(), messages: [] };
      this.state.chats.unshift(chat);
      return chat.id;
    },
    setChatFlags(id, flags) {
      Object.assign(this.chat(id), flags);
    },
    renameChat(id, title) {
      this.chat(id).title = text(title, 120, "title");
    },
    deleteChat(id) {
      this.chat(id);
      this.state.chats = this.state.chats.filter((c) => c.id !== id);
    },
    warmChat() {},
    recordVoiceLine(chatId, id, text, final) {
      const author = this.caller?.id && this.caller.id !== "owner" ? { memberId: this.caller.id, name: this.caller.name } : undefined;
      recordVoiceLine(this.chat(chatId), id, text, final, author);
    },
    // A new chat with the messages up to and including `messageIndex`.
    forkChat(chatId, messageIndex) {
      const from = this.chat(chatId);
      if (from.botIds) throw new Error("A group chat can't be forked.");
      const index = Number(messageIndex);
      if (!Number.isInteger(index) || index < 0 || index >= from.messages.length) throw new Error("That message is gone.");
      const chat = { ...structuredClone({ ...from, messages: from.messages.slice(0, index + 1) }), id: "chat-" + randomUUID().slice(0, 8), title: from.title + " (fork)", time: now(), pinned: false, unread: false, forkedFrom: { chatId, messageIndex: index } };
      delete chat.schedules;
      delete chat.context;
      this.state.chats.unshift(chat);
      return chat.id;
    },
    // Only before the first message. A project without a folder keeps the default mode.
    setChatProject(chatId, projectId, mode) {
      const chat = this.chat(chatId);
      // As the app on the computer: a chat that has started may move between projects unless that
      // would change the folder it works in.
      if (this.turns.has(chatId)) throw new Error("Wait for the reply to finish before changing the project.");
      const started = chat.messages.length > 0;
      const before = this.state.projects.find((p) => p.id === chat.projectId)?.folder ?? null;
      if (projectId == null) {
        if (chat.projectId && started && before) throw new Error("This conversation already started in its project. Start a new chat instead.");
        delete chat.projectId;
        chat.mode = "default";
        return;
      }
      const project = this.state.projects.find((p) => p.id === projectId);
      if (!project) throw new Error("This project no longer exists.");
      const after = project.folder ?? null;
      if (started && projectId !== chat.projectId && (before || after) && before !== after) throw new Error("This conversation already started in another folder. Start a new chat for this project.");
      if (chat.botIds && project.folder) throw new Error("Group chats are text only, so they can't use a project with a folder.");
      if (mode && !["default", "plan", "yolo"].includes(mode)) throw new Error("Choose Default, Plan or YOLO.");
      chat.projectId = projectId;
      chat.mode = project.folder ? (mode ?? "default") : "default";
    },
    // The quote, mentions and attachments are accepted and ignored. `delivery: "steer"` hands the
    // message to a turn that takes one ("long turn"); any other turn keeps it for after.
    send(id, value, options) {
      const chat = this.chat(id);
      const prompt = text(value, 32000, "message");
      if (this.turns.has(id)) {
        if (options?.delivery === "steer" && this.turns.get(id).steer?.(prompt)) return;
        (this.state.queued[id] ??= []).push({ id: randomUUID(), text: prompt, ...(options?.author && { author: options.author }), ...(options?.voiceId && { voiceId: options.voiceId }) });
        return;
      }
      // A routine's run says so, as the real app's does (`scheduled` is set by runRoutine).
      const scheduled = this.scheduled;
      this.scheduled = null;
      const run = { id: "run-" + randomUUID().slice(0, 8), chatId: id, title: scheduled?.name ?? prompt.slice(0, 80), time: now(), status: "Working", detail: "", ...(options?.notify === false && { notify: false }), ...(scheduled?.deliver?.to === "none" && { noOutput: true }), ...(scheduled && { trigger: "scheduled", scheduleId: scheduled.id }) };
      this.state.runs.unshift(run);
      addUserMessage(chat, { role: "user", text: prompt, runId: run.id, time: now(), ...(options?.author && { author: options.author }) }, options?.voiceId);
      if (chat.title === "New chat") chat.title = prompt.slice(0, 40);
      chat.time = now();
      // Today › New panel sends "/today-panel <what it should show>"; the demo bot makes one at once.
      const asked = /^\/today-panel\s+([\s\S]+)/.exec(prompt);
      if (asked) {
        const what = asked[1].trim();
        const spaceId = this.spacesOn ? (chat.spaceId ?? this.builtin(chat.createdBy || "owner", "today")?.id) : undefined;
        if (spaceId) this.touch(spaceId);
        this.state.panels.push({ ...(spaceId && { spaceId }), ...(chat.createdBy && { createdBy: chat.createdBy }), id: "panel-" + randomUUID().slice(0, 8), key: randomUUID().slice(0, 8), botId: chat.botId, chatId: id, title: clip(what.split("\n")[0], 40), hidden: false, size: "small", revision: 1, updatedAt: now(), routine: null, blocks: [{ type: "markdown", text: "A made-up panel for: " + what }], asks: ["Add last week's numbers", "Make it a chart"] });
      }
      this.turn(chat, run, prompt).catch((error) => console.error(error));
    },
    stop(id) {
      const turn = this.turns.get(id);
      if (turn) turn.stopped = true;
      for (const request of this.state.requests.filter((r) => r.chatId === id)) this.handlers.respond.call(this, request.id, { action: "cancel" });
    },
    unqueue(chatId, itemId) {
      this.state.queued[chatId] = (this.state.queued[chatId] ?? []).filter((item) => item.id !== itemId);
      if (!this.state.queued[chatId].length) delete this.state.queued[chatId];
    },
    sendNow(chatId, itemId) {
      // "Steer now" on a turn that takes a steer; otherwise the demo stops the turn so the message goes next.
      const item = this.state.queued[chatId]?.find((queued) => queued.id === itemId);
      if (item && this.turns.get(chatId)?.steer?.(item.text)) return this.handlers.unqueue.call(this, chatId, itemId);
      this.handlers.stop.call(this, chatId);
    },
    retry() {},
    compact() {},
    sideQuestion: async (_id, question) => "Short answer to “" + question + "”: yes, that fits the plan.",
    respond(requestId, answer) {
      this.state.requests = this.state.requests.filter((r) => r.id !== requestId);
      this.waiting.get(requestId)?.(answer);
      this.waiting.delete(requestId);
    },
    clearApprovals() {},
    mentionables(chatId) {
      const chat = this.state.chats.find((c) => c.id === chatId);
      const t = now();
      return {
        projects: this.state.projects.map((p) => ({ id: p.id, name: p.name, hint: p.description ?? "Project", ...(chat?.projectId === p.id && { current: true }) })),
        wiki: this.wiki.mentionable().slice(0, 8),
        files: [
          { path: REPO + "/README.md", name: "README.md", folder: "", where: "Project folder", modified: t - 2 * HOUR, size: 2150 },
          { path: REPO + "/package.json", name: "package.json", folder: "", where: "Project folder", modified: t - 5 * HOUR, size: 1810 },
          { path: REPO + "/link-host/server.mjs", name: "server.mjs", folder: "link-host", where: "Project folder", modified: t - 26 * HOUR, size: 24000 },
        ],
        bots: this.state.bots.slice(0, 3).map((b) => ({ id: b.id, name: b.name, hint: b.role })),
      };
    },
    catalog: () => ({
      choices: [
        { name: "weekly-review", kind: "Skill", command: "/weekly-review", source: "Botkins", description: "Run a weekly review: wins, misses and next steps." },
        { name: "meeting-notes", kind: "Skill", command: "/meeting-notes", source: "Botkins", description: "Turn a transcript into decisions and action items." },
        { name: "compact", kind: "Command", command: "/compact", source: "Botkins", description: "Summarize this chat so far to free up room." },
        { name: "btw", kind: "Command", aliases: ["ask"], command: "/btw", hint: "<question>", duringTurn: true, source: "Botkins", description: "Ask a side question about this chat without adding it to the conversation." },
        { name: "model", kind: "Command", command: "/model", source: "Botkins", description: "Choose the model for this chat.", hint: "[name]", options: [{ name: "auto", description: "Let the app choose" }, { name: "gpt-5.5", description: "GPT-5.5" }] },
      ],
      servers: [{ name: "linear", status: "connected" }, { name: "filesystem", status: "connected" }],
      plugins: [],
    }),
    linkPreview: () => null,
    // Wiki. Every change bumps state.wiki.revision.
    wikiTree() {
      return this.wiki.tree();
    },
    // What an export would hold: every page, or one page with the pages around it.
    wikiExportPlan(request) {
      const pages = this.wiki.scan();
      const view = (page, why) => ({ path: page.path, title: page.title, section: page.path.includes("/") ? humanize(page.path.split("/")[0]) : "General", why });
      const sorted = (list) => list.sort((a, b) => a.section.localeCompare(b.section) || a.title.localeCompare(b.title));
      if (request?.scope === "all") return { title: "Wiki", pages: sorted([...pages.values()].filter((p) => !p.template).map((p) => view(p, "start"))) };
      const start = pages.get(pagePath(request?.path ?? ""));
      if (!start || start.template) throw new Error("Choose the page to export.");
      const around = [...new Set([...start.links, ...start.backlinks])].map((path) => pages.get(path)).filter((p) => p && !p.template && p.path !== GUIDE && p.path !== start.path);
      return { title: start.title, pages: [view(start, "start"), ...sorted(around.map((p) => view(p, "linked")))] };
    },
    // The export itself, as a file for the phone to hand on: text for a web page, base64 for a zip or a PDF.
    exportWikiFile(request) {
      const pages = this.wiki.scan();
      const chosen = request?.everything ? [...pages.values()] : (request?.paths ?? []).map((path) => pages.get(pagePath(path))).filter(Boolean);
      if (!chosen.length) throw new Error("There is nothing to export.");
      const title = fileName(request.title, "Wiki");
      const name = title + " wiki export";
      const body = (page) => this.wiki.pages.get(page.path).content;
      if (request.format === "zip") return { name: name + ".zip", base64: storedZip(chosen.map((page) => ({ path: name + "/" + page.path, text: body(page) }))).toString("base64") };
      if (request.format === "pdf") return { name: name + ".pdf", base64: tinyPdf([title, "", ...chosen.map((page) => page.title)]).toString("base64") };
      if (request.format !== "html") throw new Error("Choose a format to export.");
      const article = (page) => "<article><h2>" + escapeHtml(page.title) + "</h2><pre>" + escapeHtml(body(page)) + "</pre></article>";
      return { name: name + ".html", text: '<!doctype html><html><head><meta charset="utf-8"><title>' + escapeHtml(title) + "</title></head><body><h1>" + escapeHtml(title) + "</h1>" + chosen.map(article).join("") + "</body></html>\n" };
    },
    wikiPage(path) {
      return this.wiki.page(path);
    },
    saveWikiPage(path, content, base) {
      return this.wiki.save(path, content, base);
    },
    createWikiPage(input) {
      return this.wiki.create(input);
    },
    createWikiPageFor(record) {
      return this.wiki.createFor(record);
    },
    createWikiFolder(input) {
      return this.wiki.createFolder(input);
    },
    moveWiki(from, to) {
      return this.wiki.move(from, to);
    },
    deleteWiki(path) {
      this.wiki.remove(path);
    },
    searchWiki(query) {
      return this.wiki.search(query);
    },
    wikiHistory(path) {
      return this.wiki.history(path);
    },
    wikiVersion(path, id) {
      return this.wiki.version(path, id);
    },
    restoreWikiVersion(path, id) {
      return this.wiki.restore(path, id);
    },
    // Models
    models() {
      const on = this.state.settings.providers;
      // Made-up details ("models-v2") for a few models, so the phone's model page has something to
      // show. A model without an entry shows only what it has: nothing is guessed.
      const details = {
        "copilot/claude-sonnet-5-5": { contextWindow: 1_000_000, maxOutput: 128_000, maxPrompt: 936_000, vision: true, tools: true, vendor: "Anthropic", tier: "Premium", description: "Fast and capable, through Copilot" },
        "claude/claude-fable-5-2": { contextWindow: 1_000_000, maxOutput: 128_000, vision: true, tools: true, vendor: "Anthropic", effortNotes: { low: "Quick answers", high: "Thinks it through", max: "The longest thinking" } },
        "claude/claude-opus-5-5": { contextWindow: 1_000_000, maxOutput: 128_000, vision: true, tools: true, vendor: "Anthropic", description: "Deep work and long tasks" },
        "codex/gpt-5.5-codex": { contextWindow: 400_000, maxOutput: 128_000, vision: true, tools: true, vendor: "OpenAI" },
        "opencode/big-pickle": { contextWindow: 128_000, tools: true, tier: "Free" },
      };
      return MODELS.filter((m) => on[m.provider]?.enabled).map((m) => ({ ...m, ...details[m.provider + "/" + m.id] }));
    },
    harnesses() {
      return HARNESS_TOOLS.map((p) => {
        const { enabled: _enabled, default: _default, connected: _connected, signIn: _signIn, signOut: _signOut, ...status } = this.signIns.status(p, true);
        return status;
      });
    },
    providers() {
      const capable = this.capabilities.includes("provider-signin-v1");
      return PROVIDERS.map((p) => ({ ...this.signIns.status(p, capable), enabled: !!this.state.settings.providers[p.id]?.enabled }));
    },
    setModel(scope, id, value) {
      if (scope === "global") this.state.settings.model = value ?? { model: "auto" };
      else {
        const target = scope === "bot" ? this.bot(id) : this.chat(id);
        if (value) target.model = value;
        else delete target.model;
      }
    },
    setProviderEnabled(id, enabled) {
      const next = { ...this.state.settings.providers, [id]: { enabled: !!enabled } };
      if (!Object.values(next).some((p) => p.enabled)) throw new Error("Keep at least one model provider on.");
      this.state.settings.providers = next;
      this.state.providers.revision++;
    },
    auth: () => ({ connected: true, login: "octocat" }),
    // This computer's own updates ("app-update-v1"), acted out by mock-update.mjs.
    appUpdateStatus() {
      return this.updates.status();
    },
    checkAppUpdate() {
      return this.updates.check();
    },
    installAppUpdate() {
      return this.updates.install();
    },
    setAppUpdateAuto(on) {
      return this.updates.setAuto(on);
    },
    signIn() {},
    cancelSignIn() {},
    signOut(id) {
      this.signIns.signOut(PROVIDERS.find((p) => p.id === id));
    },
    // Signing in and installing from a phone ("provider-signin-v1"), acted out by mock-signin.mjs.
    providerSignInStart(id, options) {
      return this.signIns.start(PROVIDERS.find((p) => p.id === id), options ?? {});
    },
    providerSignInRead(session, after) {
      return this.signIns.read(session, after);
    },
    providerSignInInput(session, text) {
      this.signIns.input(session, text);
    },
    providerSignInCancel(session) {
      return this.signIns.cancel(session);
    },
    providerUseToken(id, token, options) {
      return this.signIns.useToken(PROVIDERS.find((p) => p.id === id), token, options ?? {});
    },
    installProvider(id) {
      return this.signIns.install([...PROVIDERS, ...HARNESS_TOOLS].find((p) => p.id === id));
    },
    providerServices() {
      const on = (this.servicesOn ??= new Set(["opencode-zen"]));
      return [
        { id: "opencode-zen", name: "OpenCode Zen", connected: on.has("opencode-zen"), via: "opencode", methods: [{ type: "key", label: "API key" }] },
        { id: "google", name: "Google", connected: on.has("google"), methods: [{ type: "key", label: "API key" }, { type: "oauth", id: "oauth", label: "Sign in with Google" }] },
      ];
    },
    // A sign-in comes back with a code to type in, as some services' do; any code but "0000" works.
    async connectProviderService(_id, serviceId, how) {
      this.servicesOn ??= new Set(["opencode-zen"]);
      if (how?.method) {
        await this.sleep(1500);
        return { code: { attempt: "attempt-" + randomUUID().slice(0, 6), instructions: "Sign in with Google in the browser on your computer, then type the code it shows." } };
      }
      if (!how?.key) throw new Error("Enter the key.");
      this.servicesOn.add(serviceId);
      return { done: true };
    },
    finishProviderService(_id, serviceId, attempt, code) {
      if (!attempt) throw new Error("Start the sign-in again.");
      if (!code || code === "0000") return { done: false };
      (this.servicesOn ??= new Set(["opencode-zen"])).add(serviceId);
      return { done: true };
    },
    cancelProviderService() {},
    disconnectProviderService(_id, serviceId) {
      (this.servicesOn ??= new Set(["opencode-zen"])).delete(serviceId);
    },
    // Routines
    createRoutine(data) {
      this.bot(data.botId);
      const chatId = this.handlers.createChat.call(this, data.botId);
      const chat = this.chat(chatId);
      chat.title = "Routine · " + text(data.name, 80, "name");
      chat.lastScheduleId = 1;
      chat.schedules = [{ id: 1, routine: true, enabled: true, name: data.name, prompt: text(data.prompt, 4000, "prompt"), cadence: data.cadence, timezone: data.timezone || "America/Chicago", recurring: data.cadence.kind !== "once", nextAt: now() + 20 * HOUR, createdAt: now(), ...(data.deliver && { deliver: delivery(data.deliver) }), ...(data.notify === false && { notify: false }) }];
      return chatId;
    },
    updateRoutine(id, patch) {
      const chat = this.chat(id);
      const entry = chat.schedules.find((s) => s.routine);
      const { deliver, ...rest } = patch;
      Object.assign(entry, rest);
      if (deliver) entry.deliver = delivery(deliver);
      chat.title = "Routine · " + entry.name;
    },
    setRoutineEnabled(id, enabled) {
      this.chat(id).schedules.find((s) => s.routine).enabled = !!enabled;
    },
    deleteRoutine(id) {
      this.handlers.deleteChat.call(this, id);
    },
    runRoutine(id) {
      const chat = this.chat(id);
      const entry = chat.schedules.find((s) => s.routine);
      this.scheduled = entry;
      this.handlers.send.call(this, id, entry.prompt);
      this.scheduled = null;
      // The result also lands where the routine sends it (the real app does this when the run ends).
      const to = entry.deliver?.to ?? "routine";
      // "No output": the run is kept in the routine's history and nothing is published anywhere.
      if (to === "none") return;
      const result = entry.name + ": done. Nothing needs you right now.";
      if (to === "chat") {
        const target = this.state.chats.find((c) => c.id === entry.deliver.chatId) ?? this.state.chats.find((c) => c.botId === chat.botId && !c.schedules?.length && !c.botIds);
        if (target) {
          target.messages.push({ role: "assistant", text: result, time: now() });
          target.time = now();
          target.unread = true;
        }
      } else if (to !== "routine") {
        this.state.board.unshift({ id: "board-" + Math.random().toString(36).slice(2, 10), botId: chat.botId, kind: to, title: entry.name, body: result, status: "open", read: false, createdAt: now(), updatedAt: now(), ...(to === "goal" && { category: "other" }) });
      }
    },
    duplicateRoutine(id, botId) {
      const entry = this.chat(id).schedules.find((s) => s.routine);
      return this.handlers.createRoutine.call(this, { botId, name: entry.name, prompt: entry.prompt, cadence: entry.cadence, timezone: entry.timezone });
    },
    previewCadence: (cadence, timezone) => ({ nextAt: now() + 20 * HOUR, summary: cadence.kind === "custom" ? "Custom · " + cadence.cron : cadence.kind[0].toUpperCase() + cadence.kind.slice(1) + (cadence.time ? " at " + cadence.time : ""), timezone: timezone || "America/Chicago" }),
    // A schedule a bot made in a chat (/every, /after). A paused one has no next run, as on the computer.
    changeSchedule(chatId, id, action) {
      const chat = this.chat(chatId);
      const entry = (chat.schedules ?? []).find((s) => s.id === id);
      if (!entry) throw new Error("This schedule no longer exists.");
      if (action === "delete") chat.schedules = chat.schedules.filter((s) => s !== entry);
      else if (action === "pause" || action === "resume") Object.assign(entry, { enabled: action === "resume", nextAt: action === "resume" ? now() + (entry.intervalMs ?? HOUR) : null });
      else throw new Error("Pause, resume or delete a schedule.");
    },
    // Tasks
    saveTask(data) {
      if (data.id) {
        const task = this.state.tasks.find((t) => t.id === data.id);
        Object.assign(task, { title: text(data.title, 160, "title"), body: data.body ?? "", botId: data.botId ?? null, priority: data.priority ?? "normal", updatedAt: now(), ...(data.status && { status: data.status }) });
        return task.id;
      }
      const task = { id: randomUUID(), title: text(data.title, 160, "title"), body: data.body ?? "", botId: data.botId ?? null, priority: data.priority ?? "normal", status: data.status ?? "later", createdBy: "person", createdAt: now(), updatedAt: now() };
      this.state.tasks.unshift(task);
      return task.id;
    },
    moveTask(id, status) {
      Object.assign(this.state.tasks.find((t) => t.id === id) ?? {}, { status, updatedAt: now() });
    },
    startTask(id) {
      Object.assign(this.state.tasks.find((t) => t.id === id) ?? {}, { status: "working", updatedAt: now() });
    },
    deleteTask(id) {
      this.state.tasks = this.state.tasks.filter((t) => t.id !== id);
    },
    // Today
    refreshPanel(id) {
      const panel = this.state.panels.find((p) => p.id === id);
      if (panel?.spaceId) {
        Object.assign(panel, { revision: panel.revision + 1, updatedAt: now(), lastCheck: { time: now(), status: "ok" } });
        this.touch(panel.spaceId);
      }
    },
    // Spaces ("spaces-v1", docs/spaces.md). The link has already checked who may do each of these.
    "spaces.read"(id) {
      const space = this.spaceOf(id);
      return { id, rev: space.rev, panels: this.state.panels.filter((panel) => panel.spaceId === id), cards: this.state.board.filter((item) => item.spaceId === id && item.status === "open") };
    },
    "spaces.create"({ name }) {
      const mine = this.spaceRecords.filter((space) => (space.createdBy || "owner") === this.caller.id);
      if (mine.length >= SPACE_LIMIT.spaces) throw new Error("You have " + SPACE_LIMIT.spaces + " spaces. Delete one first.");
      return this.newSpace(text(name, 40, "name"), { ...(this.caller.id !== "owner" && { createdBy: this.caller.id }) }).id;
    },
    "spaces.rename"(id, name) {
      const space = this.spaceOf(id);
      if (space.builtin) throw new Error("This space can't be renamed.");
      space.name = text(name, 40, "name");
      this.touch(id);
    },
    "spaces.remove"(id) {
      const space = this.spaceOf(id);
      if (space.builtin) throw new Error("This space can't be deleted.");
      this.state.panels = this.state.panels.filter((panel) => panel.spaceId !== id);
      this.state.board = this.state.board.filter((item) => item.spaceId !== id);
      this.spaceRecords = this.spaceRecords.filter((item) => item.id !== id);
    },
    "spaces.setProject"(id, projectId) {
      const space = this.spaceOf(id);
      if (space.createdBy) throw new Error("Only the owner's spaces can be attached to a project.");
      if (projectId && !this.state.projects.some((project) => project.id === projectId)) throw new Error("This project no longer exists.");
      if (projectId) space.projectId = projectId;
      else delete space.projectId;
      this.touch(id);
    },
    "spaces.setPanelProject"(panelId, projectId) {
      const panel = this.panelOf(panelId);
      if (projectId && !this.state.projects.some((project) => project.id === projectId)) throw new Error("This project no longer exists.");
      if (projectId) panel.projectId = projectId;
      else delete panel.projectId;
      this.touch(panel.spaceId);
    },
    // A new panel: a chat with the bot, in that space, and the person's sentence as "/today-panel" sends it.
    "spaces.newPanel"({ spaceId, botId, prompt, start, refresh, projectId }) {
      this.spaceOf(spaceId);
      if (projectId && !this.state.projects.some((project) => project.id === projectId)) throw new Error("This project no longer exists.");
      if (this.state.panels.filter((panel) => panel.spaceId === spaceId).length >= SPACE_LIMIT.panels) throw new Error("A space holds up to " + SPACE_LIMIT.panels + " panels. Remove one first.");
      const chatId = this.handlers.createChat.call(this, botId);
      const chat = this.chat(chatId);
      chat.spaceId = spaceId;
      if (this.caller.id !== "owner") chat.createdBy = this.caller.id;
      const starts = { checklist: "Make it a checklist.", tracker: "Make it a tracker.", chart: "Make it a chart.", table: "Make it a table.", notes: "Make it notes.", app: "Make it an app." };
      this.handlers.send.call(this, chatId, "/today-panel " + prompt + (start ? "\n" + starts[start] : ""));
      const panel = this.state.panels.at(-1);
      // Its project, as the owner's sheet said: set when the bot first publishes from that chat (here, at once).
      if (projectId && panel?.chatId === chatId) panel.projectId = projectId;
      if (refresh && panel?.chatId === chatId) panel.routine = { cron: refresh.cron, timezone: refresh.timezone, prompt, enabled: true, nextAt: now() + 16 * HOUR, ...(this.caller.id !== "owner" && { setBy: this.caller.id }) };
      return { chatId };
    },
    "spaces.ask"({ spaceId, botId, text: asked, panelId }) {
      const space = this.spaceOf(spaceId);
      if (panelId !== undefined && this.panelOf(panelId).spaceId !== spaceId) throw new Error("This panel no longer exists.");
      const chatId = this.handlers.createChat.call(this, botId);
      const chat = this.chat(chatId);
      Object.assign(chat, { spaceId, ...(panelId && { panelId: undefined, aboutPanel: panelId }), title: clip(space.name + ": " + asked, 40) });
      if (this.caller.id !== "owner") chat.createdBy = this.caller.id;
      this.handlers.send.call(this, chatId, asked);
      return { chatId };
    },
    "spaces.movePanel"(panelId, { spaceId, before }) {
      const panel = this.panelOf(panelId);
      this.spaceOf(spaceId);
      const from = panel.spaceId;
      const rest = this.state.panels.filter((item) => item.id !== panelId);
      const at = before ? rest.findIndex((item) => item.id === before && item.spaceId === spaceId) : -1;
      panel.spaceId = spaceId;
      if (at >= 0) rest.splice(at, 0, panel);
      else rest.push(panel);
      this.state.panels = rest;
      this.touch(from);
      if (from !== spaceId) this.touch(spaceId);
    },
    // An app panel's saved state: a shallow merge, so two people ticking different items don't undo each other.
    "spaces.patchState"(panelId, patch, label) {
      const panel = this.panelOf(panelId);
      if (!panel.blocks.some((block) => block.type === "html")) throw new Error("Only an app panel keeps state.");
      const state = { ...(panel.state ?? {}) };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete state[key];
        else state[key] = value;
      }
      if (JSON.stringify(state).length > 64 * 1024 || Object.keys(state).length > 200) throw new Error("That change is too large to save.");
      Object.assign(panel, { state, stateRev: (panel.stateRev ?? 0) + 1, updatedAt: now(), last: { by: this.caller.id, name: this.caller.name, ...(label && { label }), at: now() } });
      this.touch(panel.spaceId);
      // The link tells the others who want to hear of it (`link.spaceEvent`; dev-host.mjs wires it).
      this.onSpaceEvent?.({ spaceId: panel.spaceId, panelId, by: this.caller.id, kind: "change", ...(label && { label }) });
      return { rev: panel.stateRev };
    },
    "spaces.note"(panelId, words) {
      const panel = this.panelOf(panelId);
      if ((panel.notes ?? []).length >= SPACE_LIMIT.notes) throw new Error("A panel holds up to " + SPACE_LIMIT.notes + " notes. Remove one first.");
      const note = { id: "n-" + randomUUID().slice(0, 8), by: this.caller.id, name: this.caller.name, text: text(words, 2000, "note"), at: now() };
      Object.assign(panel, { notes: [...(panel.notes ?? []), note], updatedAt: now(), last: { by: this.caller.id, name: this.caller.name, label: "Wrote a note", at: now() } });
      this.touch(panel.spaceId);
      this.onSpaceEvent?.({ spaceId: panel.spaceId, panelId, by: this.caller.id, kind: "note", text: note.text });
      return note.id;
    },
    // A person removes their own notes; the space's maker and the owner remove any.
    "spaces.removeNote"(panelId, noteId) {
      const panel = this.panelOf(panelId);
      const note = (panel.notes ?? []).find((item) => item.id === noteId);
      if (!note) return;
      const maker = this.spaceOf(panel.spaceId).createdBy || "owner";
      if (note.by !== this.caller.id && this.caller.id !== "owner" && this.caller.id !== maker) throw new Error("Only the person who wrote this note can remove it.");
      panel.notes = panel.notes.filter((item) => item.id !== noteId);
      this.touch(panel.spaceId);
    },
    changePanel(id, action) {
      const panels = this.state.panels;
      const i = panels.findIndex((p) => p.id === id);
      if (i < 0) throw new Error("This panel no longer exists.");
      const panel = panels[i];
      if (action === "delete") this.state.panels = panels.filter((p) => p.id !== id);
      else if (action === "hide" || action === "show") panel.hidden = action === "hide";
      else if (["small", "wide", "tall"].includes(action)) panel.size = action;
      else if (action === "earlier" || action === "later") {
        // With the panel before or after it in the same space.
        const same = panels.map((p, index) => ({ p, index })).filter(({ p }) => p.spaceId === panel.spaceId);
        const at = same.findIndex(({ p }) => p.id === id);
        const other = same[at + (action === "earlier" ? -1 : 1)];
        if (other) [panels[i], panels[other.index]] = [panels[other.index], panels[i]];
      } else throw new Error("Unknown panel action");
      if (panel.spaceId) this.touch(panel.spaceId);
    },
    // A panel's own routine, as desktop/panels.mjs keeps it (cron, time zone, refresh instructions).
    routine(id, { action, cron, prompt, timezone } = {}) {
      const panel = this.state.panels.find((p) => p.id === id);
      if (!panel) throw new Error("This panel no longer exists.");
      if (action === "set") {
        const expression = text(cron, 160, "cron");
        if (expression.split(/\s+/).length !== 5) throw new Error("A cron schedule has five parts: minute, hour, day, month and weekday.");
        panel.routine = { cron: expression, timezone: timezone || "America/Chicago", prompt: text(prompt, 4000, "refresh instructions"), enabled: true, nextAt: now() + 16 * HOUR };
      } else if (action === "remove") panel.routine = null;
      else {
        if (!panel.routine || !["pause", "resume"].includes(action)) throw new Error("No matching routine");
        panel.routine.enabled = action === "resume";
        panel.routine.nextAt = panel.routine.enabled ? now() + 16 * HOUR : null;
      }
      return panel.routine;
    },
    boardAct(id, action, value) {
      const item = this.state.board.find((b) => b.id === id);
      if (!item) throw new Error("This item no longer exists.");
      item.updatedAt = now();
      if (action === "delete") this.state.board = this.state.board.filter((b) => b !== item);
      else if (action === "read") item.read = true;
      else if (action === "unread") item.read = false;
      else if (action === "clear") item.status = "cleared";
      else if (action === "done") item.status = "done";
      else if (action === "reopen") item.status = "open";
      // As desktop/board.mjs: up toggles, down is set with its reason ("Less like this because…").
      else if (action === "up") {
        item.rating = item.rating === "up" ? undefined : "up";
        delete item.reason;
      } else if (action === "down") {
        if (value != null && !["Not relevant", "Too frequent", "Already knew", "Wrong timing"].includes(value)) throw new Error("Unknown reason");
        item.rating = "down";
        item.reason = value ?? undefined;
      }
      else if (action === "yes" || action === "goal") {
        if (item.kind !== "idea") throw new Error("Only ideas take that.");
        item.answer = action;
        item.status = "done";
        if (action === "goal") {
          const goal = { id: "board-" + randomUUID().slice(0, 8), botId: item.botId, kind: "goal", title: item.title, body: item.body, status: "open", read: true, category: typeof value === "string" ? value : "other", createdAt: now(), updatedAt: now() };
          this.state.board.unshift(goal);
          return goal.id;
        }
      } else if (action === "notToday") {
        if (item.kind !== "goal") throw new Error("Only goals take Not today.");
        const midnight = new Date();
        midnight.setHours(24, 0, 0, 0);
        item.snoozedUntil = midnight.getTime();
      } else throw new Error("Unknown board action");
    },
    // Skills
    skills() {
      const off = new Set(this.state.skills.disabled);
      const { folders, plugins } = this.state.skills;
      return {
        skills: this.skillList.map(({ instructions: _text, ...skill }) => ({ ...skill, enabled: !off.has(skill.name) })),
        folders: folders.map((folder) => ({ ...folder, missing: false, skills: this.skillList.filter((skill) => skill.folderId === folder.id).length })),
        plugins: plugins.map((plugin) => ({ ...plugin, missing: false })),
      };
    },
    readSkill(name) {
      const skill = this.skillList.find((s) => s.name === name);
      if (!skill) throw new Error("Unknown skill");
      return { name: skill.name, description: skill.description, instructions: skill.instructions ?? "" };
    },
    saveSkill({ name, description, instructions, original }) {
      const clean = text(name, 64, "name").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      const existing = this.skillList.find((s) => s.name === (original ?? clean));
      if (existing) Object.assign(existing, { name: clean, description, instructions });
      else this.skillList.unshift({ name: clean, description, instructions, path: "/skills/" + clean, origin: "botkins", enabled: true, editable: true });
      return clean;
    },
    removeSkill(name) {
      this.skillList = this.skillList.filter((s) => s.name !== name);
    },
    setSkillEnabled(name, enabled) {
      const off = new Set(this.state.skills.disabled);
      if (enabled) off.delete(name);
      else off.add(name);
      this.state.skills = { ...this.state.skills, disabled: [...off] };
    },
    // Stops using a linked folder or plugin, and its skills with it; the folder itself is left alone.
    // "Add from folder…" with a folder chosen in the folder browser. It stays where it is and is read from there.
    addSkillFolderAt(path) {
      chosenFolder(path);
      // A plugin folder is never linked as a folder of skills: it is installed as a plugin, switched off.
      if (this.pluginStarts && DEMO_FOLDER_PLUGINS[path] && path !== "/Users/demo/team-skills") {
        const record = this.addPluginFolder(path);
        return { kind: "plugin", name: record.listing.name, id: record.id, enabled: false };
      }
      const { folders } = this.state.skills;
      if (folders.some((folder) => folder.path === path)) throw new Error("That folder is already added.");
      this.state.skills = { ...this.state.skills, folders: [...folders, { id: "folder-" + randomUUID().slice(0, 6), path }] };
      return { kind: "folder", name: posix.basename(path), count: 0 };
    },
    removeSkillFolder(id) {
      const { folders, plugins } = this.state.skills;
      if (!folders.some((folder) => folder.id === id) && !plugins.some((plugin) => plugin.id === id)) throw new Error("That folder isn't linked any more.");
      this.state.skills = { ...this.state.skills, folders: folders.filter((folder) => folder.id !== id), plugins: plugins.filter((plugin) => plugin.id !== id) };
      this.skillList = this.skillList.filter((skill) => skill.folderId !== id);
    },
    // MCP servers
    saveMcpServer(input) {
      const prior = input.id ? this.server(input.id).auth : undefined;
      // A browser sign-in keeps its state and a client of the person's own; a secret is only ever "saved".
      const oauth = input.oauth
        ? { type: "oauth", signedIn: prior?.type === "oauth" && prior.signedIn, signingIn: false, canRenew: false, clientSecret: input.oauth.clientSecret === null ? !!prior?.clientSecret : !!input.oauth.clientSecret, ...(input.oauth.clientId && { clientId: input.oauth.clientId }), ...(input.oauth.scope && { scope: input.oauth.scope }) }
        : input.oauth === undefined && prior?.type === "oauth" ? prior : undefined;
      const fields = {
        ...(input.type === "stdio" && { cwd: input.cwd || undefined }),
        ...(oauth && { auth: oauth }),
        name: text(input.name, 60, "name"),
        type: input.type,
        enabled: input.enabled ?? true,
        ...(input.command && { command: input.command, args: input.args ?? [] }),
        ...(input.url && { url: input.url }),
        ...(input.env && { env: Object.keys(input.env) }),
        ...(input.headers && { headers: Object.keys(input.headers) }),
        ...(input.type !== "stdio" && !oauth && { auth: { type: input.headers && Object.keys(input.headers).length ? "header" : "none" } }),
      };
      if (input.id) {
        Object.assign(this.server(input.id), fields);
        return input.id;
      }
      const server = { id: "mcp-" + randomUUID().slice(0, 8), ...fields };
      this.state.mcpServers.push(server);
      return server.id;
    },
    setMcpServerEnabled(id, enabled) {
      this.server(id).enabled = !!enabled;
    },
    removeMcpServer(id) {
      this.server(id);
      this.state.mcpServers = this.state.mcpServers.filter((s) => s.id !== id);
    },
    async testMcpServer(id) {
      const server = this.server(id);
      await this.sleep(600);
      if (server.auth?.type === "oauth" && !server.auth.signedIn) return { status: "needs sign-in", tools: [] };
      return { status: "connected", tools: ["search", "create_issue", "list_projects"] };
    },
    async signInMcpServer(id) {
      const server = this.server(id);
      server.auth = { ...server.auth, signingIn: true };
      this.changed();
      await this.sleep(1200);
      server.auth = { type: "oauth", signedIn: true, signingIn: false, canRenew: true, clientSecret: false };
      return server.auth;
    },
    cancelMcpSignIn: () => true,
    signOutMcpServer(id) {
      this.server(id).auth = { type: "oauth", signedIn: false, signingIn: false, canRenew: false, clientSecret: false };
    },
    // Pasted JSON in the "mcpServers" shape other apps use. A server whose name exists is skipped.
    importMcpServers(json) {
      let parsed;
      try {
        parsed = JSON.parse(String(json ?? ""));
      } catch {
        throw new Error("That isn't JSON. Paste the \"mcpServers\" block from another app's settings.");
      }
      const servers = parsed?.mcpServers ?? parsed?.servers ?? parsed;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("There are no servers in that JSON.");
      const added = [];
      const skipped = [];
      for (const [name, entry] of Object.entries(servers)) {
        if (!entry || typeof entry !== "object") continue;
        if (this.state.mcpServers.some((server) => server.name === name)) {
          skipped.push(name);
          continue;
        }
        const remote = typeof entry.url === "string";
        this.state.mcpServers.push({
          id: "mcp-" + randomUUID().slice(0, 8),
          name: text(name, 60, "name"),
          type: remote ? (entry.type === "sse" ? "sse" : "http") : "stdio",
          enabled: true,
          ...(remote ? { url: entry.url, auth: { type: entry.headers ? "header" : "none" }, ...(entry.headers && { headers: Object.keys(entry.headers) }) } : { command: String(entry.command ?? ""), args: Array.isArray(entry.args) ? entry.args.map(String) : [], env: Object.keys(entry.env ?? {}), ...(entry.cwd && { cwd: String(entry.cwd) }) }),
        });
        added.push(name);
      }
      return { added, skipped };
    },
    credentials: () => ({ protection: "keychain", redirectUrl: "http://127.0.0.1:47823/callback", entries: [] }),
    removeCredential() {},
    // Projects
    createProject(input) {
      const project = { id: "p-" + randomUUID().slice(0, 6), name: text(input.name, 80, "name"), ...(input.description && { description: input.description }), ...(input.color && { color: input.color }), todos: [], lastUsed: now(), createdAt: now() };
      this.state.projects.push(project);
      return project.id;
    },
    updateProject(id, patch) {
      const project = this.state.projects.find((p) => p.id === id);
      if (!project) throw new Error("This project no longer exists.");
      // A folder comes from the folder browser (`listFolders`); null unlinks it.
      if ("folder" in patch && patch.folder !== null) chosenFolder(patch.folder);
      const { folder, ...rest } = patch;
      Object.assign(project, rest);
      if (folder === null) delete project.folder;
      else if (folder !== undefined) project.folder = folder;
    },
    // The folders inside the home folder or a plugged-in disk, by name: never a file, never what a file holds, nothing hidden.
    listFolders(path) {
      const found = demoFolder(path ?? DEMO_PLACES[0].path);
      if (!found) throw new Error(found === null ? OUTSIDE : GONE);
      const here = found.place.path + found.at;
      // As a Mac does for Documents: the first look inside waits on a question on the computer's own screen.
      if (process.env.BOTKINS_DEV_FOLDERS === "ask" && found.at === "/Documents" && !this.askedFolders) {
        this.askedFolders = true;
        throw new Error("The computer is still deciding whether Botkins may look in “Documents”. If it is asking, answer on the computer, then try again.");
      }
      return { path: here, parent: found.at ? posix.dirname(here) : null, folders: (found.place.folders[found.at] ?? []).map((name) => ({ name, path: here + "/" + name })), roots: DEMO_PLACES.map(({ name, path: top }) => ({ name, path: top })) };
    },
    // "Add folder…": a project for a folder, or the one already made for it.
    addProjectFolder(path) {
      chosenFolder(path);
      const existing = this.state.projects.find((p) => p.folder === path);
      if (existing) return existing.id;
      const project = { id: "p-" + randomUUID().slice(0, 6), name: posix.basename(path), folder: path, todos: [], lastUsed: now(), createdAt: now() };
      this.state.projects.push(project);
      return project.id;
    },
    startProjectChat(botIds, projectId, mode) {
      if (!Array.isArray(botIds) || !botIds.length) throw new Error("Choose a bot.");
      const project = this.state.projects.find((p) => p.id === projectId);
      if (!project) throw new Error("This project no longer exists.");
      botIds.forEach((id) => this.bot(id));
      const chat = { id: "chat-" + randomUUID().slice(0, 8), botId: botIds[0], ...(botIds.length > 1 && { botIds }), title: "New chat", time: now(), projectId, mode: project.folder ? (mode ?? "default") : "default", messages: [] };
      this.state.chats.unshift(chat);
      project.lastUsed = now();
      return chat.id;
    },
    renameProject(id, name) {
      Object.assign(this.state.projects.find((p) => p.id === id) ?? {}, { name });
    },
    removeProject(id) {
      this.state.projects = this.state.projects.filter((p) => p.id !== id);
    },
    // "project-artifacts-v1": a project keeps a list of artifact ids, newest attached first.
    addProjectArtifact(id, artifactId) {
      const project = this.state.projects.find((p) => p.id === id);
      if (!project) throw new Error("Unknown project");
      const found = this.artifacts.find((entry) => entry.item.id === artifactId || entry.item.path === artifactId);
      if (!found) throw new Error("This artifact no longer exists.");
      const rest = (project.artifacts ?? []).filter((held) => held !== found.item.id);
      if (rest.length >= 200) throw new Error("A project holds up to 200 artifacts. Remove one first.");
      project.artifacts = [found.item.id, ...rest];
      return [...project.artifacts];
    },
    removeProjectArtifact(id, artifactId) {
      const project = this.state.projects.find((p) => p.id === id);
      if (!project) throw new Error("Unknown project");
      const rest = (project.artifacts ?? []).filter((held) => held !== artifactId);
      if (rest.length) project.artifacts = rest;
      else delete project.artifacts;
      return rest;
    },
    projectArtifacts(id) {
      const project = this.state.projects.find((p) => p.id === id);
      if (!project) throw new Error("Unknown project");
      const items = (project.artifacts ?? []).flatMap((held) => this.artifacts.find((entry) => entry.item.id === held)?.item ?? []);
      // One that is gone drops out of the stored list too.
      if (items.length) project.artifacts = items.map((item) => item.id);
      else delete project.artifacts;
      return { items };
    },
    // A project's changes are made up (the folder itself is never read or touched). Committing clears them.
    projectChanges(id) {
      const project = this.state.projects.find((p) => p.id === id);
      if (!project) throw new Error("This project no longer exists.");
      if (!project.folder) return { repo: false, files: [] };
      const files = (this.changedFiles ??= new Map()).get(id) ?? (this.changedFiles.set(id, MADE_UP_CHANGES.map((file) => ({ ...file }))), this.changedFiles.get(id));
      const sum = (key) => files.reduce((total, file) => total + file[key], 0);
      return { repo: true, root: project.folder, branch: "feature/" + slug(project.name), upstream: "origin/main", ahead: 2, behind: 0, files, added: sum("added"), removed: sum("removed") };
    },
    projectDiff(id, file) {
      const changed = this.handlers.projectChanges.call(this, id).files.find((f) => f.path === file);
      if (!changed) throw new Error("That file has no changes now.");
      return { text: MADE_UP_DIFFS[file] ?? "--- a/" + file + "\n+++ b/" + file + "\n@@ -1 +1 @@\n-old line\n+new line", truncated: false };
    },
    projectCommit(id, message) {
      const changes = this.handlers.projectChanges.call(this, id);
      text(message, 2000, "commit message");
      if (!changes.repo || !changes.files.length) throw new Error("There is nothing to commit.");
      this.changedFiles.set(id, []);
      return randomUUID().replace(/-/g, "").slice(0, 7);
    },
    addTodo(projectId, value) {
      const todo = { id: randomUUID(), text: text(value, 400, "to-do"), done: false, createdAt: now() };
      this.state.projects.find((p) => p.id === projectId)?.todos.push(todo);
      return todo.id;
    },
    updateTodo(projectId, todoId, patch) {
      const todo = this.state.projects.find((p) => p.id === projectId)?.todos.find((t) => t.id === todoId);
      if (todo) Object.assign(todo, patch, patch.done ? { doneAt: now() } : {});
    },
    deleteTodo(projectId, todoId) {
      const project = this.state.projects.find((p) => p.id === projectId);
      if (project) project.todos = project.todos.filter((t) => t.id !== todoId);
    },
    // One place up (-1) or down (1) in the stored order, as desktop/projects.mjs does.
    moveTodo(projectId, todoId, delta) {
      const project = this.state.projects.find((p) => p.id === projectId);
      if (!project) throw new Error("This project no longer exists.");
      const i = project.todos.findIndex((t) => t.id === todoId);
      if (i < 0) throw new Error("This to-do no longer exists.");
      if (delta !== -1 && delta !== 1) throw new Error("Move a to-do up or down by one.");
      const j = i + delta;
      if (j >= 0 && j < project.todos.length) [project.todos[i], project.todos[j]] = [project.todos[j], project.todos[i]];
    },
    usage: (days) => ({
      days,
      totals: { turns: 184, input: 1_420_000, output: 96_000, cacheRead: 610_000, cost: 12.4, priced: 120 },
      byDay: Array.from({ length: Math.min(days, 14) }, (_, i) => ({ date: new Date(now() - i * 24 * HOUR).toISOString().slice(0, 10), turns: 6 + ((i * 7) % 11), input: 80_000, output: 6000, cacheRead: 30_000, cost: 0.7, priced: 6 })),
      byModel: [{ model: "Claude Fable 5.2", turns: 80, input: 700_000, output: 50_000, cacheRead: 300_000, cost: 8.1, priced: 80 }, { model: "GPT-5.5 Codex", turns: 64, input: 500_000, output: 30_000, cacheRead: 200_000, cost: 4.3, priced: 40 }],
      byBot: this.state.bots.map((bot, i) => ({ botId: bot.id, name: bot.name, turns: 60 - i * 11, input: 300_000, output: 20_000, cacheRead: 100_000, cost: 3 - i * 0.5, priced: 30 })),
    }),
    // What the person does with a chat's side pane (the tabs a bot opened beside the chat).
    // Plugins ("plugins-v1", docs/plugins.md). Nothing here reaches the network.
    "plugins.marketplaces"() {
      return this.plugins.marketplaces.map((market) => ({ ...market, ...(!market.error && { count: this.plugins.catalog.filter((entry) => entry.marketplace === market.id).length }) }));
    },
    "plugins.addMarketplace"(source) {
      const text = String(source ?? "").trim();
      let id;
      let shown = text;
      if (/^[\w.-]+\/[\w.-]+(#[\w./-]+)?$/.test(text)) id = text.split("#")[0].split("/")[1];
      else if (/^https:\/\/[^\s/]+(\/\S*)?$/.test(text)) id = slug(text.replace(/\/+$/, "").split("/").pop().replace(/\.json$/, "")) || "catalog";
      else if (text.startsWith("/")) {
        id = posix.basename(chosenFolder(text));
        shown = "Folder on your computer";
      } else throw new Error("Enter owner/repo, a web address or a folder.");
      id = slug(id);
      if (this.plugins.marketplaces.some((market) => market.id === id)) throw new Error("That marketplace is already added.");
      const market = { id, name: humanize(id), source: shown, builtIn: false, updatedAt: now(), ...(/broken/i.test(text) && { error: "Its marketplace.json couldn't be read." }) };
      this.plugins.marketplaces.push(market);
      if (!market.error)
        for (const [name, description] of [["starter", "A starter skill pack."], ["helper", "A helpful agent."], ["checks", "Checks a bot's work when a reply ends."]])
          this.plugins.catalog.push(demoPlugin(id, id + "-" + name, { description, author: humanize(id), contents: name === "helper" ? { agents: [id + "-helper"] } : name === "checks" ? { hooks: [{ event: "agentStop", command: "sh ${PLUGIN_ROOT}/check.sh" }] } : { skills: [id + "-starter"] } }));
      return { ...market, ...(!market.error && { count: 3 }) };
    },
    // "market-refresh-v1": every catalog read again now. The first time, GitHub's has one plugin more,
    // so a pull down on the phone shows something new.
    "plugins.refresh"() {
      for (const market of this.plugins.marketplaces) if (!market.error) market.updatedAt = now();
      if (!this.plugins.catalog.some((entry) => entry.id === FRESH_PLUGIN.id)) this.plugins.catalog.push(structuredClone(FRESH_PLUGIN));
      return this.handlers["plugins.marketplaces"].call(this);
    },
    "plugins.removeMarketplace"(id) {
      const market = this.plugins.marketplaces.find((item) => item.id === id);
      if (!market) throw new Error("That marketplace isn't added any more.");
      if (market.builtIn) throw new Error("GitHub's catalogs can't be removed.");
      this.plugins.marketplaces = this.plugins.marketplaces.filter((item) => item !== market);
      // Installed plugins stay; only the catalog's other entries go.
      this.plugins.catalog = this.plugins.catalog.filter((entry) => entry.marketplace !== id);
    },
    "plugins.browse"({ marketplace, query, cursor } = {}) {
      if (marketplace !== undefined && !this.plugins.marketplaces.some((market) => market.id === marketplace)) throw new Error("That marketplace isn't added any more.");
      const readable = new Set(this.plugins.marketplaces.filter((market) => !market.error).map((market) => market.id));
      const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const found = this.plugins.catalog
        .filter((entry) => readable.has(entry.marketplace) && (marketplace === undefined || entry.marketplace === marketplace))
        .filter((entry) => words.every((word) => [entry.name, entry.description ?? "", ...(entry.keywords ?? [])].some((part) => part.toLowerCase().includes(word))))
        .sort((a, b) => a.name.localeCompare(b.name));
      const from = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isInteger(from) || from < 0) throw new Error("That list can't be shown.");
      const installed = new Set(this.plugins.installed.map((record) => record.id));
      const page = found.slice(from, from + this.pluginPage).map((entry) => ({ ...listingOf(entry), ...(installed.has(entry.id) && { installed: true }) }));
      return { plugins: page, ...(from + page.length < found.length && { cursor: String(from + page.length) }) };
    },
    "plugins.preview"(id) {
      const record = this.plugins.installed.find((item) => item.id === id);
      if (record?.folder) return this.folderPreview(record);
      const entry = this.pluginEntry(id);
      return { ...listingOf(entry), ...(record && { installed: true }), ...this.described(entry.contents, entry.config), ...(entry.postInstallMessage && { postInstallMessage: entry.postInstallMessage }), revision: pluginRevision(entry) };
    },
    "plugins.install"(id, options) {
      return this.installPlugin(id, options ?? {});
    },
    // A folder plugin is added turned off: the person looks at what it runs and turns it on.
    "plugins.addFolder"(path) {
      chosenFolder(path);
      return this.pluginView(this.addPluginFolder(path));
    },
    "plugins.configure"(id, values) {
      this.applyPluginValues(this.installedPlugin(id), values);
    },
    "plugins.setBots"(id, bots, options) {
      const record = this.installedPlugin(id);
      this.sameRevision(record, options);
      record.bots = this.pluginBots(bots);
    },
    "plugins.setEnabled"(id, on, options) {
      const record = this.installedPlugin(id);
      this.sameRevision(record, options);
      // A copy that is not the reviewed files is not switched on: the way back is an update.
      if (on === true && record.changed) throw new Error(CHANGED_COPY);
      record.enabled = on === true;
      // The person looked and said yes: the app's reason for holding it back is over.
      if (record.enabled) delete record.heldBack;
    },
    "plugins.update"(id, { revision } = {}) {
      const record = this.installedPlugin(id);
      this.lookedAt(revision);
      // An update writes the reviewed files again and keeps the settings: the repair for a changed copy.
      const repaired = () => {
        delete record.changed;
      };
      // A folder plugin is a copy of the folder taken when it was added (the folder itself can change): an
      // update takes a fresh copy, the one the person looked at.
      if (record.folder) {
        const now = this.folderPreview(record);
        if (revision !== undefined && revision !== now.revision) throw new Error(STALE_UPDATE);
        const made = DEMO_FOLDER_PLUGINS[record.folder] ?? { contents: { skills: [slug(posix.basename(record.folder)) || "skill"] } };
        Object.assign(record, { contents: contents(made.contents), revision: now.revision });
        repaired();
        return this.pluginView(record);
      }
      const entry = this.pluginEntry(id);
      if (revision !== undefined && revision !== pluginRevision(entry)) throw new Error(STALE_UPDATE);
      const kept = new Set(entry.config.map((field) => field.key));
      Object.assign(record, { listing: listingOf(entry), contents: structuredClone(entry.contents), config: structuredClone(entry.config), revision: pluginRevision(entry) });
      for (const key of Object.keys(record.values)) if (!kept.has(key)) delete record.values[key];
      this.pluginServers(record);
      repaired();
      return this.pluginView(record);
    },
    "plugins.uninstall"(id) {
      const record = this.installedPlugin(id);
      const servers = new Set(Object.values(record.serverIds ?? {}));
      this.state.mcpServers = this.state.mcpServers.filter((server) => !servers.has(server.id));
      this.plugins.installed = this.plugins.installed.filter((item) => item !== record);
    },
    // Agent templates ("agent-templates-v1", docs/agent-templates.md). Nothing here reaches the network.
    "agents.browse"({ query, category, marketplace } = {}) {
      const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      // The categories count what the other filters leave, so the chips can show their counts.
      const left = DEMO_AGENTS.filter((agent) => (marketplace === undefined || agent.marketplace === marketplace) && agentMatches(agent, words));
      const counts = new Map();
      for (const agent of left) if (agent.category) counts.set(agent.category, (counts.get(agent.category) ?? 0) + 1);
      const categories = [...counts].map(([id, count]) => ({ id, name: AGENT_CATEGORIES[id] ?? "Other", count }));
      return { agents: left.filter((agent) => category === undefined || agent.category === category).map(marketAgentOf), categories };
    },
    "agents.template"(id) {
      const agent = DEMO_AGENTS.find((item) => item.id === id);
      if (!agent) throw new Error("That template isn't in its marketplace any more.");
      return structuredClone(agent);
    },
    sidePane(chatId, action, panelId) {
      const chat = this.chat(chatId);
      const pane = chat.pane ?? (chat.pane = { panels: [], active: null });
      const panel = panelId ? pane.panels.find((item) => item.id === panelId) : null;
      if (panelId && !panel) throw new Error("That panel is gone.");
      if (action === "select") {
        pane.active = panel?.id ?? null;
        if (panel) delete panel.unseen;
      } else if (action === "remove" && panel) {
        pane.panels = pane.panels.filter((item) => item !== panel);
        if (pane.active === panel.id) pane.active = pane.panels.at(-1)?.id ?? null;
      } else if (action === "pin" && panel) panel.pinned = true;
      else if (action === "unpin" && panel) delete panel.pinned;
      else if (action === "closed") pane.closed = { runId: this.state.runs.find((run) => run.chatId === chatId && run.status === "Working")?.id ?? null, at: now() };
      else if (action === "opened") delete pane.closed;
      else throw new Error("That can't be done with the side pane.");
    },
    // What the bots made or were given. Only what is in the index can be listed or read.
    "artifacts.list"(query) {
      const { botId, chatId, kind, folder, cursor } = query ?? {};
      let found = this.artifacts.filter((entry) => entry.item.botId === botId);
      if (folder) {
        if (!found.some((entry) => entry.item.id === folder && entry.item.kind === "folder")) throw new Error("That folder isn't available.");
        found = found.filter((entry) => entry.parent === folder);
      } else found = found.filter((entry) => !entry.parent);
      if (chatId) found = found.filter((entry) => entry.item.chatId === chatId);
      if (kind === "media") found = found.filter((entry) => MEDIA_KINDS.includes(entry.item.kind));
      if (kind === "files") found = found.filter((entry) => !MEDIA_KINDS.includes(entry.item.kind));
      const sorted = found.map((entry) => entry.item).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
      const from = cursor ? Number(cursor) || 0 : 0;
      return { items: sorted.slice(from, from + ARTIFACT_PAGE), nextCursor: from + ARTIFACT_PAGE < sorted.length ? String(from + ARTIFACT_PAGE) : null };
    },
    "artifacts.read"(id, options) {
      const entry = this.artifacts.find((each) => each.item.id === id || each.item.path === id);
      if (!entry) throw new Error("That file isn't available any more.");
      const data = entry.data ?? Buffer.alloc(0);
      const offset = Math.min(options?.offset ?? 0, data.length);
      const end = Math.min(data.length, offset + Math.min(options?.length ?? ARTIFACT_CHUNK, ARTIFACT_CHUNK));
      return { artifact: entry.item, data: data.subarray(offset, end).toString("base64"), encoding: "base64", offset, nextOffset: end < data.length ? end : null };
    },
    // The demo hands a picture back whole (they are small); it makes no poster for anything else.
    "artifacts.thumbnail"(id) {
      // BOTKINS_DEV_THUMBS=off: a host with no display makes no small pictures (a server host).
      if (process.env.BOTKINS_DEV_THUMBS === "off") return null;
      const entry = this.artifacts.find((each) => each.item.id === id);
      return entry?.item.kind === "image" && entry.data ? { data: entry.data.toString("base64"), mime: entry.item.mime } : null;
    },
    "artifacts.resolve"(query) {
      const chat = this.chat(query?.chatId);
      const bots = new Set(chat.botIds ?? [chat.botId]);
      // "~/" is this computer's home folder, and a folder written with its slash is the same folder.
      const home = (path) => (path.startsWith("~/") ? "/Users/demo/" + path.slice(2) : path).replace(/(?<=.)\/+$/, "");
      return { items: (query.paths ?? []).map((path) => this.artifacts.find((entry) => bots.has(entry.item.botId) && entry.item.path === home(path))?.item ?? null) };
    },
    // The usage table as the text of a .csv file ("Export CSV" without a save dialog).
    exportUsageText(days) {
      if (![7, 30, 90].includes(days)) throw new Error("Choose 7, 30 or 90 days");
      const rows = [["time", "date", "bot", "chat", "title", "status", "trigger", "model", "input_tokens", "output_tokens", "cache_read_tokens", "cost", "duration_ms", "provider"]];
      const cell = (value) => (/[",\n]/.test(String(value)) ? '"' + String(value).replace(/"/g, '""') + '"' : String(value));
      this.state.chats.slice(0, Math.min(days, 12)).forEach((chat, index) => {
        const time = now() - index * 5 * HOUR;
        rows.push([new Date(time).toISOString(), new Date(time).toISOString().slice(0, 10), this.state.bots.find((bot) => bot.id === chat.botId)?.name ?? "", chat.id, chat.title, "Done", "message", "Claude Fable 5.2", 80_000 + index * 900, 6000 + index * 70, 30_000, (0.4 + index * 0.03).toFixed(2), 42_000 + index * 800, "claude"]);
      });
      return { name: "botkins-usage-" + days + "d.csv", text: rows.map((row) => row.map(cell).join(",")).join("\n") + "\n" };
    },
    cacheInfo() {
      return { ...this.cache };
    },
    clearCache() {
      this.cache = { bytes: 0, catalogs: 0 };
    },
    // The real app shows a notification on the computer. The demo only counts.
    testNotification() {
      this.tested++;
    },
    // Made-up plans and limits, one provider for each thing a phone has to show: one limit (Copilot),
    // two limits (ChatGPT), a lookup that failed with older numbers kept and a limit without a number
    // (Claude), and a provider that gives nothing (OpenCode). BOTKINS_DEV_USAGE=keys makes every
    // account an API key (no plan limits), =error fails the call, =slow answers after four seconds,
    // =off leaves the capability out.
    async providerUsage(options) {
      const mode = process.env.BOTKINS_DEV_USAGE;
      if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 4000));
      if (mode === "error") throw new Error("The providers didn't answer.");
      const read = options?.refresh ? now() : now() - 5 * MIN;
      // The same fields the desktop app sends (its docs/PROVIDER_USAGE.md): counts where a provider
      // gives them, an allowance without a limit, a balance of credits, a limit for one model.
      const shapes = {
        copilot: {
          plan: "GitHub Copilot Pro+", account: "subscription", source: "GitHub Copilot", updatedAt: read,
          limits: [
            { id: "premium", label: "Premium requests", percentRemaining: 62, percentUsed: 38, used: 570, limit: 1500, unit: "requests", window: "month", resetAt: now() + 11 * 24 * HOUR, primary: true },
            { id: "chat", label: "Chat", unlimited: true, window: "month" },
          ],
        },
        codex: {
          plan: "ChatGPT Pro", account: "subscription", source: "Codex", updatedAt: read, credits: { label: "Credits", amount: 1250, unit: "credits" },
          limits: [
            { id: "weekly", label: "Weekly", percentRemaining: 48, percentUsed: 52, window: "week", resetAt: now() + 3 * 24 * HOUR, primary: true },
            { id: "session", label: "5-hour session", percentRemaining: 91, percentUsed: 9, window: "session", resetAt: now() + 2 * HOUR },
          ],
        },
        claude: {
          plan: "Claude Max 20x", account: "subscription", source: "Claude Code", updatedAt: now() - 3 * HOUR, error: "Claude didn't answer just now.",
          limits: [
            { id: "weekly", label: "Weekly, all models", percentRemaining: 7, percentUsed: 93, window: "week", resetAt: now() + 20 * HOUR, primary: true },
            { id: "weekly-opus", label: "Weekly, Opus", percentRemaining: 34, percentUsed: 66, window: "week", model: "Opus", resetAt: now() + 20 * HOUR },
            { id: "session", label: "5-hour session", window: "session" },
          ],
        },
        opencode: { limits: [], note: "OpenCode doesn't report a plan or limits.", updatedAt: read },
      };
      return PROVIDERS.filter((provider) => this.state.settings.providers[provider.id]?.enabled && provider.connected).map((provider) => ({
        provider: provider.id,
        name: provider.name,
        ...(mode === "keys" ? { account: "api-key", limits: [], updatedAt: read } : (shapes[provider.id] ?? { limits: [], updatedAt: read })),
      }));
    },
  };
}
