import { NativeTabs } from "expo-router/native-tabs";
import { isConversation } from "@/state/hooks";
import { useApp } from "@/state/store";
import { badgeColors, useTheme } from "@/ui";

export default function TabsLayout() {
  const theme = useTheme();
  const { colors } = theme;
  const badge = badgeColors(theme);
  const unread = useApp((state) => state.parts.chats?.filter((chat) => chat.unread && isConversation(chat)).length ?? 0);
  const waiting = useApp((state) => (state.parts.live?.requests.length ?? 0) + (state.parts.tasks?.filter((task) => task.status === "review" || task.status === "blocked").length ?? 0));
  const teamRequests = useApp((state) => {
    const team = state.parts.team;
    return state.parts.meta?.you?.kind !== "member" && team && "requests" in team ? team.requests.length : 0;
  });
  return (
    <NativeTabs tintColor={colors.accent} backgroundColor={colors.canvas} badgeBackgroundColor={badge.background} badgeTextColor={badge.text}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} md="home" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="chats">
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" }} md="forum" />
        {unread > 0 && <NativeTabs.Trigger.Badge>{String(unread)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="work">
        <NativeTabs.Trigger.Label>Work</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "bolt", selected: "bolt.fill" }} md="bolt" />
        {waiting > 0 && <NativeTabs.Trigger.Badge>{String(waiting)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="market">
        {/* Short on purpose: a long label widens its tab and the selected bubble next to it runs into it. */}
        <NativeTabs.Trigger.Label>Market</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "square.grid.2x2", selected: "square.grid.2x2.fill" }} md="apps" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} md="settings" />
        {teamRequests > 0 && <NativeTabs.Trigger.Badge>{String(teamRequests)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
