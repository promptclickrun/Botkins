import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { Camera, Keyboard, X } from "lucide-react-native";
import { useRef } from "react";
import { ActivityIndicator, Linking, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { parsePairingUrl } from "@/link/pairing";
import { showToast } from "@/state/store";
import { Button, EmptyState, haptic, IconButton, space, T, useTheme } from "@/ui";
import { usePairing } from "./usePairing";

const FRAME = 248;

/** The camera, looking for the pairing code a computer shows. */
export default function Scan() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [permission, request] = useCameraPermissions();
  const { busy, error, start, clear } = usePairing();
  const last = useRef({ data: "", time: 0 });

  function scanned(data: string) {
    if (busy) return;
    // The camera reports the same code many times a second.
    const now = Date.now();
    if (data === last.current.data && now - last.current.time < 4000) return;
    last.current = { data, time: now };
    const target = parsePairingUrl(data);
    if (!target) {
      haptic.warn();
      showToast("That isn't a Botkins pairing code.", "error");
      return;
    }
    haptic.tap();
    clear();
    void start(target);
  }

  const close = <IconButton icon={X} label="Close" variant="soft" onPress={() => router.back()} style={{ position: "absolute", top: insets.top + space.sm, left: space.lg }} />;
  if (!permission) return <View style={{ flex: 1, backgroundColor: colors.canvas }} />;
  if (!permission.granted)
    return (
      <View style={{ flex: 1, backgroundColor: colors.canvas, justifyContent: "center" }}>
        <EmptyState
          icon={Camera}
          title="Allow the camera"
          text="Botkins uses it only to read the pairing code on your computer."
          action={permission.canAskAgain ? "Continue" : "Open Settings"}
          onAction={() => (permission.canAskAgain ? void request() : void Linking.openSettings())}
        />
        <Button title="Enter a code instead" icon={Keyboard} variant="ghost" style={{ alignSelf: "center" }} onPress={() => router.replace("/pair/manual")} />
        {close}
      </View>
    );

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => scanned(data)} />
      <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]} pointerEvents="none">
        <View style={{ width: FRAME, height: FRAME, borderRadius: 36, borderWidth: 3, borderColor: error ? colors.danger : "#FFFFFF", alignItems: "center", justifyContent: "center", backgroundColor: busy ? "rgba(0,0,0,0.45)" : "transparent" }}>
          {busy && <ActivityIndicator color="#FFFFFF" size="large" />}
        </View>
        <View style={{ marginTop: space.xl, paddingHorizontal: space.lg, paddingVertical: 10, borderRadius: 999, backgroundColor: "rgba(0,0,0,0.55)", maxWidth: 320 }}>
          <T variant="subhead" weight="600" color="#FFFFFF" center>
            {busy ? "Pairing…" : (error ?? "Point at the code on your computer")}
          </T>
        </View>
      </View>
      <IconButton icon={X} label="Close" onPress={() => router.back()} color="#FFFFFF" style={{ position: "absolute", top: insets.top + space.sm, left: space.lg, backgroundColor: "rgba(0,0,0,0.45)" }} />
      <View style={{ position: "absolute", left: 0, right: 0, bottom: insets.bottom + space.xl, alignItems: "center" }}>
        <Button title="Enter a code instead" icon={Keyboard} variant="secondary" style={{ alignSelf: "center" }} onPress={() => router.replace("/pair/manual")} />
      </View>
    </View>
  );
}
