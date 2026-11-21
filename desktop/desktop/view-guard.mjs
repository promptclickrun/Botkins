// What a page a bot wrote runs first, before the app's bridge and before any of its own code: a
// custom view in a panel or a chat card (desktop/frames.mjs) and an HTML app in its own window
// (desktop/app-window.mjs).
//
// A view's policy lets nothing load (FRAME_CSP), but a policy has no word for peer-to-peer
// connections: with `RTCPeerConnection` a page could open a TCP connection to a TURN server of its
// choosing and carry data out in it. The app stops UDP for the whole window
// (`disable_non_proxied_udp`), which does not stop TCP, and the window itself needs WebRTC for live
// voice. So the ways to open such a connection are taken away from the page here.
//
// A frame inside the page would be a window of its own, with all of that back in it, and no policy
// forbids an empty or inline one (`frame-src 'none'` does not). So no frame is ever left in a
// view's page: each is taken out the moment it is put in, before anything in it can run (a frame's
// own code starts in a later turn, and a sandboxed page cannot reach into an empty one). The
// nested-frame part follows the shared page's guard (mobile/relay/src/space-frame.js.txt).

/** Runs in the page's own world. It keeps the functions it uses, so the page cannot swap them. */
export const VIEW_GUARD = String.raw`(() => {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate", "RTCRtpSender", "RTCRtpReceiver", "WebTransport"]) {
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  }
  const un = (fn) => Function.prototype.call.bind(fn);
  const getter = (proto, name) => un(Object.getOwnPropertyDescriptor(proto, name).get);
  const matches = un(Element.prototype.matches);
  const queryAll = un(Element.prototype.querySelectorAll);
  const removeNode = un(Element.prototype.remove);
  const addedOf = getter(MutationRecord.prototype, "addedNodes");
  const countOf = getter(NodeList.prototype, "length");
  const itemOf = un(NodeList.prototype.item);
  const observe = un(MutationObserver.prototype.observe);
  const Observer = MutationObserver;
  const NESTED = "iframe,frame,object,embed,portal,fencedframe";
  const drop = (node) => {
    try {
      if (matches(node, NESTED)) return removeNode(node);
      const inside = queryAll(node, NESTED);
      for (let i = countOf(inside) - 1; i >= 0; i--) removeNode(itemOf(inside, i));
    } catch (e) {
      // Not an element (text, a comment): nothing to take out.
    }
  };
  const watch = (root) =>
    observe(
      new Observer((records) => {
        for (let r = 0; r < records.length; r++) {
          const added = addedOf(records[r]);
          for (let i = countOf(added) - 1; i >= 0; i--) drop(itemOf(added, i));
        }
      }),
      root,
      { childList: true, subtree: true },
    );
  watch(document);
  // What is inside a shadow root is not seen from the document, so each one made is watched too,
  // and the ways to make one from markup are removed. (The page's own markup is served without
  // the attribute that makes one: unshadow() below.)
  const attach = Element.prototype.attachShadow;
  if (attach) {
    const attachTo = un(attach);
    Object.defineProperty(Element.prototype, "attachShadow", {
      value: function attachShadow(init) {
        const root = attachTo(this, init);
        watch(root);
        return root;
      },
      writable: false,
      configurable: false,
    });
  }
  for (const [owner, name] of [[Element.prototype, "setHTMLUnsafe"], [typeof ShadowRoot === "function" ? ShadowRoot.prototype : null, "setHTMLUnsafe"], [Document, "parseHTMLUnsafe"]]) {
    try { if (owner && name in owner) Object.defineProperty(owner, name, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  }
  // Markup written into the page while it loads is read by the same parser, so the attribute is
  // unnamed there too. (By hand: the usual ways to search a string can be swapped by a page.)
  const codeAt = un(String.prototype.charCodeAt);
  const sliceOf = un(String.prototype.slice);
  const WORD = "shadowroot";
  const plain = (value) => {
    const html = "" + value;
    let out = "";
    let from = 0;
    for (let i = 0; i + WORD.length <= html.length; i++) {
      let hit = true;
      for (let j = 0; j < WORD.length && hit; j++) hit = (codeAt(html, i + j) | 32) === codeAt(WORD, j);
      if (!hit) continue;
      out += sliceOf(html, from, i) + "data-no-";
      from = i;
    }
    return out + sliceOf(html, from);
  };
  const writeTo = un(Document.prototype.write);
  for (const name of ["write", "writeln"]) {
    Object.defineProperty(Document.prototype, name, {
      value: function (...parts) {
        let text = "";
        for (let i = 0; i < parts.length; i++) text += parts[i];
        return writeTo(this, plain(text) + (name === "writeln" ? "\n" : ""));
      },
      writable: false,
      configurable: false,
    });
  }
})();`;

/**
 * A page's own markup without the attribute that makes a shadow root as the page is read
 * (`shadowrootmode` on a template): what is inside such a root would be hidden from the guard.
 * The word is unnamed wherever it stands; in a page's text that changes nothing a person sees
 * in a view.
 */
export const unshadow = (html) => String(html).replace(/shadowroot/gi, "data-no-shadowroot");

/**
 * A page as it is served: the guard first, in a script of its own at the very start of the
 * document, so nothing of the page can run before it, whatever the page's markup begins with.
 * `rest` is the page with the app's own additions already in it (the bot's part unshadowed).
 */
export const guardedPage = (rest) => "<!doctype html><script>" + VIEW_GUARD + "</script>" + rest;
