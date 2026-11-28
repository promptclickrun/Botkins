import * as Application from "expo-application";
import Constants from "expo-constants";
import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { Calls } from "@/link/types";
import { useOnline, usePart } from "@/state/hooks";
import * as Clipboard from "expo-clipboard";
import { crashText } from "@/state/crashNote";
import { clearLastCrash, readLastCrash } from "@/state/lastCrash";
import { api } from "@/state/link";
import { showToast } from "@/state/store";
import { Button, Group, Label, MascotPair, Page, Row, space, T, useTheme } from "@/ui";
import { platformName } from "./computer";
import { capitalize } from "./shared";

const WORDMARK = require("../../../assets/images/wordmark.png");
const WORDMARK_DARK = require("../../../assets/images/wordmark-dark.png");

/** The app's name, its version, and the computer's. */
export default function About() {
  const { dark } = useTheme();
  const meta = usePart("meta");
  const version = Application.nativeApplicationVersion ?? Constants.expoConfig?.version;
  const build = Application.nativeBuildVersion;
  const online = useOnline();
  // What the computer's app runs on (its Settings › About). An older computer, or one out of reach, shows only its version.
  const [info, setInfo] = useState<ReturnType<Calls["appInfo"]>>();
  // The last error that closed the app or stopped a screen, if the phone kept one.
  const [crash, setCrash] = useState(readLastCrash);
  useEffect(() => {
    if (!online) return;
    let live = true;
    void api.appInfo().then((answer) => live && setInfo(answer), () => {});
    return () => {
      live = false;
    };
  }, [online]);
  return (
    <Page quietLink>
      <View style={{ alignItems: "center", gap: space.lg, paddingTop: space.xl, paddingBottom: space.md }}>
        <MascotPair size={128} />
        <Image source={dark ? WORDMARK_DARK : WORDMARK} style={{ width: 200, height: 60 }} contentFit="contain" accessibilityLabel="Botkins" accessible />
        {!!version && (
          <T variant="subhead" color="muted" center selectable>
            {"Version " + version + (build && build !== version ? " (" + build + ")" : "")}
          </T>
        )}
      </View>
      {meta && (
        <Group>
          <Row title="Your computer" value={capitalize(meta.app) + " " + meta.version} />
          {!!info?.electron && <Row title="Electron" value={info.electron} />}
          {!!info?.chrome && <Row title="Chromium" value={info.chrome} />}
          {!!info?.platform && <Row title="Platform" value={platformName(info.platform)} />}
        </Group>
      )}
      {crash && (
        <>
          <Label>{crash.kind === "fatal" ? "Last time the app closed" : "Last screen that failed"}</Label>
          <Group>
            <View style={{ padding: space.lg, gap: space.sm }}>
              <T variant="footnote" color="muted">
                {new Date(crash.at).toLocaleString() + (crash.version ? " · version " + crash.version : "")}
              </T>
              <T variant="callout" selectable>
                {crash.message}
              </T>
              {!!crash.stack && (
                <T variant="caption" color="faint" selectable numberOfLines={10}>
                  {crash.stack}
                </T>
              )}
            </View>
          </Group>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button title="Copy details" variant="secondary" style={{ flex: 1 }} onPress={() => void Clipboard.setStringAsync(crashText(crash)).then(() => showToast("Copied", "success"))} />
            <Button
              title="Clear"
              variant="secondary"
              style={{ flex: 1 }}
              onPress={() => {
                clearLastCrash();
                setCrash(null);
              }}
            />
          </View>
        </>
      )}
    </Page>
  );
}
