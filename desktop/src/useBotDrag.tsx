import { useState, type DragEvent } from "react";
import { moveBot, type BotPlace } from "./moveBot";
import type { Bot } from "./types";

const dragType = "application/x-botkins-bot";
const unsorted: BotPlace = { pinned: false, sectionId: null };
export function useBotDrag(bots: Bot[], fail: (error: unknown) => void) {
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState("");
  function dropProps(place: BotPlace, target?: string, horizontal = false) {
    const key = JSON.stringify([place, target]);
    return {
      "data-drag-over": over === key || undefined,
      onDragOver(e: DragEvent<HTMLElement>) {
        if (!e.dataTransfer.types.includes(dragType)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setOver(key);
      },
      onDrop(e: DragEvent<HTMLElement>) {
        if (!e.dataTransfer.types.includes(dragType)) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        setOver("");
        const id = e.dataTransfer.getData(dragType);
        const rect = e.currentTarget.getBoundingClientRect();
        const after = horizontal ? e.clientX > rect.left + rect.width / 2 : e.clientY > rect.top + rect.height / 2;
        const move = moveBot(bots, id, place, target, after);
        if (!move) return;
        const bot = bots.find(b => b.id === id)!;
        void (async () => {
          if (!!bot.pinned !== place.pinned || (bot.sectionId ?? null) !== place.sectionId)
            await window.botkins.setBotFlags(id, move.flags);
          if (move.ids.some((value, index) => value !== bots[index].id)) await window.botkins.reorderBots(move.ids);
        })().catch(fail);
      },
    };
  }
  return {
    place: dropProps,
    dragging,
    row(bot: Bot, horizontal = false) {
      if (bot.id === bots[0]?.id || bot.hidden) return {};
      return {
        draggable: true,
        onDragStart(e: DragEvent<HTMLElement>) {
          e.dataTransfer.setData(dragType, bot.id);
          e.dataTransfer.effectAllowed = "move";
          setDragging(true);
        },
        onDragEnd() { setDragging(false); setOver(""); },
        ...dropProps({ pinned: !!bot.pinned, sectionId: bot.pinned ? null : bot.sectionId ?? null }, bot.id, horizontal),
      };
    },
    zones(sections: { id: string; name: string }[]) {
      if (!dragging) return null;
      const zones = [{ label: "Pinned", place: { pinned: true, sectionId: null } },
        ...sections.map(s => ({label:s.name, place:{pinned:false, sectionId:s.id}})), { label:"Other bots", place:unsorted }];
      return <div className="bot-drop-zones">{zones.map(({label, place}) =>
        <div key={JSON.stringify(place)} {...dropProps(place)}>{label}</div>
      )}</div>;
    },
  };
}
