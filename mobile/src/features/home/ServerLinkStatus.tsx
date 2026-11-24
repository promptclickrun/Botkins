// Compact inline connection status beside Home's computer rail:
// spins while connecting, briefly shows a green checkbox on connect before fading away,
// and shows an orange disconnected icon with a refresh button when the connection fails.
import { CloudOff, RefreshCw, SquareCheck } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { wake } from "@/state/link";
import { useApp } from "@/state/store";
import { slopFor, Tap, useTheme } from "@/ui";
import { CONNECTED_HOLD_MS, initialServerLinkPhase, MIN_RETRY_SPIN_MS, nextServerLinkPhase, type ServerLinkPhase } from "./linkStatus";

export function ServerLinkStatus() {
  const { colors } = useTheme();
  const link = useApp((state) => state.link);
  const computer = useApp((state) => state.pairing?.name) ?? "Computer";
  const serverId = useApp((state) => state.pairing?.serverId);

  const [phase, setPhase] = useState<ServerLinkPhase>(() => initialServerLinkPhase(link));
  const [minSpinActive, setMinSpinActive] = useState(false);
  const lastServer = useRef(serverId);

  useEffect(() => {
    if (lastServer.current !== serverId) {
      lastServer.current = serverId;
      setMinSpinActive(false);
      setPhase(initialServerLinkPhase(link));
      return;
    }
    if (link === "online" || link === "revoked") setMinSpinActive(false);
    setPhase((current) => nextServerLinkPhase(current, link, minSpinActive));
  }, [link, serverId, minSpinActive]);

  useEffect(() => {
    if (!minSpinActive) return;
    const timer = setTimeout(() => setMinSpinActive(false), MIN_RETRY_SPIN_MS);
    return () => clearTimeout(timer);
  }, [minSpinActive]);

  useEffect(() => {
    if (phase !== "connected") return;
    const timer = setTimeout(() => setPhase("hidden"), CONNECTED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === "hidden") return null;

  const retry = () => {
    setMinSpinActive(true);
    setPhase("connecting");
    wake();
  };

  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(300)}
      style={{ flexShrink: 0, height: 32, flexDirection: "row", alignItems: "center", gap: 4 }}
    >
      {phase === "connecting" && (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={"Connecting to " + computer}
          accessibilityLiveRegion="polite"
          style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}
        >
          <ActivityIndicator size="small" color={colors.muted} style={{ transform: [{ scale: 0.85 }] }} />
        </View>
      )}
      {phase === "connected" && (
        <Animated.View
          entering={FadeIn.duration(160)}
          accessible
          accessibilityLabel={"Connected to " + computer}
          accessibilityLiveRegion="polite"
          style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}
        >
          <SquareCheck size={17} color={colors.success} strokeWidth={2.3} />
        </Animated.View>
      )}
      {phase === "failed" && (
        <Animated.View entering={FadeIn.duration(160)} style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
          <View
            accessible
            accessibilityLabel={"Can't reach " + computer}
            accessibilityLiveRegion="polite"
            style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}
          >
            <CloudOff size={17} color={colors.warning} strokeWidth={2.2} />
          </View>
          <Tap
            onPress={retry}
            feel="select"
            sink={0.88}
            hitSlop={slopFor(28)}
            accessibilityLabel={"Retry connecting to " + computer}
            style={{ width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" }}
          >
            <RefreshCw size={15} color={colors.ink2} strokeWidth={2.2} />
          </Tap>
        </Animated.View>
      )}
    </Animated.View>
  );
}
