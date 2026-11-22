// Which chat has live voice on. The chat's screen draws the call as its voice dock (VoiceDock.tsx)
// in place of the message box, so a call belongs to the chat on screen and ends when that chat closes.
import { create } from "zustand";

type LiveCall = {
  chatId: string;
  botId: string;
  /** The message box is back, to type, while the call goes on. */
  typing: boolean;
};

export const useLiveCall = create<{ call: LiveCall | null }>(() => ({ call: null }));

/** Starts live voice in a chat, or brings its dock back when the call is already on there. */
export const startLiveCall = (chatId: string, botId: string) => useLiveCall.setState({ call: { chatId, botId, typing: false } });

export const endLiveCall = () => useLiveCall.setState({ call: null });

export const setLiveTyping = (typing: boolean) => useLiveCall.setState(({ call }) => ({ call: call && { ...call, typing } }));
