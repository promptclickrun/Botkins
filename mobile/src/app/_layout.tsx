import "react-native-reanimated";
import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider, usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useRef } from "react";
import { Appearance } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { boot } from "@/state/link";
import { listenForShortcuts } from "@/features/shortcuts/bridge";
import { forget, readKept } from "@/state/keep";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { loadProfile, useProfile } from "@/state/profile";
import { JOIN_ATTEMPT_KEY, resumeDecision } from "@/features/pair/joinLogic";
import { ToastHost, useShape, useTheme } from "@/ui";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const theme = useTheme();
  const shape = useShape();
  const { colors } = theme;
  const booted = useApp((state) => state.booted);
  const paired = useApp((state) => !!state.pairing);
  const pairings = useApp((state) => state.pairings);
  const profileLoaded = useProfile((state) => state.loaded);
  const profilePrompt = useProfile((state) => state.prompt);
  const pathname = usePathname();
  const resumeChecked = useRef(false);

  const mode = usePrefs((prefs) => prefs.mode);

  useEffect(() => {
    void boot();
  }, []);
  // The phone's own parts (tab bar, menus, keyboard, alerts) follow the chosen mode too.
  useEffect(() => {
    Appearance.setColorScheme(mode === "system" ? "auto" : mode);
  }, [mode]);
  useEffect(() => {
    if (booted) void SplashScreen.hideAsync();
  }, [booted]);
  // A join request that waits for a team's owner is picked up again at launch, on top of Welcome or
  // Home so it can always be closed. One that is old or unreadable is dropped (resumeDecision).
  // Read once, when the keychain answers: the first screen changes meanwhile ("/" leads to Welcome
  // or Home), and that must not cancel it. A person already on Join (an invite link) stays there.
  const where = useRef(pathname);
  useEffect(() => {
    where.current = pathname;
  }, [pathname]);
  useEffect(() => {
    if (!booted || resumeChecked.current) return;
    resumeChecked.current = true;
    void readKept(JOIN_ATTEMPT_KEY).then((saved) => {
      const next = resumeDecision(saved, Date.now());
      if (next.kind === "drop") void forget(JOIN_ATTEMPT_KEY).catch(() => {});
      if (next.kind === "resume" && where.current !== "/join") router.push({ pathname: "/join", params: { resume: "1" } });
    }, () => {});
  }, [booted]);
  useEffect(() => {
    if (booted) return listenForShortcuts(true);
  }, [booted]);
  useEffect(() => {
    if (booted) void loadProfile(pairings.length);
  }, [booted, pairings.length]);
  useEffect(() => {
    const inSetupFlow = pathname === "/profile" || pathname.startsWith("/pair") || pathname === "/join" || pathname === "/setup";
    if (!booted || !profileLoaded || !profilePrompt || inSetupFlow) return;
    const timer = setTimeout(() => router.push({ pathname: "/profile", params: { prompt: profilePrompt } }), 0);
    return () => clearTimeout(timer);
  }, [booted, profileLoaded, profilePrompt, pathname]);
  if (!booted) return null;

  const base = theme.dark ? DarkTheme : DefaultTheme;
  // Every pushed page and sheet keeps out of the side rail (iPhone Duo puts the bars on one edge).
  // The tabs lay themselves out: their tab bar is that rail.
  const sides = { paddingLeft: shape.left, paddingRight: shape.right };
  const navigation = { ...base, colors: { ...base.colors, background: colors.canvas, card: colors.canvas, text: colors.ink, border: colors.line, primary: colors.accent } };
  // A pushed page: a bare native bar with a back button, the page draws its own title.
  const page = {
    headerShown: true,
    title: "",
    headerTitle: "",
    headerShadowVisible: false,
    headerBackButtonDisplayMode: "minimal",
    headerTintColor: colors.ink,
    headerStyle: { backgroundColor: colors.canvas },
    contentStyle: { backgroundColor: colors.canvas, ...sides },
    statusBarStyle: theme.dark ? "light" : "dark",
  } as const;
  // A sheet fills the width on a narrow screen, rail and all; with room for two panes it is a card away from it.
  const sheet = { presentation: "formSheet", headerShown: false, sheetGrabberVisible: true, sheetCornerRadius: 28, contentStyle: { backgroundColor: colors.canvas, ...(shape.wide ? {} : sides) } } as const;
  const tall = { ...sheet, sheetAllowedDetents: [1] };
  const half = { ...sheet, sheetAllowedDetents: [0.6, 1] };

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.canvas }}>
      <KeyboardProvider>
        <ThemeProvider value={navigation}>
          <Stack screenOptions={page}>
            {/* Each guard names where it leads. Without it, a phone with no computer was sent to the first open route by file name, which is the team join sheet. */}
            <Stack.Protected guard={!paired} redirectTo="/">
              <Stack.Screen name="welcome" options={{ headerShown: false, animation: "fade", statusBarStyle: "dark" }} />
            </Stack.Protected>
            <Stack.Protected guard={paired} redirectTo="/welcome">
              <Stack.Screen name="(tabs)" options={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas } }} />
              <Stack.Screen name="chat/[id]" />
              {/* Links from widgets, Live Activities and notifications (src/features/open): each hands over to a real screen at once. */}
              <Stack.Screen name="open/bot/[id]" options={{ headerShown: false, animation: "none" }} />
              <Stack.Screen name="open/chat/[id]" options={{ headerShown: false, animation: "none" }} />
              <Stack.Screen name="open/answer" options={{ headerShown: false, animation: "none" }} />
              <Stack.Screen name="open/usage" options={{ headerShown: false, animation: "none" }} />
              <Stack.Screen name="open/panel" options={{ headerShown: false, animation: "none" }} />
              <Stack.Screen name="chat/new" options={tall} />
              <Stack.Screen name="chat/model" options={tall} />
              <Stack.Screen name="chat/activity" options={tall} />
              <Stack.Screen name="chat/helper" options={tall} />
              <Stack.Screen name="chat/context" options={tall} />
              <Stack.Screen name="chat/people" options={half} />
              <Stack.Screen name="chat/changes" options={tall} />
              <Stack.Screen name="chat/pane" options={tall} />
              <Stack.Screen name="frame" />
              <Stack.Screen name="chat/model-info" options={tall} />
              <Stack.Screen name="bot/new" options={tall} />
              <Stack.Screen name="bot/agents" options={tall} />
              <Stack.Screen name="bot/[id]/index" />
              <Stack.Screen name="bot/[id]/edit" options={tall} />
              <Stack.Screen name="bot/[id]/look" options={tall} />
              <Stack.Screen name="bot/[id]/instructions" options={tall} />
              <Stack.Screen name="bot/[id]/memory" options={tall} />
              <Stack.Screen name="bot/[id]/voice" options={tall} />
              <Stack.Screen name="bot/[id]/capabilities" />
              <Stack.Screen name="bot/[id]/proactive" />
              <Stack.Screen name="bot/access" />
              <Stack.Screen name="today" />
              <Stack.Screen name="today/new" options={half} />
              <Stack.Screen name="today/routine" options={tall} />
              <Stack.Screen name="space/[id]" />
              <Stack.Screen name="space/panel" />
              <Stack.Screen name="space/share" options={tall} />
              <Stack.Screen name="space/new-panel" options={tall} />
              <Stack.Screen name="space/ask" options={half} />
              <Stack.Screen name="routine/[id]" options={tall} />
              <Stack.Screen name="task/[id]" options={tall} />
              <Stack.Screen name="tools/index" />
              <Stack.Screen name="tools/[id]" options={tall} />
              <Stack.Screen name="tools/device" />
              <Stack.Screen name="skills/index" />
              <Stack.Screen name="skills/[name]" options={tall} />
              <Stack.Screen name="models/index" />
              <Stack.Screen name="models/[id]" />
              <Stack.Screen name="models/signin" options={{ ...sheet, sheetAllowedDetents: [0.75, 1] }} />
              <Stack.Screen name="projects/index" />
              <Stack.Screen name="work/activity" />
              <Stack.Screen name="projects/[id]" />
              <Stack.Screen name="projects/add-chats" options={tall} />
              <Stack.Screen name="projects/attach" options={tall} />
              <Stack.Screen name="market/app/[slug]" options={half} />
              <Stack.Screen name="market/category/[id]" />
              <Stack.Screen name="market/plugin" />
              <Stack.Screen name="market/agent" />
              <Stack.Screen name="market/plugin-install" options={tall} />
              <Stack.Screen name="market/plugin-update" options={tall} />
              <Stack.Screen name="market/add-marketplace" options={half} />
              <Stack.Screen name="settings/index" />
              <Stack.Screen name="settings/desktop" />
              <Stack.Screen name="settings/computers" />
              <Stack.Screen name="settings/gadget/[id]" />
              <Stack.Screen name="settings/tabs" />
              <Stack.Screen name="settings/appearance" />
              <Stack.Screen name="settings/approvals" />
              <Stack.Screen name="settings/harness" />
              <Stack.Screen name="settings/usage" />
              <Stack.Screen name="settings/about" />
              <Stack.Screen name="settings/chat" />
              <Stack.Screen name="settings/experimental" />
              <Stack.Screen name="settings/voice" />
              <Stack.Screen name="settings/voice/dictation" />
              <Stack.Screen name="settings/voice/reading" />
              <Stack.Screen name="settings/voice/live" />
              <Stack.Screen name="settings/voice/keys" />
              <Stack.Screen name="settings/notifications" />
              <Stack.Screen name="settings/access" />
              <Stack.Screen name="settings/window" />
              <Stack.Screen name="settings/bubble" options={half} />
              <Stack.Screen name="settings/team/index" />
              <Stack.Screen name="settings/team/role" options={tall} />
              <Stack.Screen name="tools/import" options={tall} />
              <Stack.Screen name="folders" options={tall} />
              <Stack.Screen name="credentials/index" />
              <Stack.Screen name="credentials/[id]" options={tall} />
              <Stack.Screen name="credentials/manager/[id]" />
              <Stack.Screen name="remote" options={{ headerShown: false, presentation: "fullScreenModal", animation: "fade" }} />
              <Stack.Screen name="wiki/index" />
              <Stack.Screen name="wiki/page" />
              <Stack.Screen name="wiki/edit" options={tall} />
              <Stack.Screen name="wiki/export" options={tall} />
              <Stack.Screen name="artifacts/index" />
              <Stack.Screen name="artifacts/view" />
            </Stack.Protected>
            <Stack.Screen name="profile" />
            <Stack.Screen name="pair/index" options={{ ...sheet, sheetAllowedDetents: [0.5] }} />
            <Stack.Screen name="pair/scan" options={{ presentation: "fullScreenModal", headerShown: false, animation: "slide_from_bottom" }} />
            <Stack.Screen name="pair/manual" options={{ ...sheet, sheetAllowedDetents: [0.62, 1] }} />
            <Stack.Screen name="pair/name" options={{ ...sheet, sheetAllowedDetents: [0.5, 1] }} />
            <Stack.Screen name="join" options={{ ...sheet, sheetAllowedDetents: [0.72, 1] }} />
            <Stack.Screen name="setup" options={tall} />
          </Stack>
          <ToastHost />
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
