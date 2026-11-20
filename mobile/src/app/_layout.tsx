import "react-native-reanimated";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Appearance } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { boot } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { ToastHost, useTheme } from "@/ui";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const theme = useTheme();
  const { colors } = theme;
  const booted = useApp((state) => state.booted);
  const paired = useApp((state) => !!state.pairing);

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
  if (!booted) return null;

  const base = theme.dark ? DarkTheme : DefaultTheme;
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
    contentStyle: { backgroundColor: colors.canvas },
  } as const;
  const sheet = { presentation: "formSheet", headerShown: false, sheetGrabberVisible: true, sheetCornerRadius: 28, contentStyle: { backgroundColor: colors.canvas } } as const;
  const tall = { ...sheet, sheetAllowedDetents: [1] };
  const half = { ...sheet, sheetAllowedDetents: [0.6, 1] };

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.canvas }}>
      <KeyboardProvider>
        <ThemeProvider value={navigation}>
          <StatusBar style={theme.dark ? "light" : "dark"} />
          <Stack screenOptions={page}>
            <Stack.Protected guard={!paired}>
              <Stack.Screen name="welcome" options={{ headerShown: false, animation: "fade" }} />
            </Stack.Protected>
            <Stack.Protected guard={paired}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="chat/[id]" />
              <Stack.Screen name="chat/new" options={tall} />
              <Stack.Screen name="chat/model" options={tall} />
              <Stack.Screen name="chat/activity" options={tall} />
              <Stack.Screen name="chat/context" options={tall} />
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
              <Stack.Screen name="bot/[id]/capabilities" />
              <Stack.Screen name="bot/access" />
              <Stack.Screen name="today" />
              <Stack.Screen name="today/new" options={half} />
              <Stack.Screen name="today/routine" options={tall} />
              <Stack.Screen name="routine/[id]" options={tall} />
              <Stack.Screen name="task/[id]" options={tall} />
              <Stack.Screen name="tools/index" />
              <Stack.Screen name="tools/[id]" options={tall} />
              <Stack.Screen name="tools/device" />
              <Stack.Screen name="skills/index" />
              <Stack.Screen name="skills/[name]" options={tall} />
              <Stack.Screen name="models/index" />
              <Stack.Screen name="models/[id]" />
              <Stack.Screen name="projects/index" />
              <Stack.Screen name="projects/[id]" />
              <Stack.Screen name="market/app/[slug]" options={half} />
              <Stack.Screen name="market/category/[id]" />
              <Stack.Screen name="settings/desktop" />
              <Stack.Screen name="settings/appearance" />
              <Stack.Screen name="settings/approvals" />
              <Stack.Screen name="settings/harness" />
              <Stack.Screen name="settings/usage" />
              <Stack.Screen name="settings/about" />
              <Stack.Screen name="settings/chat" />
              <Stack.Screen name="settings/voice" />
              <Stack.Screen name="settings/notifications" />
              <Stack.Screen name="settings/access" />
              <Stack.Screen name="settings/window" />
              <Stack.Screen name="settings/bubble" options={half} />
              <Stack.Screen name="tools/import" options={tall} />
              <Stack.Screen name="folders" options={tall} />
              <Stack.Screen name="voice/live" options={{ headerShown: false, presentation: "fullScreenModal", animation: "fade" }} />
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
            <Stack.Screen name="pair/index" options={{ ...sheet, sheetAllowedDetents: [0.5] }} />
            <Stack.Screen name="pair/scan" options={{ presentation: "fullScreenModal", headerShown: false, animation: "slide_from_bottom" }} />
            <Stack.Screen name="pair/manual" options={{ ...sheet, sheetAllowedDetents: [0.62, 1] }} />
          </Stack>
          <ToastHost />
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
