// What kind of work a tool call is, from the tool's name alone ("command", "read", "edit", …), or
// null for bookkeeping that says nothing about the work. Pure, so both the work summaries
// (canvas.mjs) and the window's step icons (src/ChatActivity.tsx) read the same table.

// Tool name → how it counts in a summary. Names are the harnesses' built-in tools (Copilot's, and
// Claude's as it spells them, lowercased: WebFetch is webfetch); never arguments.
const kinds = [
  [/^(bash|powershell|shell|terminal|run_command|exec|write_bash|write_powershell|read_bash|read_powershell)$/, "command"],
  [/^(view|read|read_file|cat|open_file)$/, "read"],
  [/^(create|write|write_file|create_file)$/, "write"],
  [/^(edit|str_replace|str_replace_editor|apply_patch|patch|multi_edit|multiedit|notebookedit|notebook_edit|insert)$/, "edit"],
  [/^(grep|glob|search|search_files|find|rg|ls|list_dir|list_directory)$/, "search-files"],
  [/^(web_search|websearch|search_web|bing_search|google_search)$/, "web"],
  [/^(web_fetch|webfetch|fetch|fetch_url|browse|browser_navigate)$/, "web-page"],
  [/^(ask_user|ask)$/, "ask"],
  [/^(task|subagent|run_subagent|delegate)$/, "helper"],
  [/^(sql|update_todo|todo|todo_write|todowrite|manage_todo_list|update_plan)$/, "plan"],
  [/^(skill|read_skill|use_skill)$/, "skill"],
  [/^render_card$/, "card"],
  [/^today_/, "panel"],
];
// Bookkeeping that says nothing about the work itself.
const quiet = /^(report_intent|think|thinking|task_complete|read_agent|list_agents)$/;

export function toolKind(name) {
  const n = String(name || "").toLowerCase();
  if (quiet.test(n)) return null;
  return kinds.find(([re]) => re.test(n))?.[1] ?? "tool";
}
