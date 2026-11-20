// Usage totals from recorded runs: `run.usage = {input, output, cacheRead?, cost?, model?, durationMs?}`.
const DAY = 86400000;

/** YYYY-MM-DD for an instant in a time zone. */
export function dayKey(t, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}

const blank = () => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cost: 0, priced: 0 });
function add(total, run) {
  const u = run.usage ?? {};
  total.turns++;
  total.input += Number(u.input) || 0;
  total.output += Number(u.output) || 0;
  total.cacheRead += Number(u.cacheRead) || 0;
  if (Number.isFinite(u.cost)) {
    total.cost += u.cost;
    total.priced++;
  }
}
export const modelOf = (run) => run.usage?.model || run.model?.model || "Unknown";
/** The provider a run's model belongs to, for runs made since a run records it. */
export const providerOf = (run) => (typeof run.model?.provider === "string" ? run.model.provider : "");

/** Runs in the last `days` calendar days, ending today, in `timeZone`. */
export function usageRuns(state, days, now = Date.now(), timeZone) {
  const keys = new Set();
  for (let i = 0; i < days; i++) keys.add(dayKey(now - i * DAY, timeZone));
  // Walk extra hours either side so DST days aren't cut off; the day key decides.
  const earliest = now - (days + 1) * DAY;
  return state.runs.filter((r) => r.time >= earliest && r.time <= now && r.status !== "Working" && keys.has(dayKey(r.time, timeZone)));
}

/** Totals, a by-day series (oldest first, every day present), and by-model and by-bot rows (largest first). */
export function usageReport(state, { days = 30, now = Date.now(), timeZone } = {}) {
  if (![7, 30, 90].includes(days)) throw new Error("Choose 7, 30 or 90 days");
  const runs = usageRuns(state, days, now, timeZone);
  const totals = blank();
  const byDay = new Map();
  for (let i = days - 1; i >= 0; i--) byDay.set(dayKey(now - i * DAY, timeZone), { date: dayKey(now - i * DAY, timeZone), ...blank() });
  const byModel = new Map(),
    byBot = new Map();
  const botOf = new Map(state.chats.map((c) => [c.id, c.botId]));
  for (const run of runs) {
    add(totals, run);
    add(byDay.get(dayKey(run.time, timeZone)), run);
    // Two providers can have a model of the same id; each gets its own row.
    const model = modelOf(run);
    const provider = providerOf(run);
    const key = provider + "\n" + model;
    if (!byModel.has(key)) byModel.set(key, { model, ...(provider && { provider }), ...blank() });
    add(byModel.get(key), run);
    const botId = botOf.get(run.chatId) ?? "";
    if (!byBot.has(botId))
      byBot.set(botId, { botId, name: state.bots.find((b) => b.id === botId)?.name ?? "Deleted bot", ...blank() });
    add(byBot.get(botId), run);
  }
  const order = (a, b) => b.input + b.output - (a.input + a.output) || b.turns - a.turns;
  return {
    days,
    totals,
    byDay: [...byDay.values()],
    byModel: [...byModel.values()].sort(order),
    byBot: [...byBot.values()].sort(order),
  };
}

function cell(v) {
  if (typeof v === "number") return String(v);
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r']/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** One CSV row per turn in the range. Text cells are quoted and guarded against spreadsheet formulas. */
export function usageCsv(state, { days = 30, now = Date.now(), timeZone } = {}) {
  const chats = new Map(state.chats.map((c) => [c.id, c]));
  const rows = [["time", "date", "bot", "chat", "title", "status", "trigger", "model", "input_tokens", "output_tokens", "cache_read_tokens", "cost", "duration_ms", "provider"]];
  for (const run of usageRuns(state, days, now, timeZone).toSorted((a, b) => a.time - b.time)) {
    const chat = chats.get(run.chatId);
    const u = run.usage ?? {};
    rows.push([
      new Date(run.time).toISOString(),
      dayKey(run.time, timeZone),
      state.bots.find((b) => b.id === chat?.botId)?.name ?? "",
      chat?.title ?? "",
      run.title,
      run.status,
      run.trigger ?? "manual",
      modelOf(run),
      u.input ?? "",
      u.output ?? "",
      u.cacheRead ?? "",
      u.cost ?? "",
      u.durationMs ?? "",
      providerOf(run),
    ]);
  }
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}
