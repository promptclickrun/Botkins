// Two to a row when there is room (iPhone Duo opened, an iPad); one column otherwise. Half folded
// like a book, the columns are the two pages: the first ends before the fold and the second starts
// after it. Used inside a page's padding (`space.xl` beside the safe area).
import { Children, type ReactNode } from "react";
import { View } from "react-native";
import { space } from "./theme";
import { useShape } from "./useShape";

export function TwoUp({ children }: { children: ReactNode }) {
  const shape = useShape();
  const cards = Children.toArray(children);
  if (!shape.wide) return <>{cards}</>;
  const fold = shape.pose === "book" ? shape.fold : null;
  const first = fold ? Math.max(0, fold.x - shape.left - space.xl - space.sm) : undefined;
  const rows: ReactNode[][] = [];
  for (let at = 0; at < cards.length; at += 2) rows.push(cards.slice(at, at + 2));
  return (
    <>
      {rows.map((row, index) => (
        <View key={index} style={{ flexDirection: "row", alignItems: "flex-start", gap: fold ? fold.width + space.sm * 2 : space.lg }}>
          {row.map((card, column) => (
            <View key={column} style={column === 0 && first !== undefined ? { width: first } : { flex: 1, minWidth: 0 }}>
              {card}
            </View>
          ))}
          {row.length === 1 && <View style={{ flex: 1 }} />}
        </View>
      ))}
    </>
  );
}
