// A tap on a panel's widget (botkins://open/panel?space=…&id=…): the panel, opened in its space, on
// the computer it is about.
import { type Href, router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { spaceRoute } from "@/features/spaces/logic";
import { Loading } from "@/ui";
import { switchToHost } from "./opening";

export default function OpenPanel() {
  const { host, space, id } = useLocalSearchParams<{ host?: string; space?: string; id?: string }>();
  useEffect(() => {
    void (async () => {
      await switchToHost(host);
      router.replace("/");
      // Without a space the link names nothing to open: the list of spaces.
      router.push(spaceRoute(space, space ? id : undefined) as unknown as Href);
    })();
  }, [host, space, id]);
  return <Loading />;
}
