// A project's changes (the desktop's Project Changes, src/ProjectChanges.tsx): the branch, the
// changed files with what was added and removed, one file's changes as text, and Commit all.
import { useLocalSearchParams } from "expo-router";
import { ArrowLeft, GitBranch, GitCommitHorizontal, RefreshCw } from "lucide-react-native";
import { type ReactNode, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { ChangedFile, ProjectChanges } from "@/link/types";
import { usePart } from "@/state/hooks";
import { api } from "@/state/link";
import { Button, EmptyState, Field, Group, IconButton, Loading, radius, Row, Sheet, space, T, useTheme } from "@/ui";
import { changedPath, type DiffLine, diffLineKind, fileCount, kindLetter } from "./side";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** "+12 −3", in the add and remove colors. */
function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <View style={{ flexDirection: "row", gap: 6 }} accessible accessibilityLabel={added + " added, " + removed + " removed"}>
      <T variant="footnote" weight="700" color="success">
        {"+" + added}
      </T>
      <T variant="footnote" weight="700" color="danger">
        {"−" + removed}
      </T>
    </View>
  );
}

function FileRow({ file, onPress }: { file: ChangedFile; onPress: () => void }) {
  const { colors, type } = useTheme();
  const slash = file.path.lastIndexOf("/");
  const name = file.from ? changedPath(file) : file.path.slice(slash + 1);
  const folder = file.from || slash < 0 ? undefined : file.path.slice(0, slash);
  return (
    <Row
      leading={
        <View style={{ width: 28, height: 28, borderRadius: radius.sm, backgroundColor: colors.sunken, alignItems: "center", justifyContent: "center" }} accessibilityLabel={file.kind}>
          <Text maxFontSizeMultiplier={1.3} style={[type.mono, { color: file.kind === "deleted" ? colors.danger : file.kind === "modified" ? colors.ink2 : colors.success, fontWeight: "700" }]}>
            {kindLetter(file.kind)}
          </Text>
        </View>
      }
      title={name}
      subtitle={folder}
      trailing={<Counts added={file.added} removed={file.removed} />}
      chevron
      onPress={onPress}
    />
  );
}

/** A file's changes as text: monospace, colored by line, scrolling sideways for long lines. */
function DiffView({ text }: { text: string }) {
  const { colors, type } = useTheme();
  const tone: Record<DiffLine, string> = { file: colors.muted, add: colors.success, del: colors.danger, hunk: colors.info, plain: colors.ink2 };
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator style={{ borderRadius: radius.md, backgroundColor: colors.sunken, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }} contentContainerStyle={{ padding: space.md }}>
      <Text selectable maxFontSizeMultiplier={1.3} style={[type.mono, { color: colors.ink2 }]} accessibilityLabel="Diff">
        {text.split("\n").map((line, index) => {
          const kind = diffLineKind(line);
          return (
            <Text key={index} style={{ color: tone[kind], fontWeight: kind === "file" ? "700" : undefined }}>
              {line + "\n"}
            </Text>
          );
        })}
      </Text>
    </ScrollView>
  );
}

export default function Changes() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChangesView id={id} />;
}

/** The second page of a chat on a phone half folded like a book: the same view, without the sheet. */
function PageFrame({ title, onAction, actionDisabled, children }: { title: string; action?: string; onAction?: () => void; actionDisabled?: boolean; actionLoading?: boolean; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xl, paddingVertical: space.sm }}>
        <T variant="title2" numberOfLines={1} style={{ flex: 1 }}>
          {title}
        </T>
        {onAction && <IconButton icon={RefreshCw} label="Refresh" onPress={onAction} disabled={actionDisabled} />}
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xxl, gap: space.xl }} showsVerticalScrollIndicator={false}>
        {children}
      </ScrollView>
    </View>
  );
}

/** A project's uncommitted changes. `inline` draws it as a page beside the chat instead of a sheet. */
export function ChangesView({ id, inline }: { id?: string; inline?: boolean }) {
  const Frame = inline ? PageFrame : Sheet;
  const project = usePart("projects")?.find((p) => p.id === id);
  const [changes, setChanges] = useState<ProjectChanges>();
  const [file, setFile] = useState("");
  const [diff, setDiff] = useState<{ text: string; truncated: boolean }>();
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [message, setMessage] = useState("");

  const load = async () => {
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      setChanges(await api.projectChanges(id));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
    // Only when the project changes.
  }, [id]);
  useEffect(() => {
    if (!file || !id) return;
    setDiff(undefined);
    let live = true;
    api.projectDiff(id, file).then(
      (result) => live && setDiff(result),
      (e: unknown) => live && setError(messageOf(e)),
    );
    return () => {
      live = false;
    };
  }, [file, id]);

  const commit = async () => {
    if (!id || !changes?.repo || !message.trim()) return;
    setBusy(true);
    setError("");
    try {
      const sha = await api.projectCommit(id, message.trim());
      setNote("Committed " + sha + " on " + changes.branch + ".");
      setMessage("");
      setCommitting(false);
      await load();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (!project)
    return (
      <Frame title="Changes">
        <EmptyState title="This project is gone" />
      </Frame>
    );

  return (
    <Frame title={file ? file.split("/").pop() || file : "Changes"} action={file ? undefined : "Refresh"} onAction={file ? undefined : () => void load()} actionDisabled={busy} actionLoading={busy && !!changes}>
      {!!error && (
        <T variant="subhead" color="danger" accessibilityRole="alert">
          {error}
        </T>
      )}
      {!!note && !file && (
        <T variant="subhead" color="success" accessibilityLiveRegion="polite">
          {note}
        </T>
      )}
      {!changes ? (
        busy || !error ? <Loading /> : null
      ) : !changes.repo ? (
        <T variant="body" color="muted">
          {project.name + " isn't a git repository, so there are no changes to show."}
        </T>
      ) : file ? (
        <View style={{ gap: space.md }}>
          <Button title="Back to files" icon={ArrowLeft} variant="ghost" size="sm" onPress={() => setFile("")} style={{ alignSelf: "flex-start" }} />
          <T variant="footnote" color="muted" numberOfLines={2}>
            {file}
          </T>
          {diff ? (
            <>
              <DiffView text={diff.text || "No differences."} />
              {diff.truncated && (
                <T variant="footnote" color="muted">
                  This diff is long; the rest is not shown.
                </T>
              )}
            </>
          ) : (
            <Loading />
          )}
        </View>
      ) : (
        <View style={{ gap: space.lg }}>
          <View style={{ gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <GitBranchIcon />
              <T variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
                {changes.branch || "detached"}
              </T>
            </View>
            {!!changes.upstream && (
              <T variant="footnote" color="muted">
                {changes.ahead + " ahead, " + changes.behind + " behind " + changes.upstream}
              </T>
            )}
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <T variant="footnote" color="muted">
                {fileCount(changes.files.length)}
              </T>
              <Counts added={changes.added} removed={changes.removed} />
            </View>
          </View>

          {changes.files.length === 0 ? (
            <T variant="body" color="muted">
              Working tree clean.
            </T>
          ) : (
            <Group>
              {changes.files.map((changed) => (
                <FileRow key={changed.path} file={changed} onPress={() => setFile(changed.path)} />
              ))}
            </Group>
          )}

          {changes.files.length > 0 &&
            (committing ? (
              <View style={{ gap: space.md }}>
                <Field label="Commit message" value={message} onChangeText={setMessage} maxLength={2000} area autoFocus style={{ minHeight: 80 }} />
                <T variant="footnote" color="muted">
                  {"Stages all " + fileCount(changes.files.length) + " and commits them to " + (changes.branch || "this branch") + ". Nothing is pushed."}
                </T>
                <View style={{ flexDirection: "row", gap: space.md }}>
                  <Button title="Cancel" variant="secondary" onPress={() => setCommitting(false)} style={{ flex: 1 }} />
                  <Button title="Commit all" onPress={() => void commit()} disabled={busy || !message.trim()} loading={busy} style={{ flex: 1 }} />
                </View>
              </View>
            ) : (
              <Button title="Commit…" icon={GitCommitHorizontal} variant="secondary" onPress={() => setCommitting(true)} />
            ))}
        </View>
      )}
    </Frame>
  );
}

function GitBranchIcon() {
  const { colors } = useTheme();
  return <GitBranch size={16} color={colors.muted} strokeWidth={2.3} />;
}
