#!/usr/bin/env node
// A stand-in for the `imsg` program (desktop/mactools.mjs), so no test touches a real person's
// messages. It answers the commands Botkins uses with made-up JSON (one object per line, as imsg
// does with --json) and records the arguments it was started with.
//
// Environment, set by the test that starts it:
//   FAKE_IMSG_LOG     a file that gets one line per start: the argument array as JSON
//   FAKE_IMSG_FAIL    text to print on stderr before exiting with FAKE_IMSG_CODE (default 1)
//   FAKE_IMSG_COUNT   how many history lines and search hits to print (default 3)
//   FAKE_IMSG_LENGTH  characters in each message text (default 20)
//   FAKE_IMSG_PLAIN   print this text instead of JSON
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_IMSG_LOG) appendFileSync(process.env.FAKE_IMSG_LOG, JSON.stringify(args) + "\n");
if (process.env.FAKE_IMSG_FAIL) {
  process.stderr.write(process.env.FAKE_IMSG_FAIL + "\n");
  process.exit(Number(process.env.FAKE_IMSG_CODE ?? 1));
}
if (process.env.FAKE_IMSG_PLAIN !== undefined) {
  process.stdout.write(process.env.FAKE_IMSG_PLAIN + "\n");
  process.exit(0);
}
const count = Number(process.env.FAKE_IMSG_COUNT ?? 3);
const length = Number(process.env.FAKE_IMSG_LENGTH ?? 20);
const lines = (items) => items.map((item) => JSON.stringify(item)).join("\n") + "\n";
const text = (n) => ("message " + n + " ").repeat(Math.ceil(length / 10)).slice(0, length);
switch (args[0]) {
  case "chats":
    process.stdout.write(
      lines([
        { id: 1, name: "Dinner club", identifier: "chat100", service: "iMessage", last_message_at: "2026-11-01T18:00:00Z" },
        { id: 2, name: "Sam Example", identifier: "+15550100", service: "iMessage", last_message_at: "2026-10-30T09:30:00Z" },
        { id: 3, name: "", identifier: "sam@example.com", service: "SMS", last_message_at: "2026-10-01T12:00:00Z" },
      ]),
    );
    break;
  case "history":
    process.stdout.write(lines(Array.from({ length: count }, (_, i) => ({ id: 100 + i, chat_id: Number(args[args.indexOf("--chat-id") + 1]), sender: "+15550100", is_from_me: i % 2 === 0, text: text(i), created_at: "2026-11-01T18:0" + (i % 10) + ":00Z" }))));
    break;
  case "search":
    process.stdout.write(lines(Array.from({ length: count }, (_, i) => ({ id: 200 + i, chat_id: 2, sender: "+15550100", is_from_me: false, text: text(i), created_at: "2026-10-30T09:30:00Z" }))));
    break;
  case "send":
    process.stdout.write(lines([{ status: "sent", id: 501 }]));
    break;
  default:
    process.stderr.write("unknown command " + args[0] + "\n");
    process.exit(64);
}
