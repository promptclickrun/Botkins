// Whether a screen can be seen, from the navigation state alone. What loops for ever (a Botkin's
// motion, the typing dots) runs only on a screen that is on show: a screen under another page, or in
// a tab that isn't selected, stays mounted, and its motion would cost the phone for nothing.
// When something isn't known the answer is "on show": better a Botkin that moves unseen than one
// that stands still while it is looked at. No React or React Native imports, so a test can run it.
type State = {
  type?: string;
  key: string;
  index: number;
  routes: readonly { key: string; name: string; state?: { key?: string } }[];
};

/** One navigator on the way from a screen up to the root, and the key of the route the screen is in there. */
export type Level = { state: State; key: string };
/**
 * The root stack's routes that open as sheets (src/app/_layout.tsx). A sheet leaves what is under it
 * in view. tests/onshow.test.ts fails when this list and that file differ.
 */
export const SHEETS = new Set([
  "chat/new", "chat/model", "chat/activity", "chat/helper", "chat/command", "chat/context", "chat/people", "chat/changes", "chat/pane", "chat/model-info",
  "bot/new", "bot/agents", "bot/[id]/edit", "bot/[id]/look", "bot/[id]/instructions", "bot/[id]/memory", "bot/[id]/voice", "bot/[id]/proactive-setup",
  "today/new", "today/routine", "space/share", "space/new-panel", "space/ask", "space/notes", "routine/[id]", "workflow/[id]", "task/[id]", "tools/[id]", "skills/[name]", "market/app/[slug]", "market/plugin-install", "market/plugin-update", "market/add-marketplace", "market/tool",
  "settings/bubble", "settings/team/role", "tools/import", "folders", "credentials/[id]", "wiki/edit", "wiki/export", "models/signin", "projects/add-chats", "projects/attach", "pair/index", "pair/manual", "pair/name", "join", "setup",
]);
export const isSheet = (name: string) => SHEETS.has(name);

/**
 * On show when, at every navigator: in a stack, everything above the screen's route is a sheet; in
 * any other (the tabs), the screen's route is the selected one.
 */
export function onShow(levels: Level[], sheet = isSheet): boolean {
  return levels.every(({ state, key }) => {
    const index = state.routes.findIndex((route) => route.key === key);
    if (index < 0 || state.type === undefined) return true;
    if (state.type === "stack") return state.routes.slice(index + 1).every((route) => sheet(route.name));
    return !state.routes[state.index] || index === state.index;
  });
}
