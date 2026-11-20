// The Credentials Manager: what is saved on the computer, what is read from a password manager,
// the password managers themselves, and the keys tools use. Values never reach the phone.
import { router } from "expo-router";
import { Plus, Wrench } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { usePart } from "@/state/hooks";
import { attempt } from "@/state/link";
import { Dot, Group, IconTile, Label, Loading, Page, Row, space, T, Tap, useTheme } from "@/ui";
import { byName, CredentialMark, credentialLine, desktopVault, GateView, KeptNote, loadManagers, ManagerMark, managerBadge, type ToolCredential, useComputerName, useGate, useManagers } from "./shared";

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
  const mcp = usePart("mcp");
  const [toolKeys, setToolKeys] = useState<ToolCredential[] | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void loadManagers();
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
    await Promise.all([loadManagers(true), keys]);
    setRefreshing(false);
  };

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
              const badge = managerBadge(manager);
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
