import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Modal, TextInput, View } from "react-native";
import { PROTON_DISCONNECT, PROTON_GUIDE, protonAction, protonConsent, protonDate, sendProtonPassword, useProtonSetup, type ProtonCalls } from "@/link/proton-pass";
import type { PasswordManagerStatus } from "@/link/types";
import { api } from "@/state/link";
import { Button, Group, Row, Sheet, T, radius, space, useTheme } from "@/ui";

export const protonCalls: ProtonCalls = {
  plan: () => api["link.credentials.protonPassInstallPlan"](),
  install: (input) => api["link.credentials.protonPassInstall"](input),
  start: (input) => api["link.credentials.protonPassSignInStart"](input),
  read: (input) => api["link.credentials.protonPassSignInRead"](input),
  input: (input) => api["link.credentials.protonPassSignInInput"](input),
  cancel: (input) => api["link.credentials.protonPassSignInCancel"](input),
  disconnect: (input) => api["link.credentials.protonPassDisconnect"](input),
};

type Setup = ReturnType<typeof useProtonSetup>;

export function ProtonManagerActions({ status, setup, browse }: { status: PasswordManagerStatus; setup: Setup; browse: () => void }) {
  const action = protonAction(status);
  const connected = status.expiresAt !== undefined;
  return (
    <>
      {!!status.message && <T variant="callout" color="muted">{status.message}</T>}
      {(status.state === "installing" || status.state === "signing-in") && <T variant="callout" color="muted">Setup is in progress on another screen.</T>}
      {status.unsupported && <Button title="Install guide" onPress={() => void WebBrowser.openBrowserAsync(PROTON_GUIDE).catch(setup.fail)} />}
      {!!action && <Button title={action} size="lg" wide onPress={
        action === "Browse" ? browse : () => setup.begin(action === "Set up" ? "install" : "sign-in", action === "Renew")
      } />}
      {connected && <Group>
        <Row title="Shared vaults" subtitle={status.sharedVaults?.join(", ")} trailing={<T color="accent">Change</T>} onPress={() => setup.begin("sign-in", true)} />
        <Row title={"Access ends " + protonDate(status.expiresAt!)} />
        {status.state === "expiring" && <Row title="Browse" onPress={browse} />}
        <Row title="Disconnect" tone="danger" onPress={() => setup.begin("disconnect")} />
      </Group>}
    </>
  );
}

export function ProtonPassSheet({ setup }: { setup: Setup }) {
  const { colors } = useTheme();
  const { view, sending, confirm, answer, close, fail } = setup;
  const secret = useRef("");
  const field = useRef<ComponentRef<typeof TextInput>>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [dedicated, setDedicated] = useState(false);
  useEffect(() => {
    if (view?.finished) {
      secret.current = "";
      field.current?.clear();
    }
  }, [view?.finished]);
  if (!view) return null;
  const ids = view.vaults?.filter((v) => picked[v.id] ?? v.suggested).map((v) => v.id) ?? [];
  const clear = () => { secret.current = ""; field.current?.clear(); };
  const submitPassword = () => void sendProtonPassword(() => secret.current, clear, (extraPassword) => answer({ extraPassword })).catch(fail);
  const closeSheet = () => { clear(); void close(); };
  const ask = view.finished ? undefined : view.phase === "extra-password" ? submitPassword : view.phase === "choose-vaults"
    ? () => { if (ids.length || dedicated) void answer({ vaultIds: ids, createDedicated: dedicated }).catch(fail); }
    : view.started ? undefined : confirm;
  const label = view.phase === "extra-password" ? "Continue" : view.phase === "choose-vaults" ? "Share vaults"
    : view.mode === "install" ? "Install" : "Disconnect";
  const title = view.mode === "install" ? "Set up Proton Pass" : view.mode === "disconnect" ? "Disconnect Proton Pass" : "Sign in with Proton";
  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={closeSheet}>
      <Sheet title={title} onClose={closeSheet}>
        {view.result ? (
          <View style={{ gap: space.sm }}>
            <T accessibilityLiveRegion="polite">{view.mode === "install" ? "Proton Pass is installed." : view.mode === "disconnect" ? "Proton Pass is disconnected." : "Proton Pass is connected."}</T>
            {view.result.account && <T>{view.result.account}</T>}
            {!!view.result.sharedVaults?.length && <T>Shared vaults: {view.result.sharedVaults.join(", ")}</T>}
            {view.result.expiresAt !== undefined && <T>Access ends {protonDate(view.result.expiresAt)}</T>}
          </View>
        ) : view.finished ? null : view.mode === "install" ? (
          <>
            <T selectable>{view.started ? "Installing Proton Pass…" : view.plan ? protonConsent(view.plan) : "Checking the install plan…"}</T>
            {!view.started && <Button title="I'll install it myself" onPress={() => void WebBrowser.openBrowserAsync(PROTON_GUIDE).catch(fail)} />}
          </>
        ) : !view.started ? <T>{PROTON_DISCONNECT}</T>
          : view.phase === "extra-password" ? (
            <View style={{ gap: space.sm }}>
              {(view.attempt ?? 0) > 1 && <T>Proton didn't accept that extra password. Try again.</T>}
              <T variant="callout">Proton Pass extra password</T>
              <TextInput
                key={view.attempt}
                ref={field}
                accessibilityLabel="Proton Pass extra password"
                secureTextEntry
                autoFocus
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                editable={!sending}
                onChangeText={(text) => { secret.current = text; }}
                onSubmitEditing={submitPassword}
                style={{ backgroundColor: colors.sunken, color: colors.ink, padding: space.md, borderRadius: radius.md }}
              />
            </View>
          ) : view.phase === "choose-vaults" ? (
            <View style={{ gap: space.sm }}>
              <T variant="headline">Choose vaults to share with Botkins</T>
              <Group>
                {(view.vaults ?? []).map((vault) => {
                  const selected = picked[vault.id] ?? vault.suggested ?? false;
                  return <Row key={vault.id} title={vault.name} trailing={<T color="accent">{selected ? "Selected" : "Select"}</T>}
                    onPress={() => setPicked({ ...picked, [vault.id]: !selected })} />;
                })}
                <Row title="Create a vault for Botkins" trailing={<T color="accent">{dedicated ? "Selected" : "Select"}</T>}
                  onPress={() => setDedicated(!dedicated)} />
              </Group>
            </View>
          ) : view.phase === "setting-up" ? <T accessibilityLiveRegion="polite">Setting up Proton Pass…</T> : (
            <View style={{ gap: space.sm }}>
              <T variant="headline">Open Proton's page</T>
              <T accessibilityLiveRegion="polite">Waiting for you to finish signing in on Proton's page.</T>
              {!!view.url && <Button title="Open" onPress={() => void WebBrowser.openBrowserAsync(view.url!).catch(fail)} />}
            </View>
          )}
        {!!view.error && <T color="danger" accessibilityRole="alert">{view.error}</T>}
        {!view.result && !!ask && <Button title={label} disabled={sending || (view.mode === "install" && !view.plan) ||
          (view.phase === "choose-vaults" && !ids.length && !dedicated)} onPress={ask} />}
        <Button title={view.result ? "Done" : view.finished ? "Close" : "Cancel"} onPress={closeSheet} />
      </Sheet>
    </Modal>
  );
}
