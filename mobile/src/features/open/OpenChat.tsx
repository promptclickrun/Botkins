// A tap on a chat in a widget or a Live Activity (botkins://open/chat/<id>), on the computer it is about.
import { useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { Loading } from "@/ui";
import { showChat, switchToHost, whenSynced } from "./opening";

export default function OpenChat() {
  const { id, host } = useLocalSearchParams<{ id: string; host?: string }>();
  useEffect(() => {
    void (async () => {
      await switchToHost(host);
      await whenSynced();
      showChat(id);
    })();
  }, [id, host]);
  return <Loading />;
}
