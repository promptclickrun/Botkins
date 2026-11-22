// The view of an MCP App in a chat: a tool of an MCP server declared an interactive view, and the
// computer kept the view's page, the tool's input and its result (desktop/mcp-apps.mjs). The page loads
// from botkins-app://mcpview-<card>/ into a frame with scripts only and an origin of its own, under the
// policy its server declared (desktop/main.mjs); it gets no bridge of the window's. It talks MCP Apps
// over postMessage with the official AppBridge, which has no MCP client here: each call it makes goes
// to the computer ("mcpApps.callTool", "mcpApps.readResource"), which sends it only to the card's own
// server and checks the chat's access each time. A tool that may change something, and a link, ask
// the person first, in the card. Showing the card again never runs the tool again.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppWindow, TriangleAlert } from "lucide-react";
import { AppBridge, PostMessageTransport, type McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import { APPEARANCE_EVENT } from "./appearance";
import type { McpAppCard as Card, McpAppView, McpToolResult } from "./types";

const api = window.botkins;
const MIN = 80;
const MAX = 2000;
/** How long a view may take to say it is ready before the card shows the saved summary instead. */
const PATIENCE = 10_000;

const theme = (): "light" | "dark" => (document.documentElement.dataset.mode === "dark" ? "dark" : "light");
const clamp = (n: unknown, fallback: number) => (typeof n === "number" && Number.isFinite(n) ? Math.round(Math.min(MAX, Math.max(MIN, n))) : fallback);
const refused = (text: string): McpToolResult => ({ content: [{ type: "text", text }], isError: true });

/** A question the view's action needs answered by the person: allow a tool, or open a link. */
type Ask = { text: string; yes: string; answer: (yes: boolean) => void };

export function McpAppCard({ chatId, card }: { chatId: string; card: Card }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<McpAppView | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [height, setHeight] = useState(220);
  const [ask, setAsk] = useState<Ask | null>(null);

  useEffect(() => {
    let live = true;
    api["mcpApps.view"](chatId, card.id).then(
      (found) => live && setView(found),
      () => live && setPhase("failed"),
    );
    return () => {
      live = false;
    };
  }, [chatId, card.id]);

  // A layout effect, so the bridge listens before the frame's page can say anything.
  useLayoutEffect(() => {
    const frame = ref.current?.contentWindow;
    if (!view || !frame) return;
    let open = true;
    // One question at a time: a second one while the first is open is answered no.
    let asking = false;
    const question = (text: string, yes: string) =>
      asking
        ? Promise.resolve(false)
        : new Promise<boolean>((resolve) => {
          asking = true;
          setAsk({
          text,
          yes,
          answer: (allowed) => {
            asking = false;
            setAsk(null);
            resolve(allowed);
          },
        });
      });
    const context: McpUiHostContext = { theme: theme(), platform: "desktop", displayMode: "inline", availableDisplayModes: ["inline"], toolInfo: { tool: { ...view.tool, inputSchema: { type: "object", ...view.tool.inputSchema } } }, containerDimensions: { maxHeight: MAX } };
    const bridge = new AppBridge(null, { name: "Botkins", version: "1" }, { openLinks: {}, serverTools: {}, serverResources: {} }, { hostContext: context });
    bridge.oncalltool = async (params) => {
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const first = await api["mcpApps.callTool"](chatId, card.id, params.name, args);
      if ("result" in first) return first.result;
      const { title, server } = first.needsApproval;
      if (!open || !(await question("Allow " + server + " to run “" + title + "” from this view?", "Allow"))) return refused("The person didn't allow this.");
      const again = await api["mcpApps.callTool"](chatId, card.id, params.name, args, { approved: true });
      return "result" in again ? again.result : refused("The person didn't allow this.");
    };
    bridge.onreadresource = (params) => api["mcpApps.readResource"](chatId, card.id, params.uri);
    bridge.onopenlink = async ({ url }) => {
      let host = "";
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") host = parsed.host;
      } catch {
        // Not an address: refused below.
      }
      if (!host || !open || !(await question("Open " + host + " in your browser?", "Open"))) return { isError: true };
      await api.openLink(url);
      return {};
    };
    bridge.onsizechange = ({ height: next }) => setHeight((now) => clamp(next, now));
    bridge.oninitialized = () => {
      if (!open) return;
      setPhase("ready");
      void bridge.sendToolInput({ arguments: view.input });
      void bridge.sendToolResult(view.result);
    };
    void bridge.connect(new PostMessageTransport(frame, frame));
    const late = setTimeout(() => open && setPhase((now) => (now === "loading" ? "failed" : now)), PATIENCE);
    const retheme = () => bridge.setHostContext({ ...context, theme: theme() });
    window.addEventListener(APPEARANCE_EVENT, retheme);
    return () => {
      open = false;
      clearTimeout(late);
      window.removeEventListener(APPEARANCE_EVENT, retheme);
      void bridge.teardownResource({}).catch(() => {});
      void bridge.close().catch(() => {});
    };
  }, [view, chatId, card.id]);

  const name = card.title || card.tool;
  return (
    <section className={"chat-card mcp-app-card" + (view?.prefersBorder === false ? " borderless" : "")} aria-label={name + " from " + card.server}>
      <header className="mcp-app-head">
        <AppWindow size={15} aria-hidden="true" />
        <strong>{name}</strong>
        <small>{card.server}</small>
      </header>
      {phase === "failed" ? (
        <div className="mcp-app-fallback" role="status">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>{card.summary || "This view can't be shown here."}</span>
        </div>
      ) : (
        view && (
          <div className={"mcp-app-frame" + (phase === "loading" ? " loading" : "")}>
            <iframe ref={ref} title={name} src={"botkins-app://mcpview-" + card.id + "/"} sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ height }} />
          </div>
        )
      )}
      {ask && (
        <div className="mcp-app-ask" role="alertdialog" aria-label={ask.text}>
          <span>{ask.text}</span>
          <button className="secondary" onClick={() => ask.answer(false)}>
            Don't allow
          </button>
          <button className="primary" onClick={() => ask.answer(true)}>
            {ask.yes}
          </button>
        </div>
      )}
    </section>
  );
}
