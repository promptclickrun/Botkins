// Content-side DOM driver injected into pages via `chrome.scripting.executeScript`.
// Runs in the extension's isolated world without attaching `chrome.debugger`, so pages
// containing other extensions' iframes (Proton Pass, 1Password, Bitwarden, Grammarly, etc.)
// work normally.

import { isSameSite } from "./site.mjs";

export const DRIVER_VERSION = "0.3.0";

const BLOCKED_IFRAME_SCHEMES = [
  "chrome-extension:",
  "moz-extension:",
  "safari-web-extension:",
  "chrome:",
  "edge:",
  "devtools:",
  "chrome-untrusted:",
  "javascript:",
];

const INTERACTIVE_TAGS = new Set(["a", "button", "input", "textarea", "select", "summary"]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "listbox",
  "option",
  "textbox",
  "searchbox",
  "spinbutton",
  "slider",
  "treeitem",
]);
const SKIP_TEXT_TAGS = new Set(["script", "style", "noscript", "template", "title"]);
const MAX_SELECT_OPTIONS = 30;

function cleanText(str, maxLen = 0) {
  const out = String(str ?? "").replace(/\s+/g, " ").trim();
  return maxLen > 0 ? out.slice(0, maxLen) : out;
}

function getWin(node, fallbackWin) {
  return node?.ownerDocument?.defaultView || fallbackWin;
}

function isBlockedIframe(iframe) {
  const rawSrc = (iframe.getAttribute("src") || "").trim().toLowerCase();
  if (!rawSrc) return false;
  for (const scheme of BLOCKED_IFRAME_SCHEMES) {
    if (rawSrc.startsWith(scheme)) return true;
  }
  return false;
}

function isBlankOrSrcdocIframe(iframe) {
  if (iframe.hasAttribute("srcdoc")) return true;
  const rawSrc = (iframe.getAttribute("src") || "").trim().toLowerCase();
  return !rawSrc || rawSrc === "about:blank" || rawSrc === "about:srcdoc";
}

function tryGetIframeDocument(iframe, allowAllSameOrigin) {
  if (isBlockedIframe(iframe)) return null;
  if (!allowAllSameOrigin && !isBlankOrSrcdocIframe(iframe)) return null;
  try {
    const doc = iframe.contentDocument;
    if (!doc || !doc.documentElement) return null;
    const href = String(doc.location?.href || "").toLowerCase();
    for (const scheme of BLOCKED_IFRAME_SCHEMES) {
      if (href.startsWith(scheme)) return null;
    }
    return doc;
  } catch {
    return null;
  }
}

function isPasswordInput(el) {
  if (!el || el.tagName?.toLowerCase() !== "input") return false;
  const t = (el.type || el.getAttribute("type") || "").toLowerCase();
  return t === "password";
}

function isFileInput(el) {
  if (!el || el.tagName?.toLowerCase() !== "input") return false;
  const t = (el.type || el.getAttribute("type") || "").toLowerCase();
  return t === "file";
}

function isContentEditableEl(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const attr = el.getAttribute?.("contenteditable");
  return attr === "" || attr === "true" || attr === "plaintext-only";
}

function isSubmitControl(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "button") {
    const attr = (el.getAttribute("type") || "").toLowerCase();
    return !attr || attr === "submit";
  }
  if (tag === "input") {
    const t = (el.type || el.getAttribute("type") || "").toLowerCase();
    return t === "submit" || t === "image";
  }
  return false;
}

function isInteractiveElement(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const t = (el.type || el.getAttribute("type") || "text").toLowerCase();
    return t !== "hidden";
  }
  if (tag === "a") {
    return el.hasAttribute("href") || el.getAttribute("role") === "link" || el.getAttribute("role") === "button";
  }
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (isContentEditableEl(el)) return true;
  const role = (el.getAttribute("role") || "").trim().toLowerCase();
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el.hasAttribute("onclick")) return true;
  return false;
}

function isElementHiddenByStyle(el, win) {
  if (!el || el.nodeType !== 1) return true;
  if (el.hidden || el.getAttribute("aria-hidden") === "true" && !isInteractiveElement(el)) return true;
  const elWin = getWin(el, win);
  const style = elWin?.getComputedStyle?.(el);
  if (!style) return false;
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
  return false;
}

function isElementVisible(el, win) {
  if (!el || el.nodeType !== 1) return false;
  if (el.hidden) return false;
  const elWin = getWin(el, win);
  const style = elWin?.getComputedStyle?.(el);
  if (style) {
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    const tag = el.tagName.toLowerCase();
    const inputType = tag === "input" ? (el.type || "").toLowerCase() : "";
    const allowZeroOpacity = tag === "input" && (inputType === "checkbox" || inputType === "radio" || inputType === "file");
    if (!allowZeroOpacity && Number(style.opacity) === 0) return false;
  }
  const r = el.getBoundingClientRect?.();
  if (!r) return false;
  if (isFileInput(el)) return true;
  return r.width > 0 && r.height > 0;
}

function implicitRole(el) {
  const explicit = (el.getAttribute("role") || "").trim().toLowerCase();
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return el.multiple || Number(el.size) > 1 ? "listbox" : "combobox";
  if (tag === "input") {
    const t = (el.type || "text").toLowerCase();
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
    if (t === "search") return "searchbox";
    if (t === "number") return "spinbutton";
    if (t === "range") return "slider";
    if (t === "file") return "button";
    return "textbox";
  }
  if (isContentEditableEl(el)) return "textbox";
  return tag;
}

function getLabelTextExcludingControl(labelEl, controlEl) {
  const parts = [];
  const walk = (node) => {
    if (!node || node === controlEl) return;
    if (node.nodeType === 3) {
      parts.push(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (SKIP_TEXT_TAGS.has(tag) || tag === "input" || tag === "select" || tag === "textarea") return;
    for (const child of node.childNodes) walk(child);
  };
  walk(labelEl);
  return cleanText(parts.join(" "), 120);
}

function computeAccessibleName(el) {
  const root = el.getRootNode?.() || el.ownerDocument;
  const labelledBy = (el.getAttribute("aria-labelledby") || "").trim();
  if (labelledBy && root?.getElementById) {
    const pieces = [];
    for (const id of labelledBy.split(/\s+/)) {
      const refEl = root.getElementById(id);
      if (refEl) {
        const t = cleanText(refEl.innerText || refEl.textContent || "");
        if (t) pieces.push(t);
      }
    }
    if (pieces.length) return cleanText(pieces.join(" "), 120);
  }

  const ariaLabel = cleanText(el.getAttribute("aria-label") || "", 120);
  if (ariaLabel) return ariaLabel;

  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    if (el.labels && el.labels.length > 0) {
      const pieces = [];
      for (const lbl of el.labels) {
        const t = getLabelTextExcludingControl(lbl, el);
        if (t) pieces.push(t);
      }
      if (pieces.length) return cleanText(pieces.join(" "), 120);
    }
    if (el.id && root?.querySelector) {
      try {
        const lbl = root.querySelector(`label[for="${CSS?.escape ? CSS.escape(el.id) : el.id.replace(/"/g, '\\"')}"]`);
        if (lbl) {
          const t = getLabelTextExcludingControl(lbl, el);
          if (t) return t;
        }
      } catch {}
    }
    const parentLabel = el.closest?.("label");
    if (parentLabel) {
      const t = getLabelTextExcludingControl(parentLabel, el);
      if (t) return t;
    }
    if (tag === "input") {
      const t = (el.type || "").toLowerCase();
      if ((t === "submit" || t === "button" || t === "reset") && el.value) {
        return cleanText(el.value, 120);
      }
      if (t === "image" && el.alt) return cleanText(el.alt, 120);
    }
    const placeholder = cleanText(el.getAttribute("placeholder") || "", 120);
    if (placeholder) return placeholder;
    const title = cleanText(el.getAttribute("title") || "", 120);
    if (title) return title;
    const nameAttr = cleanText(el.getAttribute("name") || "", 120);
    if (nameAttr) return nameAttr;
    return "";
  }

  const text = cleanText(el.innerText || el.textContent || "", 120);
  if (text) return text;

  const imgAlt = cleanText(el.querySelector?.("img[alt]")?.getAttribute("alt") || "", 120);
  if (imgAlt) return imgAlt;

  return cleanText(el.getAttribute("title") || el.getAttribute("placeholder") || "", 120);
}

function cssPathWithinRoot(el) {
  if (el.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id)) return "#" + el.id;
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && parts.length < 5) {
    let part = cur.tagName.toLowerCase();
    const testId = cur.getAttribute("data-testid");
    if (testId) {
      parts.unshift(part + "[data-testid=" + JSON.stringify(testId) + "]");
      break;
    }
    const nameAttr = cur.getAttribute("name");
    if (nameAttr && ["input", "textarea", "select", "button"].includes(part)) {
      part += "[name=" + JSON.stringify(nameAttr) + "]";
    } else {
      const parent = cur.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
      }
    }
    parts.unshift(part);
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

const SENSITIVE_FIELD_KINDS = new Set(["password", "secret", "code"]);
const SECRET_INPUT_REFUSED_ERROR = "This input holds a securely filled value. Submit the form or navigate first.";

function getSecretStore(el, fallbackWin) {
  const elWin = getWin(el, fallbackWin);
  if (!elWin) return null;
  if (!elWin.__botkinsSecretElements) {
    try {
      Object.defineProperty(elWin, "__botkinsSecretElements", {
        value: new WeakMap(),
        configurable: true,
        enumerable: false,
        writable: true,
      });
    } catch {
      elWin.__botkinsSecretElements = new WeakMap();
    }
  }
  return elWin.__botkinsSecretElements;
}

function getSecretMeta(el, fallbackWin) {
  const elWin = getWin(el, fallbackWin);
  return elWin?.__botkinsSecretElements?.get(el) || null;
}

function markSecretElement(el, meta, fallbackWin) {
  const store = getSecretStore(el, fallbackWin);
  if (store) store.set(el, meta);
}

function unmarkSecretElement(el, fallbackWin) {
  const elWin = getWin(el, fallbackWin);
  elWin?.__botkinsSecretElements?.delete(el);
}

function isSensitiveSecretMeta(meta) {
  return Boolean(meta && (SENSITIVE_FIELD_KINDS.has(meta.kind) || meta.wasPassword));
}

function isSecretRedactedElement(el, fallbackWin) {
  if (!el || el.nodeType !== 1) return false;
  if (isPasswordInput(el)) return true;
  const meta = getSecretMeta(el, fallbackWin);
  if (!isSensitiveSecretMeta(meta)) return false;
  // Once an SPA empties a non-password input, the secret is gone from that input.
  if (String(el.value ?? "").length === 0) {
    unmarkSecretElement(el, fallbackWin);
    return false;
  }
  return true;
}

function isSecretProtectedElement(el, fallbackWin) {
  if (!el || el.nodeType !== 1) return false;
  const meta = getSecretMeta(el, fallbackWin);
  if (!isSensitiveSecretMeta(meta)) return false;
  if (String(el.value ?? "").length === 0) {
    unmarkSecretElement(el, fallbackWin);
    return false;
  }
  return true;
}

function isLiveFilledElement(el, topDoc) {
  if (!el) return false;
  try {
    if (!el.isConnected) return false;
    const ownerDoc = el.ownerDocument;
    if (!ownerDoc || !ownerDoc.defaultView) return false;
    if (ownerDoc !== topDoc) {
      const frameEl = ownerDoc.defaultView.frameElement;
      if (!frameEl || !frameEl.isConnected) return false;
    }
    return String(el.value ?? "").length > 0;
  } catch {
    return false;
  }
}

function getValueState(el, fallbackWin) {
  const tag = el.tagName.toLowerCase();
  const state = {};
  const secretRedacted = isSecretRedactedElement(el, fallbackWin);

  if (tag === "input") {
    const t = (el.type || "text").toLowerCase();
    if (t === "password" || secretRedacted) {
      // Never expose password or securely filled secret/code values in snapshots.
      const filled = Boolean(el.value && el.value.length > 0);
      state.hasValue = filled;
      state.valueState = filled ? "filled" : "empty";
    } else if (t === "checkbox" || t === "radio") {
      state.checked = Boolean(el.checked);
      if (el.indeterminate) state.indeterminate = true;
    } else if (t === "file") {
      state.filesCount = el.files?.length || 0;
      if (el.accept) state.accept = String(el.accept).slice(0, 120);
    } else if (t !== "submit" && t !== "button" && t !== "reset" && t !== "image") {
      state.value = String(el.value ?? "").slice(0, 200);
    }
  } else if (tag === "textarea") {
    if (secretRedacted) {
      const filled = Boolean(el.value && el.value.length > 0);
      state.hasValue = filled;
      state.valueState = filled ? "filled" : "empty";
    } else {
      state.value = String(el.value ?? "").slice(0, 200);
    }
  } else if (tag === "select") {
    state.value = String(el.value ?? "");
    const opts = [...(el.options || [])];
    const selectedOpts = opts.filter((o) => o.selected);
    if (el.multiple) {
      state.multiple = true;
      state.selectedText = selectedOpts.map((o) => cleanText(o.text, 80));
    } else if (selectedOpts[0]) {
      state.selectedText = cleanText(selectedOpts[0].text, 80);
    }
    state.options = opts.slice(0, MAX_SELECT_OPTIONS).map((o) => ({
      value: String(o.value ?? ""),
      text: cleanText(o.text, 80),
      ...(o.selected && { selected: true }),
      ...(o.disabled && { disabled: true }),
    }));
  } else if (isContentEditableEl(el)) {
    state.value = cleanText(el.innerText || el.textContent || "", 200);
  }

  const ariaChecked = el.getAttribute("aria-checked");
  if (ariaChecked === "true" || ariaChecked === "false" || ariaChecked === "mixed") {
    if (state.checked === undefined) state.checked = ariaChecked === "true" ? true : ariaChecked === "false" ? false : "mixed";
  }
  const ariaExpanded = el.getAttribute("aria-expanded");
  if (ariaExpanded === "true" || ariaExpanded === "false") state.expanded = ariaExpanded === "true";
  const ariaSelected = el.getAttribute("aria-selected");
  if (ariaSelected === "true" || ariaSelected === "false") state.selected = ariaSelected === "true";
  const ariaPressed = el.getAttribute("aria-pressed");
  if (ariaPressed === "true" || ariaPressed === "false") state.pressed = ariaPressed === "true";

  return state;
}

function walkTree(root, visitor, opts) {
  const { allowAllSameOrigin = false, includeBlankIframes = true, offsetX = 0, offsetY = 0, inShadow = false } = opts;
  const children = root.children || [];
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (!el || el.nodeType !== 1) continue;
    const tag = el.tagName.toLowerCase();

    if (tag === "iframe") {
      if (allowAllSameOrigin || includeBlankIframes) {
        const subDoc = tryGetIframeDocument(el, allowAllSameOrigin);
        if (subDoc) {
          const r = el.getBoundingClientRect?.() || { left: 0, top: 0 };
          walkTree(subDoc.documentElement, visitor, {
            allowAllSameOrigin,
            includeBlankIframes,
            offsetX: offsetX + r.left,
            offsetY: offsetY + r.top,
            inShadow,
          });
        }
      }
      continue;
    }

    const cont = visitor(el, { offsetX, offsetY, inShadow });
    if (cont === false) continue;

    if (el.shadowRoot) {
      walkTree(el.shadowRoot, visitor, {
        allowAllSameOrigin,
        includeBlankIframes,
        offsetX,
        offsetY,
        inShadow: true,
      });
    }
    if (el.children && el.children.length > 0) {
      walkTree(el, visitor, {
        allowAllSameOrigin,
        includeBlankIframes,
        offsetX,
        offsetY,
        inShadow,
      });
    }
  }
}

function collectVisibleText(root, win, opts) {
  const { allowAllSameOrigin = false, includeBlankIframes = true, maxChars = 50000 } = opts;
  const chunks = [];
  let total = 0;

  const visitNode = (node) => {
    if (total >= maxChars + 512) return;
    if (!node) return;
    if (node.nodeType === 3) {
      const txt = node.nodeValue;
      if (txt && txt.trim()) {
        chunks.push(txt);
        total += txt.length;
      }
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11 && node.nodeType !== 9) return;

    if (node.nodeType === 1) {
      const tag = node.tagName.toLowerCase();
      if (SKIP_TEXT_TAGS.has(tag)) return;
      if (isSecretRedactedElement(node, win)) return;
      if (tag === "iframe") {
        if (allowAllSameOrigin || includeBlankIframes) {
          const subDoc = tryGetIframeDocument(node, allowAllSameOrigin);
          if (subDoc?.body) {
            chunks.push("\n");
            visitNode(subDoc.body);
            chunks.push("\n");
          }
        }
        return;
      }
      if (isElementHiddenByStyle(node, win)) return;
      const isBlock = /^(div|p|section|article|main|header|footer|nav|aside|li|tr|h[1-6]|br|hr|form|fieldset|table|ul|ol|dd|dt)$/i.test(tag);
      if (isBlock) chunks.push("\n");
      if (node.shadowRoot) {
        for (const child of node.shadowRoot.childNodes) visitNode(child);
      }
      for (const child of node.childNodes) visitNode(child);
      if (isBlock) chunks.push("\n");
      return;
    }

    for (const child of node.childNodes) visitNode(child);
  };

  visitNode(root);
  return chunks
    .join(" ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function querySelectorDeep(doc, selector, opts = {}) {
  if (!selector) return null;
  try {
    const direct = doc.querySelector(selector);
    if (direct) return direct;
  } catch {
    return null;
  }

  let found = null;
  walkTree(
    doc.documentElement || doc,
    (el) => {
      if (found) return false;
      if (el.shadowRoot) {
        try {
          const hit = el.shadowRoot.querySelector(selector);
          if (hit) {
            found = hit;
            return false;
          }
        } catch {}
      }
      return true;
    },
    { allowAllSameOrigin: Boolean(opts.allowAllSameOrigin), includeBlankIframes: true },
  );
  if (found) return found;

  // Also check inlined same-origin iframes (e.g. srcdoc / about:blank).
  walkTree(
    doc.documentElement || doc,
    (el) => {
      if (found) return false;
      try {
        if (el.matches?.(selector)) {
          found = el;
          return false;
        }
      } catch {}
      return true;
    },
    { allowAllSameOrigin: Boolean(opts.allowAllSameOrigin), includeBlankIframes: true },
  );
  return found;
}

function elementFromPointDeep(doc, x, y) {
  let currentDoc = doc;
  let cx = x;
  let cy = y;
  let el = currentDoc.elementFromPoint?.(cx, cy) || null;
  let depth = 0;
  while (el && depth++ < 16) {
    if (el.shadowRoot && typeof el.shadowRoot.elementFromPoint === "function") {
      const inner = el.shadowRoot.elementFromPoint(cx, cy);
      if (!inner || inner === el) break;
      el = inner;
      continue;
    }
    if (el.tagName?.toLowerCase() === "iframe") {
      if (isBlockedIframe(el)) return { el: null, blockedIframe: true };
      try {
        const subDoc = el.contentDocument;
        if (subDoc && typeof subDoc.elementFromPoint === "function") {
          const r = el.getBoundingClientRect();
          cx = cx - r.left;
          cy = cy - r.top;
          currentDoc = subDoc;
          const inner = currentDoc.elementFromPoint(cx, cy);
          if (!inner) break;
          el = inner;
          continue;
        }
      } catch {
        return { el, crossOriginIframe: true };
      }
      return { el, crossOriginIframe: true };
    }
    break;
  }
  return { el };
}

function getActiveElementDeep(doc) {
  let el = doc.activeElement;
  let depth = 0;
  while (el && depth++ < 16) {
    if (el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
      continue;
    }
    if (el.tagName?.toLowerCase() === "iframe" && !isBlockedIframe(el)) {
      try {
        const subActive = el.contentDocument?.activeElement;
        if (subActive && subActive !== el.contentDocument.body) {
          el = subActive;
          continue;
        }
      } catch {}
    }
    break;
  }
  return el;
}

function setNativeValue(el, nextValue, fallbackWin) {
  const elWin = getWin(el, fallbackWin);
  const prevValue = el.value;
  const tag = el.tagName.toLowerCase();
  const proto =
    tag === "textarea"
      ? elWin?.HTMLTextAreaElement?.prototype
      : tag === "select"
        ? elWin?.HTMLSelectElement?.prototype
        : elWin?.HTMLInputElement?.prototype;
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
  if (desc && typeof desc.set === "function") {
    desc.set.call(el, nextValue);
  } else {
    el.value = nextValue;
  }
  // Reset React's internal value tracker so controlled inputs always fire onChange.
  const tracker = el._valueTracker;
  if (tracker && typeof tracker.setValue === "function") {
    tracker.setValue(prevValue);
  }
}

function makePointerEvent(elWin, type, init) {
  const Ctor = typeof elWin?.PointerEvent === "function" ? elWin.PointerEvent : elWin?.MouseEvent || Event;
  return new Ctor(type, init);
}

function makeMouseEvent(elWin, type, init) {
  const Ctor = typeof elWin?.MouseEvent === "function" ? elWin.MouseEvent : Event;
  return new Ctor(type, init);
}

function makeInputEvent(elWin, type, init) {
  const Ctor = typeof elWin?.InputEvent === "function" ? elWin.InputEvent : elWin?.Event || Event;
  return new Ctor(type, init);
}

function makeKeyboardEvent(elWin, type, init) {
  const Ctor = typeof elWin?.KeyboardEvent === "function" ? elWin.KeyboardEvent : elWin?.Event || Event;
  return new Ctor(type, init);
}

function dispatchSubmitOnForm(el) {
  const form = el.form || el.closest?.("form");
  if (!form) return false;
  if (typeof form.requestSubmit === "function") {
    try {
      if (isSubmitControl(el) && el.form === form) {
        form.requestSubmit(el);
      } else {
        form.requestSubmit();
      }
      return true;
    } catch {
      // Fall back to submit event if submitter isn't valid in form.
    }
  }
  const ev = new (getWin(form, globalThis).Event || Event)("submit", { bubbles: true, cancelable: true });
  if (form.dispatchEvent(ev) && typeof form.submit === "function") {
    form.submit();
  }
  return true;
}

function dispatchPointerClickSequence(el, win, coords, doubleClick) {
  const elWin = getWin(el, win);
  const r = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
  const clientX = Number.isFinite(coords?.x) ? coords.x : r.left + r.width / 2;
  const clientY = Number.isFinite(coords?.y) ? coords.y : r.top + r.height / 2;
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: elWin,
    clientX,
    clientY,
    screenX: clientX,
    screenY: clientY,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  };

  el.dispatchEvent(makePointerEvent(elWin, "pointerover", base));
  el.dispatchEvent(makePointerEvent(elWin, "pointerenter", { ...base, bubbles: false, composed: false }));
  el.dispatchEvent(makeMouseEvent(elWin, "mouseover", base));
  el.dispatchEvent(makeMouseEvent(elWin, "mouseenter", { ...base, bubbles: false, composed: false }));
  el.dispatchEvent(makePointerEvent(elWin, "pointermove", base));
  el.dispatchEvent(makeMouseEvent(elWin, "mousemove", base));

  const passes = doubleClick ? 2 : 1;
  const submitBtn = isSubmitControl(el) && Boolean(el.form || el.closest?.("form")) && !el.disabled;

  for (let i = 1; i <= passes; i++) {
    el.dispatchEvent(makePointerEvent(elWin, "pointerdown", { ...base, button: 0, buttons: 1, detail: i }));
    el.dispatchEvent(makeMouseEvent(elWin, "mousedown", { ...base, button: 0, buttons: 1, detail: i }));
    if (i === 1 && typeof el.focus === "function") {
      try {
        el.focus({ preventScroll: true });
      } catch {}
    }
    el.dispatchEvent(makePointerEvent(elWin, "pointerup", { ...base, button: 0, buttons: 0, detail: i }));
    el.dispatchEvent(makeMouseEvent(elWin, "mouseup", { ...base, button: 0, buttons: 0, detail: i }));

    if (submitBtn) {
      const form = el.form || el.closest?.("form");
      let activationHandled = false;
      const markHandled = () => {
        activationHandled = true;
      };
      if (form && i === passes) {
        form.addEventListener("submit", markHandled, { capture: true, once: true });
        form.addEventListener("invalid", markHandled, { capture: true, once: true });
      }
      let notPrevented = true;
      try {
        const clickEv = makeMouseEvent(elWin, "click", { ...base, button: 0, buttons: 0, detail: i });
        notPrevented = el.dispatchEvent(clickEv);
      } finally {
        if (form && i === passes) {
          form.removeEventListener("submit", markHandled, { capture: true });
          form.removeEventListener("invalid", markHandled, { capture: true });
        }
      }
      if (notPrevented && !activationHandled && i === passes) {
        dispatchSubmitOnForm(el);
      }
    } else if (i === 1 && typeof el.click === "function") {
      el.click();
    } else {
      el.dispatchEvent(makeMouseEvent(elWin, "click", { ...base, button: 0, buttons: 0, detail: i }));
    }
  }

  if (doubleClick) {
    el.dispatchEvent(makeMouseEvent(elWin, "dblclick", { ...base, button: 0, buttons: 0, detail: 2 }));
  }

  return { x: Math.round(clientX), y: Math.round(clientY) };
}

function selectOptionOnElement(el, opts, win) {
  const elWin = getWin(el, win);
  const options = [...(el.options || [])];
  if (!options.length) {
    return { ok: false, found: true, error: "Select element has no options." };
  }

  let match = null;
  if (typeof opts.index === "number" && Number.isInteger(opts.index) && opts.index >= 0 && opts.index < options.length) {
    match = options[opts.index];
  }
  const wantValue = opts.value != null ? String(opts.value) : null;
  const wantText = opts.label != null ? String(opts.label) : opts.text != null ? String(opts.text) : null;

  if (!match && wantValue != null) {
    match = options.find((o) => o.value === wantValue) || null;
  }
  if (!match && wantText != null) {
    const needle = cleanText(wantText).toLowerCase();
    match =
      options.find((o) => cleanText(o.text).toLowerCase() === needle) ||
      options.find((o) => cleanText(o.label || o.text).toLowerCase() === needle) ||
      options.find((o) => cleanText(o.value).toLowerCase() === needle) ||
      options.find((o) => cleanText(o.text).toLowerCase().includes(needle)) ||
      null;
  }
  if (!match && wantValue != null) {
    const needle = cleanText(wantValue).toLowerCase();
    match =
      options.find((o) => cleanText(o.text).toLowerCase() === needle) ||
      options.find((o) => cleanText(o.text).toLowerCase().includes(needle)) ||
      null;
  }
  if (!match) {
    return { ok: false, found: true, error: `Option not found in <select>: ${JSON.stringify(wantValue ?? wantText ?? opts.index)}` };
  }
  if (match.disabled) {
    return { ok: false, found: true, error: `Option "${cleanText(match.text)}" is disabled.` };
  }

  if (el.multiple) {
    match.selected = true;
  } else {
    setNativeValue(el, match.value, elWin);
    match.selected = true;
  }
  el.dispatchEvent(makeInputEvent(elWin, "input", { bubbles: true, composed: true }));
  el.dispatchEvent(new (elWin?.Event || Event)("change", { bubbles: true }));

  return {
    ok: true,
    found: true,
    selected: true,
    value: el.value,
    text: cleanText(match.text, 120),
  };
}

export function createDomDriver(win = globalThis) {
  const refs = new Map(); // ref -> Element (persists until next snapshot)
  const docToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const secretEntries = new Map(); // Element -> { kind, wasPassword }
  let docHadSensitiveFill = false;

  function pruneSecretEntries() {
    const doc = win.document;
    for (const [el] of [...secretEntries.entries()]) {
      if (!isLiveFilledElement(el, doc)) {
        secretEntries.delete(el);
        unmarkSecretElement(el, win);
      }
    }
  }

  function hasActiveSecretFields() {
    pruneSecretEntries();
    if (secretEntries.size === 0) {
      docHadSensitiveFill = false;
      return false;
    }
    if (docHadSensitiveFill) {
      for (const meta of secretEntries.values()) {
        if (isSensitiveSecretMeta(meta)) {
          return true;
        }
      }
      // All sensitive (password/secret/code) inputs have been emptied or removed by the SPA.
      secretEntries.clear();
      docHadSensitiveFill = false;
      return false;
    }
    return true;
  }

  function secretStatus(opts = {}) {
    const expectedToken = typeof opts.docToken === "string" ? opts.docToken : "";
    if (expectedToken && expectedToken !== docToken) {
      return { ok: true, sameDoc: false, active: false, docToken };
    }
    const active = hasActiveSecretFields();
    return { ok: true, sameDoc: true, active, docToken };
  }

  function resolveElement({ ref, selector, text, allowAllSameOrigin = false }) {
    const doc = win.document;
    if (ref) {
      const direct = refs.get(ref);
      if (direct && direct.isConnected) return direct;
      const byAttr = querySelectorDeep(doc, `[data-botkins-ref=${JSON.stringify(ref)}]`, { allowAllSameOrigin });
      if (byAttr) return byAttr;
      return null;
    }
    if (selector) {
      return querySelectorDeep(doc, selector, { allowAllSameOrigin });
    }
    if (text) {
      const needle = cleanText(text).toLowerCase();
      if (!needle) return null;
      let exact = null;
      let partial = null;
      walkTree(
        doc.documentElement || doc,
        (el) => {
          if (exact) return false;
          if (!isInteractiveElement(el) && el.tagName.toLowerCase() !== "label") return true;
          if (!isElementVisible(el, win)) return true;
          const label = computeAccessibleName(el).toLowerCase();
          if (!label) return true;
          if (label === needle) {
            exact = el;
            return false;
          }
          if (!partial && label.includes(needle)) {
            partial = el;
          }
          return true;
        },
        { allowAllSameOrigin, includeBlankIframes: true },
      );
      return exact || partial;
    }
    return null;
  }

  function snapshot(opts = {}) {
    const doc = win.document;
    const maxChars = Math.min(Math.max(Number(opts.maxChars) || 12000, 1000), 50000);
    const maxElements = Math.min(Math.max(Number(opts.maxElements) || 200, 1), 400);
    const allowAllSameOrigin = Boolean(opts.traverseSameOriginIframes);
    const includeBlankIframes = opts.includeBlankIframes !== false;

    for (const prevEl of refs.values()) {
      try {
        prevEl.removeAttribute?.("data-botkins-ref");
      } catch {}
    }
    refs.clear();
    const elements = [];
    let idx = 0;

    if (doc.documentElement) {
      walkTree(
        doc.documentElement,
        (el, ctx) => {
          if (elements.length >= maxElements) return false;
          if (!isInteractiveElement(el)) return true;
          if (!isElementVisible(el, win)) return true;

          const ref = "e" + ++idx;
          refs.set(ref, el);
          try {
            el.setAttribute("data-botkins-ref", ref);
          } catch {}

          const r = el.getBoundingClientRect();
          const box = {
            x: Math.round(r.left + ctx.offsetX),
            y: Math.round(r.top + ctx.offsetY),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
          const tag = el.tagName.toLowerCase();
          const role = implicitRole(el);
          const name = computeAccessibleName(el);
          const valueState = getValueState(el, win);

          const entry = {
            ref,
            tag,
            role,
            selector: cssPathWithinRoot(el),
            x: Math.round(box.x + box.width / 2),
            y: Math.round(box.y + box.height / 2),
            box,
          };

          if (tag === "input" && el.type) entry.type = el.type.toLowerCase();
          else if (tag === "button" && el.getAttribute("type")) entry.type = el.getAttribute("type").toLowerCase();

          if (tag === "input" || tag === "textarea" || tag === "select") {
            const rawName = (el.getAttribute("name") || "").trim();
            const rawId = (el.id || "").trim();
            if (rawName) entry.inputName = rawName.slice(0, 128);
            if (rawId) entry.id = rawId.slice(0, 128);
            const fieldKey = rawName || rawId;
            if (fieldKey) entry.fieldKey = fieldKey.slice(0, 128);
          }

          if (name) {
            entry.name = name;
            entry.text = name;
          } else if (tag !== "input" && tag !== "textarea" && tag !== "select") {
            const vis = cleanText(el.innerText || el.textContent || "", 120);
            if (vis) entry.text = vis;
          }

          Object.assign(entry, valueState);

          if (tag === "a" && el.href) entry.href = String(el.href).slice(0, 200);
          if ((tag === "input" || tag === "textarea") && el.placeholder) {
            entry.placeholder = cleanText(el.placeholder, 120);
          }
          if (el.disabled || el.getAttribute("aria-disabled") === "true") entry.disabled = true;
          if (el.required || el.getAttribute("aria-required") === "true") entry.required = true;
          if (el.readOnly || el.getAttribute("aria-readonly") === "true") entry.readonly = true;
          if (ctx.inShadow) entry.inShadow = true;

          elements.push(entry);
          return true;
        },
        { allowAllSameOrigin, includeBlankIframes },
      );
    }

    const textRoot = doc.body || doc.documentElement;
    const rawText = textRoot ? collectVisibleText(textRoot, win, { allowAllSameOrigin, includeBlankIframes, maxChars }) : "";

    return {
      ok: true,
      url: String(win.location?.href || ""),
      title: String(doc.title || ""),
      isTop: win === win.top,
      viewport: {
        width: Number(win.innerWidth || 0),
        height: Number(win.innerHeight || 0),
        scrollX: Math.round(Number(win.scrollX || 0)),
        scrollY: Math.round(Number(win.scrollY || 0)),
      },
      text: rawText.slice(0, maxChars),
      truncated: rawText.length > maxChars,
      elements,
    };
  }

  function click(opts = {}) {
    const doc = win.document;
    let el = null;
    let coords = null;

    if (Number.isFinite(Number(opts.x)) && Number.isFinite(Number(opts.y)) && !opts.ref && !opts.selector && !opts.text) {
      const x = Number(opts.x);
      const y = Number(opts.y);
      const hit = elementFromPointDeep(doc, x, y);
      if (hit.blockedIframe) {
        return {
          ok: false,
          found: false,
          error: "Target coordinates land on another browser extension's iframe (e.g. a password manager overlay).",
        };
      }
      if (hit.crossOriginIframe || !hit.el) {
        return { ok: false, found: false, needsCdp: true, reason: "coordinate-target", x, y };
      }
      el = hit.el;
      coords = { x, y };
    } else {
      el = resolveElement(opts);
      if (!el) return { ok: false, found: false, error: "Element not found for click." };
    }

    if (isFileInput(el)) {
      const r = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
      return {
        ok: false,
        found: true,
        needsCdp: true,
        reason: "file-input",
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        error: "File inputs require trusted click or CDP file upload.",
      };
    }

    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      } catch {
        el.scrollIntoView();
      }
    }

    const pos = dispatchPointerClickSequence(el, win, coords, Boolean(opts.doubleClick));
    return {
      ok: true,
      found: true,
      clicked: true,
      tag: el.tagName.toLowerCase(),
      x: pos.x,
      y: pos.y,
    };
  }

  function type(opts = {}) {
    const doc = win.document;
    const strText = String(opts.text ?? "");
    const clear = Boolean(opts.clear);
    const submit = Boolean(opts.submit);

    let el = null;
    if (opts.ref || opts.selector) {
      el = resolveElement(opts);
      if (!el) return { ok: false, found: false, error: "Input element not found." };
    } else {
      el = getActiveElementDeep(doc);
      if (!el || el === doc.body || el === doc.documentElement) {
        return { ok: false, found: false, error: "No focused input element." };
      }
    }

    if (isSecretProtectedElement(el, win)) {
      return {
        ok: false,
        found: true,
        secretProtected: true,
        error: SECRET_INPUT_REFUSED_ERROR,
      };
    }
    if (isFileInput(el)) {
      return {
        ok: false,
        found: true,
        needsCdp: true,
        reason: "file-input",
        error: "File inputs cannot be filled by typing; use CDP DOM.setFileInputFiles.",
      };
    }
    if (el.disabled) {
      return { ok: false, found: true, error: "Target input element is disabled." };
    }

    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      } catch {
        el.scrollIntoView();
      }
    }

    const elWin = getWin(el, win);
    if (typeof el.focus === "function") {
      try {
        el.focus({ preventScroll: true });
      } catch {}
    }

    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const selRes = selectOptionOnElement(el, { value: strText, text: strText }, elWin);
      if (!selRes.ok) return selRes;
      return { ok: true, found: true, typed: true, selected: true, length: strText.length, value: selRes.value };
    }

    if (tag === "input" || tag === "textarea") {
      const existing = String(el.value ?? "");
      let nextValue;
      let caretPos = null;
      if (clear) {
        nextValue = strText;
        caretPos = strText.length;
      } else {
        let canSelect = false;
        try {
          canSelect = typeof el.selectionStart === "number" && typeof el.selectionEnd === "number";
        } catch {}
        if (canSelect) {
          const start = el.selectionStart;
          const end = el.selectionEnd;
          nextValue = existing.slice(0, start) + strText + existing.slice(end);
          caretPos = start + strText.length;
        } else {
          nextValue = existing + strText;
        }
      }

      const keyChar = strText.length > 0 ? strText[strText.length - 1] : clear ? "Backspace" : "Unidentified";
      const inputType = clear && strText.length === 0 ? "deleteContentBackward" : "insertText";

      el.dispatchEvent(makeKeyboardEvent(elWin, "keydown", { key: keyChar, bubbles: true, cancelable: true, composed: true }));
      el.dispatchEvent(
        makeInputEvent(elWin, "beforeinput", {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType,
          data: strText.length > 0 ? strText : null,
        }),
      );

      setNativeValue(el, nextValue, elWin);
      if (caretPos != null && typeof el.setSelectionRange === "function") {
        try {
          el.setSelectionRange(caretPos, caretPos);
        } catch {}
      }

      el.dispatchEvent(
        makeInputEvent(elWin, "input", {
          bubbles: true,
          composed: true,
          inputType,
          data: strText.length > 0 ? strText : null,
        }),
      );
      el.dispatchEvent(makeKeyboardEvent(elWin, "keyup", { key: keyChar, bubbles: true, composed: true }));
      el.dispatchEvent(new (elWin?.Event || Event)("change", { bubbles: true }));
    } else if (isContentEditableEl(el)) {
      const inputType = clear && strText.length === 0 ? "deleteContentBackward" : "insertText";
      el.dispatchEvent(
        makeInputEvent(elWin, "beforeinput", {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType,
          data: strText.length > 0 ? strText : null,
        }),
      );
      if (clear) {
        el.textContent = strText;
      } else {
        el.textContent = (el.textContent || "") + strText;
      }
      el.dispatchEvent(
        makeInputEvent(elWin, "input", {
          bubbles: true,
          composed: true,
          inputType,
          data: strText.length > 0 ? strText : null,
        }),
      );
      el.dispatchEvent(makeKeyboardEvent(elWin, "keyup", { key: strText.slice(-1) || "Unidentified", bubbles: true, composed: true }));
      el.dispatchEvent(new (elWin?.Event || Event)("change", { bubbles: true }));
    } else {
      return { ok: false, found: true, needsCdp: true, reason: "non-editable", error: "Element is not editable via DOM." };
    }

    if (submit) {
      const enterInit = {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
      };
      const kd = makeKeyboardEvent(elWin, "keydown", enterInit);
      const notPrevented = el.dispatchEvent(kd);
      el.dispatchEvent(makeKeyboardEvent(elWin, "keypress", { ...enterInit, charCode: 13 }));
      if (notPrevented && tag !== "textarea") {
        dispatchSubmitOnForm(el);
      }
      el.dispatchEvent(makeKeyboardEvent(elWin, "keyup", enterInit));
    }

    return { ok: true, found: true, typed: true, length: strText.length };
  }

  function select(opts = {}) {
    const el = resolveElement(opts);
    if (!el) return { ok: false, found: false, error: "Select element not found." };
    if (isSecretProtectedElement(el, win)) {
      return {
        ok: false,
        found: true,
        secretProtected: true,
        error: SECRET_INPUT_REFUSED_ERROR,
      };
    }
    if (el.tagName.toLowerCase() !== "select") {
      return { ok: false, found: true, error: `Element <${el.tagName.toLowerCase()}> is not a <select>.` };
    }
    if (el.disabled) return { ok: false, found: true, error: "Select element is disabled." };
    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      } catch {
        el.scrollIntoView();
      }
    }
    try {
      el.focus?.({ preventScroll: true });
    } catch {}
    return selectOptionOnElement(el, opts, win);
  }

  function press(opts = {}) {
    const doc = win.document;
    const target = getActiveElementDeep(doc) || doc.body || doc.documentElement;
    if (!target) return { ok: false, needsCdp: true, error: "No target element for key press." };

    const elWin = getWin(target, win);
    const modifiers = Number(opts.modifiers) || 0;
    const init = {
      key: String(opts.key || "Enter"),
      code: String(opts.code || opts.key || "Enter"),
      keyCode: Number(opts.windowsVirtualKeyCode) || 0,
      which: Number(opts.windowsVirtualKeyCode) || 0,
      altKey: Boolean(modifiers & 1),
      ctrlKey: Boolean(modifiers & 2),
      metaKey: Boolean(modifiers & 4),
      shiftKey: Boolean(modifiers & 8),
      bubbles: true,
      cancelable: true,
      composed: true,
    };

    const kd = makeKeyboardEvent(elWin, "keydown", init);
    const notPrevented = target.dispatchEvent(kd);

    const printable = typeof opts.text === "string" && opts.text.length > 0 && !init.ctrlKey && !init.metaKey && !init.altKey;
    if (notPrevented && (printable || init.key === "Enter")) {
      const charCode = init.key === "Enter" ? 13 : opts.text.charCodeAt(0);
      target.dispatchEvent(makeKeyboardEvent(elWin, "keypress", { ...init, charCode }));
    }

    if (notPrevented) {
      const tag = target.tagName?.toLowerCase() || "";
      const role = (target.getAttribute?.("role") || "").toLowerCase();

      if (init.key === "Enter") {
        if (tag === "input" && !["button", "submit", "reset", "checkbox", "radio"].includes((target.type || "").toLowerCase())) {
          dispatchSubmitOnForm(target);
        } else if (tag === "button" || tag === "a" || role === "button" || role === "link") {
          if (isSubmitControl(target) && (target.form || target.closest?.("form"))) {
            dispatchSubmitOnForm(target);
          } else {
            target.click?.();
          }
        }
      } else if (init.key === " " || init.code === "Space") {
        if (
          tag === "button" ||
          role === "button" ||
          role === "checkbox" ||
          (tag === "input" && ["checkbox", "radio", "button", "submit"].includes((target.type || "").toLowerCase()))
        ) {
          target.click?.();
        }
      } else if ((init.ctrlKey || init.metaKey) && init.key.toLowerCase() === "a") {
        if ((tag === "input" || tag === "textarea") && typeof target.select === "function") {
          target.select();
        }
      } else if (init.key === "Backspace" && (tag === "input" || tag === "textarea") && !target.readOnly && !target.disabled) {
        const val = String(target.value ?? "");
        let start = val.length;
        let end = val.length;
        try {
          if (typeof target.selectionStart === "number" && typeof target.selectionEnd === "number") {
            start = target.selectionStart;
            end = target.selectionEnd;
          }
        } catch {}
        const nextVal = start !== end ? val.slice(0, start) + val.slice(end) : start > 0 ? val.slice(0, start - 1) + val.slice(end) : val;
        if (nextVal !== val) {
          setNativeValue(target, nextVal, elWin);
          target.dispatchEvent(makeInputEvent(elWin, "input", { bubbles: true, composed: true, inputType: "deleteContentBackward" }));
        }
      } else if (init.key === "Tab") {
        const focusables = [];
        walkTree(
          doc.documentElement || doc,
          (el) => {
            if (!isElementVisible(el, win)) return true;
            if (el.disabled) return true;
            const t = el.tagName.toLowerCase();
            const tabIdx = el.getAttribute("tabindex");
            const isFocusable =
              ["input", "textarea", "select", "button", "summary"].includes(t) ||
              (t === "a" && el.hasAttribute("href")) ||
              isContentEditableEl(el) ||
              (tabIdx !== null && Number(tabIdx) >= 0);
            if (isFocusable && tabIdx !== "-1") focusables.push(el);
            return true;
          },
          { allowAllSameOrigin: false, includeBlankIframes: true },
        );
        if (focusables.length) {
          const curIdx = focusables.indexOf(target);
          const nextIdx = init.shiftKey
            ? curIdx <= 0
              ? focusables.length - 1
              : curIdx - 1
            : curIdx < 0 || curIdx >= focusables.length - 1
              ? 0
              : curIdx + 1;
          focusables[nextIdx]?.focus?.();
        }
      }
    }

    target.dispatchEvent(makeKeyboardEvent(elWin, "keyup", init));
    return { ok: true, pressed: String(opts.rawKey || opts.key || "") };
  }

  function scroll(opts = {}) {
    const doc = win.document;
    const dir = opts.direction || "down";
    const amount = Math.min(Math.max(Number(opts.amount) || 600, 50), 10000);
    let target = null;
    if (opts.ref || opts.selector) {
      target = resolveElement(opts);
      if (!target) return { ok: false, found: false, error: "Scroll target element not found." };
    }
    const scroller = target || doc.scrollingElement || doc.documentElement || doc.body;
    if (!scroller) return { ok: false, error: "No scrollable element available." };

    if (dir === "top") {
      scroller.scrollTop = 0;
    } else if (dir === "bottom") {
      scroller.scrollTop = scroller.scrollHeight;
    } else if (dir === "up") {
      if (typeof scroller.scrollBy === "function") scroller.scrollBy(0, -amount);
      else scroller.scrollTop = Math.max(0, (scroller.scrollTop || 0) - amount);
    } else {
      if (typeof scroller.scrollBy === "function") scroller.scrollBy(0, amount);
      else scroller.scrollTop = (scroller.scrollTop || 0) + amount;
    }

    return {
      ok: true,
      found: true,
      scrollX: Math.round(target ? scroller.scrollLeft : scroller.scrollLeft || win.scrollX || 0),
      scrollY: Math.round(target ? scroller.scrollTop : scroller.scrollTop || win.scrollY || 0),
      scrollHeight: Number(scroller.scrollHeight || 0),
    };
  }

  function checkWait(opts = {}) {
    const doc = win.document;
    const sel = opts.selector || "";
    const txt = opts.text || "";
    const allowAllSameOrigin = Boolean(opts.traverseSameOriginIframes);
    if (sel && !querySelectorDeep(doc, sel, { allowAllSameOrigin })) {
      return { ok: true, matched: false };
    }
    if (txt) {
      const textRoot = doc.body || doc.documentElement;
      const visible = textRoot ? collectVisibleText(textRoot, win, { allowAllSameOrigin, includeBlankIframes: true, maxChars: 200000 }) : "";
      if (!visible.includes(txt)) return { ok: true, matched: false };
    }
    return { ok: true, matched: true };
  }

  function probe(opts = {}) {
    if (opts.focused) {
      const doc = win.document;
      const el = getActiveElementDeep(doc);
      const found = Boolean(el && el !== doc.body && el !== doc.documentElement);
      return { ok: true, found };
    }
    const el = resolveElement(opts);
    return { ok: true, found: Boolean(el) };
  }

  function isSameOriginSecureDoc(doc, expectedOrigin, ownerDoc) {
    if (!doc) return false;
    try {
      const origin = String(doc.location?.origin || "");
      if (origin && origin === expectedOrigin) return true;
      const href = String(doc.location?.href || "").toLowerCase();
      if ((href === "about:blank" || href === "about:srcdoc") && ownerDoc) {
        return String(ownerDoc.location?.origin || "") === expectedOrigin;
      }
    } catch {}
    return false;
  }

  function walkSecureTree(root, doc, expectedOrigin, visitor) {
    if (!root) return;
    const children = root.children || [];
    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      if (!el || el.nodeType !== 1) continue;
      const tag = el.tagName.toLowerCase();
      if (tag === "iframe") {
        if (isBlockedIframe(el)) continue;
        try {
          const subDoc = el.contentDocument;
          if (subDoc && subDoc.documentElement && isSameOriginSecureDoc(subDoc, expectedOrigin, doc)) {
            walkSecureTree(subDoc.documentElement, subDoc, expectedOrigin, visitor);
          }
        } catch {}
        continue;
      }
      if (visitor(el, doc) === false) continue;
      if (el.shadowRoot) {
        walkSecureTree(el.shadowRoot, doc, expectedOrigin, visitor);
      }
      if (el.children && el.children.length > 0) {
        walkSecureTree(el, doc, expectedOrigin, visitor);
      }
    }
  }

  function isSecureFieldTypeCompatible(el, kind) {
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return false;
    const inputType = tag === "input" ? (el.type || "text").toLowerCase() : "";
    const disallowed = new Set([
      "hidden",
      "submit",
      "button",
      "reset",
      "image",
      "file",
      "checkbox",
      "radio",
      "range",
      "color",
      "date",
      "datetime-local",
      "month",
      "time",
      "week",
    ]);
    if (tag === "input" && disallowed.has(inputType)) return false;
    if (kind === "password") {
      return tag === "input" && inputType === "password";
    }
    if (kind === "code") {
      return tag === "input" && ["text", "tel", "number", "password", "search"].includes(inputType);
    }
    if (kind === "secret") {
      return tag === "textarea" || (tag === "input" && ["password", "text", "search"].includes(inputType));
    }
    // kind === "text" (default)
    return tag === "textarea" || (tag === "input" && ["text", "email", "tel", "search", "url", "number"].includes(inputType));
  }

  const isLoopbackHost = (host) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

  // The approved origin must hold for this frame AND the top frame, over HTTPS
  // (loopback HTTP only when the host opted in with allowLocalHttp).
  function secureFrameOriginOk(expectedOrigin, allowLocalHttp) {
    try {
      const loc = win.location;
      if (!loc || String(loc.origin || "") !== expectedOrigin) return false;
      if (loc.username || loc.password) return false;
      if (loc.protocol !== "https:" && !(allowLocalHttp && loc.protocol === "http:" && isLoopbackHost(loc.hostname))) return false;
      if (win !== win.top && String(win.top.location.origin || "") !== expectedOrigin) return false;
      return true;
    } catch {
      return false;
    }
  }

  // Read attributes and form ownership through the prototypes so a page cannot clobber
  // `form.action` (e.g. with <input name="action">) to hide an off-site destination.
  const secureGetAttr = (el, name) => (el ? Element.prototype.getAttribute.call(el, name) : null);
  const secureHasAttr = (el, name) => Boolean(el && Element.prototype.hasAttribute.call(el, name));
  const secureTagOf = (el) => {
    if (!el) return "";
    const getter = Object.getOwnPropertyDescriptor(Element.prototype, "tagName")?.get;
    return String(getter ? getter.call(el) : el.tagName || "").toLowerCase();
  };

  function isSameSiteSubmitDestination(rawAttr, targetDoc, expectedOrigin) {
    try {
      const trimmed = rawAttr === null || rawAttr === undefined ? "" : String(rawAttr).trim();
      const docUrl = targetDoc?.URL || "";
      // Per HTML, a missing or empty action/formaction submits to the document URL (not <base href>).
      const resolvedUrl = trimmed ? new URL(trimmed, targetDoc?.baseURI || docUrl) : new URL(docUrl);
      return isSameSite(resolvedUrl, expectedOrigin);
    } catch {
      return false;
    }
  }

  function secureFormOf(el, targetDoc, targetWin) {
    if (!el) return null;
    if (secureHasAttr(el, "form")) {
      const formId = secureGetAttr(el, "form");
      if (!formId) return null;
      const byId = targetDoc?.getElementById?.(formId);
      return byId && secureTagOf(byId) === "form" ? byId : null;
    }
    const tag = secureTagOf(el);
    const proto = tag === "input" ? targetWin?.HTMLInputElement?.prototype
      : tag === "button" ? targetWin?.HTMLButtonElement?.prototype
      : tag === "textarea" ? targetWin?.HTMLTextAreaElement?.prototype
      : tag === "select" ? targetWin?.HTMLSelectElement?.prototype
      : null;
    const getter = proto ? Object.getOwnPropertyDescriptor(proto, "form")?.get : null;
    if (getter) {
      const own = getter.call(el);
      if (own && secureTagOf(own) === "form") return own;
    }
    const closest = Element.prototype.closest.call(el, "form");
    return closest && secureTagOf(closest) === "form" ? closest : null;
  }

  function isSecureSubmitControl(el) {
    const tag = secureTagOf(el);
    const t = (secureGetAttr(el, "type") || "").trim().toLowerCase();
    if (tag === "button") return !t || (t !== "button" && t !== "reset");
    if (tag === "input") return t === "submit" || t === "image";
    return false;
  }

  // The form's submitters, including external `form=` ones, in document order.
  function secureSubmittersOf(form, elDoc, elWin) {
    const controls = elDoc?.querySelectorAll ? elDoc.querySelectorAll("button, input") : [];
    const out = [];
    for (const ctrl of controls) {
      if (isSecureSubmitControl(ctrl) && secureFormOf(ctrl, elDoc, elWin) === form) out.push(ctrl);
    }
    return out;
  }

  // Where submitting the filled field would send it must be on the approved page's site
  // (same scheme and registrable domain): the form's action and every submitter's formaction.
  // No form or no action submits to the page itself, which passes.
  function secureSubmitDestinationOk(el, expectedOrigin) {
    const elDoc = el.ownerDocument;
    const elWin = getWin(el, win);
    if (secureHasAttr(el, "form") && !secureFormOf(el, elDoc, elWin)) return false;
    const form = secureFormOf(el, elDoc, elWin);
    if (!form) return isSameSiteSubmitDestination(null, elDoc, expectedOrigin);
    if (!isSameSiteSubmitDestination(secureGetAttr(form, "action"), elDoc, expectedOrigin)) return false;
    for (const ctrl of secureSubmittersOf(form, elDoc, elWin)) {
      if (secureHasAttr(ctrl, "formaction") &&
          !isSameSiteSubmitDestination(secureGetAttr(ctrl, "formaction"), elDoc, expectedOrigin)) return false;
    }
    return true;
  }

  function secureSubmit(lastEl) {
    const elDoc = lastEl.ownerDocument;
    const elWin = getWin(lastEl, win);
    const form = secureFormOf(lastEl, elDoc, elWin);
    const submitBtn = form
      ? secureSubmittersOf(form, elDoc, elWin).find((c) => !c.disabled && isElementVisible(c, elWin))
      : null;
    if (submitBtn) {
      dispatchPointerClickSequence(submitBtn, elWin, null, false);
      return;
    }
    const enterInit = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    const notPrevented = lastEl.dispatchEvent(makeKeyboardEvent(elWin, "keydown", enterInit));
    lastEl.dispatchEvent(makeKeyboardEvent(elWin, "keypress", { ...enterInit, charCode: 13 }));
    if (notPrevented && secureTagOf(lastEl) !== "textarea") dispatchSubmitOnForm(lastEl);
    lastEl.dispatchEvent(makeKeyboardEvent(elWin, "keyup", enterInit));
  }

  function secureFill(opts = {}) {
    const fields = Array.isArray(opts.fields) ? opts.fields : [];
    const expectedOrigin = String(opts.origin || "").trim();
    const allowLocalHttp = opts.allowLocalHttp === true;
    const resolved = [];
    try {
      if (!expectedOrigin || !secureFrameOriginOk(expectedOrigin, allowLocalHttp)) {
        return {
          ok: false,
          code: "origin_mismatch",
          error: "Tab origin does not match the approved origin.",
        };
      }

      const doc = win.document;
      if (!doc?.documentElement) {
        return { ok: true, filled: [], missing: fields.map((f) => String(f?.key || "")).filter(Boolean) };
      }

      const candidates = [];
      walkSecureTree(doc.documentElement, doc, expectedOrigin, (el, ownerDoc) => {
        const tag = el.tagName.toLowerCase();
        if (tag !== "input" && tag !== "textarea") return true;
        if (tag === "input" && (el.type || "").toLowerCase() === "hidden") return true;
        if (el.disabled || el.readOnly) return true;
        const elWin = getWin(el, win);
        if (!isElementVisible(el, elWin)) return true;
        candidates.push({
          el,
          ownerDoc,
          name: el.getAttribute("name") || "",
          id: el.id || "",
        });
        return true;
      });

      const missing = [];
      for (const field of fields) {
        const key = String(field?.key || "");
        const kind = String(field?.kind || "text");
        const value = typeof field?.value === "string" ? field.value : "";
        if (!key) continue;

        let matched = candidates.filter((c) => c.name === key);
        if (matched.length === 0) {
          matched = candidates.filter((c) => c.id === key);
        }
        if (matched.length === 0) {
          missing.push(key);
          continue;
        }

        const compatible = matched.find((c) => isSecureFieldTypeCompatible(c.el, kind));
        if (!compatible) {
          if (kind === "password") {
            return {
              ok: false,
              code: "password_type_mismatch",
              error: `Refused to fill password field "${key}" into a non-password input.`,
            };
          }
          return {
            ok: false,
            code: "type_mismatch",
            error: `Refused to fill field "${key}" into an incompatible input type.`,
          };
        }

        resolved.push({ key, kind, value, el: compatible.el, ownerDoc: compatible.ownerDoc });
      }

      // Re-verify this frame's and the top frame's origin immediately before writing values.
      if (!secureFrameOriginOk(expectedOrigin, allowLocalHttp)) {
        return {
          ok: false,
          code: "origin_mismatch",
          error: "Tab origin changed before filling.",
        };
      }

      const filled = [];
      for (const item of resolved) {
        if (!isSameOriginSecureDoc(item.ownerDoc, expectedOrigin, doc)) {
          return {
            ok: false,
            code: "origin_mismatch",
            error: "Frame origin no longer matches the approved origin.",
          };
        }
        const el = item.el;
        const elWin = getWin(el, win);
        if (typeof el.scrollIntoView === "function") {
          try {
            el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          } catch {}
        }
        if (typeof el.focus === "function") {
          try {
            el.focus({ preventScroll: true });
          } catch {}
        }
        setNativeValue(el, item.value, elWin);
        const meta = { kind: item.kind, wasPassword: isPasswordInput(el) };
        secretEntries.set(el, meta);
        if (isSensitiveSecretMeta(meta)) {
          docHadSensitiveFill = true;
          markSecretElement(el, meta, elWin);
        }
        el.dispatchEvent(
          makeInputEvent(elWin, "input", {
            bubbles: true,
            composed: true,
            inputType: "insertText",
          }),
        );
        el.dispatchEvent(new (elWin?.Event || Event)("change", { bubbles: true }));
        filled.push(item.key);
      }

      let submitted = false;
      let submitRefused = "";
      if (opts.submit === true && resolved.length > 0) {
        const lastEl = resolved[resolved.length - 1].el;
        if (!secureFrameOriginOk(expectedOrigin, allowLocalHttp)) {
          submitRefused = "origin_changed";
        } else if (!resolved.every((item) => secureSubmitDestinationOk(item.el, expectedOrigin))) {
          submitRefused = "cross_site_action";
        } else {
          secureSubmit(lastEl);
          submitted = true;
        }
      }

      const secretActive = filled.length > 0 ? hasActiveSecretFields() : false;
      return { ok: true, filled, missing, docToken, secretActive, submitted, ...(submitRefused && { submitRefused }) };
    } finally {
      for (const item of resolved) {
        item.value = "";
        item.el = null;
        item.ownerDoc = null;
      }
      resolved.length = 0;
      for (const field of fields) {
        if (field && typeof field === "object") {
          field.value = "";
        }
      }
    }
  }

  function dispatch(action, payload = {}) {
    switch (action) {
      case "snapshot":
        return snapshot(payload);
      case "click":
        return click(payload);
      case "type":
        return type(payload);
      case "select":
        return select(payload);
      case "press":
        return press(payload);
      case "scroll":
        return scroll(payload);
      case "checkWait":
        return checkWait(payload);
      case "probe":
        return probe(payload);
      case "secureFill":
        return secureFill(payload);
      case "secretStatus":
        return secretStatus(payload);
      default:
        return { ok: false, error: `Unknown DOM driver action: ${action}` };
    }
  }

  return {
    version: DRIVER_VERSION,
    docToken,
    refs,
    snapshot,
    click,
    type,
    select,
    press,
    scroll,
    checkWait,
    probe,
    secureFill,
    secretStatus,
    dispatch,
  };
}

export function installDomDriver(win = globalThis) {
  if (win.__botkinsDomDriver?.version === DRIVER_VERSION) {
    return win.__botkinsDomDriver;
  }
  const driver = createDomDriver(win);
  win.__botkinsDomDriver = driver;
  return driver;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  installDomDriver(window);
}
