import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Monitor, MousePointer2, X } from "lucide-react";
import { Modal } from "./WikiDialogs";
import { errorText } from "./SettingsRows";
import { playComputerVideo, videoFormats } from "./computerVideo";
import type { ComputerScreenInfo, ComputerScreenInput, State } from "./types";

type Host = NonNullable<NonNullable<State["remote"]>["using"]>;
type Point = { x: number; y: number };
type Send = (event: ComputerScreenInput) => void;

export function ComputerScreenGate({ host, open }: { host: Host; open: () => void }) {
  return <div className="int-section pane-screen">
    <p className="pane-screen-note">{host.member ? "Only an owner device can view this computer." : host.state === "online"
      ? "View the screen shared by " + host.name + "." : host.name + " is offline."}</p>
    {!host.member && host.state === "online" && <button className="set-button" onClick={open}><Monitor size={15} /> Open computer</button>}
  </div>;
}

const namedKeys: Record<string, string> = { Enter: "enter", Tab: "tab", Escape: "escape", Backspace: "backspace", Delete: "delete", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown", " ": "space" };

export default function ComputerScreen({ host, close }: { host: Host; close: () => void }) {
  const [info, setInfo] = useState<ComputerScreenInfo>();
  const [wanted, select] = useState("");
  const [retry, setRetry] = useState(0);
  const [ready, setReady] = useState(false);
  const [control, setControl] = useState(false);
  const [jpeg, setJpeg] = useState("");
  const [error, setError] = useState("");
  const film = useRef<HTMLVideoElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const send = useRef<Send | null>(null);
  const drag = useRef<{ pointer: number; start: Point; last: Point; moved: boolean } | null>(null);
  const lastClick = useRef<{ point: Point; time: number } | null>(null);
  const display = info?.displays.find(d => d.id === wanted) ?? info?.displays.find(d => d.primary) ?? info?.displays[0];

  useEffect(() => {
    const hidden = () => { if (document.hidden) close(); };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [close]);
  useEffect(() => {
    const abort = new AbortController();
    const id = crypto.randomUUID();
    const signal = abort.signal;
    const api = window.botkins.remoteScreen;
    const stop = () => api(host.id, id, "stop").catch(() => {});
    const done = () => { if (!signal.aborted) setReady(true); };
    let pending: ComputerScreenInput[] = [];
    let sending = false;
    setError(""); setReady(false); setControl(false); setJpeg(""); setInfo(undefined);
    drag.current = null; lastClick.current = null;
    async function view() {
      const status = await api(host.id, id, "start");
      signal.throwIfAborted();
      setInfo(status);
      const monitor = status.displays.find(d => d.id === wanted) ?? status.displays.find(d => d.primary) ?? status.displays[0];
      if (!status.canView || !monitor) throw new Error(status.problem || "Screen sharing is off on " + host.name + ".");
      const target = monitor.id;
      async function drain() {
        sending = true;
        try {
          while (pending.length && !signal.aborted) await api(host.id, id, "input", target, pending.splice(0, 32));
        } catch (error) {
          if (!signal.aborted) {
            setControl(false); setError(errorText(error)); send.current = null;
            setInfo(current => current && { ...current, canControl: false });
          }
        } finally { pending = []; sending = false; }
      }
      if (status.canControl) send.current = event => {
        if (signal.aborted) return;
        if (event.type === "move" && pending.at(-1)?.type === "move") pending.pop();
        if (pending.length >= 64) {
          pending = []; send.current = null; abort.abort(); void stop();
          setControl(false); setReady(false); setJpeg(""); setError("The computer is responding slowly. Reconnect to resume control.");
          return;
        }
        pending.push(event);
        if (!sending) void drain();
      };
      const formats = videoFormats();
      if (status.video && formats.length && film.current) {
        const closeVideo = () => api(host.id, id, "closeVideo");
        try {
          const { mimeType } = await api(host.id, id, "openVideo", { display: target, maxWidth: 1600, fps: 30, mimeTypes: formats });
          signal.throwIfAborted();
          if (formats.includes(mimeType)) await playComputerVideo(film.current, mimeType,
            seq => api(host.id, id, "readVideo", seq), closeVideo, signal, done);
        } catch { /* A host or decoder without a working stream can still supply screen frames. */ }
        if (!signal.aborted) { setReady(false); await closeVideo().catch(() => {}); }
      }
      let after: number | undefined;
      while (!signal.aborted) {
        const frame = await api(host.id, id, "frame", { display: target, maxWidth: 1280, quality: 75, after });
        signal.throwIfAborted();
        after = frame.seq;
        if (frame.jpeg) setJpeg("data:image/jpeg;base64," + frame.jpeg);
      }
    }
    void view().catch(e => {
      if (!signal.aborted) {
        setError(errorText(e)); setReady(false); setControl(false); setJpeg(""); send.current = null;
        void stop();
      }
    });
    return () => { abort.abort(); pending = []; send.current = null; void stop(); };
  }, [host.id, host.name, wanted, retry]);

  function point(e: { clientX: number; clientY: number }, clamp = false): Point | null {
    if (!control || !display || !ready || !stage.current) return null;
    const box = stage.current.getBoundingClientRect();
    const width = jpeg ? picture.current?.naturalWidth : film.current?.videoWidth;
    const height = jpeg ? picture.current?.naturalHeight : film.current?.videoHeight;
    if (!width || !height) return null;
    const scale = Math.min(box.width / width, box.height / height);
    const x = (e.clientX - box.left - (box.width - width * scale) / 2) / (width * scale);
    const y = (e.clientY - box.top - (box.height - height * scale) / 2) / (height * scale);
    if (!clamp && (x < 0 || y < 0 || x > 1 || y > 1)) return null;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }
  function release() {
    const held = drag.current;
    drag.current = null;
    if (held?.moved) send.current?.({ type: "up", ...held.last });
  }
  function move(e: PointerEvent) {
    const held = drag.current;
    if (held && held.pointer !== e.pointerId) return;
    const at = point(e, !!held);
    if (!at) return;
    if (held) {
      if (!held.moved && Math.hypot(at.x - held.start.x, at.y - held.start.y) < 0.003) return;
      if (!held.moved) send.current?.({ type: "down", ...held.start });
      held.moved = true; held.last = at;
    }
    send.current?.({ type: "move", ...at });
  }
  function up(e: PointerEvent) {
    const held = drag.current;
    if (!held || held.pointer !== e.pointerId) return;
    const at = point(e, true) ?? held.last;
    drag.current = null;
    if (held.moved) { send.current?.({ type: "up", ...at }); return; }
    const previous = lastClick.current;
    const double = previous && performance.now() - previous.time < 450 && Math.hypot(at.x - previous.point.x, at.y - previous.point.y) < 0.015;
    send.current?.({ type: double ? "doubleClick" : "click", ...at });
    lastClick.current = double ? null : { point: at, time: performance.now() };
  }
  function key(e: KeyboardEvent) {
    if (!control || !ready || e.nativeEvent.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); release(); setControl(false); return; }
    const printable = Array.from(e.key).length === 1;
    const name = namedKeys[e.key] ?? (printable ? e.key : null);
    if (!name) return;
    e.preventDefault(); e.stopPropagation();
    if (printable && !e.ctrlKey && !e.metaKey && !e.altKey) { send.current?.({ type: "text", text: e.key }); return; }
    const modifiers: ("ctrl" | "cmd" | "alt" | "shift" | "super")[] = [];
    if (e.ctrlKey) modifiers.push("ctrl");
    if (e.metaKey) modifiers.push(info?.superKey ? "super" : "cmd");
    if (e.altKey) modifiers.push("alt");
    if (e.shiftKey) modifiers.push("shift");
    send.current?.({ type: "key", key: name, modifiers });
  }
  return <Modal title={host.name + " computer"} className="computer-view" close={close}>
    <header><Monitor size={19} /><h2>{host.name}</h2>
      {info && info.displays.length > 1 && <select aria-label="Display" value={display?.id} onChange={e => { release(); select(e.target.value); }}>{info.displays.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}</select>}
      {control && <button className="set-button" aria-label="Send Escape to remote computer" onClick={() => { send.current?.({ type: "key", key: "escape" }); stage.current?.focus(); }}>Send Esc</button>}
      {info?.canControl && <button className="set-button" disabled={!ready} aria-label="Control" aria-pressed={control} onClick={() => { release(); setControl(!control); if (!control) stage.current?.focus(); }}><MousePointer2 size={15} /> {control ? "Controlling" : "Control"}</button>}
      <button className="pane-tool" aria-label="Close computer" onClick={close}><X size={18} /></button></header>
    <div className={"computer-stage" + (control ? " controlling" : "")} ref={stage} tabIndex={0} aria-label="Shared desktop"
      onPointerDown={e => {
        if (e.button !== 0 || drag.current) return;
        const at = point(e); if (!at) return;
        e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { pointer: e.pointerId, start: at, last: at, moved: false };
      }} onPointerMove={move} onPointerUp={up} onPointerCancel={release} onLostPointerCapture={release} onBlur={release}
      onContextMenu={e => { e.preventDefault(); const at = point(e); if (at) send.current?.({ type: "rightClick", ...at }); }}
      onWheel={e => { const at = point(e); if (at) { const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? e.currentTarget.clientHeight : 1; send.current?.({ type: "scroll", ...at, dx: e.deltaX * unit, dy: e.deltaY * unit }); } }}
      onKeyDown={key} onPaste={e => { if (control && ready) { e.preventDefault(); send.current?.({ type: "text", text: e.clipboardData.getData("text/plain") }); } }}>
      <video ref={film} muted playsInline autoPlay hidden={!!jpeg} />
      {jpeg && <img ref={picture} src={jpeg} alt={"Desktop of " + host.name} draggable={false} onLoad={() => setReady(true)} />}
      {!ready && !error && <p role="status">Connecting to the screen…</p>}
    </div>
    {error && <footer role="alert">{error} <button className="set-button" onClick={() => setRetry(n => n + 1)}>Try again</button></footer>}
  </Modal>;
}
