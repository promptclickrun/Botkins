// The computer's own Botkins and its updates, on the computer's page ("app-update-v1";
// docs/link-contract.md). The words are the desktop app's (Settings › About). On a server, where
// the phone is the only screen, this is how Botkins there is kept up to date. Installing asks
// first, restarts Botkins on the computer, and the phone says how it ended once it is back
// (src/state/appUpdate.ts). The owner's devices only: the computer refuses these calls to a member.
import * as WebBrowser from "expo-web-browser";
import { Download, ExternalLink, History, RefreshCw, Zap } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import type { AppUpdate } from "@/link/types";
import { markRestarting, useRestarting } from "@/state/appUpdate";
import { useCapability, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { Button, Group, haptic, IconTile, Label, Row, space, useOnShow, useTheme } from "@/ui";
import { installQuestion, lastLine, UPDATE_CAPABILITY, updateBusy, updateButton, updateLine } from "./updates";

/** Where releases are, the same page the desktop app's "Open release" opens. */
const RELEASE_PAGE = "https://github.com/promptclickrun/Botkins/releases/latest";
const messageOf = (error: unknown) => (error instanceof Error ? error.message : "That didn't work. Try again.");

export function AppUpdates({ name }: { name: string }) {
  const { colors } = useTheme();
  const capable = useCapability(UPDATE_CAPABILITY);
  const online = useOnline();
  const visible = useOnShow();
  const serverId = useApp((state) => state.pairing?.serverId);
  const restarting = useRestarting();
  const [update, setUpdate] = useState<AppUpdate>();
  const [problem, setProblem] = useState<string>();
  const [working, setWorking] = useState(false);
  const busy = updateBusy(update) || !!restarting;

  // Read while the page is in view: every two seconds while something is under way (as the
  // desktop's About page does), else now and then.
  useEffect(() => {
    if (!capable || !online || !visible) return;
    let live = true;
    const read = () => api.appUpdateStatus().then((value) => live && setUpdate(value), () => {});
    void read();
    const timer = setInterval(read, busy ? 2000 : 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [capable, online, visible, busy]);

  if (!capable)
    return (
      <View>
        <Label>Updates</Label>
        <Group>
          <Row leading={<IconTile icon={RefreshCw} color={colors.ink2} />} title="Check for updates" subtitle="Update the app on your computer" subtitleLines={2} disabled />
        </Group>
      </View>
    );

  const button = updateButton(update);
  const check = async () => {
    setWorking(true);
    setProblem(undefined);
    try {
      setUpdate(await api.checkAppUpdate());
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setWorking(false);
    }
  };
  const install = () => {
    const question = installQuestion(name, update?.latest);
    Alert.alert(question.title, question.message, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Update and restart",
        onPress: async () => {
          setWorking(true);
          setProblem(undefined);
          const from = update?.current;
          const to = update?.latest;
          const before = update?.last?.at;
          try {
            const next = await api.installAppUpdate();
            setUpdate(next);
            haptic.success();
            if (serverId) markRestarting(serverId, next.current, next.latest ?? to, before);
          } catch (error) {
            // The restart can cut the reply short although the install began: ask where it stands
            // before calling it a failure, and if the computer is already gone, it is restarting.
            const now = await api.appUpdateStatus().catch(() => undefined);
            if (!now || updateBusy(now)) {
              if (now) setUpdate(now);
              if (serverId && from) markRestarting(serverId, from, now?.latest ?? to, before);
            } else {
              haptic.warn();
              setUpdate(now);
              setProblem(messageOf(error));
            }
          } finally {
            setWorking(false);
          }
        },
      },
    ]);
  };
  const setAuto = (on: boolean) => void attempt(api.setAppUpdateAuto(on)).then((next) => next && setUpdate(next));
  const last = lastLine(update?.last);
  const line = problem ?? (restarting && !updateBusy(update) ? "Restarting to install " + (restarting.to ?? "the update") + "…" : updateLine(update));

  return (
    <View style={{ gap: space.md }}>
      <View>
        <Label>Updates</Label>
        <Group>
          <Row leading={<IconTile icon={Download} color={colors.ink2} />} title={update ? "Botkins " + update.current : "Botkins"} subtitle={line || " "} subtitleLines={4} />
          {!!last && update?.last && (
            <Row leading={<IconTile icon={History} color={update.last.ok ? colors.ink2 : colors.danger} />} title="Last update" subtitle={last} subtitleLines={3} />
          )}
          {typeof update?.auto === "boolean" && (
            <Row
              leading={<IconTile icon={Zap} color={colors.ink2} />}
              title="Install updates automatically"
              subtitle={"Botkins on " + name + " installs a new version by itself"}
              subtitleLines={2}
              toggled={update.auto}
              disabled={!online}
              onToggle={setAuto}
            />
          )}
        </Group>
      </View>
      {button.kind === "install" ? (
        <Button title={button.title} icon={Download} size="lg" wide loading={working} disabled={!online || button.disabled} onPress={install} />
      ) : (
        <Button title={button.title} icon={RefreshCw} variant="secondary" wide loading={working} disabled={!online || button.disabled} onPress={() => void check()} />
      )}
      {update?.status === "available" && !update.canInstall && <Button title="Open release" icon={ExternalLink} variant="ghost" wide onPress={() => void WebBrowser.openBrowserAsync(RELEASE_PAGE)} />}
    </View>
  );
}
