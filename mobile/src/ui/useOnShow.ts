import type { NativeStackNavigationEventMap } from "expo-router/native-stack";
import { type EventConsumer, NavigationContext, NavigationRouteContext } from "expo-router/react-navigation";
import { useContext, useLayoutEffect, useState } from "react";
import { type Level, onShow } from "./onShow";

/** How long a screen may count as appearing before the state has to agree: longer than any back swipe that is not being held. */
const APPEARING_MS = 3000;

/**
 * Whether the screen this component is on can be seen (the rule is in onShow.ts). It follows the
 * navigators from the screen up to the root, and answers true outside any screen.
 */
export function useOnShow(): boolean {
  const navigation = useContext(NavigationContext);
  const routeKey = useContext(NavigationRouteContext)?.key;
  const [seen, setSeen] = useState(true);

  useLayoutEffect(() => {
    if (!navigation || routeKey === undefined) return;
    const chain: (typeof navigation)[] = [];
    for (let nav: typeof navigation | undefined = navigation; nav; nav = nav.getParent()) {
      chain.push(nav);
    }

    // A screen under a back swipe counts as on show at once, but nothing says so when the swipe is
    // let go again. So that claim is checked against the state a few seconds later.
    let check: ReturnType<typeof setTimeout> | undefined;
    function update(appearing?: typeof navigation) {
      clearTimeout(check);
      if (appearing) check = setTimeout(() => update(), APPEARING_MS);
      const levels: Level[] = [];
      let childKey: string | undefined;
      for (const nav of chain) {
        const state = nav.getState();
        const key = childKey === undefined ? routeKey : state.routes.find((route) => route.state?.key === childKey)?.key;
        if (key === undefined) break;
        // A back swipe reveals this stack route before the pop. Its selected tab still matters.
        if (nav !== appearing) levels.push({ state, key });
        childKey = state.key;
      }
      setSeen(onShow(levels));
    }

    const unsubscribe = chain.flatMap((nav) => {
      const stopState = nav.addListener("state", () => update());
      if (nav.getState().type !== "stack") return [stopState];
      // The shared navigation context types only the core events.
      const stack = nav as EventConsumer<NativeStackNavigationEventMap>;
      // A screen that is appearing, or has just finished, is in view, though the state still lists the
      // page that was on it until a moment later: it counts as on show until that state arrives. A
      // screen that is leaving (a page goes over it, or a back swipe was let go) is judged by the state.
      const moved = ({ data }: { data: { closing: boolean } }) => (data.closing ? update() : update(nav));
      return [stopState, stack.addListener("transitionStart", moved), stack.addListener("transitionEnd", moved)];
    });
    update();
    return () => {
      clearTimeout(check);
      unsubscribe.forEach((stop) => stop());
    };
  }, [navigation, routeKey]);

  return !navigation || routeKey === undefined || seen;
}
