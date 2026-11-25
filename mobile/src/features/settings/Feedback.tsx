import * as Application from "expo-application";
import Constants from "expo-constants";
import { useState } from "react";
import { Linking, Platform, View } from "react-native";
import { useOnline, usePart } from "@/state/hooks";
import { api } from "@/state/link";
import { showToast } from "@/state/store";
import { Button, Field, Group, Page, Row, Segmented, space, T } from "@/ui";

type Kind = "bug" | "feature";

/**
 * Settings › Send feedback: a bug report or a feature request, sent through the computer in use
 * ("feedback-v1"), which signs it and the relay opens an issue on the public Botkins repo. Only what
 * the person writes goes, with the app's version and platform. Nothing from chats, logs or names.
 */
export default function Feedback() {
  const meta = usePart("meta");
  const online = useOnline();
  const supported = !!meta?.capabilities.includes("feedback-v1");
  const [kind, setKind] = useState<Kind>("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ number: number; url: string } | null>(null);

  const version = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "";
  const build = Application.nativeBuildVersion;
  const ready = title.trim().length >= 4 && body.trim().length >= 4 && online && supported && !busy;

  async function send() {
    setBusy(true);
    try {
      const answer = await api["link.feedback.send"]({
        kind,
        title: title.trim(),
        body: body.trim(),
        app: Platform.OS === "ios" ? "Botkins iOS" : "Botkins Android",
        version: build && build !== version ? version + " (" + build + ")" : version,
        platform: (Platform.OS === "ios" ? "iOS " : "Android ") + String(Platform.Version),
      });
      setSent(answer);
      setTitle("");
      setBody("");
    } catch (error) {
      showToast(error instanceof Error && error.message ? error.message : "The report couldn't be sent.", "error");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Page title="Send feedback">
        <View style={{ gap: space.md, paddingVertical: space.lg }}>
          <T variant="headline" center>Thanks. It's issue #{sent.number}.</T>
          <T variant="callout" color="muted" center>You can follow it, and add to it, on GitHub.</T>
        </View>
        <Group>
          <Row title="Open on GitHub" tone="accent" onPress={() => void Linking.openURL(sent.url)} />
          <Row title="Send another" onPress={() => setSent(null)} />
        </Group>
      </Page>
    );
  }

  return (
    <Page title="Send feedback">
      <View style={{ gap: space.lg }}>
        <Segmented
          options={[
            { value: "bug", label: "Bug" },
            { value: "feature", label: "Feature request" },
          ]}
          value={kind}
          onChange={setKind}
        />
        <Field label="Title" placeholder={kind === "bug" ? "What went wrong, in a few words" : "What you'd like, in a few words"} value={title} onChangeText={setTitle} maxLength={120} returnKeyType="next" />
        <Field
          label={kind === "bug" ? "What happened" : "Details"}
          placeholder={kind === "bug" ? "What you did, what you expected, and what happened instead." : "What it would let you do, and how you'd use it."}
          value={body}
          onChangeText={setBody}
          maxLength={8000}
          area
        />
        <T variant="footnote" color="muted">
          This opens a public issue on GitHub with what you write here, the app version ({version || "unknown"}) and your platform. Leave out names, chats and anything private.
        </T>
        {!supported && !!meta && <T variant="footnote" color="danger">Update Botkins on your computer to send feedback from here.</T>}
        {!online && <T variant="footnote" color="danger">Connect to your computer to send feedback.</T>}
        <Button title={kind === "bug" ? "Report bug" : "Send request"} onPress={() => void send()} loading={busy} disabled={!ready} wide />
      </View>
    </Page>
  );
}
