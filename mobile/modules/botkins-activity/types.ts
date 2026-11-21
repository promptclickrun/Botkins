// Types the plain code shares with the native module (no React Native imports).

/**
 * An answer given on a card, in the Dynamic Island or on a notification, waiting to be sent
 * (src/state/answers.ts). `host` is the computer it is for, when known.
 */
export type QueuedAnswer = {
  id: string;
  host?: string;
  request?: string;
  chat?: string;
  action: "approve" | "remember" | "deny" | "cancel" | "answer" | "stop" | "retry";
  value?: string;
  at: number;
};
