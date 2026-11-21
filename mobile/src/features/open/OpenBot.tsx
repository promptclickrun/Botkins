// A widget's or a control's tap on a Botkin (botkins://open/bot/<id>): its last chat, a new chat,
// or talking with it, as the widget was set up. `opens` is "last" (the default), "new" or "talk".
import { useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { openLiveVoice } from "@/features/voice/api";
import { api, attempt } from "@/state/link";
import { Loading } from "@/ui";
import { type BotOpens, lastOrNewChat, showChat, switchToHost, whenSynced } from "./opening";

export default function OpenBot() {
  const { id, host, opens } = useLocalSearchParams<{ id: string; host?: string; opens?: BotOpens }>();
  useEffect(() => {
    void (async () => {
      await switchToHost(host);
      await whenSynced();
      const chat = opens === "new" ? await attempt(api.createChat(id)) : await lastOrNewChat(id);
      if (!chat) return;
      showChat(chat);
      if (opens === "talk") openLiveVoice(chat, id);
    })();
  }, [id, host, opens]);
  return <Loading />;
}
