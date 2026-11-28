// A move's new order, shown at once until the computer's own state arrives: while its calls are
// out, then until the bots change once more after they finish (or DRAG.HOLD_ORDER_MS). A failed
// call shows its toast and the computer's order comes back. Home's board and the first tab's row
// both carry out their drops with it.
import { useEffect, useState } from "react";
import type { Bot } from "@/link/types";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { applyPlan, DRAG, type Plan } from "./drag";

export function useHeldOrder(bots: Bot[]) {
  const [pending, setPending] = useState<{ bots: Bot[]; done?: Bot[] } | null>(null);
  const stale = !!pending?.done && pending.done !== bots;
  useEffect(() => {
    if (stale) setPending(null);
  }, [stale]);
  useEffect(() => {
    if (!pending?.done) return;
    const timer = setTimeout(() => setPending(null), DRAG.HOLD_ORDER_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  /** Show the bots as `plan` leaves them, and ask the computer for it. */
  const carry = (id: string, plan: Plan) => {
    const shown = applyPlan(bots, id, plan);
    setPending({ bots: shown });
    void (async () => {
      let ok = true;
      if (plan.flags) ok = !!(await attempt(api.setBotFlags(id, plan.flags).then(() => true)));
      if (ok && plan.order) ok = !!(await attempt(api.reorderBots(plan.order).then(() => true)));
      // Kept until the bots change after this, so the list doesn't flick back to the old order first.
      setPending((now) => (now?.bots === shown ? (ok ? { bots: shown, done: useApp.getState().parts.bots ?? [] } : null) : now));
    })();
  };
  return { shown: pending && !stale ? pending.bots : bots, carry };
}
