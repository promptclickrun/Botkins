// The small pieces artifacts are drawn with: a type icon or a thumbnail, a row for a list, and the
// attachments under a chat message.
import { Image } from "expo-image";
import { File, FileCode, FileText, Film, Folder, Image as ImageIcon, type LucideIcon, Music, Package } from "lucide-react-native";
import { View } from "react-native";
import type { Artifact } from "@/link/types";
import { useCapability } from "@/state/hooks";
import { Group, IconTile, Label, radius, Row, space, T, Tap, useTheme } from "@/ui";
import { openArtifact, openArtifactList, useArtifactList, useThumbnail } from "./data";
import { type PreviewKind, previewKind, rowLine } from "./logic";

export const KIND_ICON: Record<PreviewKind, LucideIcon> = {
  image: ImageIcon,
  video: Film,
  audio: Music,
  text: FileText,
  markdown: FileText,
  code: FileCode,
  pdf: FileText,
  folder: Folder,
  other: File,
};

/** A picture's or a video's thumbnail, or the type's icon on a tile. */
export function ArtifactThumb({ artifact, size = 40 }: { artifact: Artifact; size?: number }) {
  const { colors } = useTheme();
  const thumb = useThumbnail(artifact);
  const kind = previewKind(artifact);
  if (thumb)
    return <Image source={{ uri: thumb }} style={{ width: size, height: size, borderRadius: size * 0.22, backgroundColor: colors.sunken }} contentFit="cover" accessibilityIgnoresInvertColors />;
  const tone = kind === "folder" ? colors.info : kind === "image" || kind === "video" ? colors.success : kind === "audio" ? colors.warning : kind === "code" ? colors.accent : colors.ink2;
  return <IconTile icon={KIND_ICON[kind]} color={tone} size={size} />;
}

/** One artifact in a list: its picture or icon, its name, and size · when · chat. */
export function ArtifactRow({ artifact }: { artifact: Artifact }) {
  return <Row leading={<ArtifactThumb artifact={artifact} />} title={artifact.name} subtitle={rowLine(artifact)} chevron onPress={() => openArtifact(artifact)} />;
}

/** A message's MEDIA: attachments: a thumbnail for a picture, a chip for anything else. */
export function ArtifactChips({ items, align }: { items: Artifact[]; align: "flex-start" | "flex-end" }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: align, gap: space.sm }}>
      {items.map((artifact) =>
        artifact.kind === "image" ? (
          <Picture key={artifact.id} artifact={artifact} />
        ) : (
          <Attachment key={artifact.id} artifact={artifact} />
        ),
      )}
    </View>
  );
}

function Attachment({ artifact }: { artifact: Artifact }) {
  const { colors } = useTheme();
  const Icon = KIND_ICON[previewKind(artifact)];
  return (
    <Tap
      onPress={() => openArtifact(artifact)}
      feel="select"
      hitSlop={{ top: 6, bottom: 6 }}
      accessibilityRole="button"
      accessibilityLabel={"Open " + artifact.name}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", minHeight: 32, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: colors.sunken }}
    >
      <Icon size={14} color={colors.muted} strokeWidth={2.2} />
      <T variant="footnote" weight="600" color="ink2" numberOfLines={1} style={{ flexShrink: 1 }}>
        {artifact.name}
      </T>
    </Tap>
  );
}

function Picture({ artifact }: { artifact: Artifact }) {
  const { colors } = useTheme();
  const thumb = useThumbnail(artifact);
  return (
    <Tap onPress={() => openArtifact(artifact)} feel="select" sink={0.97} accessibilityRole="imagebutton" accessibilityLabel={"Open " + artifact.name}>
      <View style={{ width: 160, height: 120, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.sunken, alignItems: "center", justifyContent: "center" }}>
        {thumb ? <Image source={{ uri: thumb }} style={{ width: 160, height: 120 }} contentFit="cover" accessibilityIgnoresInvertColors /> : <ImageIcon size={22} color={colors.muted} strokeWidth={2} />}
      </View>
    </Tap>
  );
}

/** The bot page's section: the newest three, and the way to all of them. One list call, read again when the index changes. */
export function BotArtifacts({ botId }: { botId: string }) {
  const { colors } = useTheme();
  const can = useCapability("artifacts-v1");
  const list = useArtifactList({ botId, enabled: can });
  const newest = list.items.slice(0, 3);
  return (
    <View>
      <Label>Artifacts</Label>
      <Group>
        {!can ? (
          <Row leading={<IconTile icon={Package} color={colors.ink2} />} title="Artifacts" subtitle="Update the app on your computer" disabled />
        ) : (
          [
            ...newest.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} />),
            <Row
              key="all"
              leading={<IconTile icon={Package} color={colors.ink2} />}
              title="All artifacts"
              value={list.loaded && !list.error && newest.length === 0 ? "None yet" : undefined}
              chevron
              onPress={() => openArtifactList(botId)}
            />,
          ]
        )}
      </Group>
    </View>
  );
}
