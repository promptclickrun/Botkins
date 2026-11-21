// The menus of sections on the Chats screen ("chat-sections-v1"), in the words bot sections on Home
// already use (src/features/bots/menus.ts): a chat's "Move to section", and a section's own
// Rename, Move up, Move down and Delete.
import type { MenuAction } from "@react-native-menu/menu";
import { Alert } from "react-native";
import type { ChatSummary, Section } from "@/link/types";
import { api, attempt } from "@/state/link";
import { moveChoices, sectionMoves, sectionName } from "./sections";

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
export function newSection(chat?: Pick<ChatSummary, "id" | "title">) {
  Alert.prompt(
    "New section",
    chat ? (chat.title || "This chat") + " moves into it." : undefined,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Create section",
        onPress: (value?: string) => {
          const name = sectionName(value);
          if (!name) return;
          void attempt(api["link.chats.addSection"](name).then((id) => (chat ? api["link.chats.setSection"](chat.id, id) : null)));
        },
      },
    ],
    "plain-text",
    "",
  );
}

/** Carries out one of `moveToSection`'s choices. Answers false for any other menu choice. */
export function runSectionChoice(chat: ChatSummary, event: string): boolean {
  if (!event.startsWith("section:")) return false;
  const choice = event.slice("section:".length);
  if (choice === "new") newSection(chat);
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

export function runSectionAction(sections: Section[], section: Section, event: string) {
  const moves = sectionMoves(sections, section.id);
  if (event === "up" && moves.up) void attempt(api["link.chats.orderSections"](moves.up));
  else if (event === "down" && moves.down) void attempt(api["link.chats.orderSections"](moves.down));
  else if (event === "rename")
    Alert.prompt(
      "Rename section",
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Rename",
          onPress: (value?: string) => {
            const name = sectionName(value);
            if (name && name !== section.name) void attempt(api["link.chats.renameSection"](section.id, name));
          },
        },
      ],
      "plain-text",
      section.name,
    );
  else if (event === "delete")
    Alert.alert("Delete “" + section.name + "”?", "Its chats stay. They move out of the section.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete section", style: "destructive", onPress: () => void attempt(api["link.chats.deleteSection"](section.id)) },
    ]);
}
