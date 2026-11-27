// The menu pieces a bot and a section share between Home and the bot's page, in the desktop's
// words (its src/Pages.tsx): Move to section, Hide or Show, and a section's Rename and Delete.
import type { MenuAction } from "@react-native-menu/menu";
import { Alert } from "react-native";
import type { Bot, Section } from "@/link/types";
import { api, attempt } from "@/state/link";
import type { TextPromptOptions } from "@/ui";

/** `useTextPrompt().ask` from the screen that shows the menu (it renders the dialog Android needs). */
type Ask = (options: TextPromptOptions) => void;

/** The computer takes a section name up to this long. */
const SECTION_MAX = 40;
const nameOf = (value?: string) => value?.trim().slice(0, SECTION_MAX) ?? "";

/** "Move to section": each section (the bot's own checked), "None", then "New section…". */
export function moveToSection(bot: Bot, sections: Section[] | undefined): MenuAction {
  const list = sections ?? [];
  const none = !bot.sectionId || !list.some((section) => section.id === bot.sectionId);
  return {
    id: "section",
    title: "Move to section",
    image: "folder",
    subactions: [
      ...list.map((section): MenuAction => ({ id: "section:" + section.id, title: section.name, state: bot.sectionId === section.id ? "on" : "off" })),
      { id: "section:none", title: "None", state: none ? "on" : "off" },
      { id: "section:new", title: "New section…", image: "folder.badge.plus" },
    ],
  };
}

/** Carries out one of `moveToSection`'s choices. Answers false for any other menu choice. */
export function runSectionChoice(bot: Bot, event: string, ask: Ask): boolean {
  if (!event.startsWith("section:")) return false;
  const choice = event.slice("section:".length);
  if (choice === "new")
    ask({
      title: "New section",
      message: bot.name + " moves into it.",
      confirm: "Create section",
      onSubmit: (value) => {
        const name = nameOf(value);
        if (name) void attempt(api.addSection(name).then((id) => api.setBotFlags(bot.id, { sectionId: id })));
      },
    });
  else void attempt(api.setBotFlags(bot.id, { sectionId: choice === "none" ? null : choice }));
  return true;
}

/** Hide or Show. The computer refuses to hide the primary bot, so that is offered disabled. */
export function hideAction(bot: Bot, primary: boolean): MenuAction {
  return { id: "hide", title: bot.hidden ? "Show" : "Hide", image: bot.hidden ? "eye" : "eye.slash", attributes: { disabled: primary && !bot.hidden } };
}

export const toggleHidden = (bot: Bot) => void attempt(api.setBotFlags(bot.id, { hidden: !bot.hidden }), bot.hidden ? bot.name + " is shown" : bot.name + " is hidden");

/** The section order with `id` one place up (-1) or down (1), or null when it is already at that end. */
export function movedSection(sections: readonly Section[], id: string, by: -1 | 1): string[] | null {
  const ids = sections.map((section) => section.id);
  const at = ids.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= ids.length) return null;
  [ids[at], ids[to]] = [ids[to]!, ids[at]!];
  return ids;
}

/** A section's own menu: Rename…, Move up, Move down, Delete section…. */
export function sectionActions(sections: readonly Section[], section: Section): MenuAction[] {
  return [
    { id: "rename", title: "Rename…", image: "pencil" },
    { id: "up", title: "Move up", image: "arrow.up", attributes: { disabled: !movedSection(sections, section.id, -1) } },
    { id: "down", title: "Move down", image: "arrow.down", attributes: { disabled: !movedSection(sections, section.id, 1) } },
    { id: "delete", title: "Delete section…", image: "trash", attributes: { destructive: true } },
  ];
}

export function runSectionAction(sections: readonly Section[], section: Section, event: string, ask: Ask) {
  if (event === "up" || event === "down") {
    const ids = movedSection(sections, section.id, event === "up" ? -1 : 1);
    if (ids) void attempt(api.orderSections(ids));
  } else if (event === "rename")
    ask({
      title: "Rename section",
      value: section.name,
      confirm: "Rename",
      onSubmit: (value) => {
        const name = nameOf(value);
        if (name && name !== section.name) void attempt(api.renameSection(section.id, name));
      },
    });
  else if (event === "delete")
    Alert.alert("Delete “" + section.name + "”?", "Its bots stay. They move out of the section.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete section", style: "destructive", onPress: () => void attempt(api.deleteSection(section.id)) },
    ]);
}
