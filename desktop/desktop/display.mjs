// Text previews of tool input and output. Values under keys that usually hold secrets are redacted.
const sensitive =
  /^(authorization|proxy-authorization|cookie|set-cookie|password|secret|access[_-]?token|api[_-]?key|env|environment|headers)$/i;
export function displayValue(value, max = 16000) {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(
          value,
          (key, item) => (sensitive.test(key) ? "[redacted]" : item),
          2,
        );
  if (!text) return "";
  return text.length > max
    ? text.slice(0, max) + "\n… (preview truncated)"
    : text;
}
