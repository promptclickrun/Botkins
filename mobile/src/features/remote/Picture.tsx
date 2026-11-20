// The two image slots a picture loop (useFeed) fills: each picture is drawn in the slot that is not
// in front and takes the front once it has been drawn, so the picture never flickers. They fill the
// view they are in. Settings › Screen's Stage, a screen card in a chat and the side pane share them.
import { Image } from "expo-image";
import { StyleSheet } from "react-native";
import type { Pictures, SlotName } from "./useFeed";

export function PictureSlots({ pictures, drawn }: { pictures: Pictures; drawn: (slot: SlotName, id: number, promote?: boolean) => void }) {
  return (
    <>
      {(["a", "b"] as const).map((slot) => {
        const picture = pictures[slot];
        if (!picture) return null;
        return (
          <Image
            key={slot}
            source={{ uri: picture.uri }}
            style={[StyleSheet.absoluteFill, { zIndex: pictures.front === slot ? 1 : 0 }]}
            contentFit="contain"
            cachePolicy="none"
            transition={null}
            priority="high"
            accessible={false}
            onDisplay={() => drawn(slot, picture.id)}
            onError={() => drawn(slot, picture.id, false)}
          />
        );
      })}
    </>
  );
}
