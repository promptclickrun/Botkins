// The fixed scripts that read and change Mail (desktop/mactools.mjs runs them with /usr/bin/osascript).
// They are JavaScript for Automation. Nothing a bot says is ever pasted into script text: each
// script reads one JSON argument, and the caller has already checked every value in it.

// Shared by the Mail scripts: the mailboxes of every account (three levels deep), found by name or path.
const COMMON = `
function boxesOf(boxes, prefix, depth, out) {
  const names = boxes.name();
  for (let i = 0; i < names.length; i++) {
    const path = prefix + names[i];
    out.push({ name: names[i], path: path, box: boxes[i] });
    if (depth < 3) boxesOf(boxes[i].mailboxes, path + "/", depth + 1, out);
  }
}
function findBoxes(Mail, accountName, wanted) {
  const found = [];
  const want = wanted.toLowerCase();
  for (const account of Mail.accounts()) {
    if (accountName && account.name().toLowerCase() !== accountName.toLowerCase()) continue;
    const all = [];
    boxesOf(account.mailboxes, "", 0, all);
    for (const entry of all)
      if (entry.path.toLowerCase() === want || entry.name.toLowerCase() === want) found.push({ account: account.name(), box: entry.box });
  }
  return found;
}
function clip(text, max) {
  const value = text == null ? "" : String(text);
  return value.length > max ? value.slice(0, max) : value;
}
`;

export const MAIL_MAILBOXES = `${COMMON}
function run(argv) {
  const input = JSON.parse(argv[0]);
  const Mail = Application("Mail");
  const out = [];
  let more = false;
  for (const account of Mail.accounts()) {
    const all = [];
    boxesOf(account.mailboxes, "", 0, all);
    const name = account.name();
    for (const entry of all) {
      if (out.length >= input.max) { more = true; break; }
      out.push({ account: name, mailbox: entry.path, unread: entry.box.unreadCount() });
    }
    if (more) break;
  }
  return JSON.stringify({ mailboxes: out, more: more });
}
`;

export const MAIL_SEARCH = `${COMMON}
function run(argv) {
  const input = JSON.parse(argv[0]);
  const Mail = Application("Mail");
  const conditions = [{ dateReceived: { _greaterThan: new Date(input.since) } }];
  if (input.before != null) conditions.push({ dateReceived: { _lessThan: new Date(input.before) } });
  if (input.sender) conditions.push({ sender: { _contains: input.sender } });
  if (input.subject) conditions.push({ subject: { _contains: input.subject } });
  let sources;
  if (input.mailbox) {
    const found = findBoxes(Mail, input.account, input.mailbox);
    if (!found.length) return JSON.stringify({ error: "mailbox" });
    sources = found.map(function (f) { return f.box.messages; });
  } else {
    sources = [Mail.inbox.messages];
  }
  const hits = [];
  for (const messages of sources) {
    const matches = messages.whose({ _and: conditions });
    const refs = matches();
    const dates = matches.dateReceived();
    for (let i = 0; i < refs.length; i++) hits.push({ ref: refs[i], at: dates[i] });
  }
  hits.sort(function (a, b) { return b.at - a.at; });
  const out = hits.slice(0, input.limit).map(function (hit) {
    const m = hit.ref;
    let mailbox = "";
    let account = "";
    try {
      const box = m.mailbox();
      mailbox = box.name();
      account = box.account().name();
    } catch (e) {}
    return {
      id: m.id(),
      account: account,
      mailbox: mailbox,
      from: clip(m.sender(), 300),
      subject: clip(m.subject(), 300),
      date: hit.at.toISOString(),
      read: m.readStatus()
    };
  });
  return JSON.stringify({ total: hits.length, messages: out });
}
`;

export const MAIL_READ = `${COMMON}
function run(argv) {
  const input = JSON.parse(argv[0]);
  const Mail = Application("Mail");
  const found = findBoxes(Mail, input.account, input.mailbox);
  if (!found.length) return JSON.stringify({ error: "mailbox" });
  for (const f of found) {
    const m = f.box.messages.byId(input.id);
    let subject;
    try { subject = m.subject(); } catch (e) { continue; }
    const body = m.content() || "";
    const addresses = function (list) { return list.map(function (r) { return clip(r.address(), 200); }); };
    let attachments = [];
    try { attachments = m.mailAttachments().map(function (a) { return clip(a.name(), 200); }); } catch (e) {}
    return JSON.stringify({
      id: input.id,
      account: f.account,
      mailbox: m.mailbox().name(),
      from: clip(m.sender(), 300),
      to: addresses(m.toRecipients()),
      cc: addresses(m.ccRecipients()),
      subject: clip(subject, 300),
      date: m.dateReceived().toISOString(),
      read: m.readStatus(),
      attachments: attachments.slice(0, 20),
      bodyLength: body.length,
      body: body.slice(0, input.maxChars)
    });
  }
  return JSON.stringify({ error: "message" });
}
`;

export const MAIL_MARK = `${COMMON}
function run(argv) {
  const input = JSON.parse(argv[0]);
  const Mail = Application("Mail");
  const found = findBoxes(Mail, input.account, input.mailbox);
  if (!found.length) return JSON.stringify({ error: "mailbox" });
  for (const f of found) {
    const m = f.box.messages.byId(input.id);
    try { m.subject(); } catch (e) { continue; }
    m.readStatus = input.read;
    return JSON.stringify({ id: input.id, read: m.readStatus() });
  }
  return JSON.stringify({ error: "message" });
}
`;

export const MAIL_SEND = `
function run(argv) {
  const input = JSON.parse(argv[0]);
  const Mail = Application("Mail");
  const message = Mail.OutgoingMessage({ subject: input.subject, content: input.body, visible: false });
  Mail.outgoingMessages.push(message);
  for (const address of input.to) message.toRecipients.push(Mail.Recipient({ address: address }));
  for (const address of input.cc) message.ccRecipients.push(Mail.Recipient({ address: address }));
  message.send();
  return JSON.stringify({ sent: true });
}
`;

// Asks an app something harmless, which is what makes macOS check (and, the first time, ask about)
// the Automation permission. Without "launch" an app that isn't running is left alone.
export const AUTOMATION_PROBE = `
function run(argv) {
  const input = JSON.parse(argv[0]);
  const app = Application(input.app);
  if (!app.running()) {
    if (!input.launch) return "not-running";
    app.launch();
  }
  app.name();
  return "ok";
}
`;
