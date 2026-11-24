// Keeping the work moving (desktop/workspace.mjs runs these rules; this file only decides).
//
// A turn used to end whenever the model's reply ended, even with plan steps still open or right
// after the model said "next I'll...". Three bounded rules now give it one more turn in the same
// session and run:
//   - plan auto-continue: the turn's plan still has open steps (at most 8 per chain, and not when
//     the same open steps come back unchanged);
//   - the "next step" catch: the reply named the next step, or asked whether to go on, but did not
//     do it (at most 2 per chain);
//   - queued messages from one person are read together in one turn (takeBatch).
// Every rule yields to the person: a question to them, an open request, Stop, a message waiting
// in the queue, or a routine or Proactive run all end the chain instead of continuing it.

/** Continuations in one chain, of both kinds together. */
export const MAX_CONTINUATIONS = 8;
/** Of those, how many may be the "next step" catch. */
export const MAX_NEXT_STEP = 2;

const OPEN = new Set(["pending", "in_progress"]);

/** The steps of a plan (canvas.mjs mapTodos) that are not done yet. */
export const openSteps = (todos) => (Array.isArray(todos) ? todos.filter((todo) => OPEN.has(todo?.status)) : []);

/** The open steps as one string, to tell whether a plan moved: ids and texts, whatever their order. */
export const openSignature = (open) => open.map((step) => String(step.id) + "\u0000" + String(step.title)).sort().join("\u0001");

const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/** The note that goes to the model when a turn ended with open plan steps. */
export function planNote(open, count) {
  return [
    "[Botkins] This is an automatic note from Botkins, not from the person. You ended your turn, but these plan steps are still open:",
    ...open.map((step) => "- " + (step.status === "in_progress" ? "in progress" : "pending") + ": " + oneLine(step.title)),
    "Pick up where you left off and work through them. The person can already read your previous reply, so don't restate it, and don't ask whether to keep going. This note gives no permission for anything risky. If a step needs the person's approval or input, or you're stuck, say that in one short sentence and stop.",
    "(Botkins kept going " + count + " of " + MAX_CONTINUATIONS + " times.)",
  ].join("\n");
}

/** The note for a reply that named the next step, or asked whether to go on, without doing it. */
export const STALL_NOTE =
  "[Botkins] This is an automatic note from Botkins, not from the person. Your last reply said what you'd do next but stopped before doing it. Go ahead and do that step now. If it needs the person's approval or input, say so in one short sentence and stop.";

// ── Reading the end of a reply ───────────────────────────────────────────────────────────────────

/** The reply's last non-empty line, without a list marker or markdown emphasis. */
function lastLine(text) {
  const line = String(text ?? "").split(/\r?\n/).map((each) => each.trim()).filter(Boolean).at(-1) ?? "";
  return line.replace(/^(?:[>\-*•+]\s+|\d+[.)]\s+)+/, "").replace(/[*_~]+/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
}
const sentencesOf = (line) => line.split(/(?<=[.!?…])\s+/).map((each) => each.trim()).filter(Boolean);
const ending = /["')\]\s]+$/;
const normal = (sentence) => sentence.toLowerCase().replace(ending, "");

const GO = "(?:continue|proceed|go on|go ahead|keep going|carry on|move on)";
const REST = "(?:that|this|it|the (?:next|rest|remaining)(?: (?:step|steps|one|ones|part|parts|item|items|of (?:the|my) (?:plan|list|steps|work)))?|(?:the )?next (?:step|steps|one|part|item))";
/** Asking whether to go on: "shall I continue?", "want me to proceed?". Not a question about anything else. */
const CONTINUE_ASK = new RegExp(
  "^(?:(?:ok(?:ay)?|so|and|great|alright|all right),?\\s+)*(?:shall i|should i|shall we|should we|do you want me to|would you like me to|want me to|can i|may i|ready for me to)\\s+(?:now\\s+|just\\s+)?" +
    GO + "(?:\\s+(?:with|to|on)\\s+" + REST + ")?(?:\\s+(?:now|then|too))?\\s*\\?$",
);

const LEAD = "(?:(?:ok(?:ay)?|alright|all right|great|good|perfect|so|and|then|now|next|first|finally|well|right|cool)[,.:!\\s\\u2014\\u2013-]+)*";
const WILL = "(?:let me|let's|i'll|i will|i'm going to|i am going to|i'm about to|i am about to|i'm gonna|going to|time to|i need to now|i now need to|i should now)";
const ADV = "(?:(?:now|next|first|then|just|quickly|also|go ahead and|start by|begin by|proceed to|move on to)\\s+)*";
const VERB =
  "(?:run|rerun|re-run|execute|check|look|inspect|examine|read|open|view|scan|search|grep|find|list|fetch|pull|download|install|build|compile|test|verify|validate|confirm|review|edit|update|modify|change|fix|patch|apply|write|create|add|implement|refactor|rename|move|delete|remove|commit|push|deploy|start|begin|continue|proceed|dig|try|make|do|set|configure|see|take|get|go|work|tackle|handle|address|investigate|diagnose|debug|reproduce|migrate|generate|draft|prepare)";
/** A step named as the next thing to do: "let me now run the tests", "next I'll update the config". */
const NAMES_STEP = new RegExp("^(?:.{0,120}?[,;:\\u2014\\u2013-]\\s*)?" + LEAD + WILL + "\\s+" + ADV + VERB + "\\b");
/** Words that make an "I'll..." an offer, a promise for later, or a goodbye rather than the next step. */
const NOT_NEXT =
  /\b(?:if you(?:'d)? (?:need|want|like|prefer|wish)|if needed|if that helps|whenever|when you(?:'re)?|once you|should you|unless|feel free|let me know|happy to|glad to|here (?:if|to|for)|be here|on standby|at your service|check back|check in|later|tomorrow|next time|in the future|until)\b/;

/** Whether the last line of a reply asks the person something other than whether to go on. */
export function asksUser(text) {
  const sentences = sentencesOf(lastLine(text));
  return sentences.some((sentence) => sentence.replace(ending, "").endsWith("?") && !CONTINUE_ASK.test(normal(sentence)));
}

/** Whether a reply ends having named the next step (or asked to go on) without doing it. */
export function namesNextStep(text) {
  const sentence = sentencesOf(lastLine(text)).at(-1);
  if (!sentence) return false;
  const said = normal(sentence);
  if (CONTINUE_ASK.test(said)) return true;
  if (said.endsWith("?") || NOT_NEXT.test(said) || /^if\b/.test(said)) return false;
  return NAMES_STEP.test(said);
}

// ── The decision ────────────────────────────────────────────────────────────────────────────────

/**
 * What happens when a turn has ended. `chain` is { count, stalls, signature } from the continuations
 * so far; `blocked` is a reason from the host (the person pressed Stop, a message waits, a request is
 * open...). Returns { move: "continue", reason, input, open, signature } or { move: "stop", ... },
 * both with the plan as { open, total } when there is one and `stoppedOpen` when open steps remain.
 */
export function nextMove({ text, todos, chain, blocked }) {
  const open = openSteps(todos);
  const plan = Array.isArray(todos) && todos.length ? { open: open.length, total: todos.length } : undefined;
  const stop = { move: "stop", plan, stoppedOpen: open.length > 0 };
  if (blocked || asksUser(text) || chain.count >= MAX_CONTINUATIONS) return stop;
  if (open.length) {
    const signature = openSignature(open);
    // The same steps again: another continuation would only repeat the last one.
    if (signature === chain.signature) return stop;
    return { move: "continue", reason: "plan", open, signature, plan, input: planNote(open, chain.count + 1) };
  }
  if (chain.stalls < MAX_NEXT_STEP && namesNextStep(text)) return { move: "continue", reason: "next-step", open, plan, input: STALL_NOTE };
  return stop;
}

// ── Queued messages ─────────────────────────────────────────────────────────────────────────────

const personOf = (item) => item.author?.memberId ?? "owner";

/**
 * Whether a queued message may be read together with the ones beside it: a command (`/compact`) and a
 * spoken line each need a turn of their own.
 */
export const mergeable = (item) => typeof item?.text === "string" && !item.text.startsWith("/") && !item.voiceId;

/**
 * Takes the next turn's messages off the front of a chat's queue: the first one, and each message
 * after it from the same person that can be read with it. A message from someone else, or one that
 * needs its own turn, ends the run and stays in the queue, so people's turns keep their order.
 * `accepts(item)` lets the host refuse one that can't be sent (a mentioned record is gone).
 */
export function takeBatch(list, accepts = () => true) {
  const first = list.shift();
  if (!first) return { first: undefined, rest: [] };
  const rest = [];
  if (mergeable(first))
    while (list.length && mergeable(list[0]) && personOf(list[0]) === personOf(first) && (list[0].notify === false) === (first.notify === false) && accepts(list[0])) rest.push(list.shift());
  return { first, rest };
}

/** The prompt of a turn that starts with several messages. `parts` are the messages' prompts, in order. */
export const mergedPrompt = (parts) =>
  "[Botkins] The person sent " + parts.length + " messages while you were busy. Here they are in order; read them all before you reply.\n\n" + parts.map((part, i) => "Message " + (i + 1) + ":\n" + part).join("\n\n");
