// A page that tries to reach the network through WebRTC, for smokes of the places a bot's page is
// shown (a custom view, an HTML app's window). WebRTC is not under a page's content policy, so a
// page could open a TCP connection to a TURN server of its choosing. The probe tries that from the
// page itself and from every kind of frame a page can make inside itself, against listeners of the
// test's own on ports the system picks. Nothing may arrive, and no nested frame may run at all.
import { createSocket } from "node:dgram";
import { createServer } from "node:net";

/** One TCP and one UDP listener on this computer only, counting what reaches them. */
export async function probeListeners() {
  const heard = { tcp: 0, udp: 0 };
  const tcp = createServer((socket) => {
    heard.tcp++;
    socket.destroy();
  });
  await new Promise((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const udp = createSocket("udp4");
  udp.on("message", () => heard.udp++);
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
  return { heard, tcpPort: tcp.address().port, udpPort: udp.address().port, close: () => (tcp.close(), udp.close()) };
}

const attr = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
/** A string as code inside a page's script: its "</script>" must not end that script. */
const js = (text) => JSON.stringify(text).replace(/<\//g, "<\\/");

/**
 * The probe's page. `window.probe` says what the page found: `has` (the type of
 * RTCPeerConnection in the page), `tried` (what happened when it tried to connect) and `nested`
 * (one entry for every nested frame whose code ran, which must be none).
 */
export function probePage({ tcpPort, udpPort }) {
  // TURN over TCP and STUN over UDP, to this test's listeners.
  const connect =
    "try { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'turn:127.0.0.1:" + tcpPort + "?transport=tcp', username: 'probe', credential: 'x' }, { urls: 'stun:127.0.0.1:" + udpPort + "' }] });" +
    " pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o)); self.rtcTried = 'made'; } catch (e) { self.rtcTried = 'refused'; }";
  // What a nested frame would run: the same try, and a word to the page that it ran.
  const nested = (name) => connect + " parent.postMessage({ probeNested: '" + name + "', has: typeof RTCPeerConnection }, '*');";
  const srcdoc = (name) => "<script>" + nested(name) + "</" + "script>";
  return `<!doctype html><html><head><title>Probe</title></head><body>
<p id="probe-title">Probe</p>
<iframe srcdoc="${attr(srcdoc("markup"))}"></iframe>
<div><template shadowrootmode="open"><iframe srcdoc="${attr(srcdoc("shadow markup"))}"></iframe></template></div>
<script>
  window.probe = { has: typeof RTCPeerConnection, nested: [], errors: [] };
  addEventListener("message", (e) => { if (e.data && e.data.probeNested) probe.nested.push(e.data.probeNested + ":" + e.data.has); });
  ${connect}
  probe.tried = self.rtcTried;
  const attempt = (name, make) => { try { make(); } catch (e) { probe.errors.push(name + ": " + e.message); } };
  const frame = (set) => { const f = document.createElement("iframe"); set(f); return f; };
  attempt("srcdoc", () => document.body.appendChild(frame((f) => (f.srcdoc = ${js(srcdoc("srcdoc"))}))));
  attempt("javascript", () => document.body.appendChild(frame((f) => (f.src = ${js("javascript:" + nested("javascript") + " ''")}))));
  // An empty frame's window is there at once. Where the page may reach into it, it tries to connect with what it finds there.
  attempt("blank", () => {
    const f = document.body.appendChild(frame(() => {}));
    const C = f.contentWindow && f.contentWindow.RTCPeerConnection;
    if (!C) return;
    probe.borrowed = typeof C;
    const pc = new C({ iceServers: [{ urls: "turn:127.0.0.1:${tcpPort}?transport=tcp", username: "probe", credential: "x" }, { urls: "stun:127.0.0.1:${udpPort}" }] });
    pc.createDataChannel("x");
    pc.createOffer().then((o) => pc.setLocalDescription(o));
  });
  attempt("shadow", () => { const host = document.body.appendChild(document.createElement("div")); host.attachShadow({ mode: "closed" }).appendChild(frame((f) => (f.srcdoc = ${js(srcdoc("shadow"))}))); });
  attempt("inner", () => { const box = document.body.appendChild(document.createElement("div")); box.innerHTML = ${js('<section><iframe srcdoc="' + attr(srcdoc("innerHTML")) + '"></iframe></section>')}; });
  attempt("object", () => { const o = document.createElement("object"); o.data = "data:text/html," + encodeURIComponent(${js(srcdoc("object"))}); document.body.appendChild(o); });
  document.write(${js('<iframe srcdoc="' + attr(srcdoc("written")) + '"></iframe><div><template shadowrootmode="open"><iframe srcdoc="' + attr(srcdoc("written shadow")) + '"></iframe></template></div>')});
  // After the page has loaded, once more: a frame made later is taken out the same way.
  addEventListener("load", () => setTimeout(() => attempt("late", () => document.body.appendChild(frame((f) => (f.srcdoc = ${js(srcdoc("late"))})))), 300));
</script></body></html>`;
}
