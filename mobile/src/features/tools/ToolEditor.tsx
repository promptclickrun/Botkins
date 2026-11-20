import { router, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Check, ChevronDown, Copy, FlaskConical, LogIn, LogOut, Trash2 } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import type { McpServer, McpServerInput } from "@/link/types";
import { usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast, useApp } from "@/state/store";
import { Badge, Button, EmptyState, Field, Group, IconTile, Loading, Row, Segmented, Sheet, space, T, Tap, useTheme } from "@/ui";
import { CredentialPicker, PickedCredential } from "@/features/credentials/CredentialPicker";
import { type PickedRef, refValue, SavedValue, type Secret, SecretList, secretRecord, storedSecret } from "./Secrets";
import { keyHeaderOf } from "./shared";

type Where = "web" | "computer";
type SignIn = "none" | "key" | "browser";
type Draft = {
  name: string;
  where: Where;
  url: string;
  /** How a server on the web is reached: HTTP, or SSE for older servers. */
  transport: "http" | "sse";
  signIn: SignIn;
  key: string;
  /** A saved credential used as the key, in place of typing it. */
  keyRef?: PickedRef;
  /** The computer holds the key, in the header `keySaved`. */
  keyStored: boolean;
  keySaved: string;
  keyReplace: boolean;
  /** The key goes as "Authorization: Bearer <key>", or else in a header named `keyHeader`. */
  bearer: boolean;
  keyHeader: string;
  /** Browser sign-in with an app the person made on the service (Advanced). The secret is typed here only, never read back. */
  clientId: string;
  clientSecret: string;
  scope: string;
  headers: Secret[];
  command: string;
  args: string;
  env: Secret[];
  cwd: string;
};

function draftOf(server: McpServer | undefined): Draft {
  const needs = server?.needs ?? [];
  const headerNames = server?.headers ?? [];
  const oauth = server?.auth?.type === "oauth" ? server.auth : undefined;
  const authName = oauth ? undefined : keyHeaderOf(headerNames);
  const signIn: SignIn = oauth ? "browser" : authName ? "key" : "none";
  const bearer = !authName || authName.toLowerCase() === "authorization";
  return {
    name: server?.name ?? "",
    where: server?.type === "stdio" ? "computer" : "web",
    url: server?.url ?? "",
    transport: server?.type === "sse" ? "sse" : "http",
    signIn,
    key: "",
    keyStored: !!authName && !needs.includes(authName),
    keySaved: authName ?? "",
    keyReplace: false,
    bearer,
    keyHeader: bearer ? "" : (authName ?? ""),
    clientId: oauth?.clientId ?? "",
    clientSecret: "",
    scope: oauth?.scope ?? "",
    headers: headerNames.filter((name) => signIn !== "key" || name !== authName).map((name) => storedSecret(name, !needs.includes(name))),
    command: server?.command ?? "",
    args: (server?.args ?? []).join("\n"),
    env: (server?.env ?? []).map((name) => storedSecret(name, !needs.includes(name))),
    cwd: server?.cwd ?? "",
  };
}

/** The header the key goes in, as the form says now. */
const keyHeaderName = (draft: Draft) => (draft.bearer ? "Authorization" : draft.keyHeader.trim());
/** The saved key is kept only while it goes the same way: sending it another way needs the key itself. */
const keepsKey = (draft: Draft) => draft.keyStored && !draft.keyReplace && draft.keySaved.toLowerCase() === keyHeaderName(draft).toLowerCase();

function problemsOf(draft: Draft) {
  const out: { name?: string; url?: string; command?: string; key?: string; header?: string } = {};
  if (!draft.name.trim()) out.name = "Give the tool a name.";
  if (draft.where === "web") {
    if (!/^https?:\/\/\S+$/i.test(draft.url.trim())) out.url = "Start with http:// or https://";
    if (draft.signIn === "key" && !keyHeaderName(draft)) out.header = "Enter the header's name, such as X-API-Key.";
    else if (draft.signIn === "key" && !keepsKey(draft) && !draft.keyRef && !draft.key.trim()) out.key = draft.keyStored && !draft.keyReplace ? "Enter the key again. You changed how it's sent." : "Enter the key or token.";
  } else if (!draft.command.trim()) out.command = "Enter the command that starts it.";
  return out;
}

function inputOf(draft: Draft, server: McpServer | undefined): McpServerInput {
  const base = { ...(server ? { id: server.id } : { enabled: true }), name: draft.name.trim() };
  if (draft.where === "computer")
    return {
      ...base,
      type: "stdio",
      command: draft.command.trim(),
      args: draft.args
        .split("\n")
        .map((arg) => arg.trim())
        .filter(Boolean),
      env: secretRecord(draft.env),
      cwd: draft.cwd.trim(),
    };
  const headers = secretRecord(draft.headers);
  if (draft.signIn === "key") {
    const key = draft.key.trim();
    const name = keyHeaderName(draft);
    // A credential goes as a reference. The computer fills in its value and puts "Bearer " in front of it when it goes as a bearer token.
    if (keepsKey(draft)) headers[draft.keySaved] = null;
    else headers[name] = draft.keyRef ? refValue(draft.keyRef, draft.bearer ? "Bearer " : undefined) : !draft.bearer || /^bearer\s/i.test(key) ? key : "Bearer " + key;
  }
  const oauth = server?.auth?.type === "oauth" ? server.auth : undefined;
  const clientId = draft.clientId.trim();
  const scope = draft.scope.trim();
  return {
    ...base,
    type: draft.transport,
    url: draft.url.trim(),
    headers,
    // As the computer's own form sends it: a client of the person's own, its secret only when one is typed (null keeps the saved one).
    ...(draft.signIn === "browser"
      ? { oauth: { ...(clientId && { clientId }), ...(scope && { scope }), ...(clientId && { clientSecret: draft.clientSecret ? draft.clientSecret : oauth?.clientSecret ? null : undefined }) } }
      : oauth && { oauth: null }),
  };
}

/** Starts a sign-in on the computer. It can take minutes, so nothing waits for it. */
function startSignIn(id: string, done?: () => void) {
  void attempt(api.signInMcpServer(id)).then((auth) => {
    done?.();
    if (auth?.type === "oauth" && auth.signedIn) showToast("Signed in", "success");
  });
}

export default function ToolEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const server = usePart("mcp")?.find((item) => item.id === id);
  const synced = useApp((state) => state.synced);
  if (id !== "new" && !server)
    return <Sheet title="Tool">{synced ? <EmptyState title="This tool is gone" action="Go back" onAction={() => router.back()} /> : <Loading />}</Sheet>;
  return <Editor key={id} server={server} />;
}

function FormLabel({ children }: { children: string }) {
  return (
    <T variant="label" color="muted" style={{ paddingHorizontal: space.xs }}>
      {children}
    </T>
  );
}

function Editor({ server }: { server: McpServer | undefined }) {
  const { colors } = useTheme();
  const [start] = useState(() => draftOf(server));
  const [draft, setDraft] = useState(start);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [moreHeaders, setMoreHeaders] = useState(start.headers.length > 0);
  const [test, setTest] = useState<{ running: boolean; status?: string; tools?: string[] }>({ running: false });
  const [starting, setStarting] = useState(false);
  const [advanced, setAdvanced] = useState(!!(start.clientId || start.scope));
  const [redirect, setRedirect] = useState("");
  const [copied, setCopied] = useState(false);

  const isNew = !server;
  const set = (patch: Partial<Draft>) => setDraft((held) => ({ ...held, ...patch }));
  const problems = problemsOf(draft);
  const shown = checked ? problems : {};
  const changed = JSON.stringify(draft) !== JSON.stringify(start);
  const auth = server?.auth?.type === "oauth" ? server.auth : undefined;
  const waiting = !!auth?.signingIn || starting;
  const keyShown = draft.signIn === "key" && keepsKey(draft);

  // The address an OAuth app of the person's own must register, from the computer.
  useEffect(() => {
    if (draft.signIn !== "browser" || !advanced || redirect) return;
    let live = true;
    void api.credentials().then((vault) => live && setRedirect(vault?.redirectUrl ?? ""), () => {});
    return () => {
      live = false;
    };
  }, [draft.signIn, advanced, redirect]);
  const copyRedirect = async () => {
    await Clipboard.setStringAsync(redirect);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const save = async () => {
    setChecked(true);
    if (Object.keys(problems).length) return;
    setSaving(true);
    const id = await attempt(api.saveMcpServer(inputOf(draft, server)), isNew ? "Tool added" : "Saved");
    // A typed client secret leaves the phone's memory once it was sent, whether or not that worked.
    if (draft.clientSecret) set({ clientSecret: "" });
    setSaving(false);
    if (!id) return;
    if (isNew && draft.signIn === "browser") {
      Alert.alert("Sign in to " + draft.name.trim() + "?", "You finish on your computer.", [
        { text: "Later", style: "cancel", onPress: () => router.back() },
        {
          text: "Sign in",
          onPress: () => {
            // The sheet turns into this tool's page, which shows the sign-in as it goes.
            router.setParams({ id });
            startSignIn(id);
          },
        },
      ]);
      return;
    }
    router.back();
  };

  const runTest = async () => {
    if (!server) return;
    setTest({ running: true });
    const result = await attempt(api.testMcpServer(server.id));
    setTest({ running: false, status: result?.status, tools: result?.tools });
  };

  const signIn = () => {
    if (!server) return;
    setStarting(true);
    startSignIn(server.id, () => setStarting(false));
  };
  const cancelSignIn = () => {
    if (!server) return;
    setStarting(false);
    void attempt(api.cancelMcpSignIn(server.id));
  };

  const remove = () => {
    if (!server) return;
    Alert.alert("Remove " + server.name + "?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          router.back();
          void attempt(api.removeMcpServer(server.id), "Tool removed");
        },
      },
    ]);
  };

  const testOk = !!test.status && /^(connected|ok|ready)/i.test(test.status);

  return (
    <Sheet title={isNew ? "New tool" : server.name} action={isNew ? "Add" : "Save"} onAction={() => void save()} actionDisabled={!isNew && !changed} actionLoading={saving}>
      <Field label="Name" placeholder="linear" value={draft.name} onChangeText={(name) => set({ name })} autoCapitalize="none" autoCorrect={false} error={shown.name} returnKeyType="next" autoFocus={isNew} />

      <View style={{ gap: 6 }}>
        <FormLabel>Runs</FormLabel>
        <Segmented
          options={[
            { value: "web", label: "On the web" },
            { value: "computer", label: "On your computer" },
          ]}
          value={draft.where}
          onChange={(where) => set({ where })}
        />
      </View>

      {draft.where === "web" ? (
        <>
          <Field label="URL" placeholder="https://…" value={draft.url} onChangeText={(url) => set({ url })} keyboardType="url" autoCapitalize="none" autoCorrect={false} textContentType="URL" error={shown.url} />

          <View style={{ gap: 6 }}>
            <FormLabel>Connection</FormLabel>
            <Segmented
              options={[
                { value: "http", label: "HTTP" },
                { value: "sse", label: "SSE (older servers)" },
              ]}
              value={draft.transport}
              onChange={(transport) => set({ transport })}
            />
          </View>

          <View style={{ gap: 6 }}>
            <FormLabel>Sign-in</FormLabel>
            <Segmented
              options={[
                { value: "none", label: "None" },
                { value: "key", label: "Key" },
                { value: "browser", label: "Browser" },
              ]}
              value={draft.signIn}
              onChange={(signIn) => set({ signIn })}
            />
          </View>

          {draft.signIn === "key" && (
            <View style={{ gap: 6 }}>
              <FormLabel>Send it as</FormLabel>
              <Segmented
                options={[
                  { value: "bearer", label: "Bearer token" },
                  { value: "header", label: "A header of its own" },
                ]}
                value={draft.bearer ? "bearer" : "header"}
                onChange={(how) => set({ bearer: how === "bearer" })}
              />
              {!draft.bearer && <Field placeholder="X-API-Key" accessibilityLabel="Header name" value={draft.keyHeader} onChangeText={(keyHeader) => set({ keyHeader })} autoCapitalize="none" autoCorrect={false} mono error={shown.header} />}
            </View>
          )}

          {draft.signIn === "key" &&
            (keyShown ? (
              <View style={{ gap: 6 }}>
                <FormLabel>Key or token</FormLabel>
                <SavedValue label="Key or token" onReplace={() => set({ keyReplace: true })} />
              </View>
            ) : draft.keyRef ? (
              <View style={{ gap: 6 }}>
                <FormLabel>Key or token</FormLabel>
                <PickedCredential name={draft.keyRef.name} onClear={() => set({ keyRef: undefined })} />
              </View>
            ) : (
              <View style={{ gap: space.xs }}>
                <Field label="Key or token" placeholder={draft.bearer ? "Sent as a bearer token" : "Sent in " + (draft.keyHeader.trim() || "its header")} value={draft.key} onChangeText={(key) => set({ key })} secureTextEntry autoCapitalize="none" autoCorrect={false} error={shown.key} />
                <CredentialPicker onPick={(ref, name) => set({ keyRef: { id: ref.$credential, name }, key: "" })} />
              </View>
            ))}

          {draft.signIn === "browser" && (
            <View style={{ gap: space.md }}>
              <Tap
                onPress={() => setAdvanced((open) => !open)}
                feel="select"
                sink={1}
                accessibilityState={{ expanded: advanced }}
                accessibilityLabel="Advanced"
                style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs }}
              >
                <T variant="callout" weight="600" style={{ flex: 1 }}>
                  Advanced
                </T>
                <ChevronDown size={18} color={colors.muted} strokeWidth={2.3} style={{ transform: [{ rotate: advanced ? "180deg" : "0deg" }] }} />
              </Tap>
              {advanced && (
                <>
                  <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
                    Only for a server that asks you to make an app yourself.
                  </T>
                  <Field label="Client ID" value={draft.clientId} onChangeText={(clientId) => set({ clientId })} autoCapitalize="none" autoCorrect={false} mono />
                  <Field
                    label="Client secret"
                    placeholder={auth?.clientSecret ? "Saved · leave empty to keep" : "Optional"}
                    value={draft.clientSecret}
                    onChangeText={(clientSecret) => set({ clientSecret })}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    textContentType="none"
                    autoComplete="off"
                  />
                  <Field label="Scopes" placeholder="read write" hint="Separate them with spaces. Leave empty for the server's own." value={draft.scope} onChangeText={(scope) => set({ scope })} autoCapitalize="none" autoCorrect={false} mono />
                  {!!redirect && (
                    <View style={{ gap: 6 }}>
                      <FormLabel>Redirect address</FormLabel>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                        <T variant="mono" color="ink2" numberOfLines={2} selectable style={{ flex: 1, paddingHorizontal: space.xs }}>
                          {redirect}
                        </T>
                        <Button title={copied ? "Copied" : "Copy"} icon={copied ? Check : Copy} variant="secondary" size="sm" onPress={() => void copyRedirect()} />
                      </View>
                      <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
                        Register it with the app you make on the service.
                      </T>
                    </View>
                  )}
                </>
              )}
            </View>
          )}

          <View style={{ gap: space.md }}>
            <Tap
              onPress={() => setMoreHeaders((open) => !open)}
              feel="select"
              sink={1}
              accessibilityState={{ expanded: moreHeaders }}
              accessibilityLabel={"Other headers" + (draft.headers.length ? ", " + draft.headers.length : "")}
              style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs }}
            >
              <T variant="callout" weight="600" style={{ flex: 1 }}>
                {"Other headers" + (draft.headers.length ? " · " + draft.headers.length : "")}
              </T>
              <ChevronDown size={18} color={colors.muted} strokeWidth={2.3} style={{ transform: [{ rotate: moreHeaders ? "180deg" : "0deg" }] }} />
            </Tap>
            {moreHeaders && <SecretList secrets={draft.headers} onChange={(headers) => set({ headers })} namePlaceholder="Header-Name" addLabel="Add header" />}
          </View>
        </>
      ) : (
        <>
          <Field label="Command" placeholder="npx" value={draft.command} onChangeText={(command) => set({ command })} autoCapitalize="none" autoCorrect={false} mono error={shown.command} />
          <Field label="Arguments" placeholder={"-y\n@scope/server"} hint="One per line" value={draft.args} onChangeText={(args) => set({ args })} autoCapitalize="none" autoCorrect={false} mono area style={{ minHeight: 96 }} />
          <View style={{ gap: 6 }}>
            <FormLabel>Environment</FormLabel>
            <SecretList secrets={draft.env} onChange={(env) => set({ env })} namePlaceholder="NAME" addLabel="Add variable" upper />
          </View>
          <Field label="Working folder" placeholder="/Users/you/projects/tools" hint="A full path. Leave empty for the bot's own folder." value={draft.cwd} onChangeText={(cwd) => set({ cwd })} autoCapitalize="none" autoCorrect={false} mono />
        </>
      )}

      {server && (
        <Group>
          <Row
            leading={<IconTile icon={FlaskConical} color={colors.info} />}
            title="Test"
            subtitle={test.running ? "Testing…" : test.tools ? test.tools.length + (test.tools.length === 1 ? " tool" : " tools") : undefined}
            trailing={test.running ? <ActivityIndicator color={colors.muted} /> : test.status ? <Badge label={test.status.charAt(0).toUpperCase() + test.status.slice(1)} tone={testOk ? "success" : "warning"} /> : undefined}
            onPress={test.running ? undefined : () => void runTest()}
          />
          {!test.running && !!test.tools?.length && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: space.lg, paddingBottom: space.md, paddingTop: space.sm }}>
              {test.tools.slice(0, 12).map((tool) => (
                <Badge key={tool} label={tool} />
              ))}
              {test.tools.length > 12 && <Badge label={"+" + (test.tools.length - 12)} />}
            </View>
          )}
          {auth &&
            (waiting ? (
              <Row
                leading={
                  <View style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}>
                    <ActivityIndicator color={colors.accent} />
                  </View>
                }
                title="Finish signing in on your computer"
                trailing={<Button title="Cancel" variant="ghost" size="sm" onPress={cancelSignIn} />}
              />
            ) : auth.signedIn ? (
              <Row leading={<IconTile icon={LogOut} color={colors.ink2} />} title="Sign out" subtitle="Signed in" onPress={() => void attempt(api.signOutMcpServer(server.id), "Signed out")} />
            ) : (
              <Row leading={<IconTile icon={LogIn} color={colors.accent} />} title="Sign in" tone="accent" onPress={signIn} />
            ))}
          <Row leading={<IconTile icon={Trash2} color={colors.danger} />} title="Remove tool" tone="danger" onPress={remove} />
        </Group>
      )}
    </Sheet>
  );
}
