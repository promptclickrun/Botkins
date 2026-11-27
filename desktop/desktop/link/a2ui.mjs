// A2UI 1.0 protocol validation, surface state management, data-binding / function evaluation,
// and plain-text fallback extraction.
//
// Spec: https://a2ui.org/specification/v1.0-a2ui/
// Catalog: https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json
//
// Kept pure & dependency-free so the host, desktop renderer, mobile renderer, and tests share
// identical validation, JSON Pointer resolution, catalog checks, and fallback semantics.

export const A2UI_VERSION = "1.0";
export const A2UI_BASIC_CATALOG_ID = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";

export const A2UI_LIMITS = {
  maxMessagesPerCall: 32,
  maxSurfacesPerMessage: 4,
  maxSurfacesPerTurn: 4,
  maxComponents: 150,
  maxComponentIdLength: 128,
  maxSurfaceIdLength: 128,
  maxPayloadBytes: 96 * 1024,
  maxDataModelBytes: 48 * 1024,
  maxDataModelDepth: 12,
  maxStringLength: 8000,
  maxArrayLength: 100,
  maxActionContextBytes: 16 * 1024,
  maxActedRecords: 64,
};

export const A2UI_BASIC_COMPONENTS = new Set([
  "Text",
  "Image",
  "Icon",
  "Video",
  "AudioPlayer",
  "Row",
  "Column",
  "List",
  "Card",
  "Tabs",
  "Modal",
  "Divider",
  "Button",
  "TextField",
  "CheckBox",
  "ChoicePicker",
  "Slider",
  "DateTimeInput",
]);

export const A2UI_BASIC_ICONS = new Set([
  "accountCircle", "add", "arrowBack", "arrowForward", "attachFile", "calendarToday",
  "call", "camera", "check", "close", "delete", "download", "edit", "event", "error",
  "fastForward", "favorite", "favoriteOff", "folder", "help", "home", "info",
  "locationOn", "lock", "lockOpen", "mail", "menu", "moreVert", "moreHoriz",
  "notificationsOff", "notifications", "pause", "payment", "person", "phone", "photo",
  "play", "print", "refresh", "rewind", "search", "send", "settings", "share",
  "shoppingCart", "skipNext", "skipPrevious", "star", "starHalf", "starOff", "stop",
  "upload", "visibility", "visibilityOff", "volumeDown", "volumeMute", "volumeOff",
  "volumeUp", "warning",
]);

export const A2UI_BASIC_FUNCTIONS = new Set([
  "required",
  "regex",
  "length",
  "numeric",
  "email",
  "formatString",
  "formatNumber",
  "formatCurrency",
  "formatDate",
  "pluralize",
  "openUrl",
  "and",
  "or",
  "not",
  "@index",
]);

const BUILTIN_ACTION_NAMES = new Set(["dispatch", "dismiss"]);
const UAX31_IDENT_RE = /^[\p{XID_Start}_][\p{XID_Continue}]*$/u;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function byteSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return JSON.stringify(value).length;
  }
}

/** Checks that a URL is safe for external openLink or media display (http/https only; images may also allow safe data:image/*). */
export function isSafeA2uiUrl(raw, { allowDataImage = false } = {}) {
  if (typeof raw !== "string") return false;
  const s = raw.trim();
  if (!s || s.length > 4096 || /[\u0000-\u001f]/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (allowDataImage && /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(s)) return true;
  return false;
}

/** Sanitizes a JSON value recursively, rejecting prototype-pollution keys and excessive depth. */
export function sanitizeJsonValue(value, depth = 0) {
  if (depth > A2UI_LIMITS.maxDataModelDepth) throw new Error("A2UI data exceeds maximum nesting depth.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("A2UI numbers must be finite.");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > A2UI_LIMITS.maxStringLength) throw new Error("A2UI string exceeds maximum length.");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > A2UI_LIMITS.maxArrayLength) throw new Error("A2UI array exceeds maximum length.");
    return value.map((item) => sanitizeJsonValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const out = {};
    const entries = Object.entries(value);
    if (entries.length > A2UI_LIMITS.maxArrayLength) throw new Error("A2UI object exceeds maximum property count.");
    for (const [k, v] of entries) {
      if (FORBIDDEN_KEYS.has(k)) throw new Error(`Forbidden property name "${k}".`);
      if (k.length > 128) throw new Error("Property name too long.");
      if (v !== undefined) out[k] = sanitizeJsonValue(v, depth + 1);
    }
    return out;
  }
  throw new Error("Unsupported value type in A2UI payload.");
}

function validateExtensions(ext, where) {
  if (ext === undefined) return;
  if (!isPlainObject(ext)) throw new Error(`${where} extensions must be an object.`);
  for (const key of Object.keys(ext)) {
    if (!UAX31_IDENT_RE.test(key) || FORBIDDEN_KEYS.has(key)) {
      throw new Error(`${where} extension key "${key}" must be a valid identifier.`);
    }
  }
}

function validateDataBinding(v, where) {
  if (!isPlainObject(v) || typeof v["@path"] !== "string" || !v["@path"].length || Object.keys(v).length !== 1) {
    throw new Error(`${where} must be a valid {"@path": "..."} binding.`);
  }
}

function validateFunctionCall(v, where, depth = 0) {
  if (depth > 8) throw new Error(`${where} function nesting exceeds limit.`);
  if (!isPlainObject(v) || typeof v["@call"] !== "string" || !v["@call"].trim()) {
    throw new Error(`${where} must have a non-empty "@call" function name.`);
  }
  const allowed = new Set(["@call", "catalogId", "args"]);
  for (const key of Object.keys(v)) {
    if (!allowed.has(key)) throw new Error(`${where} has unknown function property "${key}".`);
  }
  if (v.catalogId !== undefined && typeof v.catalogId !== "string") {
    throw new Error(`${where}.catalogId must be a string.`);
  }
  if (v.args !== undefined) {
    if (!isPlainObject(v.args)) throw new Error(`${where}.args must be an object.`);
    for (const [ak, av] of Object.entries(v.args)) {
      if (FORBIDDEN_KEYS.has(ak)) throw new Error(`Forbidden arg name "${ak}".`);
      if (isPlainObject(av) && "@call" in av) validateFunctionCall(av, `${where}.args.${ak}`, depth + 1);
      else if (isPlainObject(av) && "@path" in av) validateDataBinding(av, `${where}.args.${ak}`);
      else if (Array.isArray(av)) {
        av.forEach((item, idx) => {
          if (isPlainObject(item) && "@call" in item) validateFunctionCall(item, `${where}.args.${ak}[${idx}]`, depth + 1);
          else if (isPlainObject(item) && "@path" in item) validateDataBinding(item, `${where}.args.${ak}[${idx}]`);
        });
      }
    }
  }
}

function validateDynamic(v, kind, where) {
  if (isPlainObject(v)) {
    if ("@path" in v) {
      validateDataBinding(v, where);
      return;
    }
    if ("@call" in v) {
      validateFunctionCall(v, where);
      return;
    }
    if (kind === "any") {
      for (const key of Object.keys(v)) {
        if (/^@([^@]|$)/.test(key)) throw new Error(`${where} cannot use reserved @-prefixed key "${key}".`);
      }
      return;
    }
    throw new Error(`${where} must be a ${kind}, {"@path": "..."}, or {"@call": "..."}.`);
  }
  if (kind === "string" && typeof v === "string") {
    if (v.length > A2UI_LIMITS.maxStringLength) throw new Error(`${where} string exceeds maximum length.`);
    return;
  }
  if (kind === "number" && typeof v === "number" && Number.isFinite(v)) return;
  if (kind === "boolean" && typeof v === "boolean") return;
  if (kind === "stringList" && Array.isArray(v) && v.every((s) => typeof s === "string")) return;
  if (kind === "any" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || Array.isArray(v))) return;
  throw new Error(`${where} must be a ${kind}, {"@path": "..."}, or {"@call": "..."}.`);
}

function validateChildList(v, where) {
  if (Array.isArray(v)) {
    if (v.length > A2UI_LIMITS.maxComponents) throw new Error(`${where} exceeds component limit.`);
    for (const id of v) {
      if (typeof id !== "string" || !id.trim()) throw new Error(`${where} entries must be non-empty component IDs.`);
    }
    return;
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length !== 2 || typeof v.componentId !== "string" || !v.componentId.trim() || typeof v.path !== "string" || !v.path.trim()) {
      throw new Error(`${where} template must specify only "componentId" and "path" strings.`);
    }
    return;
  }
  throw new Error(`${where} must be an array of component IDs or a {componentId, path} template.`);
}

function validateAccessibility(a11y, where) {
  if (a11y === undefined) return;
  if (!isPlainObject(a11y)) throw new Error(`${where}.@accessibility must be an object.`);
  const allowed = new Set(["label", "description", "live", "hidden"]);
  for (const key of Object.keys(a11y)) {
    if (!allowed.has(key)) throw new Error(`${where}.@accessibility has unknown property "${key}".`);
  }
  if (a11y.label !== undefined) validateDynamic(a11y.label, "string", `${where}.@accessibility.label`);
  if (a11y.description !== undefined) validateDynamic(a11y.description, "string", `${where}.@accessibility.description`);
  if (a11y.live !== undefined && !["off", "polite", "assertive"].includes(a11y.live)) {
    throw new Error(`${where}.@accessibility.live must be "off", "polite", or "assertive".`);
  }
  if (a11y.hidden !== undefined) validateDynamic(a11y.hidden, "boolean", `${where}.@accessibility.hidden`);
}

function validateChecks(checks, where) {
  if (checks === undefined) return;
  if (!Array.isArray(checks) || checks.length > 20) throw new Error(`${where}.@checks must be an array (max 20).`);
  for (const [i, rule] of checks.entries()) {
    if (!isPlainObject(rule) || !rule.condition) throw new Error(`${where}.@checks[${i}] needs a condition.`);
    const keys = Object.keys(rule);
    if (keys.some((k) => k !== "condition" && k !== "message")) {
      throw new Error(`${where}.@checks[${i}] has unknown property.`);
    }
    if (isPlainObject(rule.condition) && "@path" in rule.condition) {
      validateDataBinding(rule.condition, `${where}.@checks[${i}].condition`);
    } else if (isPlainObject(rule.condition) && "@call" in rule.condition) {
      validateFunctionCall(rule.condition, `${where}.@checks[${i}].condition`);
    } else {
      throw new Error(`${where}.@checks[${i}].condition must be a DataBinding or FunctionCall.`);
    }
    if (rule.message !== undefined && typeof rule.message !== "string") {
      throw new Error(`${where}.@checks[${i}].message must be a string.`);
    }
  }
}

function validateAction(action, where) {
  if (!isPlainObject(action)) throw new Error(`${where}.action must be an object.`);
  const keys = Object.keys(action);
  if (keys.length !== 1 || (keys[0] !== "event" && keys[0] !== "functionCall")) {
    throw new Error(`${where}.action must contain exactly one of "event" or "functionCall".`);
  }
  if (action.event !== undefined) {
    const ev = action.event;
    if (!isPlainObject(ev) || typeof ev.name !== "string" || !ev.name.trim()) {
      throw new Error(`${where}.action.event requires a non-empty string "name".`);
    }
    for (const k of Object.keys(ev)) {
      if (!["name", "userMessage", "context"].includes(k)) {
        throw new Error(`${where}.action.event has unknown property "${k}".`);
      }
    }
    if (ev.userMessage !== undefined) validateDynamic(ev.userMessage, "string", `${where}.action.event.userMessage`);
    if (ev.context !== undefined) {
      if (!isPlainObject(ev.context)) throw new Error(`${where}.action.event.context must be an object.`);
      for (const [ck, cv] of Object.entries(ev.context)) {
        if (FORBIDDEN_KEYS.has(ck)) throw new Error(`Forbidden context key "${ck}".`);
        validateDynamic(cv, "any", `${where}.action.event.context.${ck}`);
      }
    }
  } else {
    validateFunctionCall(action.functionCall, `${where}.action.functionCall`);
  }
}

const COMMON_PROPS = new Set(["id", "component", "@catalogId", "@accessibility", "@metadata", "weight"]);
const CHECKABLE_COMPONENTS = new Set(["Button", "TextField", "CheckBox", "ChoicePicker", "Slider", "DateTimeInput"]);

const COMPONENT_ALLOWED_PROPS = {
  Text: new Set([...COMMON_PROPS, "text", "variant"]),
  Image: new Set([...COMMON_PROPS, "url", "description", "fit", "variant"]),
  Icon: new Set([...COMMON_PROPS, "name"]),
  Video: new Set([...COMMON_PROPS, "url", "posterUrl"]),
  AudioPlayer: new Set([...COMMON_PROPS, "url", "description"]),
  Row: new Set([...COMMON_PROPS, "children", "justify", "align"]),
  Column: new Set([...COMMON_PROPS, "children", "justify", "align"]),
  List: new Set([...COMMON_PROPS, "children", "direction", "align"]),
  Card: new Set([...COMMON_PROPS, "child"]),
  Tabs: new Set([...COMMON_PROPS, "tabs"]),
  Modal: new Set([...COMMON_PROPS, "trigger", "content"]),
  Divider: new Set([...COMMON_PROPS, "axis"]),
  Button: new Set([...COMMON_PROPS, "@checks", "child", "variant", "action"]),
  TextField: new Set([...COMMON_PROPS, "@checks", "label", "value", "placeholder", "variant"]),
  CheckBox: new Set([...COMMON_PROPS, "@checks", "label", "value"]),
  ChoicePicker: new Set([...COMMON_PROPS, "@checks", "label", "variant", "options", "value", "displayStyle", "filterable"]),
  Slider: new Set([...COMMON_PROPS, "@checks", "label", "min", "max", "value", "steps"]),
  DateTimeInput: new Set([...COMMON_PROPS, "@checks", "value", "enableDate", "enableTime", "min", "max", "label"]),
};

const JUSTIFY_VALUES = new Set(["start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly", "stretch"]);
const ALIGN_VALUES = new Set(["start", "center", "end", "stretch"]);

/**
 * Validates one A2UI v1.0 component against common_types.json and the Basic Catalog.
 * Unknown components: rejected if `allowUnknownComponents` is false (default: false for basic catalog,
 * or allowed as placeholder if `allowUnknownComponents: true`).
 */
export function validateA2uiComponent(raw, index, { allowUnknownComponents = false } = {}) {
  const where = `components[${index}]`;
  if (!isPlainObject(raw)) throw new Error(`${where} must be an object.`);
  const comp = sanitizeJsonValue(raw);
  if (typeof comp.id !== "string" || !comp.id.trim() || comp.id.length > A2UI_LIMITS.maxComponentIdLength) {
    throw new Error(`${where}.id must be a non-empty string (max ${A2UI_LIMITS.maxComponentIdLength} chars).`);
  }
  if (typeof comp.component !== "string" || !comp.component.trim()) {
    throw new Error(`${where}.component must be a non-empty string.`);
  }
  if (comp.component === "Surface") {
    throw new Error(`${where}.component cannot be "Surface" (the Surface container is implicit in v1.0).`);
  }
  if (comp["@catalogId"] !== undefined && typeof comp["@catalogId"] !== "string") {
    throw new Error(`${where}.@catalogId must be a string.`);
  }
  if (comp["@metadata"] !== undefined) {
    if (!isPlainObject(comp["@metadata"])) throw new Error(`${where}.@metadata must be an object.`);
    for (const k of Object.keys(comp["@metadata"])) {
      if (k !== "extensions") throw new Error(`${where}.@metadata has unknown property "${k}".`);
    }
    validateExtensions(comp["@metadata"].extensions, `${where}.@metadata`);
  }
  validateAccessibility(comp["@accessibility"], where);
  if (comp.weight !== undefined && (typeof comp.weight !== "number" || !Number.isFinite(comp.weight) || comp.weight < 0)) {
    throw new Error(`${where}.weight must be a nonnegative number.`);
  }

  const type = comp.component;
  if (!A2UI_BASIC_COMPONENTS.has(type)) {
    if (!allowUnknownComponents) {
      throw new Error(`${where} uses unsupported component "${type}". Supported Basic Catalog components: ${[...A2UI_BASIC_COMPONENTS].join(", ")}.`);
    }
    return comp;
  }

  const allowed = COMPONENT_ALLOWED_PROPS[type];
  for (const key of Object.keys(comp)) {
    if (!allowed.has(key)) throw new Error(`${where} (${type}) has unknown property "${key}".`);
  }
  if (CHECKABLE_COMPONENTS.has(type)) validateChecks(comp["@checks"], where);

  switch (type) {
    case "Text":
      if (comp.text === undefined) throw new Error(`${where} (Text) requires "text".`);
      validateDynamic(comp.text, "string", `${where}.text`);
      if (comp.variant !== undefined && !["caption", "body", "h1", "h2", "h3", "h4", "h5"].includes(comp.variant)) {
        throw new Error(`${where} (Text) invalid variant "${comp.variant}".`);
      }
      break;
    case "Image":
      if (comp.url === undefined) throw new Error(`${where} (Image) requires "url".`);
      validateDynamic(comp.url, "string", `${where}.url`);
      if (comp.description !== undefined) validateDynamic(comp.description, "string", `${where}.description`);
      if (comp.fit !== undefined && !["contain", "cover", "fill", "none", "scaleDown"].includes(comp.fit)) {
        throw new Error(`${where} (Image) invalid fit "${comp.fit}".`);
      }
      if (comp.variant !== undefined && !["icon", "avatar", "smallFeature", "mediumFeature", "largeFeature", "header"].includes(comp.variant)) {
        throw new Error(`${where} (Image) invalid variant "${comp.variant}".`);
      }
      break;
    case "Icon":
      if (comp.name === undefined) throw new Error(`${where} (Icon) requires "name".`);
      if (typeof comp.name === "string") {
        if (!comp.name.trim()) throw new Error(`${where} (Icon) name cannot be empty.`);
      } else if (isPlainObject(comp.name) && typeof comp.name.path === "string" && Object.keys(comp.name).length === 1) {
        // Custom SVG path object per catalog spec
      } else {
        validateDynamic(comp.name, "string", `${where}.name`);
      }
      break;
    case "Video":
      if (comp.url === undefined) throw new Error(`${where} (Video) requires "url".`);
      validateDynamic(comp.url, "string", `${where}.url`);
      if (comp.posterUrl !== undefined) validateDynamic(comp.posterUrl, "string", `${where}.posterUrl`);
      break;
    case "AudioPlayer":
      if (comp.url === undefined) throw new Error(`${where} (AudioPlayer) requires "url".`);
      validateDynamic(comp.url, "string", `${where}.url`);
      if (comp.description !== undefined) validateDynamic(comp.description, "string", `${where}.description`);
      break;
    case "Row":
    case "Column":
      if (comp.children === undefined) throw new Error(`${where} (${type}) requires "children".`);
      validateChildList(comp.children, `${where}.children`);
      if (comp.justify !== undefined && !JUSTIFY_VALUES.has(comp.justify)) {
        throw new Error(`${where} (${type}) invalid justify "${comp.justify}".`);
      }
      if (comp.align !== undefined && !ALIGN_VALUES.has(comp.align)) {
        throw new Error(`${where} (${type}) invalid align "${comp.align}".`);
      }
      break;
    case "List":
      if (comp.children === undefined) throw new Error(`${where} (List) requires "children".`);
      validateChildList(comp.children, `${where}.children`);
      if (comp.direction !== undefined && !["vertical", "horizontal"].includes(comp.direction)) {
        throw new Error(`${where} (List) invalid direction "${comp.direction}".`);
      }
      if (comp.align !== undefined && !ALIGN_VALUES.has(comp.align)) {
        throw new Error(`${where} (List) invalid align "${comp.align}".`);
      }
      break;
    case "Card":
      if (typeof comp.child !== "string" || !comp.child.trim()) throw new Error(`${where} (Card) requires "child" component ID.`);
      break;
    case "Tabs":
      if (!Array.isArray(comp.tabs) || !comp.tabs.length || comp.tabs.length > 20) {
        throw new Error(`${where} (Tabs) requires a non-empty "tabs" array (max 20).`);
      }
      comp.tabs.forEach((tab, ti) => {
        if (!isPlainObject(tab) || tab.title === undefined || typeof tab.child !== "string" || !tab.child.trim()) {
          throw new Error(`${where}.tabs[${ti}] requires "title" and "child".`);
        }
        if (Object.keys(tab).some((k) => k !== "title" && k !== "child")) {
          throw new Error(`${where}.tabs[${ti}] has unknown property.`);
        }
        validateDynamic(tab.title, "string", `${where}.tabs[${ti}].title`);
      });
      break;
    case "Modal":
      if (typeof comp.trigger !== "string" || !comp.trigger.trim()) throw new Error(`${where} (Modal) requires "trigger" component ID.`);
      if (typeof comp.content !== "string" || !comp.content.trim()) throw new Error(`${where} (Modal) requires "content" component ID.`);
      break;
    case "Divider":
      if (comp.axis !== undefined && !["horizontal", "vertical"].includes(comp.axis)) {
        throw new Error(`${where} (Divider) invalid axis "${comp.axis}".`);
      }
      break;
    case "Button":
      if (typeof comp.child !== "string" || !comp.child.trim()) throw new Error(`${where} (Button) requires "child" component ID.`);
      if (comp.variant !== undefined && !["default", "primary", "borderless"].includes(comp.variant)) {
        throw new Error(`${where} (Button) invalid variant "${comp.variant}".`);
      }
      if (comp.action === undefined) throw new Error(`${where} (Button) requires "action".`);
      validateAction(comp.action, where);
      break;
    case "TextField":
      if (comp.label === undefined) throw new Error(`${where} (TextField) requires "label".`);
      validateDynamic(comp.label, "string", `${where}.label`);
      if (comp.value === undefined) throw new Error(`${where} (TextField) requires "value".`);
      validateDynamic(comp.value, "string", `${where}.value`);
      if (comp.placeholder !== undefined) validateDynamic(comp.placeholder, "string", `${where}.placeholder`);
      if (comp.variant !== undefined && !["longText", "number", "shortText", "obscured"].includes(comp.variant)) {
        throw new Error(`${where} (TextField) invalid variant "${comp.variant}".`);
      }
      break;
    case "CheckBox":
      if (comp.label === undefined) throw new Error(`${where} (CheckBox) requires "label".`);
      validateDynamic(comp.label, "string", `${where}.label`);
      if (comp.value === undefined) throw new Error(`${where} (CheckBox) requires "value".`);
      validateDynamic(comp.value, "boolean", `${where}.value`);
      break;
    case "ChoicePicker":
      if (comp.label !== undefined) validateDynamic(comp.label, "string", `${where}.label`);
      if (comp.variant !== undefined && !["multipleSelection", "mutuallyExclusive"].includes(comp.variant)) {
        throw new Error(`${where} (ChoicePicker) invalid variant "${comp.variant}".`);
      }
      if (!Array.isArray(comp.options) || !comp.options.length || comp.options.length > 60) {
        throw new Error(`${where} (ChoicePicker) requires a non-empty "options" array (max 60).`);
      }
      comp.options.forEach((opt, oi) => {
        if (!isPlainObject(opt) || opt.label === undefined || typeof opt.value !== "string") {
          throw new Error(`${where}.options[${oi}] requires "label" and string "value".`);
        }
        if (Object.keys(opt).some((k) => k !== "label" && k !== "value")) {
          throw new Error(`${where}.options[${oi}] has unknown property.`);
        }
        validateDynamic(opt.label, "string", `${where}.options[${oi}].label`);
      });
      if (comp.value === undefined) throw new Error(`${where} (ChoicePicker) requires "value".`);
      validateDynamic(comp.value, "stringList", `${where}.value`);
      if (comp.displayStyle !== undefined && !["checkbox", "chips"].includes(comp.displayStyle)) {
        throw new Error(`${where} (ChoicePicker) invalid displayStyle "${comp.displayStyle}".`);
      }
      if (comp.filterable !== undefined && typeof comp.filterable !== "boolean") {
        throw new Error(`${where} (ChoicePicker) filterable must be a boolean.`);
      }
      break;
    case "Slider":
      if (comp.label !== undefined) validateDynamic(comp.label, "string", `${where}.label`);
      if (comp.min !== undefined && (typeof comp.min !== "number" || !Number.isFinite(comp.min))) {
        throw new Error(`${where} (Slider) min must be a finite number.`);
      }
      if (typeof comp.max !== "number" || !Number.isFinite(comp.max)) {
        throw new Error(`${where} (Slider) requires finite number "max".`);
      }
      if (comp.min !== undefined && comp.max <= comp.min) {
        throw new Error(`${where} (Slider) max must be greater than min.`);
      }
      if (comp.value === undefined) throw new Error(`${where} (Slider) requires "value".`);
      validateDynamic(comp.value, "number", `${where}.value`);
      if (comp.steps !== undefined && (!Number.isInteger(comp.steps) || comp.steps < 1)) {
        throw new Error(`${where} (Slider) steps must be a positive integer.`);
      }
      break;
    case "DateTimeInput":
      if (comp.value === undefined) throw new Error(`${where} (DateTimeInput) requires "value".`);
      validateDynamic(comp.value, "string", `${where}.value`);
      if (comp.label !== undefined) validateDynamic(comp.label, "string", `${where}.label`);
      if (comp.enableDate !== undefined && typeof comp.enableDate !== "boolean") {
        throw new Error(`${where} (DateTimeInput) enableDate must be a boolean.`);
      }
      if (comp.enableTime !== undefined && typeof comp.enableTime !== "boolean") {
        throw new Error(`${where} (DateTimeInput) enableTime must be a boolean.`);
      }
      if (comp.min !== undefined) validateDynamic(comp.min, "string", `${where}.min`);
      if (comp.max !== undefined) validateDynamic(comp.max, "string", `${where}.max`);
      break;
  }

  return comp;
}

const ENVELOPE_KINDS = [
  "createSurface",
  "updateComponents",
  "updateDataModel",
  "deleteSurface",
  "callRendererFunction",
  "agentFunctionResponse",
];

/** Validates a single A2UI v1.0 agent-to-renderer envelope message. */
export function validateA2uiMessage(raw, options = {}) {
  if (!isPlainObject(raw)) throw new Error("Each A2UI message must be a JSON object.");
  if (raw.version !== A2UI_VERSION) {
    throw new Error(`Unsupported A2UI version "${raw.version ?? ""}". Expected "1.0".`);
  }
  const keys = Object.keys(raw).filter((k) => k !== "version");
  if (keys.length !== 1 || !ENVELOPE_KINDS.includes(keys[0])) {
    throw new Error(`A2UI message must contain "version": "1.0" and exactly one of: ${ENVELOPE_KINDS.join(", ")}.`);
  }
  const kind = keys[0];
  const body = raw[kind];
  if (!isPlainObject(body)) throw new Error(`A2UI ${kind} payload must be an object.`);

  if (kind === "createSurface") {
    if ("theme" in body) {
      throw new Error('A2UI v1.0 createSurface must not include "theme" (Botkins styles surfaces with its own theme tokens).');
    }
    const allowed = new Set(["surfaceId", "catalogId", "sendDataModel", "components", "dataModel", "metadata"]);
    for (const k of Object.keys(body)) {
      if (!allowed.has(k)) throw new Error(`A2UI createSurface has unknown property "${k}".`);
    }
    if (typeof body.surfaceId !== "string" || !body.surfaceId.trim() || body.surfaceId.length > A2UI_LIMITS.maxSurfaceIdLength) {
      throw new Error(`createSurface.surfaceId must be a non-empty string (max ${A2UI_LIMITS.maxSurfaceIdLength} chars).`);
    }
    if (body.catalogId !== undefined && typeof body.catalogId !== "string") {
      throw new Error("createSurface.catalogId must be a string.");
    }
    if (body.sendDataModel !== undefined && typeof body.sendDataModel !== "boolean") {
      throw new Error("createSurface.sendDataModel must be a boolean.");
    }
    if (body.metadata !== undefined) {
      if (!isPlainObject(body.metadata)) throw new Error("createSurface.metadata must be an object.");
      for (const k of Object.keys(body.metadata)) {
        if (k !== "extensions") throw new Error(`createSurface.metadata has unknown property "${k}".`);
      }
      validateExtensions(body.metadata.extensions, "createSurface.metadata");
    }
    let components;
    if (body.components !== undefined) {
      if (!Array.isArray(body.components) || !body.components.length) {
        throw new Error("createSurface.components must be a non-empty array when provided.");
      }
      if (body.components.length > A2UI_LIMITS.maxComponents) {
        throw new Error(`createSurface.components exceeds maximum of ${A2UI_LIMITS.maxComponents}.`);
      }
      components = body.components.map((c, i) => validateA2uiComponent(c, i, options));
    }
    let dataModel;
    if (body.dataModel !== undefined) {
      if (!isPlainObject(body.dataModel)) throw new Error("createSurface.dataModel must be a JSON object.");
      dataModel = sanitizeJsonValue(body.dataModel);
      if (byteSize(dataModel) > A2UI_LIMITS.maxDataModelBytes) {
        throw new Error(`createSurface.dataModel exceeds ${A2UI_LIMITS.maxDataModelBytes} bytes.`);
      }
    }
    return {
      version: A2UI_VERSION,
      createSurface: {
        surfaceId: body.surfaceId.trim(),
        ...(body.catalogId !== undefined ? { catalogId: body.catalogId } : {}),
        ...(body.sendDataModel !== undefined ? { sendDataModel: body.sendDataModel } : {}),
        ...(components ? { components } : {}),
        ...(dataModel ? { dataModel } : {}),
        ...(body.metadata ? { metadata: sanitizeJsonValue(body.metadata) } : {}),
      },
    };
  }

  if (kind === "updateComponents") {
    const allowed = new Set(["surfaceId", "components"]);
    for (const k of Object.keys(body)) {
      if (!allowed.has(k)) throw new Error(`A2UI updateComponents has unknown property "${k}".`);
    }
    if (typeof body.surfaceId !== "string" || !body.surfaceId.trim() || body.surfaceId.length > A2UI_LIMITS.maxSurfaceIdLength) {
      throw new Error("updateComponents.surfaceId must be a non-empty string.");
    }
    if (!Array.isArray(body.components) || !body.components.length) {
      throw new Error("updateComponents.components must be a non-empty array.");
    }
    if (body.components.length > A2UI_LIMITS.maxComponents) {
      throw new Error(`updateComponents.components exceeds maximum of ${A2UI_LIMITS.maxComponents}.`);
    }
    const components = body.components.map((c, i) => validateA2uiComponent(c, i, options));
    return {
      version: A2UI_VERSION,
      updateComponents: {
        surfaceId: body.surfaceId.trim(),
        components,
      },
    };
  }

  if (kind === "updateDataModel") {
    const allowed = new Set(["surfaceId", "path", "value"]);
    for (const k of Object.keys(body)) {
      if (!allowed.has(k)) throw new Error(`A2UI updateDataModel has unknown property "${k}".`);
    }
    if (typeof body.surfaceId !== "string" || !body.surfaceId.trim() || body.surfaceId.length > A2UI_LIMITS.maxSurfaceIdLength) {
      throw new Error("updateDataModel.surfaceId must be a non-empty string.");
    }
    if (body.path !== undefined && typeof body.path !== "string") {
      throw new Error("updateDataModel.path must be a string.");
    }
    if (!Object.hasOwn(body, "value")) {
      throw new Error("updateDataModel requires \"value\" (set null to delete).");
    }
    const value = sanitizeJsonValue(body.value);
    if (byteSize(value) > A2UI_LIMITS.maxDataModelBytes) {
      throw new Error(`updateDataModel.value exceeds ${A2UI_LIMITS.maxDataModelBytes} bytes.`);
    }
    return {
      version: A2UI_VERSION,
      updateDataModel: {
        surfaceId: body.surfaceId.trim(),
        ...(body.path !== undefined ? { path: body.path } : {}),
        value,
      },
    };
  }

  if (kind === "deleteSurface") {
    if (Object.keys(body).some((k) => k !== "surfaceId") || typeof body.surfaceId !== "string" || !body.surfaceId.trim()) {
      throw new Error("deleteSurface requires only a non-empty string \"surfaceId\".");
    }
    return {
      version: A2UI_VERSION,
      deleteSurface: { surfaceId: body.surfaceId.trim() },
    };
  }

  if (kind === "callRendererFunction") {
    const allowed = new Set(["surfaceId", "functionCallId", "callFunction"]);
    for (const k of Object.keys(body)) {
      if (!allowed.has(k)) throw new Error(`callRendererFunction has unknown property "${k}".`);
    }
    if (body.surfaceId !== undefined && (typeof body.surfaceId !== "string" || !body.surfaceId.trim())) {
      throw new Error("callRendererFunction.surfaceId must be a non-empty string when provided.");
    }
    if (typeof body.functionCallId !== "string" || !body.functionCallId.trim()) {
      throw new Error("callRendererFunction requires functionCallId.");
    }
    validateFunctionCall(body.callFunction, "callRendererFunction.callFunction");
    if (!body.callFunction.catalogId) {
      throw new Error("callRendererFunction.callFunction requires catalogId.");
    }
    return {
      version: A2UI_VERSION,
      callRendererFunction: sanitizeJsonValue(body),
    };
  }

  if (kind === "agentFunctionResponse") {
    if (typeof body.functionCallId !== "string" || !body.functionCallId.trim()) {
      throw new Error("agentFunctionResponse requires functionCallId.");
    }
    return {
      version: A2UI_VERSION,
      agentFunctionResponse: sanitizeJsonValue(body),
    };
  }

  throw new Error(`Unsupported A2UI message kind "${kind}".`);
}

/** Validates an array of A2UI v1.0 envelope messages and enforces payload byte caps. */
export function validateA2uiMessages(messages, options = {}) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("Provide a non-empty array of A2UI v1.0 messages.");
  }
  if (messages.length > A2UI_LIMITS.maxMessagesPerCall) {
    throw new Error(`At most ${A2UI_LIMITS.maxMessagesPerCall} A2UI messages may be sent in one call.`);
  }
  if (byteSize(messages) > A2UI_LIMITS.maxPayloadBytes) {
    throw new Error(`A2UI payload exceeds maximum size of ${A2UI_LIMITS.maxPayloadBytes} bytes.`);
  }
  return messages.map((m) => validateA2uiMessage(m, options));
}

// ── JSON Pointer (RFC 6901) helpers ────────────────────────────────────────

export function decodePointerToken(token) {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function splitPointer(path) {
  if (typeof path !== "string" || !path || path === "/") return [];
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  if (!trimmed) return [];
  return trimmed.split("/").map(decodePointerToken);
}

/** Resolves a JSON Pointer (absolute `/a/b` or relative to `scopePath`) against `dataModel`. */
export function getDataAtPointer(dataModel, pointer, scopePath = "") {
  if (typeof pointer !== "string") return undefined;
  const full = pointer.startsWith("/")
    ? pointer
    : scopePath
      ? `${scopePath.replace(/\/$/, "")}/${pointer}`
      : `/${pointer}`;
  const tokens = splitPointer(full);
  let cur = dataModel;
  for (const token of tokens) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    if (FORBIDDEN_KEYS.has(token)) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (Object.hasOwn(cur, token)) {
      cur = cur[token];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Immutably updates `dataModel` at JSON Pointer `path`. Setting `value: null` deletes the key. */
export function setDataAtPointer(dataModel, path, value) {
  const tokens = splitPointer(path || "/");
  if (!tokens.length) {
    if (value === null) return {};
    if (!isPlainObject(value)) throw new Error("Root data model must be a JSON object.");
    return structuredClone(value);
  }
  const root = isPlainObject(dataModel) ? structuredClone(dataModel) : {};
  let cur = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i];
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`Forbidden path segment "${key}".`);
    if (Array.isArray(cur)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx > A2UI_LIMITS.maxArrayLength) {
        throw new Error(`Invalid array index "${key}" in data model path.`);
      }
      if (!cur[idx] || typeof cur[idx] !== "object") cur[idx] = {};
      cur = cur[idx];
    } else {
      if (!cur[key] || typeof cur[key] !== "object") {
        const nextKey = tokens[i + 1];
        cur[key] = /^\d+$/.test(nextKey) ? [] : {};
      }
      cur = cur[key];
    }
  }
  const leaf = tokens[tokens.length - 1];
  if (FORBIDDEN_KEYS.has(leaf)) throw new Error(`Forbidden path segment "${leaf}".`);
  if (Array.isArray(cur)) {
    const idx = Number(leaf);
    if (!Number.isInteger(idx) || idx < 0 || idx > A2UI_LIMITS.maxArrayLength) {
      throw new Error(`Invalid array index "${leaf}" in data model path.`);
    }
    if (value === null) cur.splice(idx, 1);
    else cur[idx] = structuredClone(value);
  } else if (value === null) {
    delete cur[leaf];
  } else {
    cur[leaf] = structuredClone(value);
  }
  if (byteSize(root) > A2UI_LIMITS.maxDataModelBytes) {
    throw new Error(`Surface dataModel exceeds ${A2UI_LIMITS.maxDataModelBytes} bytes.`);
  }
  return root;
}

// ── DynamicValue & Basic Catalog function evaluation ───────────────────────

function coerceBool(v) {
  if (isPlainObject(v) && typeof v.valid === "boolean") return v.valid;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return false;
}

function formatDateTR35(date, pattern) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const monthsShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthsLong = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const daysShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const daysLong = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  const dow = date.getDay();
  const H = date.getHours();
  const h = H % 12 || 12;
  const min = date.getMinutes();
  const sec = date.getSeconds();
  const a = H < 12 ? "AM" : "PM";
  const tokens = {
    yyyy: String(y),
    yy: String(y).slice(-2),
    MMMM: monthsLong[m],
    MMM: monthsShort[m],
    MM: pad(m + 1),
    M: String(m + 1),
    dd: pad(d),
    d: String(d),
    EEEE: daysLong[dow],
    E: daysShort[dow],
    HH: pad(H),
    H: String(H),
    hh: pad(h),
    h: String(h),
    mm: pad(min),
    ss: pad(sec),
    a,
  };
  return String(pattern).replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|E|HH|H|hh|h|mm|ss|a/g, (tok) => tokens[tok] ?? tok);
}

/** Evaluates a DynamicValue (`literal`, `{"@path": ...}`, or `{"@call": ...}`) against `dataModel`. */
export function resolveDynamicValue(value, dataModel, ctx = {}, depth = 0) {
  if (depth > 12) return undefined;
  const scopePath = ctx.scopePath || "";
  if (isPlainObject(value)) {
    if ("@path" in value) {
      return getDataAtPointer(dataModel, value["@path"], scopePath);
    }
    if ("@call" in value) {
      return evaluateFunctionCall(value, dataModel, ctx, depth + 1);
    }
  }
  return value;
}

export function resolveDynamicString(value, dataModel, ctx = {}) {
  const v = resolveDynamicValue(value, dataModel, ctx);
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

export function resolveDynamicNumber(value, dataModel, ctx = {}) {
  const v = resolveDynamicValue(value, dataModel, ctx);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export function resolveDynamicBoolean(value, dataModel, ctx = {}) {
  return coerceBool(resolveDynamicValue(value, dataModel, ctx));
}

export function resolveDynamicStringList(value, dataModel, ctx = {}) {
  const v = resolveDynamicValue(value, dataModel, ctx);
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  if (typeof v === "string" && v) return [v];
  return [];
}

function evaluateFunctionCall(call, dataModel, ctx, depth) {
  const name = call["@call"];
  const args = call.args || {};
  const evalArg = (k) => resolveDynamicValue(args[k], dataModel, ctx, depth + 1);

  switch (name) {
    case "@index": {
      if (typeof ctx.itemIndex !== "number") return 0;
      const offset = args.offset !== undefined ? Number(evalArg("offset") || 0) : 0;
      return ctx.itemIndex + (Number.isFinite(offset) ? offset : 0);
    }
    case "required": {
      const v = evalArg("value");
      const valid =
        v !== null &&
        v !== undefined &&
        !(typeof v === "string" && v.trim() === "") &&
        !(Array.isArray(v) && v.length === 0);
      return { valid };
    }
    case "regex": {
      const v = String(evalArg("value") ?? "");
      const pat = String(args.pattern ?? "");
      if (!pat || pat.length > 256) return { valid: false };
      try {
        return { valid: new RegExp(pat, "u").test(v) };
      } catch {
        return { valid: false };
      }
    }
    case "length": {
      const v = String(evalArg("value") ?? "");
      const len = [...v].length;
      const okMin = args.min === undefined || len >= Number(args.min);
      const okMax = args.max === undefined || len <= Number(args.max);
      return { valid: okMin && okMax };
    }
    case "numeric": {
      const n = Number(evalArg("value"));
      if (!Number.isFinite(n)) return { valid: false };
      const okMin = args.min === undefined || n >= Number(args.min);
      const okMax = args.max === undefined || n <= Number(args.max);
      return { valid: okMin && okMax };
    }
    case "email": {
      const v = String(evalArg("value") ?? "").trim();
      return { valid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) };
    }
    case "formatString": {
      const template = String(evalArg("value") ?? "");
      return template.replace(/(\\)?\$\{([^}]+)\}/g, (match, escaped, expr) => {
        if (escaped) return "${" + expr + "}";
        const trimmed = expr.trim();
        if (trimmed === "now()") return new Date().toISOString();
        const val = getDataAtPointer(dataModel, trimmed, ctx.scopePath || "");
        return val === undefined || val === null ? "" : String(val);
      });
    }
    case "formatNumber": {
      const n = Number(evalArg("value"));
      if (!Number.isFinite(n)) return "";
      const decimals = args.decimals !== undefined ? Number(evalArg("decimals")) : undefined;
      const grouping = args.grouping !== undefined ? coerceBool(evalArg("grouping")) : true;
      return new Intl.NumberFormat(undefined, {
        useGrouping: grouping,
        ...(Number.isInteger(decimals) && decimals >= 0 && decimals <= 20
          ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
          : {}),
      }).format(n);
    }
    case "formatCurrency": {
      const n = Number(evalArg("value"));
      const currency = String(evalArg("currency") || "USD").toUpperCase();
      if (!Number.isFinite(n)) return "";
      const decimals = args.decimals !== undefined ? Number(evalArg("decimals")) : undefined;
      const grouping = args.grouping !== undefined ? coerceBool(evalArg("grouping")) : true;
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency",
          currency,
          useGrouping: grouping,
          ...(Number.isInteger(decimals) && decimals >= 0 && decimals <= 20
            ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
            : {}),
        }).format(n);
      } catch {
        return `${currency} ${n}`;
      }
    }
    case "formatDate": {
      const raw = evalArg("value");
      const fmt = String(evalArg("format") ?? "");
      const date = raw instanceof Date ? raw : new Date(typeof raw === "number" || typeof raw === "string" ? raw : NaN);
      return formatDateTR35(date, fmt);
    }
    case "pluralize": {
      const n = Number(evalArg("value") ?? 0);
      const key = n === 0 && args.zero !== undefined ? "zero" : n === 1 && args.one !== undefined ? "one" : n === 2 && args.two !== undefined ? "two" : "other";
      return String(evalArg(key) ?? evalArg("other") ?? "");
    }
    case "and": {
      const list = Array.isArray(args.values) ? args.values : [];
      return list.every((item) => coerceBool(resolveDynamicValue(item, dataModel, ctx, depth + 1)));
    }
    case "or": {
      const list = Array.isArray(args.values) ? args.values : [];
      return list.some((item) => coerceBool(resolveDynamicValue(item, dataModel, ctx, depth + 1)));
    }
    case "not":
      return !coerceBool(evalArg("value"));
    default:
      return undefined;
  }
}

/** Evaluates a component's `@checks` rules and returns the list of failing error messages. */
export function evaluateChecks(component, dataModel, ctx = {}) {
  const checks = Array.isArray(component?.["@checks"]) ? component["@checks"] : [];
  const errors = [];
  for (const rule of checks) {
    const res = resolveDynamicValue(rule.condition, dataModel, ctx);
    const ok = coerceBool(res);
    if (!ok) {
      errors.push((isPlainObject(res) && typeof res.message === "string" && res.message) || rule.message || "Invalid value");
    }
  }
  return errors;
}

/** Resolves an Action's event context against the surface's current data model. */
export function resolveActionEvent(action, dataModel, ctx = {}) {
  if (!action?.event) return null;
  const resolvedContext = {};
  if (isPlainObject(action.event.context)) {
    for (const [k, v] of Object.entries(action.event.context)) {
      resolvedContext[k] = resolveDynamicValue(v, dataModel, ctx);
    }
  }
  const userMessage = action.event.userMessage !== undefined ? resolveDynamicString(action.event.userMessage, dataModel, ctx) : undefined;
  return {
    name: action.event.name,
    ...(userMessage ? { userMessage } : {}),
    context: resolvedContext,
  };
}

// ── Surface State Application & Integrity Checks ───────────────────────────

/**
 * Verifies component tree integrity: unique IDs, root exists, and all referenced child IDs exist.
 * Returns `{ valid, errors }`.
 */
export function validateSurfaceTree(surface) {
  const errors = [];
  const components = Array.isArray(surface?.components) ? surface.components : [];
  const byId = new Map();
  for (const c of components) {
    if (byId.has(c.id)) errors.push(`Duplicate component id "${c.id}".`);
    byId.set(c.id, c);
  }
  if (!byId.has("root")) {
    errors.push('Surface must contain a component with id "root".');
  }
  const checkRef = (ownerId, field, targetId) => {
    if (!byId.has(targetId)) errors.push(`Component "${ownerId}" references missing ${field} "${targetId}".`);
  };
  for (const c of components) {
    if (typeof c.child === "string") checkRef(c.id, "child", c.child);
    if (Array.isArray(c.children)) {
      for (const cid of c.children) checkRef(c.id, "children", cid);
    } else if (isPlainObject(c.children) && typeof c.children.componentId === "string") {
      checkRef(c.id, "children.componentId", c.children.componentId);
    }
    if (Array.isArray(c.tabs)) {
      for (const tab of c.tabs) {
        if (typeof tab.child === "string") checkRef(c.id, "tabs.child", tab.child);
      }
    }
    if (typeof c.trigger === "string") checkRef(c.id, "trigger", c.trigger);
    if (typeof c.content === "string") checkRef(c.id, "content", c.content);
  }
  // Cycle check from root
  const visiting = new Set();
  const visited = new Set();
  const walk = (id) => {
    if (visiting.has(id)) {
      errors.push(`Component cycle detected involving "${id}".`);
      return;
    }
    if (visited.has(id)) return;
    const c = byId.get(id);
    if (!c) return;
    visiting.add(id);
    const refs = [];
    if (typeof c.child === "string") refs.push(c.child);
    if (Array.isArray(c.children)) refs.push(...c.children);
    else if (isPlainObject(c.children) && typeof c.children.componentId === "string") refs.push(c.children.componentId);
    if (Array.isArray(c.tabs)) refs.push(...c.tabs.map((t) => t.child));
    if (typeof c.trigger === "string") refs.push(c.trigger);
    if (typeof c.content === "string") refs.push(c.content);
    for (const r of refs) walk(r);
    visiting.delete(id);
    visited.add(id);
  };
  if (byId.has("root")) walk("root");
  return { valid: errors.length === 0, errors };
}

/**
 * Applies a validated sequence of A2UI v1.0 messages to a map of surfaces (`surfaceId -> A2uiSurface`).
 * Enforces v1.0 lifecycle rules (no duplicate createSurface without deleteSurface, updates require
 * existing surface, bot ownership for updates, and surface component limits).
 */
export function applyA2uiMessages(existingSurfaces, rawMessages, meta = {}, options = {}) {
  const messages = validateA2uiMessages(rawMessages, options);
  const map = new Map();
  for (const s of existingSurfaces ?? []) {
    map.set(s.surfaceId, structuredClone(s));
  }
  const touchedIds = new Set();
  const createdIds = new Set();
  const deletedIds = new Set();
  const now = meta.now ?? Date.now();

  for (const msg of messages) {
    if (msg.createSurface) {
      const cs = msg.createSurface;
      const existing = map.get(cs.surfaceId);
      if (existing && !existing.deleted) {
        throw new Error(`INTEGRITY_ERROR: Surface "${cs.surfaceId}" already exists. Send deleteSurface first or use updateComponents/updateDataModel.`);
      }
      const surface = {
        surfaceId: cs.surfaceId,
        version: A2UI_VERSION,
        catalogId: cs.catalogId || A2UI_BASIC_CATALOG_ID,
        sendDataModel: cs.sendDataModel === true,
        components: cs.components ? structuredClone(cs.components) : [],
        dataModel: cs.dataModel ? structuredClone(cs.dataModel) : {},
        ...(cs.metadata ? { metadata: cs.metadata } : {}),
        ...(meta.botId ? { ownerBotId: meta.botId } : {}),
        ...(meta.workflow ? { workflow: structuredClone(meta.workflow) } : {}),
        ...(meta.dispatch ? { dispatch: structuredClone(meta.dispatch) } : {}),
        createdAt: now,
        updatedAt: now,
      };
      map.set(cs.surfaceId, surface);
      createdIds.add(cs.surfaceId);
      deletedIds.delete(cs.surfaceId);
      touchedIds.add(cs.surfaceId);
    } else if (msg.updateComponents) {
      const uc = msg.updateComponents;
      const surface = map.get(uc.surfaceId);
      if (!surface || surface.deleted) {
        throw new Error(`Surface "${uc.surfaceId}" does not exist. Send createSurface first.`);
      }
      if (meta.botId && surface.ownerBotId && surface.ownerBotId !== meta.botId) {
        throw new Error(`Surface "${uc.surfaceId}" belongs to another bot and cannot be updated.`);
      }
      const byId = new Map(surface.components.map((c) => [c.id, c]));
      for (const comp of uc.components) {
        byId.set(comp.id, structuredClone(comp));
      }
      if (byId.size > A2UI_LIMITS.maxComponents) {
        throw new Error(`Surface "${uc.surfaceId}" exceeds maximum of ${A2UI_LIMITS.maxComponents} components.`);
      }
      surface.components = [...byId.values()];
      surface.updatedAt = now;
      touchedIds.add(uc.surfaceId);
    } else if (msg.updateDataModel) {
      const ud = msg.updateDataModel;
      const surface = map.get(ud.surfaceId);
      if (!surface || surface.deleted) {
        throw new Error(`Surface "${ud.surfaceId}" does not exist. Send createSurface first.`);
      }
      if (meta.botId && surface.ownerBotId && surface.ownerBotId !== meta.botId) {
        throw new Error(`Surface "${ud.surfaceId}" belongs to another bot and cannot be updated.`);
      }
      surface.dataModel = setDataAtPointer(surface.dataModel, ud.path || "/", ud.value);
      surface.updatedAt = now;
      touchedIds.add(ud.surfaceId);
    } else if (msg.deleteSurface) {
      const ds = msg.deleteSurface;
      const surface = map.get(ds.surfaceId);
      if (!surface || surface.deleted) {
        throw new Error(`Surface "${ds.surfaceId}" does not exist.`);
      }
      if (meta.botId && surface.ownerBotId && surface.ownerBotId !== meta.botId) {
        throw new Error(`Surface "${ds.surfaceId}" belongs to another bot and cannot be deleted.`);
      }
      surface.deleted = true;
      surface.updatedAt = now;
      deletedIds.add(ds.surfaceId);
      touchedIds.add(ds.surfaceId);
    }
  }

  // Validate tree integrity for every non-deleted touched surface that has components.
  for (const id of touchedIds) {
    const surface = map.get(id);
    if (!surface || surface.deleted) continue;
    if (!surface.components.length) {
      throw new Error(`Surface "${id}" has no components. Include components with a "root" component.`);
    }
    const treeCheck = validateSurfaceTree(surface);
    if (!treeCheck.valid) {
      throw new Error(`Surface "${id}" tree error: ${treeCheck.errors[0]}`);
    }
    if (byteSize(surface) > A2UI_LIMITS.maxPayloadBytes) {
      throw new Error(`Surface "${id}" exceeds maximum stored size of ${A2UI_LIMITS.maxPayloadBytes} bytes.`);
    }
  }

  return {
    surfaces: map,
    createdIds: [...createdIds],
    updatedIds: [...touchedIds].filter((id) => !createdIds.has(id) && !deletedIds.has(id)),
    deletedIds: [...deletedIds],
    touchedIds: [...touchedIds],
  };
}

// ── Plain-text fallback extraction (for notifications, older clients, rich-cards-off) ──

/**
 * Extracts a concise plain-text summary and clickable action descriptors from a surface.
 * Used for `message.text` fallbacks and rich-cards-off rendering.
 */
export function summarizeA2uiSurface(surface) {
  if (!surface || surface.deleted || !Array.isArray(surface.components)) {
    return { lines: [], actions: [], text: "" };
  }
  const byId = new Map(surface.components.map((c) => [c.id, c]));
  const data = surface.dataModel || {};
  const lines = [];
  const actions = [];
  const seen = new Set();

  const labelOf = (compId, ctx) => {
    const c = byId.get(compId);
    if (!c) return "";
    if (c.component === "Text") return resolveDynamicString(c.text, data, ctx).trim();
    if (c.component === "Icon") return typeof c.name === "string" ? c.name : "Action";
    if (c.component === "Row" || c.component === "Column") {
      if (Array.isArray(c.children)) {
        return c.children.map((id) => labelOf(id, ctx)).filter(Boolean).join(" ").trim();
      }
    }
    return c["@accessibility"]?.label ? resolveDynamicString(c["@accessibility"].label, data, ctx).trim() : "";
  };

  const visit = (id, ctx = {}, depth = 0) => {
    if (depth > 20 || !id) return;
    const visitKey = `${id}@${ctx.scopePath || ""}`;
    if (seen.has(visitKey)) return;
    seen.add(visitKey);
    const c = byId.get(id);
    if (!c) return;
    switch (c.component) {
      case "Text": {
        const s = resolveDynamicString(c.text, data, ctx).trim();
        if (s) lines.push(s);
        break;
      }
      case "Image": {
        const desc = c.description ? resolveDynamicString(c.description, data, ctx).trim() : "";
        if (desc) lines.push(`[Image: ${desc}]`);
        break;
      }
      case "Button": {
        const label = labelOf(c.child, ctx) || c.action?.event?.name || "Action";
        actions.push({
          componentId: c.id,
          label,
          variant: c.variant || "default",
          action: c.action,
          scopePath: ctx.scopePath || "",
          itemIndex: ctx.itemIndex,
        });
        break;
      }
      case "TextField":
      case "CheckBox":
      case "ChoicePicker":
      case "Slider":
      case "DateTimeInput": {
        const label = c.label ? resolveDynamicString(c.label, data, ctx).trim() : c.id;
        const val = resolveDynamicValue(c.value, data, ctx);
        const formatted = Array.isArray(val) ? val.join(", ") : val === undefined || val === null ? "" : String(val);
        lines.push(formatted ? `${label}: ${formatted}` : label);
        break;
      }
      case "Card":
        visit(c.child, ctx, depth + 1);
        break;
      case "Row":
      case "Column":
      case "List":
        if (Array.isArray(c.children)) {
          for (const cid of c.children) visit(cid, ctx, depth + 1);
        } else if (isPlainObject(c.children) && typeof c.children.path === "string") {
          const arr = getDataAtPointer(data, c.children.path, ctx.scopePath || "");
          if (Array.isArray(arr)) {
            const base = c.children.path.startsWith("/")
              ? c.children.path.replace(/\/$/, "")
              : `${(ctx.scopePath || "").replace(/\/$/, "")}/${c.children.path}`;
            arr.slice(0, 50).forEach((_, idx) => {
              visit(c.children.componentId, { scopePath: `${base}/${idx}`, itemIndex: idx }, depth + 1);
            });
          }
        }
        break;
      case "Tabs":
        if (Array.isArray(c.tabs)) {
          for (const tab of c.tabs) {
            const t = resolveDynamicString(tab.title, data, ctx).trim();
            if (t) lines.push(t);
            visit(tab.child, ctx, depth + 1);
          }
        }
        break;
      case "Modal":
        visit(c.trigger, ctx, depth + 1);
        break;
      default:
        break;
    }
  };

  visit("root");
  const text = lines.slice(0, 20).join("\n");
  return { lines, actions, text };
}

/** Validates an incoming A2UI renderer-to-agent action payload from a client over the Link. */
export function validateA2uiActionPayload(payload) {
  if (!isPlainObject(payload)) throw new Error("A2UI action payload must be an object.");
  const surfaceId = typeof payload.surfaceId === "string" ? payload.surfaceId.trim() : "";
  const sourceComponentId = typeof payload.sourceComponentId === "string" ? payload.sourceComponentId.trim() : "";
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!surfaceId || surfaceId.length > A2UI_LIMITS.maxSurfaceIdLength) throw new Error("Invalid surfaceId.");
  if (!sourceComponentId || sourceComponentId.length > A2UI_LIMITS.maxComponentIdLength) throw new Error("Invalid sourceComponentId.");
  if (!name || name.length > 128) throw new Error("Invalid action name.");
  const actionId = typeof payload.actionId === "string" && payload.actionId.trim()
    ? payload.actionId.trim().slice(0, 128)
    : `${surfaceId}:${sourceComponentId}:${name}`;
  const userMessage = typeof payload.userMessage === "string" ? payload.userMessage.trim().slice(0, 1000) : undefined;
  const timestamp = typeof payload.timestamp === "string" && payload.timestamp.trim()
    ? payload.timestamp.trim().slice(0, 64)
    : new Date().toISOString();
  const context = payload.context !== undefined ? sanitizeJsonValue(payload.context) : {};
  if (!isPlainObject(context)) throw new Error("Action context must be a JSON object.");
  if (byteSize(context) > A2UI_LIMITS.maxActionContextBytes) {
    throw new Error(`Action context exceeds ${A2UI_LIMITS.maxActionContextBytes} bytes.`);
  }
  let dataModel;
  if (payload.dataModel !== undefined) {
    if (!isPlainObject(payload.dataModel)) throw new Error("Action dataModel must be a JSON object.");
    dataModel = sanitizeJsonValue(payload.dataModel);
    if (byteSize(dataModel) > A2UI_LIMITS.maxDataModelBytes) {
      throw new Error(`Action dataModel exceeds ${A2UI_LIMITS.maxDataModelBytes} bytes.`);
    }
  }
  return {
    version: A2UI_VERSION,
    surfaceId,
    sourceComponentId,
    name,
    actionId,
    ...(userMessage ? { userMessage } : {}),
    timestamp,
    context,
    ...(dataModel !== undefined ? { dataModel } : {}),
    isBuiltin: BUILTIN_ACTION_NAMES.has(name.toLowerCase()),
  };
}
