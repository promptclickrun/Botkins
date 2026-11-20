// Mail: an iPhone lets an app open a filled-in message for the person to send, and nothing more.
// There is no way to read mail on the phone; reading is set up in Botkins on a Mac.
import { AppState } from "react-native";
import { checkArgs, DeviceError, optBool, optStringList, reqString } from "./args";
import { mailModule, need } from "./native";
import { argsOf } from "./tools";

/** Whether this phone can open a message at all (a Mail account is set up). */
export async function mailReady(): Promise<boolean> {
  const Mail = mailModule();
  if (!Mail) return false;
  return Mail.isAvailableAsync().catch(() => false);
}

const addresses = (list: string[] | undefined, key: string) => {
  for (const address of list ?? []) if (!/^[^\s@]+@[^\s@]+$/.test(address)) throw new DeviceError(JSON.stringify(address.slice(0, 80)) + " in `" + key + "` isn't an email address.");
  return list;
};

async function compose(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_mail_compose"));
  const to = addresses(optStringList(args, "to"), "to");
  if (!to?.length) throw new DeviceError("`to` needs at least one address.");
  const cc = addresses(optStringList(args, "cc"), "cc");
  const bcc = addresses(optStringList(args, "bcc"), "bcc");
  const subject = reqString(args, "subject", 1000);
  const body = reqString(args, "body", 200_000);
  const html = optBool(args, "html") ?? false;
  const Mail = need(mailModule);
  // The message is shown for the person to read and send, so Botkins must be in front.
  if (AppState.currentState !== "active") throw new DeviceError("The person needs to open Botkins on their phone to see this email.");
  if (!(await Mail.isAvailableAsync().catch(() => false))) throw new DeviceError("Mail isn't set up on the phone.");
  const result = await Mail.composeAsync({ recipients: to, ccRecipients: cc, bccRecipients: bcc, subject, body, isHtml: html });
  if (result.status === Mail.MailComposerStatus.SENT) return { status: "sent" };
  if (result.status === Mail.MailComposerStatus.SAVED) return { status: "saved" };
  if (result.status === Mail.MailComposerStatus.CANCELLED) return { status: "cancelled" };
  throw new DeviceError("The phone couldn't tell whether the email was sent.");
}

export const mailTools = { phone_mail_compose: compose };
