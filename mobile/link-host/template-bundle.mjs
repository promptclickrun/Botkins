// The portable additions to a version 2 bot template. Values are copied by allowlist so installed
// skills and routine definitions contain only words and a cadence supplied by the author.
const MAX_ITEMS = 8;
const MAX_BYTES = 64 * 1024;
const BUNDLE_HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const PROTOTYPE_NAMES = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"].map((key) => key.toLowerCase()));

function fields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be an object.`);
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unknown field.`);
}

function words(value, limit, label, multiline = false) {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new Error(`${label} must contain 1 to ${limit} characters.`);
  if (BUNDLE_HIDDEN.test(multiline ? value.replace(/[\t\n]/g, "") : value))
    throw new Error(`${label} contains a control or invisible character.`);
  return value.trim();
}

function skill(value) {
  fields(value, ["name", "description", "instructions"], "Bundled skill");
  const { name } = value;
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ||
      PROTOTYPE_NAMES.has(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name))
    throw new Error("Bundled skill names must be portable names of up to 64 lowercase letters, numbers and dashes.");
  return { name, description: words(value.description, 600, "Skill description"), instructions: words(value.instructions, 12000, "Skill instructions", true) };
}

function routineCadence(value) {
  fields(value, value?.kind === "weekly" ? ["kind", "time", "days"] : ["kind", "time"], "Routine cadence");
  const { kind, time } = value;
  if (!["daily", "weekdays", "weekly"].includes(kind)) throw new Error("Bundle routines use daily, weekdays or weekly cadence.");
  if (typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Routine time must use 24-hour HH:MM.");
  if (kind !== "weekly") return { kind, time };
  const { days } = value;
  if (!Array.isArray(days) || !days.length || days.length > 7 ||
      [...days].some((day) => !Number.isInteger(day) || day < 0 || day > 6) || new Set(days).size !== days.length)
    throw new Error("A weekly routine needs unique day numbers from 0 (Sunday) to 6 (Saturday).");
  return { kind, time, days: [...days].sort((a, b) => a - b) };
}

function routine(value) {
  fields(value, ["name", "instructions", "cadence"], "Bundled routine");
  const name = words(value.name, 80, "Routine name");
  if (/[\\/]/.test(name) || name === "." || name === ".." || PROTOTYPE_NAMES.has(name.toLowerCase()))
    throw new Error("A bundled routine needs a display name without a path or reserved name.");
  const instructions = words(value.instructions, 4000, "Routine instructions", true);
  if (instructions.startsWith("/")) throw new Error("Bundled routine instructions cannot start with a slash command.");
  return { name, instructions, cadence: routineCadence(value.cadence) };
}

function items(list, check, label) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_ITEMS)
    throw new Error(`Template bundle ${label} must contain between 1 and ${MAX_ITEMS} entries.`);
  const entries = Array.from(list, check);
  const names = entries.map(({ name }) => name.normalize("NFKC").toLowerCase());
  if (new Set(names).size !== names.length) throw new Error(`Template bundle ${label} contain a duplicate name.`);
  return entries;
}

/** Checks and copies a portable bundle. An absent bundle keeps the original template format. */
export function templateBundle(input) {
  if (input === undefined) return undefined;
  fields(input, ["skills", "routines"], "Template bundle");
  const bundle = {};
  if (Object.hasOwn(input, "skills")) bundle.skills = items(input.skills, skill, "skills");
  if (Object.hasOwn(input, "routines")) bundle.routines = items(input.routines, routine, "routines");
  if (!bundle.skills && !bundle.routines) throw new Error("A template bundle needs skills or routines.");
  if (Buffer.byteLength(JSON.stringify(bundle), "utf8") > MAX_BYTES) throw new Error("Template bundle exceeds 64 KiB.");
  return bundle;
}

/** Older clients would silently create a plain bot from this detail. */
export function templateForReader(template, version) {
  if (template.bundle && version !== 2) throw new Error("Update Botkins on this device to use templates with bundled skills or routines.");
  return template;
}
