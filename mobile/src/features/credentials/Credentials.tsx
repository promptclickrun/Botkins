// The Credentials Manager: what is saved on the computer, what is read from a password manager,
// the password managers themselves, and the keys tools use. Values never reach the phone.
import { router } from "expo-router";
import { History, Plus, ShieldCheck, ShieldOff, Wrench } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import type { CredentialAuditEntry, CredentialGrant } from "@/link/types";
import { usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Badge, brand, Dot, Group, IconTile, Label, Loading, Page, Row, space, T, Tap, useTheme } from "@/ui";
import { byName, CredentialMark, credentialLine, desktopVault, GateView, KeptNote, loadManagers, ManagerMark, managerBadge, type ToolCredential, useComputerName, useGate, useManagers, useProtonSupport } from "./shared";

const GRANT_META: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  always: { label: "Always allow", tone: "success" },
  today: { label: "Today", tone: "warning" },
  deny: { label: "Always deny", tone: "danger" },
  ask: { label: "Ask", tone: "neutral" },
};

const OUTCOME_META: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  allowed: { label: "Allowed", tone: "success" },
  used: { label: "Allowed", tone: "success" },
  denied: { label: "Denied", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  origin_mismatch: { label: "Origin blocked", tone: "danger" },
  rate_limited: { label: "Rate limited", tone: "warning" },
  locked: { label: "Vault locked", tone: "warning" },
  error: { label: "Error", tone: "danger" },
};

const open = (id: string) => router.push({ pathname: "/credentials/[id]", params: { id } });

export default function Credentials() {
  const gate = useGate();
  if (gate === "open") return <Body />;
  return (
    <Page title="Credentials" caption="Kept on your computer">
      <GateView gate={gate} />
    </Page>
  );
}

function Body() {
  const { colors } = useTheme();
  const computer = useComputerName();
  const credentials = usePart("credentials");
  const managers = useManagers((state) => state.managers);
  const proton = useProtonSupport();
  const mcp = usePart("mcp");
  const [toolKeys, setToolKeys] = useState<ToolCredential[] | undefined>(undefined);
  const [grants, setGrants] = useState<CredentialGrant[] | undefined>(undefined);
  const [audit, setAudit] = useState<CredentialAuditEntry[] | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);

  const loadGrantsAndAudit = async () => {
    const [g, a] = await Promise.all([
      attempt(api["link.credentials.grants"]()),
      attempt(api["link.credentials.audit"]({ limit: 20 })),
    ]);
    if (g) setGrants(g);
    if (a) setAudit(a);
  };

  useEffect(() => {
    void loadManagers();
    void loadGrantsAndAudit();
  }, []);
  // The tools' keys change when a tool does.
  useEffect(() => {
    let live = true;
    void attempt(desktopVault.credentials()).then((vault) => live && vault && setToolKeys(vault.entries));
    return () => {
      live = false;
    };
  }, [mcp]);

  const reload = async () => {
    setRefreshing(true);
    const keys = attempt(desktopVault.credentials()).then((vault) => vault && setToolKeys(vault.entries));
    await Promise.all([loadManagers(true), keys, loadGrantsAndAudit()]);
    setRefreshing(false);
  };

  const revokeGrant = (grant: CredentialGrant) =>
    Alert.alert(
      "Revoke access?",
      `${grant.botName || grant.botId} will ask again before using ${grant.credentialName || grant.credentialId} on ${grant.destination}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Revoke",
          style: "destructive",
          onPress: async () => {
            const done = await attempt(api["link.credentials.revokeGrant"](grant.id), "Revoked");
            if (done) setGrants((held) => held?.filter((item) => item.id !== grant.id));
          },
        },
      ],
    );

  const removeToolKey = (entry: ToolCredential) =>
    Alert.alert("Remove " + entry.label + "?", entry.usedBy ? "Used by " + entry.usedBy : undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          const done = await attempt(desktopVault.removeCredential(entry.id).then(() => true), "Removed");
          if (done) setToolKeys((held) => held?.filter((item) => item.id !== entry.id));
        },
      },
    ]);

  const saved = (credentials ?? []).filter((credential) => credential.source === "vault").sort(byName);
  const linked = (credentials ?? []).filter((credential) => credential.source !== "vault").sort(byName);

  return (
    <Page title="Credentials" caption="Kept on your computer" onRefresh={reload} refreshing={refreshing}>
      <View>
        <Label>{"Saved on " + computer}</Label>
        {!credentials ? (
          <Loading />
        ) : (
          <Group>
            {saved.length === 0 && (
              <View style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: space.lg }}>
                <T variant="subhead" color="muted">
                  Nothing saved yet
                </T>
              </View>
            )}
            {saved.map((credential) => (
              <Row key={credential.id} leading={<CredentialMark credential={credential} />} title={credential.name} subtitle={credentialLine(credential)} chevron onPress={() => open(credential.id)} />
            ))}
            <Row leading={<IconTile icon={Plus} color={colors.accent} size={36} />} title="Add a credential" tone="accent" onPress={() => open("new")} />
          </Group>
        )}
        <View style={{ marginTop: space.sm }}>
          <KeptNote text="Encrypted on your computer. This phone can't show them." />
        </View>
      </View>

      {linked.length > 0 && (
        <View>
          <Label>From your password manager</Label>
          <Group>
            {linked.map((credential) => (
              <Row key={credential.id} leading={<CredentialMark credential={credential} />} title={credential.name} subtitle={credentialLine(credential)} chevron onPress={() => open(credential.id)} />
            ))}
          </Group>
        </View>
      )}

      <View>
        <Label>Password managers</Label>
        {managers === undefined ? (
          <Loading />
        ) : managers === null ? (
          <Group>
            <Row title="Password managers didn't load" value="Retry" tone="accent" onPress={() => void loadManagers(true)} />
          </Group>
        ) : (
          <Group>
            {managers.map((manager) => {
              const badge = managerBadge(manager, proton);
              return (
                <Row
                  key={manager.id}
                  leading={<ManagerMark id={manager.id} />}
                  title={manager.name}
                  subtitle={manager.state === "ready" ? (manager.account ?? badge.label) : badge.label}
                  trailing={manager.state === "ready" || manager.state === "locked" || manager.state === "error" ? <Dot tone={badge.tone} /> : undefined}
                  chevron
                  onPress={() => router.push({ pathname: "/credentials/manager/[id]", params: { id: manager.id } })}
                />
              );
            })}
          </Group>
        )}
      </View>

      {!!grants?.length && (
        <View>
          <Label>Standing bot grants</Label>
          <Group>
            {grants.map((grant) => {
              const meta = GRANT_META[grant.level] ?? { label: grant.level, tone: "neutral" as const };
              const isDeny = grant.level === "deny";
              return (
                <Row
                  key={grant.id}
                  leading={<IconTile icon={isDeny ? ShieldOff : ShieldCheck} color={isDeny ? colors.danger : brand.clay} size={36} />}
                  title={`${grant.botName || grant.botId} · ${grant.credentialName || grant.credentialId}`}
                  subtitle={`${grant.destinationLabel || grant.destination} · ${grant.operation}`}
                  trailing={
                    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                      <Badge label={meta.label} tone={meta.tone} />
                      <Tap onPress={() => revokeGrant(grant)} feel="select" accessibilityLabel={`Revoke ${grant.botName || grant.botId} grant`} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm, marginRight: -space.sm }}>
                        <T variant="subhead" weight="600" color="danger">
                          Revoke
                        </T>
                      </Tap>
                    </View>
                  }
                />
              );
            })}
          </Group>
        </View>
      )}

      {!!audit?.length && (
        <View>
          <Label>Credential audit log</Label>
          <Group>
            {audit.slice(0, 10).map((entry) => {
              const meta = OUTCOME_META[entry.outcome] ?? { label: entry.outcome, tone: "neutral" as const };
              return (
                <Row
                  key={entry.id}
                  leading={<IconTile icon={History} color={colors.ink2} size={36} />}
                  title={`${entry.botName || entry.botId} · ${entry.credentialName || entry.credentialId || "Credential"}`}
                  subtitle={`${entry.destination || "—"} · ${entry.operation}`}
                  trailing={<Badge label={meta.label} tone={meta.tone} />}
                />
              );
            })}
          </Group>
        </View>
      )}

      {!!toolKeys?.length && (
        <View>
          <Label>Used by tools</Label>
          <Group>
            {toolKeys.map((entry) => (
              <Row
                key={entry.id}
                leading={<IconTile icon={Wrench} color={colors.ink2} size={36} />}
                title={entry.label}
                subtitle={entry.usedBy ? "Used by " + entry.usedBy : undefined}
                trailing={
                  <Tap onPress={() => removeToolKey(entry)} feel="select" accessibilityLabel={"Remove " + entry.label} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm, marginRight: -space.sm }}>
                    <T variant="subhead" weight="600" color="danger">
                      Remove
                    </T>
                  </Tap>
                }
              />
            ))}
          </Group>
        </View>
      )}
    </Page>
  );
}
