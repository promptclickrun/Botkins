import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Copy, Download, ExternalLink, KeyRound, LogOut, Power } from "lucide-react-native";
import { Alert, StyleSheet, View } from "react-native";
import type { ProviderStatus } from "@/link/types";
import { refresh, useCapability, useMember, useModels, useProviders } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { Badge, Button, EmptyState, Group, IconButton, IconTile, Label, Loading, Page, ProviderIcon, radius, Row, space, T, useTheme } from "@/ui";
import { Services } from "./Services";
import { providerAction, SIGNIN_CAPABILITY } from "./signin";
import { providerBadge } from "./status";

export default function ProviderPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const providers = useProviders();
  const member = useMember();
  const provider = providers?.find((entry) => entry.id === id);
  if (member) return <Page><EmptyState title="Only the owner can manage providers" /></Page>;
  if (!providers) return (
      <Page>
        <Loading />
      </Page>
    );
  if (!provider)
    return (
      <Page>
        <EmptyState title="This provider is gone" />
      </Page>
    );
  return <Detail provider={provider} />;
}

function Detail({ provider }: { provider: ProviderStatus }) {
  const { colors } = useTheme();
  const models = useModels()?.filter((model) => model.provider === provider.id);
  const badge = providerBadge(provider);
  // "provider-signin-v1": the computer runs the sign-in or the install, and the phone finishes it.
  const action = providerAction(provider, useCapability(SIGNIN_CAPABILITY));
  const openSheet = (mode: "signin" | "install" | "token") => router.push({ pathname: "/models/signin", params: { id: provider.id, mode } });

  const setOn = async (on: boolean) => {
    await attempt(api.setProviderEnabled(provider.id, on));
    await refresh("providers");
  };
  const signIn = () => void attempt(api.signIn(provider.id), "Finish signing in on your computer");
  const signOut = () =>
    Alert.alert("Sign out of " + provider.name + "?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          await attempt(api.signOut(provider.id));
          await refresh("providers");
        },
      },
    ]);
  const copy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    showToast("Copied", "success");
  };

  const facts = [
    { title: "Account", value: provider.account },
    { title: "Plan", value: provider.plan },
    { title: "Version", value: provider.version },
  ].filter((fact): fact is { title: string; value: string } => !!fact.value);

  return (
    <Page>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
        <ProviderIcon provider={provider.id} name={provider.name} size={64} tile />
        <View style={{ flex: 1, gap: space.xs }}>
          <T variant="title1" accessibilityRole="header" numberOfLines={2}>
            {provider.name}
          </T>
          <Badge label={badge.label} tone={badge.tone} />
        </View>
      </View>
      {!!provider.description && (
        <T variant="subhead" color="muted" style={{ marginTop: -space.sm }}>
          {provider.description}
        </T>
      )}

      <Group>
        <Row leading={<IconTile icon={Power} color={provider.enabled ? colors.success : colors.muted} />} title="On" toggled={provider.enabled} onToggle={(on) => void setOn(on)} />
      </Group>

      {!!provider.error && provider.installed && (
        <View style={{ padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.dangerSoft }}>
          <T variant="subhead" color="danger">
            {provider.error}
          </T>
        </View>
      )}

      {!provider.installed ? (
        <View style={{ gap: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
          <T variant="callout" weight="600">
            {provider.message ?? "Install it on your computer first."}
          </T>
          {action.kind === "install" && <Button title="Install on your computer" icon={Download} size="lg" wide onPress={() => openSheet("install")} />}
          {!!provider.install?.command && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.md, borderRadius: radius.sm, backgroundColor: colors.sunken }}>
              <T variant="mono" selectable style={{ flex: 1, paddingVertical: space.md }}>
                {provider.install.command}
              </T>
              <IconButton icon={Copy} label="Copy install command" size={44} color={colors.ink2} onPress={() => void copy(provider.install!.command!)} />
            </View>
          )}
          {!!provider.install?.url && <Button title="Install guide" icon={ExternalLink} variant="secondary" size="sm" onPress={() => void WebBrowser.openBrowserAsync(provider.install!.url)} />}
        </View>
      ) : (
        <>
          {action.kind === "signin" && <Button title="Sign in" size="lg" wide onPress={() => openSheet("signin")} />}
          {action.kind === "signin" && action.token && <Button title="Use a token instead" icon={KeyRound} variant="ghost" wide onPress={() => openSheet("token")} />}
          {action.kind === "token" && <Button title="Sign in with a token" icon={KeyRound} size="lg" wide onPress={() => openSheet("token")} />}
          {action.kind === "computer" && <Button title="Sign in on your computer" size="lg" wide onPress={signIn} />}
          {(facts.length > 0 || (provider.connected && provider.signOut)) && (
            <View>
              <Label>Account</Label>
              <Group>
                {facts.map((fact) => (
                  <Row key={fact.title} title={fact.title} value={fact.value} />
                ))}
                {provider.connected && provider.signOut && <Row leading={<IconTile icon={LogOut} color={colors.danger} />} title="Sign out" tone="danger" onPress={signOut} />}
              </Group>
            </View>
          )}
          {provider.signIn === "services" && <Services providerId={provider.id} />}
        </>
      )}

      {!!models?.length && (
        <View>
          <Label>Models</Label>
          <Group>
            {models.map((model) => (
              <Row
                key={model.id + (model.group ?? "")}
                title={model.name}
                subtitle={model.available ? (model.group ?? model.description) : "Not on this account"}
                trailing={model.recommended ? <Badge label="Recommended" tone="accent" /> : undefined}
                disabled={!model.available}
              />
            ))}
          </Group>
        </View>
      )}
    </Page>
  );
}
