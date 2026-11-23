// What the pages of Settings › Voice share: a row that opens a short list of choices, a provider's
// mark, the row that opens a provider's sheet, and saving the computer's choices.
import { MenuView } from "@react-native-menu/menu";
import { ChevronsUpDown, Cpu, Server, Smartphone } from "lucide-react-native";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { VoicePatch, VoiceSettings } from "@/link/types";
import { api, attempt } from "@/state/link";
import { Group, IconTile, ProviderIcon, Row, space, T, useTextPrompt, useTheme } from "@/ui";
import { markOf, missing, OTHER, providerName, providerState, type Typing, withTyped } from "../choices";
import { ProviderSheet } from "../ProviderSheet";
import { type SheetProvider, setupFor } from "./summary";

export type Option = { value: string; label: string; subtitle?: string };

/** The computer's voice settings are saved there and shared by every phone. */
export const save = (patch: VoicePatch) => void attempt(api["link.voice.set"](patch));

/** A row whose value opens a short list of choices. */
export function Choice({ title, subtitle, value, options, onChange, disabled }: { title: string; subtitle?: string; value: string; options: Option[]; onChange: (value: string) => void; disabled?: boolean }) {
  const { colors } = useTheme();
  const current = options.find((option) => option.value === value);
  return (
    <MenuView
      title={title}
      actions={options.map((option) => ({ id: option.value || "-", title: option.label, subtitle: option.subtitle, state: option.value === value ? "on" : "off", attributes: disabled ? { disabled: true } : undefined }))}
      onPressAction={({ nativeEvent }) => !disabled && onChange(nativeEvent.event === "-" ? "" : nativeEvent.event)}
      isAnchoredToRight
    >
      <View accessible accessibilityRole="button" accessibilityLabel={title + ", " + (current?.label ?? "Default")} accessibilityHint="Opens the choices" accessibilityState={{ disabled }}>
        <Row title={title} subtitle={subtitle} value={current?.label ?? (value || "Default")} disabled={disabled} trailing={<ChevronsUpDown size={16} color={colors.faint} strokeWidth={2.2} />} />
      </View>
    </MenuView>
  );
}

/** "Default" first, then what the provider offers. A provider that names its own default (an item with no id, such as Azure's standard voices) is not given a second one. */
export const withDefault = (items: { id: string; name: string; subtitle?: string }[]): Option[] => [...(items.some((item) => !item.id) ? [] : [{ value: "", label: "Default" }]), ...items.map((item) => ({ value: item.id, label: item.name, subtitle: item.subtitle }))];

/**
 * A choice that also lets the person type what isn't listed ("Other model…"): what is saved shows
 * even when the list lacks it, and the typed text goes to `onChange` like a choice made.
 */
export function TypedChoice({ title, subtitle, items, value, typing, onChange, disabled }: { title: string; subtitle?: string; items: Option[]; value: string; typing: Typing; onChange: (value: string) => void; disabled?: boolean }) {
  const prompt = useTextPrompt();
  return (
    <>
      <Choice
        title={title}
        subtitle={subtitle}
        value={value}
        options={withTyped(items, value, typing)}
        onChange={(next) => (next === OTHER ? prompt.ask({ title: typing.title, message: typing.message, confirm: typing.confirm, value, max: 64, onSubmit: onChange }) : onChange(next))}
        disabled={disabled}
      />
      {prompt.node}
    </>
  );
}

export function providerOptions(kind: "stt" | "tts" | "live", list: string[], voice: VoiceSettings | undefined): Option[] {
  return list.map((provider) => ({ value: provider, label: providerName(provider), subtitle: voice ? (missing(kind, provider, voice) ?? undefined) : undefined }));
}

export function ProviderMark({ provider }: { provider: string }) {
  const { colors } = useTheme();
  if (provider === "device") return <IconTile icon={Smartphone} color={colors.ink2} />;
  if (provider === "local") return <IconTile icon={Cpu} color={colors.ink2} />;
  if (provider === "custom") return <IconTile icon={Server} color={colors.ink2} />;
  return <ProviderIcon provider={markOf(provider)} name={providerName(provider)} size={32} tile />;
}

/** A short line under a group. */
export function Note({ children }: { children: string }) {
  return (
    <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
      {children}
    </T>
  );
}

/** The provider sheet a page opens, and the element that shows it. */
export function useProviderSheet(voice: VoiceSettings | undefined): [(provider: SheetProvider) => void, ReactNode] {
  const [sheet, setSheet] = useState<SheetProvider | null>(null);
  const element = !!sheet && !!voice && <ProviderSheet provider={sheet} voice={voice} onClose={() => setSheet(null)} />;
  return [setSheet, element];
}

/**
 * The chosen provider's key and address, one tap away. It asks to be set up while the provider
 * still needs something. Nothing for a provider with no sheet (this phone, ChatGPT sign-in).
 */
export function SetupRow({ kind, provider, voice, onOpen }: { kind: "stt" | "tts" | "live"; provider: string | null | undefined; voice: VoiceSettings | undefined; onOpen: (provider: SheetProvider) => void }) {
  const sheet = setupFor(provider);
  if (!sheet || !voice) return null;
  const lack = missing(kind, sheet, voice);
  return (
    <Group>
      <Row leading={<ProviderMark provider={sheet} />} title={lack ? "Set up " + providerName(sheet) : providerName(sheet)} subtitle={lack ?? providerState(sheet, voice)} tone={lack ? "accent" : undefined} chevron onPress={() => onOpen(sheet)} />
    </Group>
  );
}

/** Speed changes save a moment after the slider stops. */
export function useSpeed(value: number, commit: (value: number) => void) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const change = (next: number) => {
    const rounded = Math.round(next * 20) / 20;
    setDraft(rounded);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(rounded), 400);
  };
  return [draft, change] as const;
}

export const speedLabel = (speed: number) => (Math.round(speed * 100) / 100).toString() + "×";
