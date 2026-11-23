// How much a push to the window costs while a bot streams, whole state against the live parts only.
// Not part of `npm test`:  node test/window-push-bench.mjs
import { serialize } from "node:v8";
import { createWindowPush } from "../desktop/window-push.mjs";

const words = "Botkins reads the files, runs the tests and tells you what it found. ".repeat(6);
function makeState(chats, messages, steps) {
  return {
    bots: [{ id: "bot-1", name: "Bot" }], settings: { theme: "light" },
    chats: Array.from({ length: chats }, (_, c) => ({ id: "chat-" + c, title: "Chat " + c, botId: "bot-1", messages: Array.from({ length: messages }, (_, m) => ({ role: m % 2 ? "assistant" : "user", text: words + m, time: 1000 + m })) })),
    runs: [
      { id: "live", chatId: "chat-0", status: "Working", title: "Live", time: 5000, detail: "", steps: Array.from({ length: steps }, (_, i) => ({ id: "s" + i, name: "shell", label: "Run " + i, input: "x".repeat(2000), output: "y".repeat(12000), status: "Done", started: i })) },
      ...Array.from({ length: chats }, (_, c) => ({ id: "old-" + c, chatId: "chat-" + c, status: "Completed", title: "Old", time: c, detail: "", steps: [{ id: "s", name: "shell", label: "Old", output: "z".repeat(12000), status: "Done", started: 1 }] })),
    ],
    streams: { "chat-0": "" }, thinking: {}, intents: {}, speakers: {}, steerable: {}, queued: {}, requests: [],
  };
}
const ms = (fn, times = 5) => { const t = performance.now(); for (let i = 0; i < times; i++) fn(); return (performance.now() - t) / times; };

console.log("chats x messages | whole state | hot message | whole clone | hot clone | push work in main (hot tick)");
for (const [chats, messages] of [[50, 50], [200, 100], [500, 200]]) {
  const state = makeState(chats, messages, 40);
  let last;
  const push = createWindowPush({ snapshot: () => state, send: (m) => { last = m; }, sendHot: (m) => { last = m; }, now: () => 0, later: () => 0 });
  push.flush();
  const whole = last;
  const wholeClone = ms(() => structuredClone(whole), 3);
  state.streams["chat-0"] += "word ";
  state.runs[0].steps[39].output += "line\n";
  let hotMessage;
  const hotPush = createWindowPush({ snapshot: () => state, send: () => {}, sendHot: (m) => { hotMessage = m; }, now: () => 0, later: () => 0 });
  hotPush.flush();
  const work = ms(() => { state.streams["chat-0"] += "w"; hotPush.flush(); }, 20);
  const hotClone = ms(() => structuredClone(hotMessage), 200);
  console.log(`${chats} x ${messages} | ${(serialize(whole).length / 1e6).toFixed(1)} MB | ${(serialize(hotMessage).length / 1e3).toFixed(1)} KB | ${wholeClone.toFixed(1)} ms | ${hotClone.toFixed(3)} ms | ${work.toFixed(2)} ms`);
}
