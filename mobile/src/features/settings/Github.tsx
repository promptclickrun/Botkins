// Settings › GitHub (owner-only).
// Install/manage Botkins Agent on GitHub, view bound installations, toggle built-in
// @botkins-agent mention answering and default bot per repo, and check delivery status.
import { Stack } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useState } from "react";
import { Alert, View } from "react-native";
import type { GithubAgentRepoConfig, GithubAgentStatus } from "@/link/types";
import { useBots, useOnline, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { computerLacksGithub, githubNotice } from "./githubNotice";
import { Button, EmptyState, Field, Group, Label, Page, Row, space, T } from "@/ui";

function formatShortTime(iso?: string | null): string {
  if (!iso) return "None yet";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function GithubSettings() {
  const meta = usePart("meta");
  const owner = meta?.you?.kind !== "member";
  const online = useOnline();
  const bots = (useBots() ?? []).filter((b) => !b.hidden);
  const [status, setStatus] = useState<GithubAgentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [allowDrafts, setAllowDrafts] = useState<Record<string, string>>({});
  // The computer answered that it can't do GitHub's calls: nothing here can work until that is put right there.
  const [old, setOld] = useState(false);

  const load = useCallback(async (refreshFromRelay = false) => {
    if (!owner) {
      setLoading(false);
      return;
    }
    let next: GithubAgentStatus | undefined;
    try {
      next = await (refreshFromRelay ? api.githubAgentRefresh() : api.githubAgentStatus());
      setOld(false);
    } catch (error) {
      // An older computer is said once, on the page, in words a person can act on; anything else as before.
      if (computerLacksGithub(error)) setOld(true);
      else showToast(error instanceof Error ? error.message : "That didn't work.", "error");
    }
    if (next) {
      setStatus(next);
      setAllowDrafts((prev) => {
        const merged = { ...prev };
        for (const r of next.repos ?? []) {
          if (merged[r.fullName] === undefined) merged[r.fullName] = (r.allowlist ?? []).join(", ");
        }
        return merged;
      });
    }
    setLoading(false);
  }, [owner]);

  useEffect(() => {
    if (online && owner) void load(true);
    else setLoading(false);
  }, [online, owner, load]);

  if (!owner) {
    return (
      <Page>
        <Stack.Screen options={{ title: "GitHub" }} />
        <Group>
          <View style={{ padding: space.md }}>
            <T variant="callout" color="muted">
              Only this computer&apos;s owner can manage the Botkins Agent GitHub App.
            </T>
          </View>
        </Group>
      </Page>
    );
  }

  if (old)
    return (
      <Page>
        <Stack.Screen options={{ title: "GitHub" }} />
        {/* Which computer answered, and what it runs: with several computers joined, it is the one Settings is for. */}
        <EmptyState {...githubNotice(meta)} action="Check again" onAction={() => void load(true)} />
      </Page>
    );

  const hasInstallations = (status?.installations?.length ?? 0) > 0;
  const appSlug = status?.appSlug || "botkins-agent";

  const handleInstall = async () => {
    setBusy(true);
    try {
      const res = await attempt(api.githubAgentInstallUrl());
      if (res?.url) {
        await WebBrowser.openBrowserAsync(res.url);
        await load(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    setBusy(true);
    try {
      await load(true);
    } finally {
      setBusy(false);
    }
  };

  const handleUnbind = (installationId: number, label: string) => {
    Alert.alert(
      "Disconnect installation",
      `Stop routing GitHub events for ${label} to this computer?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setBusy(true);
              try {
                const next = await attempt(api.githubAgentUnbind(installationId), "Disconnected");
                if (next) setStatus(next);
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
  };

  const patchRepo = async (
    repo: string,
    patch: { answerMentions?: boolean; defaultBotId?: string | null; allowlist?: string[] | string },
    toast?: string,
  ) => {
    setBusy(true);
    try {
      const next = await attempt(api.githubAgentSetRepo(repo, patch), toast);
      if (next) setStatus(next);
    } finally {
      setBusy(false);
    }
  };

  const toggleRelayTokenFallback = async (relayUserTokenFallback: boolean) => {
    setBusy(true);
    try {
      const next = await attempt(api.githubAgentSetSettings({ relayUserTokenFallback }));
      if (next) setStatus(next);
    } finally {
      setBusy(false);
    }
  };

  const pickDefaultBot = (repo: GithubAgentRepoConfig) => {
    const buttons = [
      {
        text: "Primary bot",
        onPress: () => void patchRepo(repo.fullName, { defaultBotId: null }),
      },
      ...bots.map((b) => ({
        text: b.name,
        onPress: () => void patchRepo(repo.fullName, { defaultBotId: b.id }),
      })),
      { text: "Cancel", style: "cancel" as const },
    ];
    Alert.alert("Default bot", `Choose which bot answers @${appSlug} on ${repo.fullName} when no bot name is given.`, buttons);
  };

  const botNameFor = (botId: string | null) => {
    if (!botId) return "Primary bot";
    return bots.find((b) => b.id === botId)?.name ?? "Primary bot";
  };

  return (
    <Page>
      <Stack.Screen options={{ title: "GitHub" }} />
      <View style={{ gap: space.lg }}>
        <View>
          <Label>Botkins Agent</Label>
          <Group>
            <Row
              title="Connection"
              value={
                loading && !status
                  ? "Checking…"
                  : status?.relayConnected
                    ? hasInstallations
                      ? "Connected"
                      : "Not installed"
                    : "Relay offline"
              }
            />
            <Row title="Events" value={status?.eventsOn ? "On" : "Off"} />
            <Row
              title="Last delivery"
              subtitle={status?.lastDelivery ? `${status.lastDelivery.event} · ${status.lastDelivery.repository}` : undefined}
              value={formatShortTime(status?.lastDelivery?.receivedAt)}
            />
          </Group>
          <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap", marginTop: space.sm }}>
            <Button
              title={hasInstallations ? "Add installation" : "Install Botkins Agent"}
              onPress={() => void handleInstall()}
              disabled={busy || !online}
              size="sm"
            />
            {hasInstallations && (
              <Button
                title="Manage on GitHub"
                variant="secondary"
                size="sm"
                disabled={busy}
                onPress={() => {
                  const url = status?.installations?.[0]?.manageUrl || status?.manageAppUrl || `https://github.com/apps/${appSlug}`;
                  void WebBrowser.openBrowserAsync(url);
                }}
              />
            )}
            <Button
              title="Refresh"
              variant="secondary"
              size="sm"
              disabled={busy || !online}
              onPress={() => void handleRefresh()}
            />
          </View>
          <T variant="caption" color="muted" style={{ marginTop: space.xs }}>
            Mention @{appSlug} (or @{appSlug} &lt;bot name&gt;) on an issue or PR. Replies post as Botkins Agent with the answering bot&apos;s name.
          </T>
        </View>

        <View>
          <Label>Installations</Label>
          <Group>
            {!hasInstallations ? (
              <Row
                title="No installations bound"
                subtitle="Tap Install Botkins Agent above to connect an account or organization."
              />
            ) : (
              status!.installations.map((inst) => (
                <Row
                  key={inst.installationId}
                  title={`${inst.accountLogin || `Installation #${inst.installationId}`} (${inst.accountType})`}
                  subtitle={
                    inst.expired
                      ? `Expired${inst.installerLogin ? ` (@${inst.installerLogin})` : ""} · tap Re-authorize to resume events and tokens`
                      : `${inst.repos.length} verified ${inst.repos.length === 1 ? "repo" : "repos"}${inst.installerLogin ? ` · @${inst.installerLogin}` : ""}${inst.expiresAt ? ` · expires ${formatShortTime(new Date(inst.expiresAt).toISOString())}` : ""}`
                  }
                  trailing={
                    <View style={{ flexDirection: "row", gap: space.xs }}>
                      {inst.expired && (
                        <Button
                          title="Re-authorize"
                          size="sm"
                          disabled={busy || !online}
                          onPress={() => void handleInstall()}
                        />
                      )}
                      <Button
                        title="Disconnect"
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onPress={() => handleUnbind(inst.installationId, inst.accountLogin || `#${inst.installationId}`)}
                      />
                    </View>
                  }
                />
              ))
            )}
          </Group>
        </View>

        <View>
          <Label>Repositories</Label>
          {!(status?.repos?.length) ? (
            <Group>
              <Row
                title="No repositories yet"
                subtitle="Install Botkins Agent on GitHub and grant access to repositories, then tap Refresh."
              />
            </Group>
          ) : (
            <View style={{ gap: space.md }}>
              {status!.repos.map((repo) => {
                const draft = allowDrafts[repo.fullName] ?? (repo.allowlist ?? []).join(", ");
                return (
                  <Group key={repo.fullName}>
                    <Row
                      title={repo.fullName}
                      subtitle={`Answer @${appSlug} mentions`}
                      toggled={repo.answerMentions}
                      onToggle={(answerMentions) => void patchRepo(repo.fullName, { answerMentions })}
                    />
                    <Row
                      title="Default bot"
                      value={botNameFor(repo.defaultBotId)}
                      chevron
                      onPress={() => pickDefaultBot(repo)}
                    />
                    <View style={{ padding: space.md, gap: space.xs }}>
                      <Field
                        label="Extra allowlist (optional)"
                        hint="Comma-separated GitHub logins allowed in addition to the installer and write collaborators."
                        placeholder="alice, bob"
                        value={draft}
                        onChangeText={(text) => setAllowDrafts((prev) => ({ ...prev, [repo.fullName]: text }))}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                        <Button
                          title="Save allowlist"
                          variant="secondary"
                          size="sm"
                          disabled={busy || !online}
                          onPress={() => void patchRepo(repo.fullName, { allowlist: draft }, "Allowlist saved")}
                        />
                      </View>
                    </View>
                  </Group>
                );
              })}
            </View>
          )}
        </View>

        <View>
          <Label>Fallback without App binding</Label>
          <Group>
            <Row
              title="Send local gh token to relay when unbound"
              subtitle="When no live Botkins Agent binding exists, your local GitHub CLI token is sent to the relay to check private repository access."
              toggled={Boolean(status?.relayUserTokenFallback)}
              onToggle={(checked) => void toggleRelayTokenFallback(checked)}
            />
          </Group>
          <T variant="caption" color="muted" style={{ marginTop: space.xs }}>
            Off by default. Bound rooms never send a personal token, and public repositories need no token. Turn this on only for private repositories on an unbound self-hosted relay.
          </T>
        </View>
      </View>
    </Page>
  );
}
