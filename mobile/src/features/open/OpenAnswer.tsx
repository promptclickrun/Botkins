// "Allow once" on a risky approval, from a notification or a Live Activity: the app opens on the
// chat, asks for Face ID, Touch ID or the passcode, and only then answers. It stands in for the
// press and hold the request panel asks for (docs/live-cards.md, section 7).
import { useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { verifyOwner } from "@/features/credentials/shared";
import { api, attempt } from "@/state/link";
import { Loading } from "@/ui";
import { showChat, switchToHost, whenSynced } from "./opening";

export default function OpenAnswer() {
  const { request, chat, host } = useLocalSearchParams<{ request?: string; chat?: string; host?: string }>();
  useEffect(() => {
    void (async () => {
      await switchToHost(host);
      await whenSynced();
      if (chat) showChat(chat);
      if (request && (await verifyOwner("Allow the risky command"))) await attempt(api.respond(request, { action: "approve" }), "Allowed");
    })();
  }, [request, chat, host]);
  return <Loading />;
}
