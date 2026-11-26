// A tool's browser sign-in (OAuth) done in a paired phone's browser, for a computer that has none
// to open (a terminal host) or that the person isn't sitting at.
//
// The computer runs the sign-in as it always does (desktop/oauth.mjs: discovery, its own client
// registration, PKCE, `state`), with one change: the browser is sent back to the phone app's own
// address, PHONE_REDIRECT. The phone opens the page, catches that address and hands it back with
// `finish`. It is judged as a pasted answer is (oauth.answer), and the code is good only with the
// secret this computer made for this one sign-in. Tokens never pass through the phone.
//
// Reached from the phone as "link.startMcpSignIn" and "link.finishMcpSignIn" (owner only: the
// link's rule for a call it has no entry for).

/** The phone app's return address for a tool's sign-in (its "botkins" scheme, mobile/app.config.ts). */
export const PHONE_REDIRECT = "botkins://mcp-auth";
const PHONE_PATIENCE_MS = 10 * 60_000;

/**
 * @param owner  (id) → the object that signs that server in: { signIn(id, options), answerSignIn(id, address), cancelSignIn(id) }.
 */
export function phoneSignIns(owner) {
  /** id → the sign-in's promise, while one runs. */
  const running = new Map();
  return {
    /** Starts a sign-in and answers { url, redirect }: the page for the phone to open, and where it comes back. */
    async start(id) {
      if (typeof id !== "string" || !id) throw new Error("That tool can't be found.");
      const who = owner(id);
      if (running.has(id)) who.cancelSignIn(id);
      let opened;
      const page = new Promise((resolve) => (opened = resolve));
      const done = who.signIn(id, {
        redirect: PHONE_REDIRECT,
        patience: PHONE_PATIENCE_MS,
        open: async (url) => opened(url),
      });
      const mine = done.finally(() => {
        if (running.get(id) === mine) running.delete(id);
      });
      mine.catch(() => {});
      running.set(id, mine);
      // The sign-in fails before it has a page (no client, a server that can't be found): that error is the answer.
      const url = await Promise.race([page, done.then(() => null)]);
      if (!url) throw new Error("That sign-in finished before it needed a browser.");
      return { url, redirect: PHONE_REDIRECT };
    },
    /** The address the phone's browser came back to. Answers the tool's sign-in state once the tokens are kept. */
    async finish(id, address) {
      const sign = running.get(id);
      if (!sign) throw new Error("No sign-in is waiting. Start it again.");
      owner(id).answerSignIn(id, address);
      return await sign;
    },
    cancel(id) {
      if (running.has(id)) owner(id).cancelSignIn(id);
    },
  };
}
