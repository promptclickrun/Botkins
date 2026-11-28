// One artifact, shown by its type: a picture to pinch and zoom, video and sound in a player, text,
// Markdown and code (the first 512 KB), a PDF, or its name and size with Share. Share, Save to
// Photos (pictures and video) and Open chat sit in the bar.
import { Directory, File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { MenuView } from "@react-native-menu/menu";
import { CircleAlert, Download, ExternalLink, FolderPlus, ImageDown, MessageCircle, Package, Share } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { openLink } from "@/ui/LinkHold";
import { openChat as openChatRoute } from "@/features/chat/navigate";
import type { Artifact } from "@/link/types";
import { shareLocalFile } from "@/state/files";
import { useCapability, useOnline, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { Button, EmptyState, IconButton, Loading, Markdown, Page, radius, space, T, useTheme } from "@/ui";
import { ArtifactThumb } from "./ArtifactBits";
import { download, folderHref, readArtifact, readText, remembered, saveToPhotos, stopDownload, useDownloads, useThumbnail } from "./data";
import { canSaveToPhotos, isBig, isTextPreview, type PreviewKind, previewKind, rowLine, sizeWords } from "./logic";

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** Downloads the whole file, asking first when it is big. Resolves undefined when the person said no. */
function fetchFile(artifact: Artifact): Promise<string | undefined> {
  if (!isBig(artifact) || useDownloads.getState()[artifact.id]?.uri) return download(artifact);
  return new Promise((resolve, reject) =>
    Alert.alert("Download " + sizeWords(artifact.size) + "?", undefined, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(undefined) },
      { text: "Download", onPress: () => download(artifact).then(resolve, reject) },
    ]),
  );
}

async function shareArtifact(artifact: Artifact) {
  try {
    const uri = await fetchFile(artifact);
    if (uri) await shareLocalFile(uri);
  } catch (error) {
    showToast(errorText(error, "Couldn't share that file."), "error");
  }
}

async function saveArtifact(artifact: Artifact) {
  try {
    const uri = await fetchFile(artifact);
    if (!uri) return;
    await saveToPhotos(uri);
    showToast("Saved to Photos", "success");
  } catch (error) {
    showToast(errorText(error, "Couldn't save that to Photos."), "error");
  }
}

function openChat(artifact: Artifact) {
  if (!artifact.chatId) return;
  // `at` lands on the message that made it, when the computer knows which.
  openChatRoute(artifact.chatId, artifact.messageIndex !== undefined ? { at: String(artifact.messageIndex) } : undefined);
}

/** "Add to a project…" in the bar ("project-artifacts-v1"): a menu of the projects; one that has it is checked. */
function AddToProject({ artifact }: { artifact: Artifact }) {
  const capable = useCapability("project-artifacts-v1");
  const projects = usePart("projects");
  const { colors } = useTheme();
  if (!capable || !projects?.length) return null;
  const sorted = [...projects].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 30);
  return (
    <MenuView
      title="Add to a project…"
      actions={sorted.map((project) => ({ id: project.id, title: project.name, state: project.artifacts?.includes(artifact.id) ? ("on" as const) : ("off" as const) }))}
      onPressAction={({ nativeEvent }) => {
        const project = sorted.find((item) => item.id === nativeEvent.event);
        if (!project) return;
        if (project.artifacts?.includes(artifact.id)) void attempt(api.removeProjectArtifact(project.id, artifact.id), "Removed from " + project.name);
        else void attempt(api.addProjectArtifact(project.id, artifact.id), "Added to " + project.name);
      }}
    >
      <View accessible accessibilityRole="button" accessibilityLabel="Add to a project…" style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
        <FolderPlus size={22} color={colors.ink} strokeWidth={2.1} />
      </View>
    </MenuView>
  );
}

export default function ArtifactView() {
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const can = useCapability("artifacts-v1");
  const online = useOnline();
  const [artifact, setArtifact] = useState<Artifact | undefined>(() => remembered(id));
  const [failed, setFailed] = useState<string>();
  const [tries, setTries] = useState(0);

  useEffect(() => {
    if (!can || !online || !id) return;
    let live = true;
    readArtifact(id).then(
      (found) => {
        if (!live) return;
        setArtifact(found);
        setFailed(undefined);
      },
      (error: unknown) => live && setFailed(errorText(error, "Couldn't open that file.")),
    );
    return () => {
      live = false;
    };
  }, [can, online, id, tries]);

  const kind = artifact ? previewKind(artifact) : undefined;
  // A folder is a list.
  useEffect(() => {
    if (artifact && kind === "folder") router.replace(folderHref(artifact));
  }, [artifact, kind]);
  // Leaving stops a download that only this screen wanted.
  useEffect(() => () => stopDownload(id), [id]);

  if (!can)
    return (
      <Page>
        <EmptyState icon={Package} title="Update the app on your computer" />
      </Page>
    );
  if (failed)
    return (
      <Page>
        <EmptyState icon={CircleAlert} title="Couldn't open this file" text={failed} action="Try again" onAction={() => setTries((n) => n + 1)} />
      </Page>
    );
  if (!artifact || !kind || kind === "folder")
    return <Page>{online ? <Loading /> : <EmptyState icon={Package} title="Can't reach your computer" />}</Page>;

  const bar = (
    <Stack.Screen
      options={{
        headerRight: () => (
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {!!artifact.url && <IconButton icon={ExternalLink} label="Open on claude.ai" size={44} onPress={() => openLink(artifact.url!)} />}
            {!!artifact.chatId && <IconButton icon={MessageCircle} label="Open chat" size={44} onPress={() => openChat(artifact)} />}
            <AddToProject artifact={artifact} />
            {canSaveToPhotos(kind) && <IconButton icon={ImageDown} label="Save to Photos" size={44} onPress={() => void saveArtifact(artifact)} />}
            <IconButton icon={Share} label="Share" size={44} onPress={() => void shareArtifact(artifact)} />
          </View>
        ),
      }}
    />
  );
  const head = (
    <View style={{ gap: 2 }}>
      <T variant="title2" accessibilityRole="header" numberOfLines={2}>
        {artifact.name}
      </T>
      <T variant="footnote" color="muted" numberOfLines={1}>
        {rowLine(artifact)}
      </T>
    </View>
  );

  if (isTextPreview(kind))
    return (
      <Page>
        {bar}
        {head}
        <TextPreview artifact={artifact} kind={kind} />
      </Page>
    );
  if (kind === "other")
    return (
      <Page>
        {bar}
        <View style={{ alignItems: "center", gap: space.md, paddingTop: space.huge }}>
          <ArtifactThumb artifact={artifact} size={72} />
          <T variant="title3" center numberOfLines={3}>
            {artifact.name}
          </T>
          <T variant="subhead" color="muted" center>
            {sizeWords(artifact.size) || "Size unknown"}
          </T>
          <Button title="Share" icon={Share} onPress={() => void shareArtifact(artifact)} style={{ alignSelf: "stretch", marginTop: space.md }} />
        </View>
      </Page>
    );
  return (
    <Page scroll={false}>
      {bar}
      {head}
      <FileViewer artifact={artifact} kind={kind} />
    </Page>
  );
}

// ---- Text, Markdown and code: the first 512 KB, read as one piece

function TextPreview({ artifact, kind }: { artifact: Artifact; kind: PreviewKind }) {
  const { colors, type } = useTheme();
  const online = useOnline();
  const [read, setRead] = useState<{ id: string; text?: string; cut?: boolean; error?: string }>();
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!online) return;
    let live = true;
    readText(artifact.id).then(
      ({ text, cut }) => live && setRead({ id: artifact.id, text, cut }),
      (error: unknown) => live && setRead({ id: artifact.id, error: errorText(error, "Couldn't read that file.") }),
    );
    return () => {
      live = false;
    };
  }, [online, artifact.id, tries]);

  const now = read?.id === artifact.id ? read : undefined;
  if (!now) return <Loading />;
  if (now.error || now.text === undefined) return <EmptyState icon={CircleAlert} title="Couldn't read this file" text={now.error} action="Try again" onAction={() => setTries((n) => n + 1)} />;
  const note = now.cut && (
    <T variant="footnote" color="muted" center>
      Showing the first 512 KB
    </T>
  );
  if (!now.text.trim())
    return (
      <T variant="callout" color="muted">
        Empty file
      </T>
    );
  if (kind === "markdown")
    return (
      <View style={{ gap: space.lg }}>
        <Markdown text={now.text} />
        {note}
      </View>
    );
  if (kind === "code")
    return (
      <View style={{ gap: space.md }}>
        <View style={{ borderRadius: radius.md, backgroundColor: colors.sunken, overflow: "hidden" }}>
          <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ padding: space.md }}>
            <Text selectable style={[type.mono, { color: colors.ink }]}>
              {now.text}
            </Text>
          </ScrollView>
        </View>
        {note}
      </View>
    );
  return (
    <View style={{ gap: space.md }}>
      <Text selectable style={[type.callout, { color: colors.ink }]}>
        {now.text}
      </Text>
      {note}
    </View>
  );
}

// ---- Pictures, video, sound and PDF: the whole file, downloaded to the phone first

function FileViewer({ artifact, kind }: { artifact: Artifact; kind: PreviewKind }) {
  const state = useDownloads((all) => all[artifact.id]);
  const big = isBig(artifact);
  const [asked, setAsked] = useState(!big);
  const [tries, setTries] = useState(0);
  const wanted = asked || !!state?.uri;
  useEffect(() => {
    if (wanted) download(artifact).catch(() => {});
  }, [wanted, artifact, tries]);

  if (!wanted)
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <EmptyState icon={Download} title={sizeWords(artifact.size)} action="Download" onAction={() => setAsked(true)} />
      </View>
    );
  if (state?.error)
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <EmptyState icon={CircleAlert} title="Couldn't download this file" text={state.error} action="Try again" onAction={() => setTries((n) => n + 1)} />
      </View>
    );
  if (!state?.uri) return <Fetching artifact={artifact} progress={state?.progress ?? 0} />;
  if (kind === "image") return <Zoomable uri={state.uri} name={artifact.name} />;
  return <MediaFrame uri={state.uri} kind={kind} name={artifact.name} />;
}

function Fetching({ artifact, progress }: { artifact: Artifact; progress: number }) {
  const { colors } = useTheme();
  const thumb = useThumbnail(artifact);
  const percent = Math.round(progress * 100);
  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: space.lg }}>
      {thumb && <Image source={{ uri: thumb }} style={{ width: "100%", height: 240, borderRadius: radius.md, opacity: 0.5 }} contentFit="contain" accessibilityIgnoresInvertColors />}
      <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percent }} accessibilityLabel="Downloading" style={{ width: "60%", height: 4, borderRadius: 2, backgroundColor: colors.sunken, overflow: "hidden" }}>
        <View style={{ width: `${Math.max(4, percent)}%`, height: 4, backgroundColor: colors.accent }} />
      </View>
      <T variant="footnote" color="muted">
        {"Downloading " + percent + "%"}
      </T>
    </View>
  );
}

/** A picture to pinch and zoom (the scroll view's own zoom). */
function Zoomable({ uri, name }: { uri: string; name: string }) {
  const [room, setRoom] = useState<{ width: number; height: number }>();
  return (
    <View style={{ flex: 1, marginHorizontal: -space.xl }} onLayout={(event) => setRoom({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
      {room && (
        <ScrollView maximumZoomScale={6} minimumZoomScale={1} centerContent bouncesZoom showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false} contentContainerStyle={{ width: room.width, height: room.height }}>
          <Image source={{ uri }} style={{ width: room.width, height: room.height }} contentFit="contain" accessible accessibilityLabel={name} accessibilityIgnoresInvertColors />
        </ScrollView>
      )}
    </View>
  );
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const shelf = () => new Directory(Paths.cache, "botkins-artifacts");

/**
 * Video, sound and PDF in a web view, from the downloaded file. The page runs no script, may load
 * only the file, and every navigation away is refused.
 */
function MediaFrame({ uri, kind, name }: { uri: string; kind: PreviewKind; name: string }) {
  const { colors } = useTheme();
  const [page, setPage] = useState<{ uri: string; for: string }>();
  const root = shelf().uri;
  useEffect(() => {
    if (kind === "pdf") return;
    // A small page around the player, next to the file.
    try {
      const html = new File(shelf(), "player.html");
      const tag = kind === "video" ? '<video controls playsinline preload="metadata" src="' + escapeHtml(uri) + '"></video>' : '<audio controls preload="metadata" src="' + escapeHtml(uri) + '"></audio>';
      html.create({ overwrite: true });
      void html
        .write(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; media-src file:; style-src 'unsafe-inline'\">" +
            "<style>html,body{margin:0;height:100%;background:" + colors.canvas + ";display:flex;align-items:center;justify-content:center}video{width:100%;max-height:100%}audio{width:92%}</style>" +
            tag,
        )
        .then(() => setPage({ uri: html.uri, for: uri }));
    } catch {
      setPage({ uri, for: uri });
    }
  }, [uri, kind, colors.canvas]);
  const source = kind === "pdf" ? uri : page?.for === uri ? page.uri : undefined;
  if (!source) return <Loading />;
  return (
    <View style={{ flex: 1, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.surface }} accessibilityLabel={name}>
      <WebView
        source={{ uri: source }}
        allowingReadAccessToURL={root}
        allowFileAccess
        // Everything passes the library's own list (one that fails it is handed to the phone's
        // browser); the check below refuses every load but the file's.
        originWhitelist={["*"]}
        javaScriptEnabled={false}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction
        allowsLinkPreview={false}
        onShouldStartLoadWithRequest={(request) => request.url.startsWith(root) || request.url === source}
        style={{ flex: 1, backgroundColor: colors.surface }}
      />
    </View>
  );
}
