import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

const id = location.hash.slice(1),
  get = (id) => document.getElementById(id);
const sections = ["welcome", "match", "choose", "create", "verify", "email-code", "done"];
const message = get("message");
let state, mode, label, browser;
function show(id) {
  for (const section of sections) get(section).hidden = section !== id;
  const field = get(id).querySelector("input, button");
  if (field) field.focus();
}
async function post(action, data = {}) {
  const response = await fetch("/v1/browser/" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({ id, browser, ...data }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Try again in Botkins.");
  return result;
}
function reflect(result) {
  ({ state, mode, label } = result);
  for (const node of document.querySelectorAll(".device")) node.textContent = "Setting up " + label + ".";
  if (state === "approved" || state === "complete") {
    show("done");
    return;
  }
  if (state === "verified") {
    get("check").hidden = mode === "create";
    get("verify-copy").textContent =
      mode === "create"
        ? "Verify your email to finish setting up " + label + "."
        : "In Profile on a trusted Botkins device, approve " +
          label +
          " with the matching device code. You can also verify with a code sent to your email.";
    show("verify");
  } else show("choose");
}
function on(id, kind, fn) {
  get(id).addEventListener(kind, async (event) => {
    event.preventDefault();
    message.textContent = "";
    const buttons = [...document.querySelectorAll("button")];
    buttons.forEach((b) => (b.disabled = true));
    try {
      await fn();
    } catch (e) {
      message.textContent =
        e?.name === "NotAllowedError"
          ? "Passkey sign-in was cancelled. You can try again."
          : e?.message || "Couldn’t complete sign-in.";
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });
}
async function passkey(mode) {
  const { options } = await post("options", {
    mode,
    name: get("name").value,
    email: get("email").value,
    avatar: get("avatar").value,
  });
  const credential =
    mode === "create"
      ? await startRegistration({ optionsJSON: options })
      : await startAuthentication({ optionsJSON: options });
  await post("verify", { credential });
  reflect(await post("open"));
}
async function send() {
  await post("email");
  show("email-code");
  message.textContent = "A verification code was sent.";
}
on("match", "submit", async () => reflect(await post("open", { code: get("match-code").value })));
on("new", "click", () => show("create"));
on("back", "click", () => show("choose"));
on("signin", "click", () => passkey("signin"));
on("create", "submit", () => passkey("create"));
on("send", "click", send);
on("resend", "click", send);
on("check", "click", async () => {
  reflect(await post("open"));
  if (state === "verified")
    message.textContent = "Still waiting for approval. Check Profile on your trusted device.";
});
on("email-code", "submit", async () => {
  await post("code", { otp: get("otp").value });
  show("done");
});
if (/^[\w-]{32}$/.test(id)) {
  // Kept in this tab only so returning from a passkey prompt can resume the same ceremony.
  const storageKey = "botkins.enroll." + id;
  browser = sessionStorage.getItem(storageKey);
  if (!browser) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    browser = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    sessionStorage.setItem(storageKey, browser);
    show("match");
  } else
    post("open")
      .then(reflect)
      .catch(() => show("match"));
}
