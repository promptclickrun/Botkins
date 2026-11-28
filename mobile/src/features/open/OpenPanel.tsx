// A tap on a panel's widget (botkins://open/panel?space=…&id=…): the panel, opened in its space, on
// the computer it is about.
import { type Href, router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { openPlace } from "@/features/all/open";
import { spaceRoute } from "@/features/spaces/logic";
import { Loading } from "@/ui";
import { switchToHost } from "./opening";

export default function OpenPanel() {
  const { host, space, id } = useLocalSearchParams<{ host?: string; space?: string; id?: string }>();
  useEffect(() => {
    void (async () => {
      await switchToHost(host);
      router.replace("/");
      // Without a space the link names nothing to open: the list of spaces, as its tab or its page.
      if (space) router.push(spaceRoute(space, id) as unknown as Href);
      else openPlace("spaces");
    })();
  }, [host, space, id]);
  return <Loading />;
}
