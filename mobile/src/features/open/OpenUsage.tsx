// A tap on a usage widget (botkins://open/usage): Usage › Plans and limits, on the computer it is about.
import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { Loading } from "@/ui";
import { switchToHost } from "./opening";

export default function OpenUsage() {
  const { host } = useLocalSearchParams<{ host?: string }>();
  useEffect(() => {
    void (async () => {
      await switchToHost(host);
      router.replace("/");
      router.push("/settings/usage");
    })();
  }, [host]);
  return <Loading />;
}
