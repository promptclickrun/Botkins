// The devices paired with the computer: phones, and other computers' Botkins apps that use this
// one. The same list as Settings › Phone on the computer, with the same things to do: name the
// person a device belongs to ("device-person-v1"), rename the device, and remove it
// (docs/link-contract.md). Needs "devices-v1". A row shows the person first, then the model. A gadget
// opens its own page with every setting when the computer has "gadget-settings-v1" (GadgetPage.tsx).
import { router } from "expo-router";
import { Monitor, Smartphone, Speaker } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import type { PairedDevice } from "@/link/types";
import { deviceSubtitle, deviceTitle } from "@/features/pair/person";
import { useOnline, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { ago } from "@/state/time";
import { GADGET_SETTINGS } from "./gadget";
import { brand, Group, IconTile, Label, Row, useTextPrompt } from "@/ui";

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
  const capabilities = usePart("meta")?.capabilities;
  const supported = capabilities?.includes("devices-v1");
  const named = capabilities?.includes("device-person-v1");
  const prompt = useTextPrompt();
  const gadgetPages = capabilities?.includes(GADGET_SETTINGS);
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

  const changePerson = (device: PairedDevice) =>
    prompt.ask({
      title: device.person ? "Change name" : "Add name",
      message: "Who this " + (device.kind === "desktop" ? "computer" : device.kind === "gadget" ? "gadget" : "phone") + " belongs to",
      value: device.person ?? "",
      onSubmit: (next) => {
        if (next !== device.person) void attempt(api["link.devices.setPerson"](device.id, next)).then((list) => list && setDevices(list));
      },
    });
  const rename = (device: PairedDevice) =>
    prompt.ask({
      title: "Rename device",
      value: device.name,
      onSubmit: (name) => {
        if (name !== device.name) void attempt(api["link.devices.rename"](device.id, name)).then((list) => list && setDevices(list));
      },
    });
  const remove = (device: PairedDevice) =>
    Alert.alert("Remove " + deviceTitle(device) + "?", "It can't reach your computer until it is paired again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void attempt(api["link.devices.remove"](device.id), "Removed").then((list) => list && setDevices(list)) },
    ]);
  const open = (device: PairedDevice) =>
    device.kind === "gadget" && gadgetPages
      ? router.push({ pathname: "/settings/gadget/[id]", params: { id: device.id } })
      : Alert.alert(deviceTitle(device), deviceSubtitle(device, statusOf(device)), [
      ...(named ? [{ text: device.person ? "Change name" : "Add name", onPress: () => changePerson(device) }] : []),
      { text: "Rename device", onPress: () => rename(device) },
      // This phone is let go with "Unpair this phone" below.
      ...(device.current ? [] : [{ text: "Remove", style: "destructive" as const, onPress: () => remove(device) }]),
      { text: "Cancel", style: "cancel" as const },
    ]);

  return (
    <View>
      {prompt.node}
      <Label>Devices</Label>
      <Group>
        {devices.map((device) => (
          <Row
            key={device.id}
            leading={<IconTile icon={device.kind === "desktop" ? Monitor : device.kind === "gadget" ? Speaker : Smartphone} color={brand.tide} />}
            title={deviceTitle(device)}
            subtitle={deviceSubtitle(device, statusOf(device))}
            chevron
            disabled={!online}
            onPress={() => open(device)}
          />
        ))}
      </Group>
    </View>
  );
}
