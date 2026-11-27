import { parseFragment } from "parse5";

const children = node => node.childNodes ?? [];
const nodes = function* (node) {
  for (const child of children(node)) {
    yield child;
    yield* nodes(child);
  }
};
const attr = (node, name) => node.attrs?.find(each => each.name === name)?.value;
const text = node => node.nodeName === "#text" ? node.value : children(node).map(text).join(" ").trim();
const controls = new Set(["input", "textarea", "select"]);
const unsafe = new Set(["script", "iframe", "object", "embed", "template"]);
const fieldName = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

/** Project an OMP form onto Botkins' existing inert form control. Never deliver the HTML. */
export function dialogForm(html) {
  if (typeof html !== "string" || html.length > 64000) return null;
  const all = [...nodes(parseFragment(html))];
  if (all.some(node => unsafe.has(node.tagName))) return null;
  const labels = all.filter(node => node.tagName === "label");
  const properties = Object.create(null);
  const required = [];
  const choices = new Map();
  for (const node of all.filter(node => controls.has(node.tagName))) {
    const name = attr(node, "name");
    const type = attr(node, "type")?.toLowerCase() ?? "text";
    if (["button", "submit", "reset"].includes(type)) continue;
    if (!fieldName.test(name ?? "") || Object.hasOwn(Object.prototype, name)) return null;
    if (attr(node, "disabled") !== undefined || attr(node, "readonly") !== undefined) return null;
    const label = labels.find(label => (attr(node, "id") && attr(label, "for") === attr(node, "id")) || [...nodes(label)].includes(node));
    const title = label ? children(label).filter(child => !controls.has(child.tagName)).map(text).join(" ").trim() : name;
    if (attr(node, "required") !== undefined && !required.includes(name)) required.push(name);
    if (node.tagName === "input" && ["radio", "checkbox"].includes(type)) {
      let group = choices.get(name);
      if (!group) choices.set(name, group = { type, labels: [], values: [], initial: [] });
      if (group.type !== type || Object.hasOwn(properties, name)) return null;
      const value = attr(node, "value") ?? "on";
      if (group.values.includes(value)) return null;
      group.values.push(value);
      group.labels.push(title || value);
      if (attr(node, "checked") !== undefined) group.initial.push(value);
      continue;
    }
    if (Object.hasOwn(properties, name) || choices.has(name)) return null;
    if (node.tagName === "select") {
      const options = [...nodes(node)].filter(child => child.tagName === "option" && attr(child, "disabled") === undefined);
      const values = options.map(option => attr(option, "value") ?? text(option));
      if (!values.length || new Set(values).size !== values.length) return null;
      const selected = options.flatMap((option, i) => attr(option, "selected") === undefined ? [] : [values[i]]);
      properties[name] = choiceField(title || name, values, options.map(text), selected, attr(node, "multiple") !== undefined);
    } else if (node.tagName === "textarea" || (node.tagName === "input" && type === "text")) {
      properties[name] = { type: "string", title: title || name, default: node.tagName === "textarea" ? text(node) : attr(node, "value") ?? "" };
    } else {
      return null;
    }
  }
  for (const [name, group] of choices) properties[name] = choiceField(name, group.values, group.labels, group.initial, group.type === "checkbox");
  if (!Object.keys(properties).length || Object.keys(properties).length > 32) return null;
  const heading = all.find(node => node.tagName === "legend" || /^h[1-6]$/.test(node.tagName ?? ""));
  return { message: (heading && text(heading).slice(0, 1024)) || "Answer this form", requestedSchema: { type: "object", properties, required } };
}

function choiceField(title, values, labels, initial, multiple) {
  if (multiple) return { type: "array", title, items: { type: "string", enum: values }, default: initial };
  return { type: "string", title, oneOf: values.map((value, i) => ({ const: value, title: labels[i] || value })), ...(initial.length && { default: initial[0] }) };
}

export function formData(schema, content) {
  const data = Object.create(null);
  for (const [name, field] of Object.entries(schema.properties)) {
    const value = Object.hasOwn(content ?? {}, name) ? content[name] : undefined;
    const required = schema.required.includes(name);
    if (value == null || (value === "" && !field.oneOf)) {
      if (required) return null;
      if (value === "") data[name] = value;
      continue;
    }
    if (field.type === "array") {
      if (!Array.isArray(value) || (required && !value.length) || new Set(value).size !== value.length || value.some(entry => !field.items.enum.includes(entry))) return null;
    } else if (typeof value !== "string" || value.length > 32000 || (required && value === "") || (field.oneOf && !field.oneOf.some(option => option.const === value))) {
      return null;
    }
    data[name] = value;
  }
  return { ...data };
}
