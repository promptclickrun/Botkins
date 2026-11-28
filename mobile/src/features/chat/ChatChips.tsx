// The chips over the Chats list. Hold one, then move, to put it in its place (the drag of
// src/features/spaces/sortable.tsx, side by side); VoiceOver has Move left and Move right. The leftmost
// chip is the one the Chats screen opens on. The order is this phone's (`prefs.chatChipOrder`).
import type { ReactNode } from "react";
import { useState } from "react";
import { useWindowDimensions } from "react-native";
import Animated, { useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import type { BoardScroll } from "@/features/home/BotBoard";
import { SortArea, SortCell, SortHandle, type SortItem, useSorter } from "@/features/spaces/sortable";
import { setPrefs } from "@/state/prefs";
import { Chip, space } from "@/ui";
import { type ChatChip, type ChatFilter, withChipAt, withChipMoved } from "./sections";

// The row has one group. Its heading is only where the row starts, so a chip can be dropped first.
const START: SortItem = { key: "head", kind: "head", zone: "chips" };

export function ChatChips({ chips, picked, onPick, trailing }: { chips: ChatChip[]; picked: ChatFilter; onPick: (value: ChatFilter) => void; trailing?: ReactNode }) {
  const { width } = useWindowDimensions();
  const view = useSharedValue(0);
  const content = useSharedValue(0);
  // The row scrolls sideways: its two ends are the screen's sides.
  const scroll: BoardScroll = { ref: useAnimatedRef<Animated.ScrollView>(), offset: useSharedValue(0), max: useSharedValue(0), edges: useSharedValue({ top: 0, bottom: width }) };
  const { offset, max } = scroll;
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      offset.value = event.contentOffset.x;
    },
  });
  const [lifted, setLifted] = useState(false);
  const { sorter, items } = useSorter({
    across: true,
    build: () => [START, ...chips.map((chip): SortItem => ({ key: chip.value, kind: "row", zone: "chips" }))],
    scroll,
    onDrop: (key, _zone, index) => setPrefs({ chatChipOrder: withChipAt(chips, key as ChatFilter, index) }),
    onDragging: setLifted,
  });
  return (
    <SortArea sorter={sorter}>
      <Animated.ScrollView
        ref={scroll.ref}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={!lifted}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onLayout={(event) => {
          view.value = event.nativeEvent.layout.width;
          max.value = Math.max(0, content.value - view.value);
        }}
        onContentSizeChange={(w) => {
          content.value = w;
          max.value = Math.max(0, content.value - view.value);
        }}
        style={{ marginHorizontal: -space.xl }}
        // Each chip's cell holds the gap after it, so the cells sit edge to edge and one makes room by its own width.
        contentContainerStyle={{ paddingLeft: space.xl, paddingRight: space.xl - space.sm }}
      >
        {items.map((item) => {
          const chip = item.kind === "row" ? chips.find((one) => one.value === item.key) : undefined;
          if (!chip) return <SortCell key={item.key} item={item} look="chip" />;
          const at = chips.indexOf(chip);
          const left = withChipMoved(chips, chip.value, -1);
          const right = withChipMoved(chips, chip.value, 1);
          const label = chip.count ? chip.label + " · " + chip.count : chip.label;
          return (
            <SortCell key={item.key} item={item} look="chip" style={{ paddingRight: space.sm }}>
              <SortHandle itemKey={item.key} disabled={chips.length < 2}>
                <Chip
                  label={label}
                  selected={picked === chip.value}
                  onPress={() => onPick(chip.value)}
                  accessibilityLabel={label + (at === 0 ? ", opens first" : "") + ". Hold, then move, to put it in order"}
                  accessibilityActions={[...(left ? [{ name: "left", label: "Move left" }] : []), ...(right ? [{ name: "right", label: "Move right" }] : [])]}
                  onAccessibilityAction={(event) => {
                    const next = event.nativeEvent.actionName === "left" ? left : right;
                    if (next) setPrefs({ chatChipOrder: next });
                  }}
                />
              </SortHandle>
            </SortCell>
          );
        })}
        {trailing}
      </Animated.ScrollView>
    </SortArea>
  );
}
