import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { CliError, usage } from "../output.mjs";
import { protonPage } from "../../desktop/link/proton-login.mjs";
import { shownText } from "../../desktop/shown-text.mjs";
import { ask, confirm } from "./input.mjs";

const yes = { type: "boolean", about: "Confirm the action without a prompt" };
const vaults = { type: "string", about: "Comma-separated vault names to share; required without a terminal" };
const consent = ({ version, url, sha256, destination }) =>
  `Botkins will download Proton's pass-cli ${version} from ${url}, check it matches SHA-256 ${sha256}, and keep it at ${destination}. Botkins runs it only to read fields you link.`;

function proton(context) {
  if (context.args.length !== 1 || context.args[0] !== "proton-pass") {
    throw usage("Specify proton-pass as the password manager.");
  }
}

async function choose(context, offered, signal) {
  let names = context.options.vaults;
  if (names !== undefined) {
    const requested = new Set(names.split(",").map((name) => name.trim()).filter(Boolean));
    const selected = [...requested].map((name) => offered.filter((vault) => vault.name === name));
    if (!requested.size || selected.some((matches) => matches.length !== 1)) {
      throw usage("Use exact, unique vault names in --vaults. For duplicate names, use the interactive vault picker.");
    }
    return { vaultIds: selected.map(([vault]) => vault.id), createDedicated: false };
  }
  if (!context.stdin.isTTY) throw usage("Choose vaults with --vaults when there's no terminal.");
  offered.forEach((vault, index) => context.stderr.write(`${index + 1}. ${shownText(vault.name)}${vault.suggested ? " (suggested)" : ""}\n`));
  context.stderr.write(`${offered.length + 1}. Create a vault for Botkins\n`);
  names = await ask(context, "Share which vaults? Enter numbers separated by commas: ", { signal });
  if (names == null) throw new CliError("Canceled.", 130, "CANCELLED");
  const indices = [...new Set(names.split(",").map((part) => Number(part.trim()) - 1))];
  if (!indices.length || indices.some((i) => !Number.isInteger(i) || i < 0 || i > offered.length)) {
    throw usage("Enter valid numbers from the vault list.");
  }
  return { vaultIds: indices.filter((i) => i < offered.length).map((i) => offered[i].id), createDedicated: indices.includes(offered.length) };
}

async function follow(context, session) {
  const cancel = new AbortController();
  const onInterrupt = () => cancel.abort(new CliError("Canceled.", 130, "CANCELLED"));
  process.once("SIGINT", onInterrupt);
  let done = false, piped, lines;
  try {
    for (let after = 0; ; ) {
      cancel.signal.throwIfAborted();
      const view = await context.client.call("protonPass.signInRead", { session, after });
      done = view.done;
      if (view.error) throw new CliError(view.error, 1, view.code ?? "PROTON_PASS");
      if (done) return view.result;
      for (const event of view.events) {
        cancel.signal.throwIfAborted();
        if (event.type === "open") {
          const url = protonPage(event.url);
          if (!url) throw new CliError("The computer didn't provide a Proton sign-in page.");
          context.stderr.write("Open Proton's page: " + url + "\n");
        } else if (event.type === "extra-password") {
          if (!context.stdin.isTTY && !piped) {
            piped = createInterface({ input: context.stdin, crlfDelay: Infinity, signal: cancel.signal });
            lines = piped[Symbol.asyncIterator]();
          }
          if (event.attempt > 1) context.stderr.write("Proton didn't accept that extra password. Try again.\n");
          let extraPassword = lines ? (await lines.next()).value : await ask(context, "Proton Pass extra password: ", { hidden: true, signal: cancel.signal });
          cancel.signal.throwIfAborted();
          if (!extraPassword) throw usage("Enter your Proton Pass extra password through the hidden prompt or standard input.");
          const input = { session, extraPassword };
          try {
            await context.client.call("protonPass.signInInput", input);
          } finally {
            input.extraPassword = "";
            extraPassword = "";
          }
        } else if (event.type === "choose-vaults") {
          await context.client.call("protonPass.signInInput", { session, ...await choose(context, event.vaults, cancel.signal) });
        } else if (event.type === "step" && event.name === "setting-up") context.stderr.write("Setting up Proton Pass…\n");
      }
      after = view.next;
      await delay(250, undefined, { signal: cancel.signal }).catch((error) => { throw cancel.signal.reason ?? error; });
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    piped?.close();
    if (!done) {
      try {
        await context.client.call("protonPass.signInCancel", { session });
      } catch {
        context.stderr.write("Botkins couldn't cancel Proton Pass setup on the computer.\n");
      }
    }
  }
}

function print(context, result) {
  context.print(result, ({ state, account, expiresAt }) => {
    if (state === "ready" || state === "expiring") {
      return "Proton Pass is connected" + (account ? " as " + shownText(account) : "") +
        (expiresAt ? ". Access ends " + new Date(expiresAt).toISOString().slice(0, 10) + "." : ".");
    }
    return "Proton Pass: " + shownText(state) + ".";
  });
}

const signIn = (renew) => async (context) => {
  proton(context);
  if (!context.stdin.isTTY && !context.options.vaults) throw usage("Choose vaults with --vaults when there's no terminal.");
  const { session } = await context.client.call("protonPass.signInStart", { renew });
  print(context, await follow(context, session));
};

export const protonCommands = {
  install: {
    summary: "Review and install Botkins' verified Proton Pass CLI",
    usage: "botkins password-managers install proton-pass [--yes]",
    options: { yes },
    async run(context) {
      proton(context);
      const plan = await context.client.call("protonPass.installPlan");
      context.stderr.write(shownText(consent(plan)) + "\n");
      if (!(await confirm(context, "Install Proton Pass?"))) return;
      const { session } = await context.client.call("protonPass.install", { sha256: plan.sha256, agreed: true });
      print(context, await follow(context, session));
    },
  },
  "sign-in": {
    summary: "Sign in on Proton's page and choose vaults to share with Botkins",
    usage: "botkins password-managers sign-in proton-pass [--vaults <names>]",
    options: { vaults },
    run: signIn(false),
  },
  renew: {
    summary: "Renew Proton Pass access and confirm the shared vaults",
    usage: "botkins password-managers renew proton-pass [--vaults <names>]",
    options: { vaults },
    run: signIn(true),
  },
  disconnect: {
    summary: "Sign in on Proton's page to delete the agent and disconnect",
    usage: "botkins password-managers disconnect proton-pass [--yes] [--delete-agent]",
    options: { yes, "delete-agent": { type: "boolean", about: "Delete the Proton agent (always done when disconnecting)" } },
    async run(context) {
      proton(context);
      context.stderr.write("Disconnect removes Botkins' access on Proton. Your Proton session and linked credentials stay.\n");
      if (!(await confirm(context, "Disconnect Proton Pass?"))) return;
      const result = await context.client.call("protonPass.disconnect", { deleteAgent: true, agreed: true });
      print(context, result.session ? await follow(context, result.session) : result);
    },
  },
};
