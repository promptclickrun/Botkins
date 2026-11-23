// The menus of sections on the Chats screen ("chat-sections-v1"), in the words bot sections on Home
// already use (src/features/bots/menus.ts): a chat's "Move to section", and a section's own
// Rename, Move up, Move down and Delete.
import type { MenuAction } from "@react-native-menu/menu";
import { Alert } from "react-native";
import type { ChatSummary, Section } from "@/link/types";
import { api, attempt } from "@/state/link";
import type { TextPromptOptions } from "@/ui";
import { moveChoices, sectionMoves, sectionName } from "./sections";

/** `useTextPrompt().ask` from the screen that shows the menu (it renders the dialog Android needs). */
type Ask = (options: TextPromptOptions) => void;

/** "Move to section": each section (the chat's own checked), "None", then "New section…". */
export function moveToSection(chat: ChatSummary, sections: Section[] | undefined): MenuAction {
  return {
    id: "section",
    title: "Move to section",
    image: "folder",
    subactions: moveChoices(chat, sections).map((choice): MenuAction => (choice.id === "section:new" ? { id: choice.id, title: choice.title, image: "folder.badge.plus" } : { id: choice.id, title: choice.title, state: choice.on ? "on" : "off" })),
  };
}

/** Asks for a new section's name. `chat` moves into it once it is made. */
export function newSection(ask: Ask, chat?: Pick<ChatSummary, "id" | "title">) {
  ask({
    title: "New section",
    message: chat ? (chat.title || "This chat") + " moves into it." : undefined,
    confirm: "Create section",
    onSubmit: (value) => {
      const name = sectionName(value);
      if (name) void attempt(api["link.chats.addSection"](name).then((id) => (chat ? api["link.chats.setSection"](chat.id, id) : null)));
    },
  });
}

/** Carries out one of `moveToSection`'s choices. Answers false for any other menu choice. */
export function runSectionChoice(chat: ChatSummary, event: string, ask: Ask): boolean {
  if (!event.startsWith("section:")) return false;
  const choice = event.slice("section:".length);
  if (choice === "new") newSection(ask, chat);
  else void attempt(api["link.chats.setSection"](chat.id, choice === "none" ? null : choice));
  return true;
}

/** A section's own menu: Rename…, Move up, Move down, Delete section…. */
export function sectionActions(sections: Section[], section: Section): MenuAction[] {
  const moves = sectionMoves(sections, section.id);
  return [
    { id: "rename", title: "Rename…", image: "pencil" },
    { id: "up", title: "Move up", image: "arrow.up", attributes: { disabled: !moves.up } },
    { id: "down", title: "Move down", image: "arrow.down", attributes: { disabled: !moves.down } },
    { id: "delete", title: "Delete section…", image: "trash", attributes: { destructive: true } },
  ];
}

export function runSectionAction(sections: Section[], section: Section, event: string, ask: Ask) {
  const moves = sectionMoves(sections, section.id);
  if (event === "up" && moves.up) void attempt(api["link.chats.orderSections"](moves.up));
  else if (event === "down" && moves.down) void attempt(api["link.chats.orderSections"](moves.down));
  else if (event === "rename")
    ask({
      title: "Rename section",
      value: section.name,
      confirm: "Rename",
      onSubmit: (value) => {
        const name = sectionName(value);
        if (name !== section.name) void attempt(api["link.chats.renameSection"](section.id, name));
      },
    });
  else if (event === "delete")
    Alert.alert("Delete “" + section.name + "”?", "Its chats stay. They move out of the section.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete section", style: "destructive", onPress: () => void attempt(api["link.chats.deleteSection"](section.id)) },
    ]);
}
