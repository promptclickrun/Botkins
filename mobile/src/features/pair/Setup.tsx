import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { Cloud, Copy, ExternalLink, Monitor, QrCode, Share2 } from "lucide-react-native";
import type { ReactNode } from "react";
import { Linking, Platform, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { showToast } from "@/state/store";
import { brand, Button, IconTile, radius, Sheet, space, T, useTheme } from "@/ui";
import { AZURE_DEPLOY_URL, DOWNLOAD_URL } from "./setupLinks";

const open = (url: string) => void Linking.openURL(url).catch(() => showToast("Couldn't open that page.", "error"));

/** Sends the download link on, so the person can open it on the computer it is for. */
async function shareDownload() {
  // iOS shares `url` as a link; Android takes only `message`.
  await Share.share(Platform.OS === "ios" ? { url: DOWNLOAD_URL } : { message: DOWNLOAD_URL }).catch(() => {});
}

async function copyDownload() {
  await Clipboard.setStringAsync(DOWNLOAD_URL);
  showToast("Link copied", "success");
}

/** One way to set up Botkins: a tile, what it is, how it goes, and what to tap. */
function Way({ icon, color, title, children, actions }: { icon: typeof Monitor; color: string; title: string; children: ReactNode; actions: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <IconTile icon={icon} color={color} size={36} />
        <T variant="headline" style={{ flex: 1 }} accessibilityRole="header">
          {title}
        </T>
      </View>
      {children}
      <View style={{ gap: space.sm }}>{actions}</View>
    </View>
  );
}

/**
 * "Set up a new Botkins": the two places Botkins can run (a computer, or a server on Azure) and a
 * link out to each. Opened from Welcome and from Settings › Computers and teams.
 */
export default function Setup() {
  const insets = useSafeAreaInsets();
  return (
    <Sheet
      title="Set up a new Botkins"
      footer={
        <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm, paddingBottom: insets.bottom + space.lg }}>
          <Button title="Connect to my computer" icon={QrCode} size="lg" wide onPress={() => router.replace("/pair/scan")} />
        </View>
      }
    >
      <T variant="callout" color="muted">
        Botkins runs on a computer or a server of your own. Set it up there, then connect this phone to it.
      </T>

      <Way
        icon={Monitor}
        color={brand.tide}
        title="On a Mac, Windows or Linux computer"
        actions={
          <>
            <Button title="Open the download page" icon={ExternalLink} variant="secondary" wide onPress={() => open(DOWNLOAD_URL)} />
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Button title="Share link" icon={Share2} variant="ghost" size="sm" onPress={() => void shareDownload()} />
              <Button title="Copy link" icon={Copy} variant="ghost" size="sm" onPress={() => void copyDownload()} />
            </View>
          </>
        }
      >
        <T variant="subhead" color="ink2">
          Download Botkins on that computer and open it. In its Settings › Phone, turn on phone access: it shows a code to scan.
        </T>
      </Way>

      <Way icon={Cloud} color={brand.clay} title="On a server in the cloud" actions={<Button title="Deploy to Azure" icon={ExternalLink} variant="secondary" wide onPress={() => open(AZURE_DEPLOY_URL)} />}>
        <T variant="subhead" color="ink2">
          Make your own Botkins server in your Azure account. It works from this phone, with no SSH key.
        </T>
        <T variant="subhead" color="ink2">
          When it finishes, open Outputs and tap pairingLink. Botkins opens and connects to the new server.
        </T>
      </Way>
    </Sheet>
  );
}
