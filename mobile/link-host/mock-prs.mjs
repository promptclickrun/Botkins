// The demo's gh answers. These pass through the same parser and limits as a real tool result.
const repo = "example/botkins";
const pulls = [
  [42, "Share one in-flight token renewal per server", "OPEN"],
  [41, "Pricing page: final copy pass", "OPEN"],
  [39, "Compress hero images", "MERGED"],
  [37, "Try a darker footer", "CLOSED"],
].map(([number, title, state]) => ({
  number, title, state, url: "https://github.com/" + repo + "/pull/" + number,
  author: { login: number === 41 ? "quill-bot" : "mira-bot" }, isDraft: number === 41,
  baseRefName: "main", headRefName: "branch-" + number,
  createdAt: "2026-11-20T12:00:00Z", updatedAt: "2026-11-21T13:00:00Z",
  body: "Ready for **review**.", reviewDecision: "APPROVED",
  statusCheckRollup: [{ name: "Unit tests", status: "COMPLETED", conclusion: "SUCCESS" }],
  files: [{ path: "README.md", additions: 1, deletions: 0 }],
}));

export async function demoGitHub(args) {
  if (args[1] === "list") {
    const query = args.find((arg) => arg.startsWith("--search="))?.slice(9).toLowerCase() ?? "";
    return JSON.stringify(pulls.filter((pull) => pull.title.toLowerCase().includes(query)));
  }
  if (args[1] === "view" && (!args.includes("--repo") || args.includes("github.com/" + repo))) {
    const pull = pulls.find((item) => item.number === Number(args[2]));
    if (pull) return JSON.stringify(pull);
  }
  if (args[0] === "api" && pulls.some((item) => args.at(-1) === "repos/" + repo + "/pulls/" + item.number + "/files?per_page=100"))
    return JSON.stringify([[{ filename: "README.md", patch: "@@ -1 +1,2 @@\n Botkins\n+Ready for review." }]]);
  throw Object.assign(new Error(), { kind: "exit", detail: "HTTP 404" });
}
