// Health tools, through @kingstinct/react-native-healthkit. iOS never tells an app whether the
// person let it read a kind of data (a refused kind simply reads as empty), so reading is "asked",
// never "granted". Only the kinds `healthRequest` asks for are ever queried.
import type { Access } from "./access";
import { type Args, checkArgs, DeviceError, isoLocal, limitOf, optNumber, optWhen, reqString, reqWhen, spanOf, startOfDay, type When } from "./args";
import { HEALTH_KINDS, HEALTH_LOGS, HEALTH_TYPES, type HealthKind, type HealthLog, healthRequest, SUMMARY_KINDS, workoutName } from "./healthTypes";
import { healthModule, need } from "./native";
import { argsOf } from "./tools";
import { compact, daysOf, fit, minutesBetween, round, SLEEP_STAGES, sleepByDay } from "./shape";

type Quantity = { unit: string; quantity: number };
type Statistics = { startDate?: Date; endDate?: Date; sumQuantity?: Quantity; averageQuantity?: Quantity; mostRecentQuantity?: Quantity };
type Sample = { startDate: Date; endDate: Date; uuid?: string };
type QuantitySample = Sample & { quantity: number; unit: string };
type CategorySample = Sample & { value: number };
type Workout = Sample & { workoutActivityType: number; totalEnergyBurned?: Quantity; totalDistance?: Quantity };
type DateFilter = { filter: { date: { startDate: Date; endDate: Date } } };
type Request = { toRead: string[]; toShare: string[] };

/** The part of the HealthKit module this file uses. Its identifiers are typed as long unions; these are checked by HEALTH_TYPES instead. */
type HealthKit = {
  isHealthDataAvailable(): boolean;
  requestAuthorization(request: Request): Promise<boolean>;
  getRequestStatusForAuthorization(request: Request): Promise<number>;
  authorizationStatusFor(id: string): number;
  queryStatisticsCollectionForQuantity(id: string, statistics: string[], anchor: Date, interval: { day: number }, options: DateFilter & { unit: string }): Promise<readonly Statistics[]>;
  queryQuantitySamples(id: string, options: DateFilter & { limit: number; ascending: boolean; unit: string }): Promise<readonly QuantitySample[]>;
  queryCategorySamples(id: string, options: DateFilter & { limit: number; ascending: boolean }): Promise<readonly CategorySample[]>;
  queryWorkoutSamples(options: DateFilter & { limit: number; ascending: boolean }): Promise<readonly Workout[]>;
  saveQuantitySample(id: string, unit: string, value: number, start: Date, end: Date): Promise<{ uuid?: string } | undefined>;
  saveCategorySample(id: string, value: number, start: Date, end: Date): Promise<{ uuid?: string } | undefined>;
};

// HealthKit's own numbers (AuthorizationRequestStatus, AuthorizationStatus).
const SHOULD_REQUEST = 1;
const SHARING_AUTHORIZED = 2;
const SHARING_DENIED = 1;

function kit(): HealthKit | null {
  const module = healthModule();
  return module ? (module as unknown as HealthKit) : null;
}

function available(): HealthKit {
  const Health = need(kit);
  if (!Health.isHealthDataAvailable()) throw new DeviceError("Health isn't available on this device.");
  return Health;
}

export async function healthAccess(level: "read" | "interact"): Promise<Access> {
  const Health = kit();
  if (!Health) return { state: "unavailable" };
  if (!Health.isHealthDataAvailable()) return { state: "unavailable", reason: "Health isn't available on this device." };
  const request = healthRequest(level);
  if ((await Health.getRequestStatusForAuthorization(request)) === SHOULD_REQUEST) return { state: "undetermined" };
  if (!request.toShare.length) return { state: "asked" };
  // Writing is the one thing iOS does tell.
  const shared = request.toShare.map((id) => Health.authorizationStatusFor(id));
  if (shared.every((status) => status === SHARING_DENIED)) return { state: "denied" };
  return { state: shared.every((status) => status === SHARING_AUTHORIZED) ? "asked" : "limited" };
}

export async function askHealth(level: "read" | "interact"): Promise<Access> {
  const Health = kit();
  if (!Health) return { state: "unavailable" };
  if (!Health.isHealthDataAvailable()) return { state: "unavailable", reason: "Health isn't available on this device." };
  await Health.requestAuthorization(healthRequest(level));
  return healthAccess(level);
}

/** Reading is set up: iOS was asked for every kind a bot may read. */
async function ready(): Promise<HealthKit> {
  const Health = available();
  if ((await Health.getRequestStatusForAuthorization(healthRequest("read"))) === SHOULD_REQUEST) throw new DeviceError("Health access isn't set up yet. The person can turn Health on again in Botkins on their phone.");
  return Health;
}

const dateFilter = (start: Date, end: Date): DateFilter => ({ filter: { date: { startDate: start, endDate: end } } });

/** A span from optional `from` and `to`: today when neither is given. */
function optionalSpan(args: Args, maxDays: number) {
  const now = new Date();
  const from = optWhen(args, "from");
  const to = optWhen(args, "to");
  const start: When = from ?? { date: startOfDay(to?.date ?? now), dateOnly: true };
  const end: When = to ?? { date: now, dateOnly: false };
  return spanOf(start, end, maxDays);
}

/** A workout's energy in kcal and distance in km, from whatever unit HealthKit gave. */
function kcal(quantity: Quantity | undefined) {
  if (!quantity) return undefined;
  const unit = quantity.unit.toLowerCase();
  return round(unit === "kj" ? quantity.quantity / 4.184 : quantity.quantity, 0);
}
function km(quantity: Quantity | undefined) {
  if (!quantity) return undefined;
  const unit = quantity.unit.toLowerCase();
  return round(unit === "m" ? quantity.quantity / 1000 : unit === "mi" ? quantity.quantity * 1.609344 : quantity.quantity, 2);
}

function workoutOf(workout: Workout) {
  return compact({
    activity: workoutName(workout.workoutActivityType),
    start: isoLocal(workout.startDate),
    end: isoLocal(workout.endDate),
    minutes: round(minutesBetween(workout.startDate, workout.endDate), 0),
    energyKcal: kcal(workout.totalEnergyBurned),
    distanceKm: km(workout.totalDistance),
  });
}

/** One figure a day for a quantity, by the day each interval starts on. */
async function daily(Health: HealthKit, kind: HealthKind, start: Date, end: Date): Promise<Record<string, number>> {
  const type = HEALTH_TYPES[kind];
  if (type.kind !== "quantity") return {};
  const statistic = type.daily === "sum" ? "cumulativeSum" : type.daily === "average" ? "discreteAverage" : "mostRecent";
  const rows = await Health.queryStatisticsCollectionForQuantity(type.id, [statistic], startOfDay(start), { day: 1 }, { ...dateFilter(start, end), unit: type.unit });
  const out: Record<string, number> = {};
  for (const row of rows) {
    const quantity = type.daily === "sum" ? row.sumQuantity : type.daily === "average" ? row.averageQuantity : row.mostRecentQuantity;
    if (!row.startDate || !quantity || !Number.isFinite(quantity.quantity)) continue;
    if (type.daily === "sum" && quantity.quantity === 0) continue;
    const key = isoLocal(row.startDate).slice(0, 10);
    out[key] = round(quantity.quantity * (type.scale ?? 1), type.unit === "count" ? 0 : 1);
  }
  return out;
}

const SUMMARY_KEYS: Partial<Record<HealthKind, string>> = {
  steps: "steps",
  distance: "distanceKm",
  activeEnergy: "activeEnergyKcal",
  exerciseMinutes: "exerciseMinutes",
  heartRate: "heartRateAvgBpm",
  restingHeartRate: "restingHeartRateBpm",
  weight: "weightKg",
};

async function summary(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_health_summary"));
  const { start, end } = optionalSpan(args, 93);
  const Health = await ready();
  const days = daysOf(start, end);
  const figures: Record<string, Record<string, unknown>> = {};
  for (const day of days) figures[day.key] = { date: day.key };
  // Each kind on its own, so one the person didn't allow (it reads as empty) or that fails leaves the rest.
  const quietly = <T,>(work: Promise<T>, fallback: T) => work.catch(() => fallback);
  const quantities = SUMMARY_KINDS.filter((kind) => SUMMARY_KEYS[kind]);
  const [values, sleep, workouts] = await Promise.all([
    Promise.all(quantities.map((kind) => quietly(daily(Health, kind, start, end), {}))),
    // A night that ends on the first day started the evening before.
    quietly(Health.queryCategorySamples(HEALTH_TYPES.sleep.id, { ...dateFilter(new Date(start.getTime() - 18 * 3_600_000), end), limit: 20_000, ascending: true }), []),
    quietly(Health.queryWorkoutSamples({ ...dateFilter(start, end), limit: 500, ascending: true }), []),
  ]);
  quantities.forEach((kind, index) => {
    for (const [key, value] of Object.entries(values[index])) if (figures[key]) figures[key][SUMMARY_KEYS[kind]!] = value;
  });
  for (const [key, hours] of Object.entries(sleepByDay(sleep.map((sample) => ({ start: sample.startDate, end: sample.endDate, value: sample.value }))))) if (figures[key]) figures[key].sleepHours = hours;
  for (const workout of workouts) {
    const key = isoLocal(workout.startDate).slice(0, 10);
    if (figures[key]) ((figures[key].workouts as unknown[]) ??= []).push(workoutOf(workout));
  }
  return fit(
    {
      from: isoLocal(start),
      to: isoLocal(end),
      days: days.map((day) => figures[day.key]),
      note: "Sums for steps, distance, energy and exercise; averages for heart rate; the latest weight; sleep is the night that ends on that day.",
    },
    "days",
  );
}

async function samples(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_health_samples"));
  const kind = reqString(args, "type", 40) as HealthKind;
  if (!HEALTH_KINDS.includes(kind)) throw new DeviceError("`type` must be one of: " + HEALTH_KINDS.join(", ") + ".");
  const { start, end } = spanOf(reqWhen(args, "from"), reqWhen(args, "to"), 400);
  const limit = limitOf(args, 100, 500);
  const Health = await ready();
  const type = HEALTH_TYPES[kind];
  const options = { ...dateFilter(start, end), limit: limit + 1, ascending: false };
  let list: Record<string, unknown>[];
  let unit = type.shown;
  if (type.kind === "quantity") {
    const found = await Health.queryQuantitySamples(type.id, { ...options, unit: type.unit });
    list = found.map((sample) => compact({ start: isoLocal(sample.startDate), end: sample.endDate.getTime() !== sample.startDate.getTime() ? isoLocal(sample.endDate) : undefined, value: round(sample.quantity * (type.scale ?? 1), 2) }));
  } else if (type.kind === "workout") {
    list = (await Health.queryWorkoutSamples(options)).map(workoutOf);
    unit = "workouts";
  } else {
    const found = await Health.queryCategorySamples(type.id, options);
    list = found.map((sample) => {
      const base = { start: isoLocal(sample.startDate), end: isoLocal(sample.endDate) };
      if (kind === "sleep") return { ...base, stage: SLEEP_STAGES[sample.value] ?? "unknown" };
      if (kind === "standHours") return { ...base, stood: sample.value === 0 };
      return { ...base, minutes: minutesBetween(sample.startDate, sample.endDate) };
    });
  }
  const more = list.length > limit;
  return fit({ type: kind, unit, samples: list.slice(0, limit), ...(more && { more: true }) }, "samples");
}

const LOG_UNITS: Record<HealthLog, string> = { water: "mL", weight: "kg", caffeine: "mg", mindfulMinutes: "min", bodyFat: "percent" };

async function log(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_health_log"));
  const kind = reqString(args, "type", 40) as HealthLog;
  if (!Object.prototype.hasOwnProperty.call(HEALTH_LOGS, kind)) throw new DeviceError("`type` must be one of: " + Object.keys(HEALTH_LOGS).join(", ") + ".");
  const range = HEALTH_LOGS[kind];
  const value = optNumber(args, "value", range);
  if (value === undefined) throw new DeviceError("`value` is needed.");
  const at = optWhen(args, "at")?.date ?? new Date();
  if (at.getTime() > Date.now() + 5 * 60_000) throw new DeviceError("`at` can't be in the future.");
  const Health = available();
  const type = HEALTH_TYPES[kind];
  if (Health.authorizationStatusFor(type.id) !== SHARING_AUTHORIZED) throw new DeviceError("Botkins isn't allowed to write this to Health. The person can allow it in the Health app, under Sharing › Apps › Botkins.");
  let saved: { uuid?: string } | undefined;
  if (type.kind === "category") {
    // A mindful session ends at `at`.
    saved = await Health.saveCategorySample(type.id, 0, new Date(at.getTime() - value * 60_000), at);
  } else if (type.kind === "quantity") {
    saved = await Health.saveQuantitySample(type.id, type.unit, value / (type.scale ?? 1), at, at);
  }
  return compact({ saved: true, id: saved?.uuid, type: kind, value, unit: LOG_UNITS[kind], at: isoLocal(at) });
}

export const healthTools = {
  phone_health_summary: summary,
  phone_health_samples: samples,
  phone_health_log: log,
};

