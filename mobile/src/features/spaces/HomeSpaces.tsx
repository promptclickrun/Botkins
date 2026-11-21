// Home's row of pinned spaces, where Today sat: one row of chips under the bots. A tap shows that
// space in place, a dot says something changed, and a tap on the chosen one opens its page. "All"
// lists every space.
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Chip, Dot, space as gap, T, Tap } from "@/ui";
import { openSpace, openSpaces, useSpaces } from "./data";
import { spaceTitle } from "./logic";
import { SpaceView } from "./SpaceView";

// The space last shown stays the one shown while the app is open.
let last: string | undefined;

export function HomeSpaces() {
  const spaces = useSpaces();
  const pinned = spaces.filter((space) => space.pinned);
  const [chosen, setChosen] = useState<string | undefined>(last);
  const shown = pinned.find((space) => space.id === chosen) ?? pinned[0];
  const pick = (id: string) => {
    if (shown?.id === id) return openSpace(id);
    last = id;
    setChosen(id);
  };
  return (
    <View style={{ gap: gap.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", minHeight: 32 }}>
        <T variant="label" color="muted" style={{ flex: 1, textTransform: "uppercase" }} accessibilityRole="header">
          Spaces
        </T>
        <Tap onPress={openSpaces} feel="select" accessibilityLabel="All spaces" style={{ minHeight: 32, justifyContent: "center", paddingLeft: gap.md }}>
          <T variant="footnote" weight="600" color="muted">
            All
          </T>
        </Tap>
      </View>
      {pinned.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -gap.xl }} contentContainerStyle={{ paddingHorizontal: gap.xl, gap: gap.sm }}>
          {pinned.map((space) => (
            <Chip
              key={space.id}
              label={spaceTitle(space)}
              selected={shown?.id === space.id}
              onPress={() => pick(space.id)}
              leading={space.changed > 0 && shown?.id !== space.id ? <Dot size={7} /> : undefined}
              accessibilityLabel={spaceTitle(space) + (space.changed > 0 ? ", changed" : "") + (shown?.id === space.id ? ", shown. Tap to open" : "")}
            />
          ))}
        </ScrollView>
      )}
      {shown ? (
        <SpaceView space={shown} />
      ) : (
        <Tap onPress={openSpaces} feel="select" accessibilityLabel="All spaces" style={{ minHeight: 44, justifyContent: "center" }}>
          <T variant="subhead" color="muted">
            No pinned spaces. Pin one from All.
          </T>
        </Tap>
      )}
    </View>
  );
}
