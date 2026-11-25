// Telling the computer where Apple delivers for this phone, once per real change.
//
// Asking iOS for the push token (expo-notifications' getDevicePushTokenAsync) calls
// registerForRemoteNotifications, and iOS answers through the same delegate that fires every push
// token listener. A listener that asks for the token again therefore calls itself: before this
// file, that loop sent link.push.register to the computer about 25 times a second while the app
// was open. Here a token that arrives through the listener is used as given, a repeat of what the
// computer already has is not sent, and calls that come while one runs fold into one more run.
// No React Native imports, so tests/push-registrar.test.ts runs it.

export type RegistrarDeps = {
  /** Checks the link, the person's choice and the permission. False: nothing to register now. */
  prepare(): Promise<boolean>;
  /** Asks the system for the token. Null when there is none to send. */
  osToken(): Promise<string | null>;
  /** What the computer would be told with this token, as one string to compare. */
  said(token: string): Promise<string>;
  /** Tells the computer. */
  send(token: string): Promise<void>;
  /** After a successful send. */
  sent?(): void;
  failed?(error: unknown): void;
};

export type Registrar = {
  /** `force` sends even when nothing changed; `given` is a token iOS already handed over. */
  register(force?: boolean, given?: string): Promise<void>;
  /** Forget what the computer was told (notifications turned off). */
  reset(): void;
};

export function createRegistrar(deps: RegistrarDeps): Registrar {
  let registered = "";
  let running: Promise<void> | null = null;
  let queued: { force: boolean; given?: string } | null = null;

  async function once(force: boolean, given?: string) {
    try {
      if (!(await deps.prepare())) return;
      // A token from the listener is used as it is: asking again would fire the listener again.
      const token = given ?? (await deps.osToken());
      if (!token) return;
      const said = await deps.said(token);
      if (said === registered && !force) return;
      await deps.send(token);
      registered = said;
      deps.sent?.();
    } catch (error) {
      deps.failed?.(error);
    }
  }

  function register(force = false, given?: string): Promise<void> {
    if (running) {
      // One more run after this one, carrying the strongest ask and the newest token.
      queued = { force: force || !!queued?.force, given: given ?? queued?.given };
      return running;
    }
    running = (async () => {
      let next: { force: boolean; given?: string } | null = { force, given };
      while (next) {
        const { force: f, given: g } = next;
        queued = null;
        await once(f, g);
        next = queued;
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    register,
    reset() {
      registered = "";
    },
  };
}
