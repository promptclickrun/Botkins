// Settings › General › Claude artifacts on phone (#267 layout): availability, model, and per-bot standing grants.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { RefreshCw, Sparkles } from "lucide-react-native";
import { useBots, useCapability, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { brand, EmptyState, Group, IconTile, Label, Loading, Page, Row, T, useOnShow } from "@/ui";
import { ChoiceRow } from "./shared";
type Status = Awaited<ReturnType<(typeof api)["claudeArtifacts.status"]>>;

const MODELS: { value: "haiku" | "sonnet" | "opus"; title: string; subtitle: string }[] = [
  { value: "haiku", title: "Haiku", subtitle: "Fastest and uses the least of your Claude plan" },
  { value: "sonnet", title: "Sonnet", subtitle: "Balanced speed and capability" },
  { value: "opus", title: "Opus", subtitle: "Highest reasoning, highest plan usage" },
];

export default function ClaudeArtifactsScreen() {
  const capable = useCapability("claude-artifacts-v1");
  const shown = useOnShow();
  const bots = useBots();
  const revision = useApp((state) => state.parts.revs?.providers);
  const meta = usePart("meta");
  const owner = meta?.you?.kind !== "member";
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (refresh = false) => {
    if (!capable) return;
    setBusy(true);
    void api["claudeArtifacts.status"](refresh)
      .then((next) => setStatus(next))
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    if (shown && capable) load(false);
  }, [shown, capable, revision]);

  if (!owner || !capable) {
    return (
      <Page title="Claude artifacts">
        <EmptyState title="Not available on this computer" text="Update the app on your computer to manage Claude artifacts." />
      </Page>
    );
  }

  if (!status) {
    return (
      <Page title="Claude artifacts">
        <Loading />
      </Page>
    );
  }

  const granted = new Set(status.grants.map((g) => g.botId));
  const visibleBots = (bots ?? []).filter((b) => !b.hidden);
  const availability = status.available
    ? ["Available", status.plan, status.account].filter(Boolean).join(" · ")
    : status.installed
      ? status.signedIn
        ? "Needs claude.ai subscription"
        : "Not signed in"
      : "Claude Code not found";

  return (
    <Page title="Claude artifacts">
      <View>
        <Group>
          <Row leading={<IconTile icon={Sparkles} color={brand.tide} />} title="Availability" subtitle={availability} />
          <Row title="Refresh status" leading={<IconTile icon={RefreshCw} color={brand.tide} />} disabled={busy} onPress={() => load(true)} />
        </Group>
        <T variant="footnote" color="muted" style={{ marginTop: 8, paddingHorizontal: 4 }}>
          {status.available
            ? "Offered to every bot regardless of harness. Pages are private on claude.ai by default."
            : status.reason || "Install Claude Code and sign in with a claude.ai subscription."}
        </T>
      </View>

      <View>
        <Label>Artifact model</Label>
        <Group>
          {MODELS.map((option) => (
            <ChoiceRow
              key={option.value}
              title={option.title}
              subtitle={option.subtitle}
              selected={status.model === option.value}
              onPress={() => {
                if (busy || status.model === option.value) return;
                setBusy(true);
                void attempt(api["claudeArtifacts.setModel"](option.value))
                  .then((next) => next && setStatus(next))
                  .finally(() => setBusy(false));
              }}
            />
          ))}
        </Group>
        <T variant="footnote" color="muted" style={{ marginTop: 8, paddingHorizontal: 4 }}>
          Used for headless Claude Code Artifact tool sub-runs.
        </T>
      </View>

      <View>
        <Label>Standing bot grants</Label>
        <Group>
          {visibleBots.length ? (
            visibleBots.map((bot) => {
              const on = granted.has(bot.id);
              return (
                <Row
                  key={bot.id}
                  title={bot.name}
                  subtitle={on ? "Always allowed" : "Ask on first publish per chat"}
                  toggled={on}
                  disabled={busy}
                  onToggle={(next) => {
                    setBusy(true);
                    void attempt(api["claudeArtifacts.setBotApproval"](bot.id, next))
                      .then((updated) => updated && setStatus(updated))
                      .finally(() => setBusy(false));
                  }}
                />
              );
            })
          ) : (
            <Row title="No bots yet" subtitle="Create a bot to manage standing grants." />
          )}
        </Group>
        <T variant="footnote" color="muted" style={{ marginTop: 8, paddingHorizontal: 4 }}>
          Bots with a standing grant can publish without asking first, including from routines.
        </T>
      </View>
    </Page>
  );
}
