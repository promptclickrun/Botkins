// The devices paired with the computer: phones, and other computers' Botkins apps that use this
// one. The same list as Settings › Phone on the computer, with the same two things to do: rename
// one and remove one (docs/link-contract.md). Needs "devices-v1".
import { Monitor, Smartphone } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import type { PairedDevice } from "@/link/types";
import { useOnline, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { ago } from "@/state/time";
import { brand, Group, IconTile, Label, Row } from "@/ui";

/** "This phone", "Connected", or when it was last heard from. */
function statusOf(device: PairedDevice): string {
  if (device.current) return "This phone";
  if (device.connected) return "Connected";
  const seen = ago(device.lastSeenAt);
  if (!seen) return "Not seen yet";
  if (seen === "now") return "Seen just now";
  if (/^\d+[mh]$/.test(seen)) return "Seen " + seen + " ago";
  return "Seen " + (seen === "Yesterday" ? "yesterday" : seen);
}

export function Devices() {
  const online = useOnline();
  const supported = usePart("meta")?.capabilities.includes("devices-v1");
  // The part changes when a device is paired, renamed or removed: the list is read again then.
  const phones = usePart("phones");
  const [devices, setDevices] = useState<PairedDevice[]>();
  const stamp = phones ? Object.entries(phones).map(([id, phone]) => id + ":" + phone.name).join("|") : "";
  useEffect(() => {
    if (!supported || !online) return;
    let live = true;
    void api["link.devices.list"]().then(
      (list) => live && setDevices(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [supported, online, stamp]);

  if (!supported || !devices?.length) return null;

  const rename = (device: PairedDevice) =>
    Alert.prompt(
      "Rename",
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save",
          onPress: (name?: string) => {
            if (name?.trim() && name.trim() !== device.name) void attempt(api["link.devices.rename"](device.id, name.trim())).then((list) => list && setDevices(list));
          },
        },
      ],
      "plain-text",
      device.name,
    );
  const remove = (device: PairedDevice) =>
    Alert.alert("Remove " + device.name + "?", "It can't reach your computer until it is paired again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void attempt(api["link.devices.remove"](device.id), "Removed").then((list) => list && setDevices(list)) },
    ]);
  const open = (device: PairedDevice) =>
    Alert.alert(device.name, statusOf(device), [
      { text: "Rename", onPress: () => rename(device) },
      // This phone is let go with "Unpair this phone" below.
      ...(device.current ? [] : [{ text: "Remove", style: "destructive" as const, onPress: () => remove(device) }]),
      { text: "Cancel", style: "cancel" as const },
    ]);

  return (
    <View>
      <Label>Devices</Label>
      <Group>
        {devices.map((device) => (
          <Row
            key={device.id}
            leading={<IconTile icon={device.kind === "desktop" ? Monitor : Smartphone} color={brand.tide} />}
            title={device.name}
            subtitle={statusOf(device)}
            chevron
            disabled={!online}
            onPress={() => open(device)}
          />
        ))}
      </Group>
    </View>
  );
}
