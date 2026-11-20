// Signing a model provider in, or installing its command-line tool, from the phone
// ("provider-signin-v1"; route /models/signin). The computer runs the provider's own sign-in or
// install, with no browser of its own, and this sheet shows what it says as it goes: the page to
// open here and the code to type there, the tool's lines, and a question it waits on. A token
// pasted here is the other way in: it is typed only in its field, sent once, and cleared.
import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { CircleCheck, ExternalLink } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { CredentialPicker, PickedCredential } from "@/features/credentials/CredentialPicker";
import { LinkError } from "@/link/client";
import type { CredentialRef } from "@/link/types";
import { refresh, useProviders } from "@/state/hooks";
import { api } from "@/state/link";
import { showToast } from "@/state/store";
import { Button, Field, Group, haptic, radius, Sheet, space, T, useTheme } from "@/ui";
import { applyView, codeInLines, finishedLine, pageHost, type RunState, startState } from "./signin";

type Mode = "signin" | "install" | "token";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown) => (error instanceof Error ? error.message : "That didn't work. Try again.");

export default function SignInSheet() {
  const params = useLocalSearchParams<{ id: string; mode?: string; service?: string; method?: string; label?: string }>();
  const provider = useProviders()?.find((entry) => entry.id === params.id);
  const name = params.label || provider?.name || "this provider";
  const [mode, setMode] = useState<Mode>(params.mode === "install" ? "install" : params.mode === "token" ? "token" : "signin");
  const [round, setRound] = useState(0);
  const [run, setRun] = useState<RunState>(startState);
  const [failed, setFailed] = useState<string>();
  const session = useRef<string | undefined>(undefined);

  // The run on the computer: started once per round, read until it ends, and cancelled when the sheet goes.
  useEffect(() => {
    if (mode === "token") return;
    let live = true;
    let id: string | undefined;
    setRun(startState());
    setFailed(undefined);
    void (async () => {
      try {
        const options = { ...(params.service && { service: params.service }), ...(params.method && { method: params.method }) };
        const started = mode === "install" ? await api.installProvider(params.id) : await api.providerSignInStart(params.id, options);
        id = started.session;
        session.current = id;
        let state = startState();
        while (live) {
          let view;
          try {
            view = await api.providerSignInRead(id, state.next);
          } catch (error) {
            // The computer's own answer ("That sign-in is over.") ends it; a dropped link is tried again.
            if (error instanceof LinkError && error.code === "remote") throw error;
            await pause(2000);
            continue;
          }
          if (!live) return;
          state = applyView(state, view);
          setRun(state);
          if (state.done) {
            session.current = undefined;
            if (state.error) haptic.warn();
            else {
              haptic.success();
              await refresh("providers");
            }
            return;
          }
        }
      } catch (error) {
        session.current = undefined;
        if (live) setFailed(messageOf(error));
      }
    })();
    return () => {
      live = false;
      if (id && session.current === id) {
        session.current = undefined;
        void api.providerSignInCancel(id).catch(() => {});
      }
    };
  }, [mode, round, params.id, params.service, params.method]);

  const again = () => setRound((value) => value + 1);
  const title = mode === "install" ? "Install " + name : "Sign in to " + name;

  if (mode === "token") return <TokenSignIn title={title} name={name} providerId={params.id} service={params.service} onGuided={provider?.signInWays?.guided && !params.service ? () => setMode("signin") : undefined} />;

  const finished = run.done && !run.error;
  const problem = failed ?? (run.done ? run.error : undefined);
  return (
    <Sheet title={title}>
      {problem ? (
        <View style={{ gap: space.md }}>
          <T variant="callout" color="danger">
            {problem}
          </T>
          <Button title="Try again" size="lg" wide onPress={again} />
        </View>
      ) : finished ? (
        <Finished
          line={finishedLine(run.result, name)}
          next={mode === "install" && provider?.signInWays?.guided && !provider.connected ? { title: "Sign in", onPress: () => setMode("signin") } : undefined}
        />
      ) : (
        <Running run={run} mode={mode} session={session} />
      )}
      {mode === "signin" && !finished && provider?.signInWays?.token && !params.service && <Button title="Use a token instead" variant="ghost" wide onPress={() => setMode("token")} />}
      {run.lines.length > 0 && <Lines lines={mode === "install" ? run.lines : run.lines.slice(-8)} />}
    </Sheet>
  );
}

/** What the run asks of the person now: a page and its code, a page, a question, or a wait. */
function Running({ run, mode, session }: { run: RunState; mode: Mode; session: { current: string | undefined } }) {
  const { colors } = useTheme();
  const [typed, setTyped] = useState("");
  const [sending, setSending] = useState(false);
  const page = run.code?.url ?? run.page;
  const code = run.code?.code ?? (page ? codeInLines(run.lines) : null);

  const open = async () => {
    if (!page) return;
    if (code) {
      await Clipboard.setStringAsync(code);
      showToast("Code copied", "success");
    }
    await WebBrowser.openBrowserAsync(page);
  };
  const send = async () => {
    const id = session.current;
    const text = typed.trim();
    if (!id || !text) return;
    setSending(true);
    try {
      await api.providerSignInInput(id, text);
      setTyped("");
    } catch (error) {
      showToast(messageOf(error), "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={{ gap: space.lg }}>
      {!!code && (
        <View style={{ alignItems: "center", gap: space.sm, padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface }}>
          <T variant="label" color="muted">
            Your code
          </T>
          <T variant="title1" selectable style={{ letterSpacing: 2 }} accessibilityLabel={"Code " + code.split("").join(" ")}>
            {code}
          </T>
        </View>
      )}
      {!!page && <Button title={code ? "Copy code and open " + pageHost(page) : "Open " + pageHost(page)} icon={ExternalLink} size="lg" wide onPress={() => void open()} />}
      {run.prompt !== undefined && (
        <View style={{ gap: space.sm }}>
          <Field
            label={run.prompt || "Code from the page"}
            placeholder="Paste it here"
            value={typed}
            onChangeText={setTyped}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            returnKeyType="send"
            onSubmitEditing={() => void send()}
            editable={!sending}
          />
          <Button title="Send" wide loading={sending} disabled={!typed.trim()} onPress={() => void send()} />
        </View>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <ActivityIndicator color={colors.muted} />
        <T variant="subhead" color="muted" style={{ flex: 1 }}>
          {mode === "install" ? "Installing on your computer…" : run.prompt !== undefined ? "Waiting for the code" : page ? "Waiting for you to finish on the page" : "Starting the sign-in on your computer…"}
        </T>
      </View>
    </View>
  );
}

function Finished({ line, next }: { line: string; next?: { title: string; onPress: () => void } }) {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: "center", gap: space.md, paddingVertical: space.lg }}>
      <CircleCheck size={48} color={colors.success} strokeWidth={1.8} />
      <T variant="title3" center>
        {line}
      </T>
      {next ? <Button title={next.title} size="lg" wide onPress={next.onPress} /> : <Button title="Done" size="lg" wide onPress={() => router.back()} />}
    </View>
  );
}

/** The tool's own lines, as it printed them. */
function Lines({ lines }: { lines: string[] }) {
  return (
    <Group>
      <View style={{ padding: space.lg, gap: 2 }}>
        {lines.map((line, index) => (
          <T key={index} variant="mono" color="muted" selectable>
            {line}
          </T>
        ))}
      </View>
    </Group>
  );
}

/** A token or key pasted on the phone, or a saved credential: sent once, and the field is cleared. */
function TokenSignIn({ title, name, providerId, service, onGuided }: { title: string; name: string; providerId: string; service?: string; onGuided?: () => void }) {
  const [token, setToken] = useState("");
  const [picked, setPicked] = useState<{ ref: CredentialRef; name: string }>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [problem, setProblem] = useState<string>();

  const submit = async () => {
    const value = picked ? (picked.ref as unknown as string) : token.trim();
    if (!value) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await api.providerUseToken(providerId, value, service ? { service } : undefined);
      haptic.success();
      await refresh("providers");
      setDone(finishedLine({ connected: result.connected, account: result.account }, name));
    } catch (error) {
      haptic.warn();
      setProblem(messageOf(error));
    } finally {
      // The token leaves the phone's memory whether or not it worked.
      setToken("");
      setPicked(undefined);
      setBusy(false);
    }
  };

  return (
    <Sheet title={title}>
      {done ? (
        <Finished line={done} />
      ) : (
        <>
          {picked ? (
            <PickedCredential name={picked.name} onClear={() => setPicked(undefined)} />
          ) : (
            <View style={{ gap: space.xs }}>
              <Field
                label="Token or API key"
                placeholder="Paste it here"
                value={token}
                onChangeText={setToken}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                returnKeyType="done"
                onSubmitEditing={() => void submit()}
                editable={!busy}
                error={problem}
                autoFocus
              />
              <CredentialPicker
                onPick={(ref, label) => {
                  setToken("");
                  setPicked({ ref, name: label });
                }}
              />
            </View>
          )}
          {!!problem && picked && (
            <T variant="footnote" color="danger">
              {problem}
            </T>
          )}
          <Button title="Sign in" size="lg" wide loading={busy} disabled={!picked && !token.trim()} onPress={() => void submit()} />
          {onGuided && <Button title={"Sign in with " + name + "'s page instead"} variant="ghost" wide onPress={onGuided} />}
        </>
      )}
    </Sheet>
  );
}
