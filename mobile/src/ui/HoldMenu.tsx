import { type MenuComponentProps, MenuView } from "@react-native-menu/menu";
import { View } from "react-native";
import { InHoldMenu } from "./Tap";

/**
 * A menu that opens when what is inside is held. Use this, not `MenuView` with
 * `shouldOpenOnLongPress`: a `Tap` inside knows it is in a held menu, so holding it opens the menu
 * and does not also press it when the finger lifts.
 *
 * The menu sits in a view of its own that is never flattened away. While a menu opens and closes,
 * iOS puts a stand-in beside the pressed view, in that view's parent. Without the wrapper that parent
 * is whatever list the menu is in, and when a row left that list in the same moment the app stopped
 * ("Attempt to unmount a view which has a different index"). `style` lays the wrapper out.
 */
export function HoldMenu({ children, style, ...props }: Omit<MenuComponentProps, "shouldOpenOnLongPress">) {
  return (
    <View collapsable={false} style={style}>
      <MenuView shouldOpenOnLongPress {...props}>
        <InHoldMenu.Provider value>{children}</InHoldMenu.Provider>
      </MenuView>
    </View>
  );
}
