// The model services inside a provider that holds several (OpenCode): connect one with its key, or
// with one of its sign-ins. A sign-in is finished on the computer, and may come back with a code for
// the person to type in (the desktop's ProviderSettings ConnectService).
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { CredentialPicker, PickedCredential } from "@/features/credentials/CredentialPicker";
import type { CredentialRef, ProviderService } from "@/link/types";
import { refresh } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { Badge, Button, Field, Group, Label, Loading, Row, space, T, useTheme } from "@/ui";

/** Where connecting the open service is: choosing how, waiting for the sign-in on the computer, or asking for a code. */
type Phase = { kind: "method" } | { kind: "waiting" } | { kind: "code"; attempt: string; instructions: string };

export function Services({ providerId }: { providerId: string }) {
  const { colors } = useTheme();
  const [services, setServices] = useState<ProviderService[] | null | undefined>(undefined);
  const [round, setRound] = useState(0);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ kind: "method" });
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  // A saved credential used as the key instead of typing it.
  const [picked, setPicked] = useState<{ ref: CredentialRef; name: string } | undefined>(undefined);
  // A sign-in that was cancelled ignores its late answer.
  const tries = useRef(0);

  useEffect(() => {
    let live = true;
    void attempt(api.providerServices(providerId)).then((list) => live && setServices(list ?? null));
    return () => {
      live = false;
    };
  }, [providerId, round]);

  const changed = async () => {
    setRound(round + 1);
    await refresh("providers");
  };
  const close = () => {
    tries.current++;
    setBusy(false);
    setOpen(undefined);
    setPhase({ kind: "method" });
    setKey("");
    setCode("");
    setPicked(undefined);
  };
  const connected = async () => {
    close();
    await changed();
  };
  const connect = async (service: ProviderService, how: { key: string } | { method: string }) => {
    const mine = ++tries.current;
    if ("method" in how) setPhase({ kind: "waiting" });
    else setBusy(true);
    let result: Awaited<ReturnType<typeof api.connectProviderService>> | undefined;
    try {
      result = await api.connectProviderService(providerId, service.id, how);
    } catch (error) {
      // A sign-in cancelled here ends on the computer with an error of its own; that one says nothing new.
      if (mine === tries.current) showToast(error instanceof Error ? error.message : "That didn't work.", "error");
    }
    // The typed key leaves the phone's memory whether or not the call worked.
    if ("key" in how) how.key = "";
    setKey("");
    if (mine !== tries.current) return;
    setBusy(false);
    if (!result) return setPhase({ kind: "method" });
    if (result.code) {
      setCode("");
      setPhase({ kind: "code", attempt: result.code.attempt, instructions: result.code.instructions });
    } else await connected();
  };
  const connectWithKey = (service: ProviderService) =>
    // The computer swaps a credential reference for its value; the input type only knows strings.
    void connect(service, { key: picked ? (picked.ref as unknown as string) : key.trim() });
  const finish = async (service: ProviderService, step: Extract<Phase, { kind: "code" }>) => {
    const mine = tries.current;
    const typed = code.trim();
    setCode("");
    setBusy(true);
    const result = await attempt(api.finishProviderService(providerId, service.id, step.attempt, typed));
    if (mine !== tries.current) return;
    setBusy(false);
    if (result?.done) return void (await connected());
    if (result) showToast("That code didn't work. Check it and try again.", "error");
  };
  // Ends a sign-in under way on the computer.
  const cancel = (service: ProviderService) => {
    close();
    void api.cancelProviderService(providerId, service.id).catch(() => {});
  };
  const disconnect = (service: ProviderService) =>
    Alert.alert("Disconnect " + service.name + "?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: async () => {
          await attempt(api.disconnectProviderService(providerId, service.id));
          await changed();
        },
      },
    ]);

  const panel = (service: ProviderService) => {
    const keyMethod = service.methods.find((method) => method.type === "key");
    const signIns = service.methods.filter((method) => method.type === "oauth");
    if (phase.kind === "waiting")
      return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <ActivityIndicator color={colors.accent} />
          <T variant="subhead" color="muted" style={{ flex: 1 }}>
            Finish signing in on your computer
          </T>
          <Button title="Cancel" variant="ghost" size="sm" onPress={() => cancel(service)} />
        </View>
      );
    if (phase.kind === "code")
      return (
        <>
          {!!phase.instructions && (
            <T variant="subhead" color="muted">
              {phase.instructions}
            </T>
          )}
          <Field label="Code" value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} autoComplete="off" autoFocus editable={!busy} returnKeyType="done" onSubmitEditing={() => code.trim() && void finish(service, phase)} />
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button title="Cancel" variant="secondary" style={{ flex: 1 }} onPress={() => cancel(service)} />
            <Button title="Finish" style={{ flex: 1 }} loading={busy} disabled={!code.trim()} onPress={() => void finish(service, phase)} />
          </View>
        </>
      );
    return (
      <>
        {signIns.map((method, index) => (
          <Button key={method.id ?? "oauth" + index} title={method.label} variant="secondary" wide disabled={busy} onPress={() => void connect(service, { method: method.id ?? "" })} />
        ))}
        {keyMethod &&
          (picked ? (
            <View style={{ gap: 6 }}>
              <T variant="label" color="muted" style={{ paddingHorizontal: space.xs }}>
                {keyMethod.label}
              </T>
              <PickedCredential name={picked.name} onClear={() => setPicked(undefined)} />
            </View>
          ) : (
            <View style={{ gap: space.xs }}>
              <Field label={signIns.length ? "Or use an API key" : keyMethod.label} placeholder="Paste key" value={key} onChangeText={setKey} secureTextEntry autoCapitalize="none" autoCorrect={false} autoFocus={!signIns.length} returnKeyType="done" editable={!busy} onSubmitEditing={() => key.trim() && connectWithKey(service)} />
              <CredentialPicker
                onPick={(ref, name) => {
                  setKey("");
                  setPicked({ ref, name });
                }}
              />
            </View>
          ))}
        {keyMethod && <Button title="Connect" wide loading={busy} disabled={!picked && !key.trim()} onPress={() => connectWithKey(service)} />}
      </>
    );
  };

  return (
    <View>
      <Label>Services</Label>
      {services === undefined ? (
        <Loading />
      ) : (
        <Group>
          {(services ?? []).map((service) => {
            const canConnect = service.methods.length > 0;
            const fromEnvironment = service.via === "environment";
            const expanded = open === service.id;
            // While a sign-in waits on the computer, the row's own tap does nothing: Cancel ends it.
            const underWay = expanded && (phase.kind !== "method" || busy);
            const onPress = service.connected
              ? fromEnvironment
                ? undefined
                : () => disconnect(service)
              : canConnect && !underWay
                ? () => {
                    if (expanded) return close();
                    close();
                    setOpen(service.id);
                  }
                : undefined;
            return (
              <View key={service.id}>
                <Row
                  title={service.name}
                  subtitle={fromEnvironment ? "From your computer's environment" : !service.connected && !canConnect ? "Connect on your computer" : undefined}
                  trailing={service.connected ? <Badge label="Connected" tone="success" /> : undefined}
                  value={!service.connected && canConnect && !underWay ? (expanded ? "Cancel" : "Connect") : undefined}
                  onPress={onPress}
                />
                {expanded && canConnect && (
                  <Animated.View entering={FadeIn.duration(180)} style={{ paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md }}>
                    {panel(service)}
                  </Animated.View>
                )}
              </View>
            );
          })}
          {services === null && <Row title="Services didn't load" value="Retry" tone="accent" onPress={() => setRound(round + 1)} />}
        </Group>
      )}
    </View>
  );
}
