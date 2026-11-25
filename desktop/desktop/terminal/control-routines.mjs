// Routines: the control socket's calls for the command line (desktop/terminal/control.mjs adds them).
// A call is `"<area>.<verb>"([...args], context)`. `handlers` are the app's own calls.
//
// A routine runs a bot on a schedule, with nobody watching. So `routines.review` says what a routine
// will be before it is saved: the bot, the schedule in words, the next times and the prompt. The
// command line shows that and asks. The calls here check what they are given with the app's own
// rules (desktop/routines.mjs); this file only finds things by name and shapes the answers.
//
// (`routines.list`, `routines.run`, `routines.pause` and `routines.resume` are in control.mjs.)
import { nextTime } from "../panels.mjs";
import { compileCadence, deliveryField, describeCadence, notifyField, slowEnough } from "../routines.mjs";
import { ControlError } from "./socket.mjs";
import { invocationOf, needsScriptYes } from "./script-yes.mjs";

const text = (value, max, what) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ControlError("Give " + what + ".", "BAD_ARGUMENT");
  return value.trim();
};
/** The app's own rules throw plain errors. A caller gets their sentence, as a refusal of what it gave. */
const checked = (work) => {
  try {
    return work();
  } catch (error) {
    if (error instanceof ControlError) throw error;
    throw new ControlError(String(error?.message ?? error), "BAD_ARGUMENT");
  }
};
const iso = (time) => new Date(time).toISOString();
/** The time after `first`, one after the other: the next `count` times of a cron line, in a zone. */
const series = (cron, zone, first, count) => {
  const out = [first];
  while (out.length < count) out.push(nextTime(cron, zone, out.at(-1)));
  return out;
};
/** What fields a kind of schedule has. */
/**
 * How often a repeating schedule runs at its fastest, in whole minutes, when it runs more often than a
 * bot's own routine tool allows; else null. The verdict is the app's own rule, `slowEnough`: two runs
 * less than its limit apart among the next 21 times from now. The words use the same 21 times.
 */
const fastEvery = (cron, zone, now) => {
  if (!cron || slowEnough(cron)) return null;
  const times = series(cron, zone, nextTime(cron, zone, now), 21);
  return Math.max(1, Math.round(Math.min(...times.slice(1).map((time, index) => time - times[index])) / 60_000));
};
/** What the caller must say, as the last argument of a call that makes or keeps a fast schedule, after the person agreed. */
const agreed = (mark) => mark?.fastSchedule === true;
const FAST_SENTENCE = (minutes) => "This schedule runs as often as every " + (minutes === 1 ? "minute" : minutes + " minutes") + ". Each run uses one model turn, and a model turn can cost money.";
/** The refusal of a fast schedule that comes without the mark. */
const needsAgreement = (minutes) =>
  new ControlError(FAST_SENTENCE(minutes) + " Show it to the person and ask first. `botkins routines` does that and needs --yes. A call to the socket carries { fastSchedule: true } as its last argument once the person agreed.", "NEEDS_AGREEMENT");
const FIELDS = { once: ["date", "time"], daily: ["time"], weekdays: ["time"], weekly: ["time", "days"], custom: ["cron"] };
const FIELD_NAMES = { date: "date", time: "time of day", days: "days", cron: "cron line" };
// A cron line of one of the simple shapes that the app's picker has (a time on every day, on weekdays, on some days).
const SIMPLE = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6](?:,[0-6])*)$/;
/** A cadence in words. A cron line is said in words when it has a simple shape, else field by field. */
export function meaning(cadence) {
  if (cadence?.kind !== "custom") return describeCadence(cadence);
  const cron = String(cadence.cron ?? "").trim().replace(/\s+/g, " ");
  const simple = SIMPLE.exec(cron);
  if (simple && +simple[1] <= 59 && +simple[2] <= 23) {
    const time = simple[2].padStart(2, "0") + ":" + simple[1].padStart(2, "0");
    if (simple[3] === "*") return describeCadence({ kind: "daily", time });
    if (simple[3] === "1-5") return describeCadence({ kind: "weekdays", time });
    return describeCadence({ kind: "weekly", time, days: [...new Set(simple[3].split(",").map(Number))].sort() });
  }
  const [minute, hour, day, month, weekday] = cron.split(" ");
  return "Cron fields: minute " + minute + ", hour " + hour + ", day of the month " + day + ", month " + month + ", day of the week " + weekday + " (* is every one)";
}
/** A chat schedule (made in a chat with /every or /after) in words. */
const scheduleWords = (entry) => {
  if (entry.cadence) return describeCadence(entry.cadence);
  if (entry.cron) return "Cron · " + entry.cron;
  if (entry.recurring && entry.intervalMs) {
    const [size, name] = [[86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"], [1000, "second"]].find(([unit]) => entry.intervalMs % unit === 0 && entry.intervalMs >= unit) ?? [1000, "second"];
    const count = Math.round(entry.intervalMs / size);
    return "Every " + (count === 1 ? name : count + " " + name + "s");
  }
  return "Once";
};

/**
 * @param workspace  The app's workspace.
 * @param handlers   `runtime.handlers`.
 * @param bot        (ref) → a bot, by id or by a name only one bot has (desktop/terminal/control.mjs).
 */
export function routinesApi({ workspace, handlers, bot, selection }) {
  const state = () => workspace.state;
  const routines = () => workspace.panels.routines;
  const botName = (id) => state().bots.find((entry) => entry.id === id)?.name ?? null;
  /** One of a list by its id, or by its name when exactly one has it. A name more than one has says which ones. */
  const pick = (list, ref, what, see, label) => {
    const wanted = text(ref, 200, "a " + what + "'s name or id");
    const byId = list.find((item) => item.id === wanted);
    if (byId) return byId;
    const named = list.filter((item) => String(item.name ?? "").toLowerCase() === wanted.toLowerCase());
    if (named.length > 1) throw new ControlError("More than one " + what + " is called " + wanted + ": " + named.map(label).join("; ") + ". Use its id.", "AMBIGUOUS");
    if (!named.length) throw new ControlError("There is no " + what + " called " + wanted + ". See `" + see + "`.", "NOT_FOUND");
    return named[0];
  };
  /** A routine by its id (its chat's id) or its name. */
  const routine = (ref) => {
    const all = routines().list().map(({ chat, entry }) => ({ id: chat.id, name: entry.name, chat, entry }));
    const found = pick(all, ref, "routine", "botkins routines list", (item) => item.id + " (" + (botName(item.chat.botId) ?? "no bot") + ")");
    return { chat: found.chat, entry: found.entry };
  };
  const chatNamed = (chats, ref, see) => pick(chats.map((chat) => ({ id: chat.id, name: chat.title, chat })), ref, "chat", see, (item) => item.id + " (" + (botName(item.chat.botId) ?? "no bot") + ")").chat;
  /** `fastEvery` for a routine as it is kept. */
  const fastOf = (entry) => fastEvery(entry.recurring && entry.cron, entry.timezone, Date.now());
  const nextRuns = (entry, count, now = Date.now()) => {
    if (entry.recurring && entry.cron) return series(entry.cron, entry.timezone, nextTime(entry.cron, entry.timezone, now), count).map(iso);
    return !entry.recurring && entry.nextAt != null && entry.nextAt > now ? [iso(entry.nextAt)] : [];
  };
  const deliverChat = (deliver) => (deliver?.chatId ? (state().chats.find((chat) => chat.id === deliver.chatId)?.title ?? null) : null);
  /** A routine whole, as `routines.list` shows it, with its schedule as data, its next times and its prompt (`instructions`). */
  const view = ({ chat, entry }) => ({
    ...routines().view(chat, entry),
    bot: botName(chat.botId),
    botId: chat.botId,
    running: workspace.active.has(chat.id),
    // Runs are kept newest first.
    lastRun: state().runs.find((run) => run.chatId === chat.id)?.status ?? null,
    schedule: entry.cadence,
    meaning: meaning(entry.cadence),
    next: nextRuns(entry, 3),
    ...(fastOf(entry) && { fastMinutes: fastOf(entry) }),
    ...(deliverChat(entry.deliver) && { deliverChat: deliverChat(entry.deliver) }),
    // A routine whose prompt is a script command of Botkins' runs that script, with no model.
    ...(!entry.script && invocationOf(workspace, entry.prompt) && { scriptCommand: invocationOf(workspace, entry.prompt) }),
  });

  /** A schedule made in a chat. */
  const scheduleView = (chat, entry) => ({
    chatId: chat.id,
    chat: chat.title,
    bot: botName(chat.botId),
    botId: chat.botId,
    id: entry.id,
    prompt: entry.prompt,
    when: scheduleWords(entry),
    timezone: entry.timezone ?? null,
    enabled: entry.enabled !== false,
    nextRun: entry.enabled !== false && entry.nextAt != null ? iso(entry.nextAt) : null,
  });
  const chatSchedules = (chat) => (chat.schedules ?? []).filter((entry) => !entry.routine);

  const CADENCE_KEYS = ["kind", "time", "days", "date", "cron"];
  /** What a patch of a schedule gives: its own when it names another kind, else the old one with the patch laid over it. */
  const mergedCadence = (old, patch) => {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ControlError("Give the schedule as { kind, time?, days?, date?, cron? }.", "BAD_ARGUMENT");
    const kind = patch.kind ?? old.kind;
    if (!Object.hasOwn(FIELDS, kind)) throw new ControlError("A schedule is once, daily, weekdays, weekly or custom.", "BAD_ARGUMENT");
    for (const key of CADENCE_KEYS) if (key !== "kind" && patch[key] !== undefined && !FIELDS[kind].includes(key)) throw new ControlError("A " + kind + " schedule has no " + FIELD_NAMES[key] + ".", "BAD_ARGUMENT");
    const given = Object.fromEntries(CADENCE_KEYS.filter((key) => patch[key] !== undefined).map((key) => [key, patch[key]]));
    return kind === old.kind ? { ...old, ...given, kind } : { ...given, kind };
  };
  /** A chat by its id or title for a result's destination: `{ to, chat?, chatId?, category? }` → the app's own form. */
  const destination = (deliver) => {
    if (deliver === undefined || deliver === null) return deliver;
    if (typeof deliver !== "object" || Array.isArray(deliver)) throw new ControlError("Choose where the result goes.", "BAD_ARGUMENT");
    const { chat, ...rest } = deliver;
    if (chat === undefined) return rest;
    if (rest.chatId !== undefined) throw new ControlError("Name the chat once: `chat` or `chatId`.", "BAD_ARGUMENT");
    return { ...rest, chatId: chatNamed(state().chats.filter((item) => !item.temporary), chat, "botkins chat list").id };
  };

  /** A routine's own model as words: "claude/claude-opus-5-5 · high". */
  const modelWords = (model) => (model.provider ? model.provider + "/" : "") + model.model + (model.reasoningEffort ? " · " + model.reasoningEffort : "");
  /** `data.model` ("provider/model", or null for the routines default) with `data.effort`, as the app's choice. Undefined leaves it. */
  const modelOf = async (data) => {
    if (data.model === undefined) {
      if (data.effort !== undefined) throw new ControlError("A thinking level goes with a model: --model <provider/model> --effort <level>.", "BAD_ARGUMENT");
      return undefined;
    }
    if (data.model === null || data.model === "default") return null;
    return { ...(await selection(data.model)), ...(data.effort !== undefined && { reasoningEffort: String(data.effort) }) };
  };
  /**
   * What a routine will be, and what to give the app to make it so. `found` is null for a new one. For a
   * change, `data` holds only what changes. Nothing is saved here; a refusal is the app's own sentence.
   * A script is shown whole, because it runs on this computer with nobody watching.
   */
  const plan = async (found, data, now) => {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ControlError("Give the routine as an object.", "BAD_ARGUMENT");
    const entry = found?.entry;
    const model = await modelOf(data);
    const owner = found ? found.chat.botId : bot(data.bot).id;
    const cadence = data.cadence === undefined ? undefined : mergedCadence(found ? entry.cadence : {}, data.cadence);
    const input = {
      name: data.name ?? entry?.name,
      prompt: data.prompt ?? entry?.prompt,
      cadence: cadence ?? entry?.cadence,
      timezone: data.timezone ?? entry?.timezone,
      script: data.script === undefined ? entry?.script : data.script,
      followUp: data.followUp ?? entry?.followUp,
    };
    // A change of the result, of notifying or of the model alone leaves the schedule as it is, so a finished one-time routine can still take it (as the app does).
    const keepsSchedule = found && ["name", "prompt", "cadence", "timezone", "script", "followUp"].every((key) => data[key] === undefined);
    const fields = keepsSchedule ? { ...input, recurring: entry.recurring, cron: entry.cron, nextAt: entry.nextAt } : checked(() => routines().fields(input, now));
    const finalModel = model === undefined ? found?.chat.model : (model ?? undefined);
    const wanted = destination(data.deliver);
    // `routine`, which is the default, is never saved: the app answers undefined for it. A change to it then takes the old one away (null).
    const deliver = wanted === undefined ? undefined : (checked(() => deliveryField(wanted, workspace, owner, entry?.createdBy ?? "owner")) ?? null);
    const notify = checked(() => notifyField(data.notify));
    const app = found
      ? {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.prompt !== undefined && { prompt: data.prompt }),
          ...(cadence !== undefined && { cadence }),
          ...(data.timezone !== undefined && { timezone: data.timezone }),
          ...(deliver !== undefined && { deliver }),
          ...(notify !== undefined && { notify }),
          ...(data.script !== undefined && { script: data.script }),
          ...(data.followUp !== undefined && { followUp: data.followUp }),
          ...(model !== undefined && { model }),
        }
      : {
          botId: owner,
          name: data.name,
          prompt: data.prompt,
          cadence: data.cadence,
          timezone: data.timezone,
          ...(deliver && { deliver }),
          ...(notify === false && { notify: false }),
          ...(data.script != null && { script: data.script, followUp: data.followUp === true }),
          ...(model && { model }),
        };
    if (found && !Object.keys(app).length) throw new ControlError("Say what to change.", "BAD_ARGUMENT");
    const finalDeliver = deliver === undefined ? entry?.deliver : (deliver ?? undefined);
    const finalNotify = notify === undefined ? entry?.notify !== false : notify;
    const fastMinutes = fastEvery(fields.recurring && fields.cron, fields.timezone, now);
    const times = keepsSchedule ? nextRuns(entry, 2, now).map(Date.parse) : fields.recurring ? series(fields.cron, fields.timezone, fields.nextAt, 2) : [fields.nextAt];
    return {
      app,
      review: {
        ...(found && { id: found.chat.id }),
        name: fields.name,
        bot: botName(owner),
        botId: owner,
        instructions: fields.prompt,
        ...(fields.script && { script: fields.script, followUp: fields.followUp === true }),
        ...(!fields.script && invocationOf(workspace, fields.prompt) && { scriptCommand: invocationOf(workspace, fields.prompt) }),
        // Left out when the routine has no model of its own.
        ...(finalModel && { model: modelWords(finalModel) }),
        cadence: describeCadence(fields.cadence),
        meaning: meaning(fields.cadence),
        schedule: fields.cadence,
        timezone: fields.timezone,
        repeats: fields.recurring,
        next: times.map(iso),
        ...(fastMinutes && { fastMinutes }),
        ...(finalDeliver && { deliver: finalDeliver }),
        ...(deliverChat(finalDeliver) && { deliverChat: deliverChat(finalDeliver) }),
        notify: finalNotify,
        ...(found && {
          enabled: entry.enabled !== false,
          changes: [
            ...(app.name !== undefined && fields.name !== entry.name ? ["name"] : []),
            ...(app.prompt !== undefined && fields.prompt !== entry.prompt ? ["prompt"] : []),
            ...(app.cadence !== undefined && JSON.stringify(fields.cadence) !== JSON.stringify(entry.cadence) ? ["schedule"] : []),
            ...(app.timezone !== undefined && fields.timezone !== entry.timezone ? ["time zone"] : []),
            ...(deliver !== undefined && JSON.stringify(finalDeliver ?? null) !== JSON.stringify(entry.deliver ?? null) ? ["result"] : []),
            ...(notify !== undefined && finalNotify !== (entry.notify !== false) ? ["notifying"] : []),
            ...(data.script !== undefined && (fields.script ?? null) !== (entry.script ?? null) ? ["script"] : []),
            ...(data.followUp !== undefined && (fields.followUp === true) !== (entry.followUp === true) ? ["follow-up action"] : []),
            ...(model !== undefined && JSON.stringify(model ?? null) !== JSON.stringify(found.chat.model ?? null) ? ["model"] : []),
          ],
        }),
      },
    };
  };

  return {
    /** One routine whole: its bot, its schedule in words and as data, its next times, its prompt (`instructions`), where its result goes. */
    "routines.get": ([ref]) => view(routine(ref)),
    /**
     * What a routine will be, before anything is saved. `ref` is null for a new routine, whose `data` is
     * { bot, name, prompt, cadence, timezone?, deliver?, notify? }. With a routine, `data` holds only what
     * changes; `cadence` there is a part of a schedule laid over the old one. The answer has `next`, the first two times.
     */
    "routines.review": async ([ref, data]) => (await plan(ref === null || ref === undefined ? null : routine(ref), data, Date.now())).review,
    /** What a cadence means, from the app's own preview: { summary, meaning, timezone, repeats, next }. `cadence` is { kind, time?, days?, date?, cron? }. */
    async "routines.when"([cadence, timezone]) {
      if (!cadence || typeof cadence !== "object" || Array.isArray(cadence)) throw new ControlError("Give the schedule as { kind, time?, days?, date?, cron? }.", "BAD_ARGUMENT");
      const preview = await checked(() => handlers.previewCadence(cadence, timezone));
      const compiled = checked(() => compileCadence(cadence, preview.timezone));
      return {
        summary: preview.summary,
        meaning: meaning(compiled.cadence),
        timezone: preview.timezone,
        repeats: compiled.recurring,
        next: (compiled.recurring ? series(compiled.cron, preview.timezone, preview.nextAt, 5) : [preview.nextAt]).map(iso),
      };
    },
    /** A new routine: { bot, name, prompt, cadence, timezone?, deliver?, notify? }. The answer is the routine whole. */
    async "routines.add"([data, mark]) {
      const { app, review } = await plan(null, data, Date.now());
      if (review.fastMinutes && !agreed(mark)) throw needsAgreement(review.fastMinutes);
      if (review.scriptCommand) needsScriptYes(workspace, review.instructions, mark, "This routine");
      const id = await handlers.createRoutine(app);
      return view(routine(id));
    },
    /** Changes a routine. `patch` holds only what changes (see `routines.review`). */
    async "routines.edit"([ref, patch, mark]) {
      const found = routine(ref);
      const { app, review } = await plan(found, patch, Date.now());
      if (review.fastMinutes && !agreed(mark)) throw needsAgreement(review.fastMinutes);
      if (review.scriptCommand) needsScriptYes(workspace, review.instructions, mark, "This routine");
      await handlers.updateRoutine(found.chat.id, app);
      return view(routine(found.chat.id));
    },
    /** Deletes a routine with its own chat and every run it kept. */
    async "routines.remove"([ref]) {
      const found = routine(ref);
      await handlers.deleteRoutine(found.chat.id);
      return { removed: found.chat.id, name: found.entry.name };
    },
    /** A copy of a routine, for the same bot or for `bot`, under its own name or under `name`. The copy has its own id. */
    async "routines.duplicate"([ref, other, name, mark]) {
      const found = routine(ref);
      // The copy runs the schedule of the routine, so a fast one is a new fast routine.
      const fast = fastOf(found.entry);
      if (fast && !agreed(mark)) throw needsAgreement(fast);
      if (!found.entry.script) needsScriptYes(workspace, found.entry.prompt, mark, "The copy of this routine");
      const target = other === undefined || other === null ? found.chat.botId : bot(other).id;
      const renamed = name === undefined || name === null ? undefined : text(name, 80, "a name of up to 80 characters");
      const id = await handlers.duplicateRoutine(found.chat.id, target);
      if (renamed !== undefined) await handlers.updateRoutine(id, { name: renamed });
      return view(routine(id));
    },
    /** The prompts that chats scheduled for themselves (with /every or /after), newest chats first, for one bot or all. */
    "routines.schedules": ([ref]) => {
      const owner = ref === undefined || ref === null ? null : bot(ref).id;
      return state().chats.filter((chat) => (!owner || chat.botId === owner) && chatSchedules(chat).length).flatMap((chat) => chatSchedules(chat).map((entry) => scheduleView(chat, entry)));
    },
    /** Pauses, resumes or deletes one schedule of a chat: `action` is "pause", "resume" or "delete". A routine's own schedule is not changed here. */
    async "routines.schedule"([chatRef, number, action]) {
      if (!["pause", "resume", "delete"].includes(action)) throw new ControlError("Say pause, resume or delete.", "BAD_ARGUMENT");
      const chat = chatNamed(state().chats.filter((item) => chatSchedules(item).length), chatRef, "botkins routines schedules");
      const id = Number(number);
      const entry = (chat.schedules ?? []).find((item) => item.id === id);
      if (!Number.isInteger(id) || !entry) throw new ControlError("The chat " + chat.title + " has no schedule with the number " + number + ". See `botkins routines schedules`.", "NOT_FOUND");
      if (entry.routine) throw new ControlError("That is a routine's own schedule. Use `botkins routines pause`, `resume` or `remove`.", "BAD_ARGUMENT");
      await handlers.changeSchedule(chat.id, id, action);
      return { chatId: chat.id, chat: chat.title, id, action, ...(action === "delete" ? { removed: true } : { enabled: action === "resume" }) };
    },
  };
}
