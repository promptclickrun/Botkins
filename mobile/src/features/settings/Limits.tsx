// Usage › Plans and limits: each connected provider's plan and what is left of its limits. The
// numbers are the provider's own, read by the computer (src/state/providerUsage.ts). A value the
// provider doesn't give is said to be not available: there is never a made-up number or bar.
import { RefreshCw } from "lucide-react-native";
import { ActivityIndicator, View } from "react-native";
import type { ProviderLimit, ProviderStatus, ProviderUsage } from "@/link/types";
import { useProviders } from "@/state/hooks";
import { type ProviderUsageView } from "@/state/providerUsage";
import { Group, Label, ProviderIcon, slopFor, space, T, Tap, useTheme } from "@/ui";
import { countWords, creditWords, limitTone, percentWords, resetWords, updatedWords } from "../models/limits";

function LimitLine({ limit }: { limit: ProviderLimit }) {
  const { colors } = useTheme();
  const percent = limit.percentRemaining;
  // The long form here ("today at 2:10 PM"); the model picker's one line has the short one.
  const reset = limit.resetAt ? resetWords(limit.resetAt, {}, false) : "";
  const tone = percent === undefined ? "ok" : limitTone(percent);
  const fill = tone === "out" ? colors.danger : tone === "low" ? colors.warning : colors.accent;
  // What the provider says besides the percent: the counts behind it, and when it starts again.
  const under = [countWords(limit), reset ? "Resets " + reset : undefined].filter(Boolean).join(" · ");
  const right = limit.unlimited ? "Unlimited" : percent === undefined ? "Not available" : percentWords(percent) + " left";
  return (
    <View
      style={{ gap: 6 }}
      accessible
      accessibilityRole={percent === undefined ? undefined : "progressbar"}
      accessibilityLabel={limit.label + ", " + right + (under ? ", " + under : "")}
      accessibilityValue={percent === undefined ? undefined : { min: 0, max: 100, now: Math.round(percent) }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
        <T variant="subhead" numberOfLines={1} style={{ flex: 1 }}>
          {limit.label}
        </T>
        <T variant="subhead" weight={percent === undefined ? "400" : "600"} color={percent === undefined ? "muted" : tone === "out" ? "danger" : tone === "low" ? "warning" : "ink"}>
          {right}
        </T>
      </View>
      {percent !== undefined && (
        <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.sunken, overflow: "hidden" }}>
          <View style={{ width: `${percent}%`, minWidth: percent > 0 ? 3 : 0, height: 6, borderRadius: 3, backgroundColor: fill }} />
        </View>
      )}
      {!!under && (
        <T variant="footnote" color="muted">
          {under}
        </T>
      )}
    </View>
  );
}

function ProviderBlock({ id, name, plan, usage }: { id: string; name: string; plan?: string; usage?: ProviderUsage }) {
  const key = usage?.account === "api-key";
  // An API key has no plan. Otherwise the plan as the limits say it, else as the provider's own page says it.
  const tier = key ? "API key" : (usage?.plan ?? plan);
  // When the numbers were read, and from what: "Updated 5 min ago · from Claude Code".
  const updated = updatedWords(usage?.updatedAt, Date.now(), usage?.source);
  return (
    <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <ProviderIcon provider={id} name={name} size={32} tile />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="callout" weight="600" numberOfLines={1}>
            {name}
          </T>
          {!!tier && (
            <T variant="footnote" color="muted" numberOfLines={1}>
              {tier}
            </T>
          )}
        </View>
      </View>
      {usage?.limits.map((limit) => <LimitLine key={limit.id} limit={limit} />)}
      {!!usage?.credits && (
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
          <T variant="subhead" numberOfLines={1} style={{ flex: 1 }}>
            {usage.credits.label}
          </T>
          <T variant="subhead" weight="600">
            {creditWords(usage.credits)}
          </T>
        </View>
      )}
      {key && (
        <T variant="subhead" color="muted">
          Billed by use. An API key has no plan limits.
        </T>
      )}
      {!usage?.limits.length && !key && !usage?.error && (
        <T variant="subhead" color="muted">
          {usage?.note ?? "Limits: not available."}
        </T>
      )}
      {!!usage?.error && (
        <T variant="footnote" color="warning" accessibilityRole="alert">
          {usage.error}
        </T>
      )}
      {!!updated && (
        <T variant="footnote" color="muted">
          {updated}
        </T>
      )}
    </View>
  );
}

/** The providers to show: the ones that are on and signed in, in the computer's order; else whatever has limits. */
function rows(providers: ProviderStatus[] | undefined, items: ProviderUsage[]) {
  const shown = providers?.filter((provider) => provider.enabled && provider.connected);
  if (shown?.length) return shown.map((provider) => ({ id: provider.id, name: provider.name, plan: provider.plan, usage: items.find((item) => item.provider === provider.id) }));
  return items.map((usage) => ({ id: usage.provider, name: usage.name ?? providers?.find((provider) => provider.id === usage.provider)?.name ?? usage.provider, plan: undefined, usage }));
}

export function Limits({ view }: { view: ProviderUsageView }) {
  const { colors } = useTheme();
  const providers = useProviders();
  // Until the computer has said what it can do, there is nothing to say.
  if (view.supported === undefined) return null;
  const head = (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <Label style={{ flex: 1 }}>Plans and limits</Label>
      {view.supported && !!view.items && (
        <Tap onPress={() => void view.refresh()} disabled={view.loading} accessibilityLabel="Read the limits again" hitSlop={slopFor(28)} style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}>
          {view.loading ? <ActivityIndicator size="small" color={colors.muted} /> : <RefreshCw size={15} color={colors.muted} strokeWidth={2.2} />}
        </Tap>
      )}
    </View>
  );
  if (!view.supported)
    return (
      <View>
        {head}
        <Group>
          <View style={{ padding: space.lg }}>
            <T variant="subhead" color="muted">
              Update the app on your computer to see plans and limits.
            </T>
          </View>
        </Group>
      </View>
    );
  if (!view.items)
    return (
      <View>
        {head}
        <Group>
          {view.error ? (
            <View style={{ padding: space.lg, flexDirection: "row", alignItems: "center", gap: space.md }}>
              <T variant="subhead" color="muted" style={{ flex: 1 }}>
                Couldn't load the limits.
              </T>
              <Tap onPress={() => void view.refresh()} accessibilityLabel="Try again" hitSlop={slopFor(30)} style={{ minHeight: 30, justifyContent: "center" }}>
                <T variant="subhead" weight="600">
                  Try again
                </T>
              </Tap>
            </View>
          ) : (
            <View style={{ padding: space.xl, alignItems: "center" }} accessibilityLabel="Loading plans and limits">
              <ActivityIndicator color={colors.muted} />
            </View>
          )}
        </Group>
      </View>
    );
  const list = rows(providers, view.items);
  return (
    <View>
      {head}
      <Group>
        {list.length ? (
          list.map((row) => <ProviderBlock key={row.id} {...row} />)
        ) : (
          <View style={{ padding: space.lg }}>
            <T variant="subhead" color="muted">
              No provider is signed in.
            </T>
          </View>
        )}
      </Group>
      {/* The last ask failed, and what is shown is from before it. */}
      {!!view.error && (
        <T variant="footnote" color="warning" style={{ marginTop: space.sm, paddingHorizontal: space.xs }}>
          Couldn't read the limits again. These are the last ones.
        </T>
      )}
    </View>
  );
}
