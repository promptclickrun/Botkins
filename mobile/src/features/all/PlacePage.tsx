// A tab that is not on the bar, opened from All as a page (route `/place/[id]`): the same screen,
// told it is a page (PageRoot), under the native bar with its back button.
import { useLocalSearchParams } from "expo-router";
import ChatList from "@/features/chat/ChatList";
import Home from "@/features/home/Home";
import Market from "@/features/market/Market";
import Spaces from "@/features/spaces/Spaces";
import Work from "@/features/work/Work";
import { EmptyState, PageRoot } from "@/ui";

export default function PlacePage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const screen = id === "home" ? <Home /> : id === "chats" ? <ChatList /> : id === "spaces" ? <Spaces /> : id === "work" ? <Work /> : id === "market" ? <Market /> : null;
  if (!screen) return <EmptyState title="This page is gone" />;
  return <PageRoot>{screen}</PageRoot>;
}
