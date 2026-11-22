// The hold menu of a member in Settings › Team. The page is the owner's alone, so so is the menu.
import type { MenuAction } from "@react-native-menu/menu";
import type { Group, Member } from "@/link/types";

/** Rename… needs a computer that names "member-rename-v1"; an older one has no such call, so it is left out. */
export function memberActions(member: Pick<Member, "groupId">, groups: Pick<Group, "id" | "name">[], canRename: boolean): MenuAction[] {
  return [
    ...(canRename ? [{ id: "rename", title: "Rename…", image: "pencil" }] : []),
    {
      id: "group",
      title: "Move to group",
      image: "person.2",
      subactions: groups.map((group): MenuAction => ({ id: "group:" + group.id, title: group.name, state: group.id === member.groupId ? "on" : "off" })),
    },
    { id: "remove", title: "Remove…", image: "person.badge.minus", attributes: { destructive: true } },
  ];
}

export type MemberChoice = { do: "rename" } | { do: "remove" } | { do: "move"; groupId: string };

/** What a chosen menu item asks for, or null for one that is not a member's. */
export function memberChoice(event: string): MemberChoice | null {
  if (event === "rename" || event === "remove") return { do: event };
  return event.startsWith("group:") ? { do: "move", groupId: event.slice("group:".length) } : null;
}
