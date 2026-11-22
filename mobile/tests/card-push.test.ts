// The pushes that keep the card for all Botkins up to date (link-host/push.mjs, Push.cards), with a
// clock the test sets: when the card makes its sound, how its pushes are stamped and paced, and
// that the relay takes them. tests/push.test.ts checks the same card end to end with a real link.
import assert from "node:assert/strict";
import { test } from "node:test";
import { random } from "../link-host/crypto.mjs";
import { DEFAULT_PREFS, Push } from "../link-host/push.mjs";
import { newRelayKey } from "../link-host/relay.mjs";
import { parseSends } from "../relay/src/push";

const T0 = 1_795_385_000_000;
const CARD = "c4".repeat(80);
type Sent = { token: string; type: string; priority: number; expiration: number; payload: any };
type Step = { id: string; name: string; label: string; status: string; started: number };

/**
 * A computer with one phone that has the card for all Botkins running and is not in front, and one
 * chat with a turn at work. `look()` is the computer noticing a change; every push it sends is in `sent`.
 */
function computer({ prefs = {}, attention, working = true }: { prefs?: Partial<typeof DEFAULT_PREFS>; attention?: () => { focused: boolean; chatId?: string }; working?: boolean } = {}) {
  let now = T0;
  const sent: Sent[] = [];
  const relayKey = newRelayKey();
  const key = random(32);
  let record: any = { token: "a".repeat(64), env: "production", cards: "all", prefs: { ...DEFAULT_PREFS, ...prefs }, activities: { all: CARD } };
  const store = {
    data: { devices: [{ id: "phone", name: "Phone", kind: "phone", publicKey: "a".repeat(43) }], looks: {} },
    relayKey: () => relayKey,
    push: () => record,
    setPush: (_id: string, next: unknown) => void (record = next),
    name: "Mac",
  };
  const run = { id: "run", chatId: "chat", title: "", time: T0 - 20_000, status: working ? "Working" : "Completed", steps: [] as Step[], ...(!working && { finished: T0 - 10_000 }) } as { id: string; chatId: string; title: string; time: number; status: string; steps: Step[]; finished?: number };
  const world = {
    bots: [{ id: "bot", name: "Pearl", look: { head: "pearl", palette: "custom", colors: ["#2f7fa6", "#f0a64a", "#e6f3f7", "#132f3d"] } }],
    chats: [{ id: "chat", botId: "bot", title: "Fix login refresh", messages: [] as { runId: string; role: string; text: string }[] }],
    runs: [run],
    requests: [] as any[],
    streams: {},
    thinking: {} as Record<string, string>,
    intents: {},
  };
  const push = new Push({
    store,
    deviceKey: () => key,
    relayUrl: () => "https://relay.test",
    snapshot: () => world,
    attention,
    now: () => now,
    // The relay's push route, which takes everything: what it was sent is all a test reads.
    fetch: (async (_url: string, init: { body: string }) => {
      sent.push(...JSON.parse(JSON.parse(init.body).sends));
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }) as never,
  });
  // The first look only notes what is going on; it also sends the card whole.
  push.start();
  return {
    push,
    world,
    run,
    sent,
    record: () => record,
    /** The pushes to the card since the last call. */
    card: () => sent.splice(0).filter((item) => item.token === CARD),
    /** Lets `ms` pass, then the computer looks. */
    look(ms = 1000) {
      now += ms;
      push.look();
    },
    step(label: string) {
      for (const step of run.steps) step.status = "Done";
      run.steps.push({ id: "s" + run.steps.length, name: "bash", label, status: "Running", started: now });
    },
    finish(status = "Completed") {
      Object.assign(run, { status, finished: now });
      world.chats[0]!.messages.push({ runId: "run", role: "assistant", text: "Fixed: renew now waits." });
    },
    now: () => now,
    done: () => push.dispose(),
  };
}

test("when every chat on the card has ended the card says so with a sound, also while the chat is open on the computer", () => {
  // The turn's own notification is skipped when the person is reading the chat on the computer. The
  // card is on the phone they carry: its sound must not wait on that notification.
  for (const attention of [undefined, () => ({ focused: true, chatId: "chat" }), () => ({ focused: true })]) {
    const mac = computer({ attention });
    mac.sent.length = 0;
    mac.finish();
    mac.look();
    const notes = mac.sent.filter((item) => item.type === "alert");
    const [card] = mac.card();
    assert.equal(card!.payload.aps.event, "update");
    assert.equal(card!.payload.aps["content-state"].phase, "done");
    assert.deepEqual(card!.payload.aps.alert, { title: "Botkins", body: "All done", sound: "default" }, "the island opens and the sound plays");
    assert.equal(card!.priority, 10);
    // Watched on the computer: no notification. Otherwise it comes, and the card made the sound.
    assert.equal(notes.length, attention ? 0 : 1);
    if (!attention) assert.equal(notes[0]!.payload.aps.sound, undefined, "one sound, the card's");
    mac.done();
  }
});

test("the card stays quiet when the app is in front, replies are off, the person stopped the turn, or it was over before this computer started", () => {
  // The phone is in the app (on another screen): the card can't open there, so the notification keeps its sound.
  const front = computer();
  front.push.setPresence("phone", true);
  front.sent.length = 0;
  front.finish();
  front.look();
  const note = front.sent.find((item) => item.type === "alert")!;
  assert.equal(note.payload.aps.sound, "default");
  assert.equal(front.card()[0]!.payload.aps.alert, undefined);
  front.done();

  const off = computer({ prefs: { replies: false } });
  off.sent.length = 0;
  off.finish();
  off.look();
  assert.equal(off.card()[0]!.payload.aps.alert, undefined, "finished replies are switched off");
  off.done();

  const stopped = computer();
  stopped.sent.length = 0;
  stopped.finish("Stopped");
  stopped.look();
  assert.equal(stopped.card()[0]!.payload.aps.alert, undefined, "the person stopped it themselves");
  stopped.done();

  // A card left over from before the computer started shows its end, without announcing it again.
  const late = computer({ working: false });
  const [first] = late.card();
  assert.equal(first!.payload.aps["content-state"].phase, "done");
  assert.equal(first!.payload.aps.alert, undefined);
  late.done();
});

test("a push with an alert is always sent at priority 10", () => {
  const mac = computer();
  mac.card();
  mac.world.requests.push({ id: "ask1", chatId: "chat", botId: "bot", kind: "question", title: "Which day?" });
  mac.look();
  const first = mac.card().find((item) => item.payload.aps.alert)!;
  assert.equal(first.priority, 10);
  // A second request takes the first one's place: the card's phases are as they were.
  mac.world.requests.splice(0, 1, { id: "ask2", chatId: "chat", botId: "bot", kind: "question", title: "And which hour?" });
  mac.look(3000);
  const second = mac.card().find((item) => item.payload.aps.alert)!;
  assert.equal(second.payload.aps.alert.body, "A bot needs you");
  assert.equal(second.priority, 10, "Apple holds a priority 5 push back: an alert in one would come late");
  mac.done();
});

test("a card's push is never stamped earlier than the moment it was built, and each one is newer than the last", () => {
  // Apple applies a card's updates by their time, the phone's own among them. A push stamped with
  // the second's start would lose to what the phone drew a moment before it left the app.
  const mac = computer();
  mac.card();
  const stamps: number[] = [];
  for (const ms of [2850, 2600, 2700, 3100]) {
    mac.step("Step at " + stamps.length);
    mac.look(ms);
    const [card] = mac.card();
    assert.ok(card!.payload.aps.timestamp * 1000 >= mac.now(), "not older than now");
    assert.ok(card!.payload.aps.timestamp * 1000 < mac.now() + 2000, "and not far ahead");
    stamps.push(card!.payload.aps.timestamp);
  }
  assert.deepEqual(stamps, [...new Set(stamps)].sort((a, b) => a - b), "each newer than the one before");
  mac.done();
});

test("steps reach a locked phone at once: a priority 10 push every so often, the rest at 5", () => {
  // Apple holds priority 5 pushes back to save power, most of all on a locked phone, and allows
  // only so many at 10. So a turn's steps go at 10 now and then, and the card is never far behind.
  const mac = computer();
  mac.card();
  const pushes: { at: number; priority: number }[] = [];
  for (let second = 3; second <= 90; second += 3) {
    mac.step("Step at " + second);
    mac.look(3000);
    for (const item of mac.card()) pushes.push({ at: mac.now(), priority: item.priority });
  }
  assert.equal(pushes.length, 30, "every step is sent");
  const loud = pushes.filter((item) => item.priority === 10).map((item) => item.at);
  assert.ok(loud.length >= 4, "some at priority 10");
  assert.ok(loud.length <= 8, "not all: Apple allows only so many");
  for (let index = 1; index < loud.length; index++) {
    assert.ok(loud[index]! - loud[index - 1]! >= 15_000, "at least 15 seconds apart");
    assert.ok(loud[index]! - loud[index - 1]! <= 20_000, "and no more than a little over that while steps come");
  }
  mac.done();
});

test("the relay takes every push to the card, however long the words are", () => {
  const mac = computer();
  const long = "word ".repeat(400);
  mac.world.bots.push({ id: "bot2", name: long, look: { head: "luna", palette: "custom", colors: ["#111111", "#222222", "#333333", "#444444"] } });
  mac.world.chats[0]!.title = long;
  for (const id of ["two", "three", "four"]) {
    mac.world.chats.push({ id: id + "-".repeat(60), botId: "bot2", title: long, messages: [] });
    mac.world.runs.push({ id: "run-" + id, chatId: id + "-".repeat(60), title: "", time: T0 - 5000, status: "Working", steps: [{ id: "s", name: "bash", label: long, status: "Running", started: T0 }] });
  }
  mac.world.thinking.chat = long + ".";
  mac.step(long);
  mac.look();
  mac.world.requests.push({ id: "ask", chatId: "chat", botId: "bot", kind: "question", title: long, choices: ["a".repeat(40), "b".repeat(40), "c".repeat(40)], freeform: true });
  mac.look(3000);
  for (const run of mac.world.runs) Object.assign(run, { status: "Completed", finished: mac.now() });
  mac.world.requests.length = 0;
  mac.look(3000);
  const cards = mac.card();
  assert.ok(cards.some((item) => item.payload.aps.alert?.body === "A bot needs you") && cards.some((item) => item.payload.aps.alert?.body === "All done"));
  for (const item of cards) {
    assert.ok(Buffer.byteLength(JSON.stringify(item.payload)) <= 4096, "under Apple's 4 KB");
    assert.ok(parseSends(JSON.stringify([item])), "the relay's own check takes it");
  }
  mac.done();
});
