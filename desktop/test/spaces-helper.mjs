// For smokes that go to Today or to its Feed, Ideas and Goals. On a computer with Spaces
// ("spaces-v1") each of the four is a space in the side menu's Spaces list; on one without them
// Today is a place, and the other three are tabs on its page. These helpers get there either way.

const places = (page) => page.getByRole("navigation", { name: "Workspace" });
const spaces = (page) => page.getByRole("navigation", { name: "Spaces" });

/** Whether the window shows Spaces. Waits until the side menu has drawn one or the other. */
export async function showsSpaces(page) {
  const place = places(page).getByRole("button", { name: "Today", exact: true });
  const space = spaces(page).getByRole("button", { name: "Today", exact: true });
  await place.or(space).first().waitFor();
  return (await space.count()) > 0;
}

/** Opens one of the person's pinned spaces by its name. */
export async function openSpace(page, name) {
  await spaces(page).getByRole("button", { name, exact: true }).click();
  await page.getByRole("heading", { name, exact: true, level: 1 }).waitFor();
}

/** Opens Today: the owner's Today space, or the Today place. */
export async function openToday(page) {
  if (await showsSpaces(page)) await openSpace(page, "Today");
  else await places(page).getByRole("button", { name: "Today", exact: true }).click();
}

/** Opens Feed, Ideas or Goals: that space, or that tab of the Today page's board. */
export async function openBoard(page, name) {
  if (await showsSpaces(page)) return openSpace(page, name);
  await openToday(page);
  await page.getByRole("region", { name: "Feed, Ideas and Goals" }).getByRole("tab", { name: new RegExp(name) }).click();
}
