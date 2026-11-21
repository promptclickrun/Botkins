import { useState, type DragEvent } from "react";
import type { Chat } from "./types";

// Dragging a chat on the Chats page into one of the person's sections ("chat-sections-v1"), or out
// of its section onto the chats in no section. The target is outlined while the chat is over it,
// as when a bot is dragged into a section on Home.
const dragType = "application/x-botkins-chat";

export function useChatDrag(chats: Chat[], fail: (error: unknown) => void) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /** The props of a place a chat can be dropped on: a section's id, or null for no section. */
  function place(sectionId: string | null) {
    const key = sectionId ?? "";
    return {
      "data-drag-over": over === key || undefined,
      onDragOver(e: DragEvent<HTMLElement>) {
        if (!e.dataTransfer.types.includes(dragType)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setOver(key);
      },
      onDragLeave(e: DragEvent<HTMLElement>) {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((now) => (now === key ? null : now));
      },
      onDrop(e: DragEvent<HTMLElement>) {
        if (!e.dataTransfer.types.includes(dragType)) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(null);
        setOver(null);
        const chat = chats.find((item) => item.id === e.dataTransfer.getData(dragType));
        if (!chat || (chat.sectionId ?? null) === sectionId) return;
        window.botkins["link.chats.setSection"](chat.id, sectionId).catch(fail);
      },
    };
  }
  return {
    place,
    /** The chat being dragged, while one is. */
    dragging: dragging ? chats.find((chat) => chat.id === dragging) : undefined,
    row(chat: Chat) {
      return {
        draggable: true,
        onDragStart(e: DragEvent<HTMLElement>) {
          e.dataTransfer.setData(dragType, chat.id);
          e.dataTransfer.effectAllowed = "move";
          setDragging(chat.id);
        },
        onDragEnd() {
          setDragging(null);
          setOver(null);
        },
      };
    },
  };
}
