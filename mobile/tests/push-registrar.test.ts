// The phone's push registration (src/state/pushRegistrar.ts) against a stand-in for iOS that
// behaves like expo-notifications: asking for the token fires every push token listener with it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRegistrar } from "../src/state/pushRegistrar";

const TOKEN = "ab".repeat(32);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeIos() {
  const listeners: ((token: string) => void)[] = [];
  let asked = 0;
  return {
    get asked() {
      return asked;
    },
    addListener(fn: (token: string) => void) {
      listeners.push(fn);
    },
    // registerForRemoteNotifications: the delegate answers a moment later, to the caller and every listener.
    async getToken() {
      asked++;
      await delay(1);
      for (const fn of listeners) fn(TOKEN);
      return TOKEN;
    },
  };
}

function setup() {
  const ios = fakeIos();
  const sends: string[] = [];
  const registrar = createRegistrar({
    prepare: async () => true,
    osToken: () => ios.getToken(),
    said: async (token) => "host,device," + token,
    send: async (token) => void sends.push(token),
  });
  // What src/state/push.ts does with the listener: the token is used as given.
  ios.addListener((token) => void registrar.register(false, token));
  return { ios, sends, registrar };
}

test("asking iOS for the token does not loop through the push token listener", async () => {
  const { ios, sends, registrar } = setup();
  await registrar.register(true);
  await delay(50);
  assert.equal(ios.asked, 1, "the token is asked for once");
  assert.equal(sends.length, 1, "the computer is told once");
});

test("a repeat registration with nothing changed is not sent", async () => {
  const { ios, sends, registrar } = setup();
  await registrar.register();
  await delay(20);
  await registrar.register();
  await registrar.register();
  await delay(20);
  assert.equal(sends.length, 1);
  assert.equal(ios.asked, 3);
});

test("calls that arrive while one runs fold into one more run", async () => {
  const { sends, registrar } = setup();
  await Promise.all([registrar.register(true), registrar.register(true), registrar.register(true)]);
  await delay(20);
  assert.ok(sends.length <= 2, "at most the run and one follow-up, got " + sends.length);
});

test("after reset the same address is sent again", async () => {
  const { sends, registrar } = setup();
  await registrar.register();
  await delay(10);
  registrar.reset();
  await registrar.register();
  await delay(10);
  assert.equal(sends.length, 2);
});
