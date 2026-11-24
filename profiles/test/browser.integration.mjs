import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { hash, random, ORIGIN } from "../src/common.mjs";
import { setup } from "./support.mjs";

const { chromium } = createRequire(new URL("../../desktop/package.json", import.meta.url))(
  "@playwright/test",
);

test("the browser enrolls with a passkey and email, then signs in a second device by trusted approval", async (t) => {
  const fixture = setup(t);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const assets = new Map([
    ["/", "index.html"],
    ["/mark.png", "mark.png"],
    ["/enroll.js", "enroll.js"],
    ["/profile.css", "profile.css"],
  ]);
  await page.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname.startsWith("/v1/")) {
      const res = await fixture.fetchWorker(url, {
        method: req.method(),
        headers: await req.allHeaders(),
        body: req.postData(),
      });
      return route.fulfill({ status: res.status, contentType: "application/json", body: await res.text() });
    }
    const name = assets.get(url.pathname);
    if (!name) return route.fulfill({ status: 404, body: "" });
    const contentType = {
      "index.html": "text/html",
      "mark.png": "image/png",
      "enroll.js": "text/javascript",
      "profile.css": "text/css",
    }[name];
    return route.fulfill({ contentType, body: readFileSync(new URL("../public/" + name, import.meta.url)) });
  });

  async function open(label) {
    const verifier = random(),
      { id, code } = await fixture.api("enroll/start", { label, challenge: await hash(verifier) });
    await page.goto("about:blank");
    await page.goto(ORIGIN + "/#" + id);
    await page.getByLabel("Device code", { exact: true }).fill(code);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    return { id, code, finish: () => fixture.api("enroll/finish", { id, verifier }) };
  }
  const first = await open("Test desktop");
  await page.getByRole("button", { name: "Create a profile", exact: true }).click();
  await page.getByLabel("Your name", { exact: true }).fill("Casey");
  await page.getByLabel("Email address").fill("casey@example.test");
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await page.getByRole("button", { name: "Send an email code" }).click();
  const input = page.getByLabel("Email code", { exact: true });
  await input.waitFor();
  await input.fill(/code is (\d{6})/.exec(fixture.mail.at(-1).text)[1]);
  await page.getByRole("button", { name: "Verify device", exact: true }).click();
  await page.getByRole("heading", { name: "Device verified" }).waitFor();
  const { session } = await first.finish();
  const second = await open("Test phone");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.getByRole("heading", { name: "Verify this device" }).waitFor();
  assert.equal((await second.finish()).session, null);
  await fixture.api("devices/approve", { id: second.id, code: second.code }, session.token);
  await page.getByRole("button", { name: "I approved it on another device" }).click();
  await page.getByRole("heading", { name: "Device verified" }).waitFor();
  assert.equal((await second.finish()).session.profileId, session.profileId);
});
