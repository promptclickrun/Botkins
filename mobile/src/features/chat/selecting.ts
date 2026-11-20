// Which message's text is being selected, and when that ends. A message enters by a double tap or
// by "Select text" in its menu (Messages.tsx). Only one at a time.
//
// The selected text is a native text view that can't be edited. Such a view never says that it
// lost the selection, so the end is found here: a short tap anywhere else in the chat (a drag is
// not a tap: the chat scrolls with the selection still there), a touch on the message box or its
// buttons, a message sent, or the chat's screen closing.
import type { GestureResponderEvent } from "react-native";
import { create } from "zustand";

export const useSelecting = create<{ id: string | null }>(() => ({ id: null }));
export const select = (id: string | null) => useSelecting.getState().id !== id && useSelecting.setState({ id });
export const endSelecting = () => select(null);
export const DOUBLE_TAP_MS = 320;

let insideSelection = false;
let touch: { x: number; y: number; at: number; inside: boolean } | null = null;
/** For the view that holds the text being selected: touches in it belong to the selection. */
export const selectionTouch = {
  onTouchStart: () => {
    insideSelection = true;
  },
};
/** For the view that holds the chat's messages: a short tap outside the selected text ends the selecting. */
export const selectionEnds = {
  onTouchStart: (event: GestureResponderEvent) => {
    touch = useSelecting.getState().id ? { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY, at: Date.now(), inside: insideSelection } : null;
    insideSelection = false;
  },
  onTouchEnd: (event: GestureResponderEvent) => {
    const began = touch;
    touch = null;
    if (!began || began.inside) return;
    const moved = Math.abs(event.nativeEvent.pageX - began.x) + Math.abs(event.nativeEvent.pageY - began.y);
    if (moved < 12 && Date.now() - began.at < 400) select(null);
  },
};
