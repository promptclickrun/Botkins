// The plain logic of what a bot asks of the person (src/features/chat/request/logic.ts): a choice
// read as a label and a description, the card's heading (also its folded line), which parts are
// shown, the answer that is sent, the form's readiness, and when two buttons fit side by side.
// Run by `npm test` (tsx).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRequest } from "../src/link/types";
import {
  answerOf,
  choiceLabel,
  choicesOf,
  countLabel,
  detailMode,
  emFor,
  fitsSideBySide,
  foldHint,
  formReady,
  freeAnswerShown,
  heading,
  headerLabel,
  hostOf,
  initialValue,
  isSecretField,
  looksDangerous,
  looksSecret,
  rememberNote,
  splitChoice,
  wordsFor,
} from "../src/features/chat/request/logic";
import {
  cleanValue,
  fieldLabel,
  fieldProps,
  hasValue,
  isKnownKind,
  labelsLine,
  promiseLine,
  returnKeyOf,
  SEND_FAILED,
  secureContent,
  secureFieldsOf,
  secureReady,
  toggleLabel,
  UNKNOWN_LINE,
} from "../src/features/chat/request/secure";
import type { SecureField } from "../src/link/types";

const request = (over: Partial<AgentRequest>): AgentRequest => ({ id: "r1", chatId: "c1", botId: "b1", kind: "question", title: "Which one?", ...over });

test("a choice keeps one line when it has no description", () => {
  assert.deepEqual(splitChoice("Staging"), { label: "Staging" });
  assert.deepEqual(splitChoice("  Make the main Botkins repo public  "), { label: "Make the main Botkins repo public" });
  // A hyphen inside a word, an address and a parenthesis are part of the label.
  assert.deepEqual(splitChoice("A public releases-only repo (promptclick/botkins-releases)"), { label: "A public releases-only repo (promptclick/botkins-releases)" });
  assert.deepEqual(splitChoice("Use https://example.com/releases"), { label: "Use https://example.com/releases" });
  assert.deepEqual(splitChoice("Re-run the build"), { label: "Re-run the build" });
});

test("a choice splits into a label and a description where it says so", () => {
  assert.deepEqual(splitChoice("Staging — the test server, safe to break"), { label: "Staging", description: "the test server, safe to break" });
  assert.deepEqual(splitChoice("Staging – safe to break"), { label: "Staging", description: "safe to break" });
  assert.deepEqual(splitChoice("Staging - safe to break"), { label: "Staging", description: "safe to break" });
  assert.deepEqual(splitChoice("Production: what people use"), { label: "Production", description: "what people use" });
  assert.deepEqual(splitChoice("Keep it\nNothing changes on the site."), { label: "Keep it", description: "Nothing changes on the site." });
  // Markdown bold around the label is a bot's way of making it the label.
  assert.deepEqual(splitChoice("**Staging** — safe"), { label: "Staging", description: "safe" });
  // The first separator wins; the rest stays in the description.
  assert.deepEqual(splitChoice("Staging: the test server — safe"), { label: "Staging", description: "the test server — safe" });
  assert.deepEqual(splitChoice("Keep releases private — give the site a read-only token: safer"), { label: "Keep releases private", description: "give the site a read-only token: safer" });
});

test("a choice is not split where a side would be empty or the label is a sentence", () => {
  assert.deepEqual(splitChoice("— just a note"), { label: "— just a note" });
  assert.deepEqual(splitChoice("Yes:"), { label: "Yes:" });
  assert.deepEqual(splitChoice("\nYes"), { label: "Yes" });
  const sentence = "Keep releases private and give the website a token it reads with: safer";
  assert.deepEqual(splitChoice(sentence), { label: sentence });
  const long = "Keep releases private and give the site a read-only token for the latest release only — it needs a secret on the server";
  assert.deepEqual(splitChoice(long), { label: long });
});

test("a choice reads aloud as its label and its description", () => {
  assert.equal(choiceLabel({ label: "Staging" }), "Staging");
  assert.equal(choiceLabel({ label: "Staging", description: "safe to break" }), "Staging, safe to break");
});

test("the heading says who asks and what kind of thing it is, as the desktop app does", () => {
  assert.equal(heading("question", "Gordie"), "Gordie has a question");
  assert.equal(heading("form", "Gordie"), "Gordie has a question");
  assert.equal(heading("permission", "Gordie"), "Gordie needs approval");
  assert.equal(heading("permission", "Gordie", true), "Gordie wants to do something risky");
  assert.equal(heading("question", undefined), "Your bot has a question");
  assert.equal(heading("question", "  "), "Your bot has a question");
});

test("the folded line counts the requests and says what a tap does", () => {
  assert.equal(countLabel(undefined), undefined);
  assert.equal(countLabel(1), undefined);
  assert.equal(countLabel(3), "1 of 3");
  assert.equal(headerLabel(request({}), { bot: "Gordie" }), "Gordie has a question");
  assert.equal(headerLabel(request({ kind: "permission" }), { bot: "Gordie", count: 2 }), "Gordie needs approval, 1 of 2");
  assert.equal(headerLabel(request({ kind: "permission" }), { bot: "Gordie", danger: true }), "Gordie wants to do something risky");
  assert.equal(foldHint(true), "Folds the request so you can read the chat");
  assert.equal(foldHint(false), "Opens the request");
});

test("the buttons use the desktop app's words", () => {
  assert.deepEqual(wordsFor("permission"), { quiet: "Deny", main: "Allow once", remember: "Allow for this chat" });
  assert.deepEqual(wordsFor("question"), { quiet: "Dismiss", main: "Send answer" });
  assert.deepEqual(wordsFor("form"), { quiet: "Dismiss", main: "Send answer" });
  assert.equal(rememberNote("npm run deploy"), "Remembering this approval allows npm run deploy for this conversation.");
});

test("the full request is folded under the preview, and open without one", () => {
  assert.equal(detailMode(request({ kind: "permission" })), "none");
  assert.equal(detailMode(request({ kind: "permission", preview: "npm run deploy", detail: "Deploys the site." })), "folded");
  assert.equal(detailMode(request({ kind: "permission", detail: '{ "path": "/tmp" }' })), "open");
  assert.equal(detailMode(request({ kind: "question", detail: "More about it." })), "open");
});

test("a free answer is offered when the bot allows one or gives no choices", () => {
  assert.equal(freeAnswerShown(request({ choices: ["A", "B"], freeform: true })), true);
  assert.equal(freeAnswerShown(request({ choices: ["A", "B"], freeform: false })), false);
  assert.equal(freeAnswerShown(request({ choices: ["A", "B"] })), false);
  assert.equal(freeAnswerShown(request({ choices: [] })), true);
  assert.equal(freeAnswerShown(request({})), true);
  assert.equal(freeAnswerShown(request({ kind: "permission" })), false);
  assert.equal(freeAnswerShown(request({ kind: "form" })), false);
});

test("the answer sent is the whole choice or the trimmed text, never the split", () => {
  assert.equal(answerOf("Staging — the test server", ""), "Staging — the test server");
  assert.equal(answerOf(undefined, "  something else \n"), "something else");
  assert.equal(answerOf("Staging", "my own"), "my own");
  assert.equal(answerOf(undefined, "   "), null);
  assert.equal(answerOf(undefined, ""), null);
});

test("secrets and risky commands are recognized", () => {
  assert.equal(looksSecret("API key"), true);
  assert.equal(looksSecret("otp_code"), true);
  assert.equal(looksSecret("apiKey"), true);
  assert.equal(looksSecret("Which environment?"), false);
  assert.equal(looksSecret(undefined, "Your password"), true);
  assert.equal(isSecretField("username", { type: "string", title: "Username" }), false);
  assert.equal(isSecretField("api_key", { type: "string", title: "API key" }), true);
  assert.equal(isSecretField("value", { type: "string", format: "password" }), true);
  assert.equal(looksDangerous(request({ kind: "permission", preview: "rm -rf build" })), true);
  assert.equal(looksDangerous(request({ kind: "permission", preview: "git push --force origin main" })), true);
  assert.equal(looksDangerous(request({ kind: "permission", preview: "npm run deploy -- --env production" })), false);
});

test("a form's choices, starting values and readiness", () => {
  assert.deepEqual(choicesOf({ type: "string", enum: ["a", "b"], enumNames: ["Apple"] }), [
    { value: "a", label: "Apple" },
    { value: "b", label: "b" },
  ]);
  assert.deepEqual(choicesOf({ type: "string", oneOf: [{ const: "x", title: "Ex" }, { const: "y" }] }), [
    { value: "x", label: "Ex" },
    { value: "y", label: "y" },
  ]);
  assert.equal(choicesOf({ type: "string" }), undefined);
  assert.equal(initialValue({ type: "string", default: "hi" }, true), "");
  assert.equal(initialValue({ type: "string", default: "hi" }, false), "hi");
  assert.equal(initialValue({ type: "boolean" }, false), false);
  assert.equal(initialValue({ type: "integer" }, false), undefined);
  assert.equal(initialValue({ type: "string" }, false), "");
  assert.equal(formReady(["user", "key"], { user: "me", key: "" }, []), false);
  assert.equal(formReady(["user", "key"], { user: "me", key: "" }, ["key"]), true);
  assert.equal(formReady(["count"], { count: 0 }, []), true);
  assert.equal(formReady(["count"], { count: undefined }, []), false);
  assert.equal(formReady([], {}, []), true);
});

test("an address shows by its host", () => {
  assert.equal(hostOf("https://user@example.com/sign-in?x=1"), "example.com");
  assert.equal(hostOf("http://localhost:3000"), "localhost:3000");
  assert.equal(hostOf("file:///etc/passwd"), null);
});

test("two buttons sit side by side only when both labels fit", () => {
  // Not measured yet: side by side, as most cards are.
  assert.equal(fitsSideBySide(0, [{ label: "Dismiss" }, { label: "Send answer" }], 16), true);
  // A 375-point phone at the default text size.
  assert.equal(fitsSideBySide(319, [{ label: "Deny" }, { label: "Allow once" }], 16), true);
  assert.equal(fitsSideBySide(319, [{ label: "Dismiss" }, { label: "Send answer" }], 16), true);
  // The largest text size, or an icon beside the label, stacks them.
  assert.equal(fitsSideBySide(319, [{ label: "Dismiss" }, { label: "Send answer" }], 21), false);
  assert.equal(fitsSideBySide(319, [{ label: "Dismiss" }, { label: "Send answer", extra: 27 }], 16), false);
  // A wider face (SF Mono) needs more room.
  assert.equal(fitsSideBySide(300, [{ label: "Deny" }, { label: "Allow once" }], 16, 0.62), true);
  assert.equal(fitsSideBySide(260, [{ label: "Deny" }, { label: "Allow once" }], 16, 0.62), false);
  assert.equal(emFor("ui-monospace"), 0.62);
  assert.equal(emFor("Georgia"), 0.6);
  assert.equal(emFor("Lora"), 0.6);
  assert.equal(emFor("Open Sans"), 0.57);
  assert.equal(emFor(undefined), 0.57);
});

// --- A secure input ("secure-input-v1") ---------------------------------------------------------

const login: SecureField[] = [
  { key: "username", label: "Username", kind: "text" },
  { key: "password", label: "Password", kind: "password" },
  { key: "otp", label: "One-time code", kind: "code", optional: true, hint: "From your authenticator app" },
];

test("a secure input says who asks and what it promises, in the labels' words only", () => {
  assert.equal(heading("secure", "Gordie"), "Gordie needs a secure input");
  assert.deepEqual(wordsFor("secure"), { quiet: "Decline", main: "Send securely" });
  assert.equal(promiseLine("Gordie", 1), "Only your computer gets this. Gordie can use it but never sees it, and it stays out of the chat.");
  assert.equal(promiseLine("Gordie", 3), "Only your computer gets these. Gordie can use them but never sees them, and they stay out of the chat.");
  assert.equal(promiseLine(undefined, 1), "Only your computer gets this. Your bot can use it but never sees it, and it stays out of the chat.");
  assert.equal(labelsLine(login), "Username, Password, One-time code");
  assert.equal(fieldLabel(login[1]), "Password");
  assert.equal(fieldLabel(login[2]), "One-time code, optional");
  assert.equal(toggleLabel(false, "Password"), "Show Password");
  assert.equal(toggleLabel(true, "Password"), "Hide Password");
  assert.equal(SEND_FAILED, "That didn't send. Try again.");
});

test("each kind of field gets its own keyboard, autofill and masking, and none corrects or learns", () => {
  assert.deepEqual(fieldProps("password"), { masked: true, textContentType: "password", autoComplete: "current-password", keyboardType: "ascii-capable", importantForAutofill: "yes" });
  assert.deepEqual(fieldProps("code"), { masked: false, textContentType: "oneTimeCode", autoComplete: "one-time-code", keyboardType: "ascii-capable", importantForAutofill: "yes" });
  assert.deepEqual(fieldProps("secret"), { masked: true, textContentType: "none", autoComplete: "off", keyboardType: "ascii-capable", importantForAutofill: "no" });
  assert.deepEqual(fieldProps("text"), { masked: false, textContentType: "username", autoComplete: "username", keyboardType: "default", importantForAutofill: "yes" });
  // A kind this phone doesn't know is kept masked.
  assert.equal(fieldProps("pin" as SecureField["kind"]).masked, true);
});

test("only well-formed fields are shown, at most 8, each key once", () => {
  assert.deepEqual(secureFieldsOf(request({ kind: "secure", fields: login })), login);
  assert.deepEqual(secureFieldsOf(request({ kind: "secure" })), []);
  const odd = [
    { key: "a", label: "A", kind: "password" },
    { key: "a", label: "A again", kind: "text" },
    { key: "", label: "No key", kind: "text" },
    { key: "b", label: "  ", kind: "text" },
    { key: "c", label: "C", kind: "pin" },
  ] as unknown as SecureField[];
  assert.deepEqual(secureFieldsOf(request({ kind: "secure", fields: odd })), [
    { key: "a", label: "A", kind: "password" },
    { key: "c", label: "C", kind: "secret" },
  ]);
  const many = Array.from({ length: 12 }, (_, i) => ({ key: "k" + i, label: "Field " + i, kind: "secret" as const }));
  assert.equal(secureFieldsOf(request({ kind: "secure", fields: many })).length, 8);
});

test("the main action waits for every field that is not optional", () => {
  assert.equal(secureReady(login, []), false);
  assert.equal(secureReady(login, ["username"]), false);
  assert.equal(secureReady(login, ["username", "password"]), true);
  assert.equal(secureReady([], []), false);
  assert.equal(hasValue("password", "   "), false);
  assert.equal(hasValue("password", " a "), true);
  assert.equal(hasValue("code", " 12 34 "), true);
  assert.equal(hasValue("text", "\n"), false);
});

test("what is sent: each value under its key, cleaned by kind, and a saved credential by reference", () => {
  assert.equal(cleanValue("password", " pa ss "), " pa ss ");
  assert.equal(cleanValue("secret", " tok "), " tok ");
  assert.equal(cleanValue("text", "  me@example.com "), "me@example.com");
  assert.equal(cleanValue("code", " 123 456 "), "123456");
  const values: Record<string, string | { $credential: string }> = { username: " me ", password: { $credential: "cred-1" }, otp: "" };
  assert.deepEqual(
    secureContent(login, (key) => values[key]),
    { username: "me", password: { $credential: "cred-1" } },
    "an empty optional field is left out",
  );
  assert.deepEqual(secureContent(login, () => undefined), {});
});

test("the return key moves to the next field and sends from the last", () => {
  assert.equal(returnKeyOf(0, 1), "send");
  assert.equal(returnKeyOf(0, 3), "next");
  assert.equal(returnKeyOf(2, 3), "send");
});

test("a kind this phone doesn't know is never guessed at", () => {
  for (const kind of ["permission", "question", "form", "secure"]) assert.equal(isKnownKind(kind), true, kind);
  assert.equal(isKnownKind("vote"), false);
  assert.equal(heading("vote" as AgentRequest["kind"], "Gordie"), "Gordie needs you");
  assert.equal(UNKNOWN_LINE, "Update the app on this phone to answer this, or answer it on your computer.");
});
