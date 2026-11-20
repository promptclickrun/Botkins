// The controls of Bot Studio: which character, its eyes, and its colors. The preview is the caller's.
// `advanced` is a computer with "looks-v2": only then are eyes, the templates and colors of the
// person's own on offer, because an older computer refuses to save them.
import { Check } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { type BotkinLook, colorsOf, CUSTOM, EYES, HEADS, hasAccent, headName, KIT_PALETTES } from "@/data/botLook";
import { COLOR_SLOTS, type FourColors, remember, SUGGESTED, TEMPLATES, templateOf } from "@/data/lookTemplates";
import { usePart } from "@/state/hooks";
import { BotAvatar, ColorPicker, Label, radius, space, T, Tap, useTheme } from "@/ui";

export type LookEditorProps = {
  value: BotkinLook;
  onChange: (next: BotkinLook) => void;
  /** The computer can save eyes and custom colors ("looks-v2"). */
  advanced?: boolean;
  /** A color drag started or ended, so a scroll view around the editor can hold still. */
  onDragging?: (dragging: boolean) => void;
};

/** Can the computer save eyes and custom colors? */
export function useLooksV2() {
  return !!usePart("meta")?.capabilities?.includes("looks-v2");
}

const SWATCH = 40;
const RING = SWATCH + 10;
const EYE_CELL = 76;

export function LookEditor({ value, onChange, advanced = false, onDragging }: LookEditorProps) {
  const { colors } = useTheme();
  const [slot, setSlot] = useState<number | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const custom = value.palette === CUSTOM;
  const four = colorsOf(value);
  const template = custom ? templateOf(value.colors) : undefined;

  const setColor = (index: number, hex: string) => {
    const next = [...four] as FourColors;
    next[index] = hex;
    onChange({ ...value, palette: CUSTOM, colors: next });
  };
  const pickKit = (id: string) => onChange({ head: value.head, palette: id, ...(value.eyes && { eyes: value.eyes }) });
  const pickTemplate = (next: FourColors) => onChange({ ...value, palette: CUSTOM, colors: [...next] });

  return (
    <View style={{ gap: space.xl }}>
      <View>
        <Label>Character</Label>
        <View style={{ flexDirection: "row", flexWrap: "wrap", marginHorizontal: -space.xs }}>
          {HEADS.map((head) => {
            const selected = head.id === value.head;
            return (
              <View key={head.id} style={{ width: "25%", padding: space.xs }}>
                <Tap onPress={() => onChange({ ...value, head: head.id })} feel="select" sink={0.94} accessibilityLabel={head.name} accessibilityState={{ selected }} style={{ alignItems: "center", gap: 4 }}>
                  <View style={{ alignSelf: "stretch", aspectRatio: 1, borderRadius: radius.lg, borderWidth: 2.5, borderColor: selected ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
                    <BotAvatar look={{ ...value, head: head.id }} size={58} />
                  </View>
                  <T variant="caption" color={selected ? "accentText" : "muted"} weight={selected ? "700" : "500"} numberOfLines={1}>
                    {head.name}
                  </T>
                </Tap>
              </View>
            );
          })}
        </View>
      </View>

      {advanced && (
        <View>
          <Label>Eyes</Label>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.xl }} contentContainerStyle={{ paddingHorizontal: space.xl - space.xs }}>
            {EYES.map((eyes) => {
              const selected = (value.eyes ?? "oval") === eyes.id;
              return (
                <Tap
                  key={eyes.id}
                  onPress={() => onChange({ ...value, eyes: eyes.id === "oval" ? undefined : eyes.id })}
                  feel="select"
                  sink={0.94}
                  accessibilityLabel={eyes.name + " eyes"}
                  accessibilityState={{ selected }}
                  style={{ width: EYE_CELL, alignItems: "center", gap: 4, paddingHorizontal: space.xs }}
                >
                  <View style={{ width: EYE_CELL - space.sm, aspectRatio: 1, borderRadius: radius.lg, borderWidth: 2.5, borderColor: selected ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
                    <BotAvatar look={{ ...value, eyes: eyes.id }} size={EYE_CELL - 22} badge={false} />
                  </View>
                  <T variant="caption" color={selected ? "accentText" : "muted"} weight={selected ? "700" : "500"} numberOfLines={1}>
                    {eyes.name}
                  </T>
                </Tap>
              );
            })}
          </ScrollView>
        </View>
      )}

      <View>
        <Label>Colors</Label>
        <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: space.md, marginHorizontal: -space.xs }}>
          {KIT_PALETTES.map((palette) => (
            <Choice key={palette.id} name={palette.name} selected={!custom && palette.id === value.palette} onPress={() => pickKit(palette.id)}>
              {palette.colors ? <Swatch colors={palette.colors} /> : <BotAvatar look={{ head: value.head, palette: palette.id, ...(value.eyes && { eyes: value.eyes }) }} size={SWATCH} badge={false} />}
            </Choice>
          ))}
          {advanced &&
            TEMPLATES.map((item) => (
              <Choice key={item.id} name={item.name} selected={template?.id === item.id} onPress={() => pickTemplate(item.colors)}>
                <Swatch colors={item.colors} />
              </Choice>
            ))}
        </View>
        {!advanced && (
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.lg }}>
            Update Botkins on your computer for eyes and your own colors
          </T>
        )}
      </View>

      {advanced && (
        <View>
          <Label>Your colors</Label>
          <View style={{ flexDirection: "row", marginHorizontal: -space.xs }}>
            {COLOR_SLOTS.map((item, index) => {
              const open = slot === index;
              const unused = index === 1 && !hasAccent(value.head);
              return (
                <Tap
                  key={item.key}
                  onPress={() => setSlot(open ? null : index)}
                  feel="select"
                  sink={0.92}
                  accessibilityLabel={item.name + " color, " + four[index].slice(1).toUpperCase()}
                  accessibilityHint={unused ? headName(value.head) + " has no accent" : open ? "Closes the color picker" : "Opens the color picker"}
                  accessibilityState={{ expanded: open }}
                  style={{ width: "25%", alignItems: "center", gap: 4, opacity: unused ? 0.45 : 1 }}
                >
                  <View style={{ width: RING, height: RING, borderRadius: RING / 2, borderWidth: 2.5, borderColor: open ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
                    <View style={{ width: SWATCH, height: SWATCH, borderRadius: SWATCH / 2, backgroundColor: four[index], borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong }} />
                  </View>
                  <T variant="caption" color={open ? "accentText" : "muted"} weight={open ? "700" : "500"} numberOfLines={1}>
                    {item.name}
                  </T>
                </Tap>
              );
            })}
          </View>
          {slot != null && (
            <View style={{ marginTop: space.lg }}>
              <ColorPicker
                key={slot}
                label={COLOR_SLOTS[slot].name}
                value={four[slot]}
                onChange={(hex) => setColor(slot, hex)}
                onCommit={(hex) => setRecent((list) => remember(list, hex))}
                onDragging={onDragging}
                swatches={[...recent, ...SUGGESTED]}
              />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

/** One palette or template: its swatch with a ring and a check when chosen, and its name. */
function Choice({ name, selected, onPress, children }: { name: string; selected: boolean; onPress: () => void; children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <Tap onPress={onPress} feel="select" sink={0.92} accessibilityLabel={name} accessibilityState={{ selected }} style={{ width: "25%", alignItems: "center", gap: 4 }}>
      <View style={{ width: RING, height: RING, borderRadius: RING / 2, borderWidth: 2.5, borderColor: selected ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}>
        {children}
        {selected && (
          <View style={{ position: "absolute", right: -2, bottom: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.accent, borderWidth: 2, borderColor: colors.canvas, alignItems: "center", justifyContent: "center" }}>
            <Check size={11} color={colors.onAccent} strokeWidth={3.2} />
          </View>
        )}
      </View>
      <T variant="caption" color={selected ? "accentText" : "muted"} weight={selected ? "700" : "500"} numberOfLines={1}>
        {name}
      </T>
    </Tap>
  );
}

/** Four colors in one round swatch: shell and accent as its halves, the faceplate and eyes at its middle. */
function Swatch({ colors: [shell, accent, face, eyes] }: { colors: readonly string[] }) {
  const { colors } = useTheme();
  const dot = Math.round(SWATCH * 0.42);
  return (
    <View style={{ width: SWATCH, height: SWATCH, borderRadius: SWATCH / 2, overflow: "hidden", flexDirection: "row", alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong }}>
      <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "50%", backgroundColor: shell }} />
      <View style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "50%", backgroundColor: accent }} />
      <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: face, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: 4, height: 6, borderRadius: 2, backgroundColor: eyes }} />
      </View>
    </View>
  );
}
