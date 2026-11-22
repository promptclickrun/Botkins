import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  FolderPlus,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  Wrench,
} from "lucide-react";
import type {
  Bot,
  CredentialRef,
  InstalledPlugin,
  PluginConfigValue,
  PluginField,
  PluginListing,
  PluginMarketplace,
  PluginPreview,
  MarketAgentTemplate,
  State,
} from "./types";
import MarketApps, { refreshApps } from "./MarketApps";
import MarketPi from "./MarketPi";
import MarketAgents from "./MarketAgents";
import { CredentialChoice, useSavedCredentials, type Picked } from "./CredentialPicker";
import { useAsk } from "./Pages";
import { Group, Sheet, errorText } from "./SettingsRows";
import { stopCancel } from "./SkillsSettings";
import { PluginContentsView } from "./PluginRuns";
import { PLUGIN_STARTS, decisionText, heldBack, linkedError, onOffLabel, readTold, sentToLines, startQuestion, switchedOffNotice, writeTold, type Step, type Where } from "./pluginStarts";
import "./plugins.css";

const api = window.botkins;
/** Named by the computer's app when it reads its catalogs again on request (`plugins.refresh`). */
export const MARKET_REFRESH = "market-refresh-v1";
type View = "apps" | "agents" | "plugins" | "pi";
/** Where the window keeps the Marketplace view last looked at, as the phone keeps its own. */
const VIEW = "botkins.market.view";
function readView(): View {
  try {
    const saved = localStorage.getItem(VIEW);
    return saved === "agents" || saved === "plugins" || saved === "pi" ? saved : "apps";
  } catch {
    return "apps";
  }
}
type PluginMode = "browse" | "installed";
type Selection = { kind: "listing" | "installed"; id: string };
type FolderBrowser = { path?: string };
type UpdateReview = { plugin: InstalledPlugin; preview: PluginPreview };

function marketplaceLabel(markets: PluginMarketplace[], id: string) {
  return markets.find((market) => market.id === id)?.name ?? id;
}
function statusLabel(plugin: InstalledPlugin) {
  return plugin.status === "ready" ? "Ready" : plugin.status === "needs-config" ? "Needs settings" : plugin.status === "needs-sign-in" ? "Needs sign-in" : "Couldn't load";
}
/** Where the window keeps which switched-off plugins the person was told about. */
const TOLD = "botkins.plugins.switchedOffTold";

/** Settings › Marketplace: catalog browsing, trusted installs and installed plugin controls. */
export default function PluginsSettings({ state, bots, open, createBot }: { state: State; bots: Bot[]; /** An installed plugin to show at once (from Settings › Skills). */ open?: string; /** Opens Create a bot filled in from an agent template. */ createBot?: (template: MarketAgentTemplate) => void }) {
  const [view, setViewNow] = useState<View>(() => (open ? "plugins" : readView()));
  const setView = (next: View) => {
    setViewNow(next);
    setRefreshError("");
    try {
      localStorage.setItem(VIEW, next);
    } catch {
      // Only a convenience: the view is still shown.
    }
  };
  const [mode, setMode] = useState<PluginMode>(open ? "installed" : "browse");
  const [markets, setMarkets] = useState<PluginMarketplace[]>([]);
  const [marketplace, setMarketplace] = useState("");
  const [query, setQuery] = useState("");
  const [listings, setListings] = useState<PluginListing[]>([]);
  const [cursor, setCursor] = useState<string>();
  // Where the page on screen starts, so a refresh reads the same page again.
  const [pageAt, setPageAt] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [refreshed, setRefreshed] = useState(0);
  const [loading, setLoading] = useState(false);
  const [marketLoading, setMarketLoading] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [selection, setSelection] = useState<Selection | undefined>(open ? { kind: "installed", id: open } : undefined);
  const [told, setTold] = useState(() => readTold(TOLD));
  const [preview, setPreview] = useState<PluginPreview>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [installOpen, setInstallOpen] = useState(false);
  const [configPlugin, setConfigPlugin] = useState<InstalledPlugin>();
  const [addMarketplaceOpen, setAddMarketplaceOpen] = useState(false);
  const [folderBrowser, setFolderBrowser] = useState<FolderBrowser>();
  const [updateReview, setUpdateReview] = useState<UpdateReview>();
  const [busy, setBusy] = useState(false);
  const [localInstalled, setLocalInstalled] = useState<InstalledPlugin[]>(state.plugins ?? []);
  const dialogs = useAsk();
  const capability = state.remote?.using?.capabilities;
  const supported = (!capability || capability.includes("plugins-v1")) && typeof api["plugins.browse"] === "function";
  // The computer in use, for the words of a question. A computer that does not name the rule can
  // leave out a command that runs. The name is that computer's own, never this one's.
  const using = state.remote?.using;
  const where: Where = { ...(using && { name: using.name }), starts: !using || using.capabilities.includes(PLUGIN_STARTS) };
  const hostId = using?.id ?? "";
  const installed = localInstalled;
  const selectedInstalled = selection?.kind === "installed" ? installed.find((plugin) => plugin.id === selection.id) : undefined;

  useEffect(() => setLocalInstalled(state.plugins ?? []), [state.plugins]);

  async function loadMarkets() {
    if (!supported) return;
    setMarketLoading(true); setError("");
    try { setMarkets(await api["plugins.marketplaces"]()); } catch (e) { setError(errorText(e)); } finally { setMarketLoading(false); }
  }
  async function loadBrowse(nextCursor?: string) {
    if (!supported) return;
    setLoading(true); setError("");
    try {
      const result = await api["plugins.browse"]({ ...(marketplace && { marketplace }), ...(query.trim() && { query: query.trim() }), ...(nextCursor && { cursor: nextCursor }) });
      setListings(result.plugins); setCursor(result.cursor); setPageAt(nextCursor);
    } catch (e) { setError(errorText(e)); setListings([]); setCursor(undefined); } finally { setLoading(false); }
  }
  /**
   * The refresh button: the computer reads every marketplace again now (an older one only lists
   * them), then the view on screen is read again. What is shown stays until the new lists come.
   */
  async function refreshMarket() {
    if (refreshing) return;
    setRefreshing(true); setRefreshError("");
    try {
      if (view === "pi") setRefreshed((n) => n + 1);
      else if (view === "apps") await refreshApps();
      else if (supported) {
        const before = markets;
        const fresh = (!using || using.capabilities.includes(MARKET_REFRESH)) && typeof api["plugins.refresh"] === "function";
        const list = fresh ? await api["plugins.refresh"]!() : await api["plugins.marketplaces"]();
        setMarkets(list);
        if (view === "agents") setRefreshed((n) => n + 1);
        else if (mode === "browse" && !selection) {
          const result = await api["plugins.browse"]({ ...(marketplace && { marketplace }), ...(query.trim() && { query: query.trim() }), ...(pageAt && { cursor: pageAt }) });
          setListings(result.plugins); setCursor(result.cursor); setError("");
        }
        const failed = list.filter((market) => market.error && !before.find((had) => had.id === market.id)?.error);
        if (failed.length) setRefreshError("Couldn't refresh " + (failed.length === 1 ? failed[0].name : failed.length + " marketplaces"));
      }
    } catch (e) { setRefreshError(errorText(e)); } finally { setRefreshing(false); }
  }
  useEffect(() => { if (supported) void loadMarkets(); }, [supported, state.remote?.using?.id]);
  useEffect(() => {
    if (!supported || view !== "plugins" || mode !== "browse" || selection) return;
    setCursor(undefined);
    const timer = window.setTimeout(() => void loadBrowse(), 120);
    return () => window.clearTimeout(timer);
  }, [supported, view, mode, selection, marketplace, query]);
  useEffect(() => {
    if (!selection || selection.kind !== "listing" || !supported) { setPreview(undefined); return; }
    let live = true; setPreview(undefined); setPreviewLoading(true); setError("");
    api["plugins.preview"](selection.id).then((value) => live && setPreview(value)).catch((e) => live && setError(errorText(e))).finally(() => live && setPreviewLoading(false));
    return () => { live = false; };
  }, [selection?.id, selection?.kind, previewRevision, supported]);
  function upsertPlugin(plugin: InstalledPlugin) { setLocalInstalled((current) => [plugin, ...current.filter((item) => item.id !== plugin.id)]); }
  async function addFolderPath(path: string) {
    setFolderBrowser(undefined); setBusy(true); setError("");
    try {
      const plugin = await api["plugins.addFolder"](path); upsertPlugin(plugin); setSelection({ kind: "installed", id: plugin.id }); setMode("installed");
      setNote(plugin.enabled ? "Added " + plugin.name + ". Review its contents below." : "Added " + plugin.name + ", switched off. Review what it runs, then turn it on.");
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function addFolder() {
    setError("");
    if (api.pickPluginFolder && !state.remote?.using) {
      try { const path = await api.pickPluginFolder(); if (path) await addFolderPath(path); } catch (e) { setError(errorText(e)); }
      return;
    }
    if (!api.listFolders) { setError("Choose a plugin folder on the computer running Botkins."); return; }
    setFolderBrowser({});
  }
  async function removeMarketplace(market: PluginMarketplace) {
    const ok = await dialogs.ask({ title: "Remove " + market.name + "?", body: "The catalog will disappear from Marketplace. Plugins already installed from it stay installed.", confirm: "Remove", danger: true });
    if (!ok) return;
    try { await api["plugins.removeMarketplace"](market.id); await loadMarkets(); if (marketplace === market.id) setMarketplace(""); setNote("Removed " + market.name + "."); } catch (e) { setError(errorText(e)); }
  }
  /** Asks before a step when the description calls for it. A description without the mark is asked about always. */
  async function agreed(plugin: Pick<PluginPreview | InstalledPlugin, "contents" | "starts" | "warnings">, step: Step) {
    const asked = startQuestion(plugin, step, where);
    return !asked || !!(await dialogs.ask(asked));
  }
  async function install(values: { bots: "all" | string[]; config: Record<string, PluginConfigValue> }) {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const plugin = await api["plugins.install"](preview.id, { ...values, ...(preview.revision && { revision: preview.revision }) });
      upsertPlugin(plugin); setInstallOpen(false); setSelection({ kind: "installed", id: plugin.id }); setMode("installed"); setNote("Installed " + plugin.name + ".");
    } catch (e) { const text = errorText(e); setError(/revision|changed|review/i.test(text) ? "This plugin changed while you were reviewing it. Review the new contents before installing." : text); if (/revision|changed|review/i.test(text)) setPreviewRevision((value) => value + 1); } finally { setBusy(false); }
  }
  async function startInstall() {
    if (!preview) return;
    if (await agreed(preview, "install")) setInstallOpen(true);
  }
  async function configure(id: string, values: Record<string, PluginConfigValue>) {
    setBusy(true); setError("");
    try { await api["plugins.configure"](id, values); setConfigPlugin(undefined); setNote("Saved plugin settings."); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function setEnabled(plugin: InstalledPlugin, enabled: boolean) {
    if (enabled && !(await agreed(plugin, "on"))) return;
    setBusy(true); setError("");
    try {
      // A switch-on names the revision of the description that was looked at: the computer refuses a plugin that is another one by then.
      await api["plugins.setEnabled"](plugin.id, enabled, ...(enabled && plugin.revision ? [{ revision: plugin.revision }] : []));
      // Switched on by the person, a plugin no longer has the computer's reason for being off.
      setLocalInstalled((all) => all.map((item) => item.id === plugin.id ? { ...item, enabled, ...(enabled && heldBack(item) && item.status !== "error" && { detail: undefined }) } : item));
      setNote(enabled ? plugin.name + " is on." : plugin.name + " is off.");
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function setBots(plugin: InstalledPlugin, botsForPlugin: "all" | string[]) {
    setBusy(true); setError("");
    try { await api["plugins.setBots"](plugin.id, botsForPlugin, ...(plugin.revision ? [{ revision: plugin.revision }] : [])); setLocalInstalled((all) => all.map((item) => item.id === plugin.id ? { ...item, bots: botsForPlugin } : item)); setNote("Updated which bots use " + plugin.name + "."); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function openUpdateReview(plugin: InstalledPlugin) {
    setBusy(true); setError(""); setUpdateReview(undefined);
    try {
      const fresh = await api["plugins.preview"](plugin.id);
      setUpdateReview({ plugin, preview: fresh });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function update(review: UpdateReview) {
    if (!(await agreed(review.preview, "update"))) return;
    setBusy(true); setError("");
    try {
      const next = await api["plugins.update"](review.plugin.id, { ...(review.preview.revision && { revision: review.preview.revision }) });
      upsertPlugin(next); setUpdateReview(undefined); setNote("Updated " + next.name + ".");
    } catch (e) {
      const text = errorText(e);
      if (/revision|changed|review/i.test(text)) {
        setUpdateReview(undefined);
        setNote("The plugin changed while you were reviewing it. Review the new contents before updating.");
        await openUpdateReview(review.plugin);
      } else setError(text);
    } finally { setBusy(false); }
  }
  async function uninstall(plugin: InstalledPlugin) {
    const ok = await dialogs.ask({ title: "Remove " + plugin.name + "?", body: "Its installed files, settings and tools will be removed from this computer. This can't be undone.", confirm: "Remove", danger: true });
    if (!ok) return;
    setBusy(true);
    try { await api["plugins.uninstall"](plugin.id); setLocalInstalled((all) => all.filter((item) => item.id !== plugin.id)); setSelection(undefined); setNote("Removed " + plugin.name + "."); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function signIn(serverId: string, pluginName: string) {
    setBusy(true); setError("");
    try { await api.signInMcpServer(serverId); setNote("Signed in for " + pluginName + "."); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  // Plugins that Botkins switched off: said one time, at the top of the page.
  const switchedOff = switchedOffNotice(installed, told, where, hostId);
  function toldNow(keys: string[]) { const next = [...told, ...keys]; setTold(next); writeTold(TOLD, next); }

  const detail = selection && <PluginDetail selection={selection} preview={preview} previewLoading={previewLoading} installed={selectedInstalled} where={where} markets={markets} bots={bots} busy={busy} note={note} error={error} onBack={() => { setSelection(undefined); setPreview(undefined); setError(""); }} onInstall={() => void startInstall()} onConfigure={(plugin) => setConfigPlugin(plugin)} onEnabled={(plugin, enabled) => void setEnabled(plugin, enabled)} onBots={(plugin, selectedBots) => void setBots(plugin, selectedBots)} onUpdate={(plugin) => void openUpdateReview(plugin)} onRemove={(plugin) => void uninstall(plugin)} onSignIn={(serverId, name) => void signIn(serverId, name)} onRetry={() => setPreviewRevision((value) => value + 1)} />;
  return <div className="int-section plugin-settings" {...stopCancel}>
    <div className="plugin-top-bar"><div className="plugin-top-tabs" role="tablist" aria-label="Marketplace"><button type="button" role="tab" aria-selected={view === "apps"} onClick={() => { setView("apps"); setSelection(undefined); }}>Apps</button><button type="button" role="tab" aria-selected={view === "agents"} onClick={() => { setView("agents"); setSelection(undefined); }}>Agents</button><button type="button" role="tab" aria-selected={view === "plugins"} onClick={() => { setView("plugins"); setSelection(undefined); }}>Plugins</button><button type="button" role="tab" aria-selected={view === "pi"} onClick={() => { setView("pi"); setSelection(undefined); }}>Pi</button></div><button type="button" className="plugin-refresh" aria-label="Refresh" title="Refresh" aria-busy={refreshing} disabled={refreshing} onClick={() => void refreshMarket()}><RefreshCw size={15} aria-hidden="true" className={refreshing ? "spin" : undefined} /></button></div>
    {refreshError && <p className="set-status error-text" role="alert">{refreshError}</p>}
    {note && !selection && view === "plugins" && <p className="set-status" role="status">{note}</p>}
    {switchedOff && !selection && view === "plugins" && <div className="plugin-notice" role="status" aria-label={switchedOff.title}><ShieldAlert size={16} aria-hidden="true" /><div><strong>{switchedOff.title}</strong><p>{switchedOff.text}</p></div><button type="button" className="set-button" onClick={() => { toldNow(switchedOff.keys); setMode("installed"); }}>OK</button></div>}
    {view === "pi" ? <MarketPi key={hostId} state={state} refreshed={refreshed} /> : view === "apps" ? <MarketApps state={state} /> : view === "agents" ? <MarketAgents state={state} createBot={createBot} refreshed={refreshed} /> : !supported ? <Group><div className="int-empty plugin-unavailable"><span className="int-empty-icon" aria-hidden="true"><ShieldAlert size={20} /></span><strong>Plugins need an update</strong><p>Update the app on your computer to use Marketplace plugins here.</p></div></Group> : selection ? detail : <><div className="plugin-mode-tabs" role="tablist" aria-label="Plugins"><button type="button" role="tab" aria-selected={mode === "browse"} onClick={() => setMode("browse")}>Browse</button><button type="button" role="tab" aria-selected={mode === "installed"} onClick={() => setMode("installed")}>Installed ({installed.length})</button></div>{mode === "browse" ? <>
      <div className="set-toolbar int-toolbar plugin-toolbar"><label className="int-filter"><Search size={14} aria-hidden="true" /><input type="search" aria-label="Search plugins" placeholder="Search plugins" value={query} onChange={(e) => setQuery(e.target.value)} /></label><button type="button" className="set-button" onClick={() => void addFolder()} disabled={busy}><FolderPlus size={14} /> Add from computer</button><button type="button" className="set-button" onClick={() => setAddMarketplaceOpen(true)}><Plus size={14} /> Add marketplace</button></div>
      <div className="plugin-market-chips" role="group" aria-label="Plugin marketplaces"><button type="button" className={marketplace ? "" : "selected"} aria-pressed={!marketplace} onClick={() => setMarketplace("")}>All</button>{markets.map((market) => <button type="button" key={market.id} className={marketplace === market.id ? "selected" : ""} aria-pressed={marketplace === market.id} onClick={() => setMarketplace(market.id)}>{market.name}</button>)}</div>
      {marketLoading && <p className="set-status">Loading marketplaces…</p>}{error && <ErrorNotice message={error} retry={() => void loadBrowse()} />}<Group title="Plugins" footer="Plugins can add skills, tools, hooks, agents and commands to your bots.">{loading ? <p className="set-status">Searching plugins…</p> : listings.length ? listings.map((plugin) => <PluginListingRow key={plugin.id} plugin={plugin} marketplace={marketplaceLabel(markets, plugin.marketplace)} onClick={() => setSelection({ kind: "listing", id: plugin.id })} />) : <div className="set-row"><small>No plugins match this search.</small></div>}{cursor && <div className="set-actions"><button type="button" className="set-button" onClick={() => void loadBrowse(cursor)} disabled={loading}>More plugins</button></div>}</Group>
      <MarketplacesGroup markets={markets} loading={marketLoading} onAdd={() => setAddMarketplaceOpen(true)} onRemove={(market) => void removeMarketplace(market)} onRetry={() => void loadMarkets()} />
    </> : <InstalledGroup plugins={installed} markets={markets} onOpen={(plugin) => setSelection({ kind: "installed", id: plugin.id })} onAdd={() => setMode("browse")} />}</>}
    {dialogs.node}
    {addMarketplaceOpen && <AddMarketplaceSheet close={() => setAddMarketplaceOpen(false)} saved={(market) => { setAddMarketplaceOpen(false); setMarkets((all) => [...all.filter((item) => item.id !== market.id), market]); setMarketplace(market.id); setNote("Added " + market.name + "."); void loadBrowse(); }} />}
    {folderBrowser && <FolderBrowserSheet close={() => setFolderBrowser(undefined)} choose={(path) => void addFolderPath(path)} />}
    {updateReview && <PluginUpdateReviewSheet review={updateReview} where={where} busy={busy} close={() => setUpdateReview(undefined)} submit={() => void update(updateReview)} />}
    {installOpen && preview && <PluginConfigSheet key={preview.id + ":install"} title="Install plugin" fields={preview.config} bots={bots} initialBots="all" submit={(values, selectedBots) => void install({ config: values, bots: selectedBots ?? "all" })} close={() => setInstallOpen(false)} busy={busy} />}
    {configPlugin && <PluginConfigSheet key={configPlugin.id + ":configure"} title={"Settings · " + configPlugin.name} fields={configPlugin.config} bots={[]} submit={(values) => void configure(configPlugin.id, values)} close={() => setConfigPlugin(undefined)} busy={busy} existing />}
  </div>;
}

function ErrorNotice({ message, retry }: { message: string; retry: () => void }) { return <p className="set-status error-text plugin-error" role="alert"><span>{message}</span><button type="button" className="set-link" onClick={retry}>Retry</button></p>; }
function PluginListingRow({ plugin, marketplace, onClick }: { plugin: PluginListing; marketplace: string; onClick: () => void }) { return <button type="button" className="plugin-listing" onClick={onClick}><span className="plugin-listing-icon" aria-hidden="true"><Wrench size={16} /></span><span className="plugin-listing-copy"><strong>{plugin.name}</strong><small>{plugin.description || "Adds capabilities to your bots."}</small><em>{marketplace}{plugin.version ? " · v" + plugin.version : ""}</em></span><ChevronRight size={16} aria-hidden="true" /></button>; }
function InstalledGroup({ plugins, markets, onOpen, onAdd }: { plugins: InstalledPlugin[]; markets: PluginMarketplace[]; onOpen: (plugin: InstalledPlugin) => void; onAdd: () => void }) { return plugins.length ? <Group title="Installed" footer="Installed plugins stay on this computer until you remove them.">{plugins.map((plugin) => <button type="button" className="plugin-listing" key={plugin.id} onClick={() => onOpen(plugin)}><span className="plugin-listing-icon" aria-hidden="true"><Wrench size={16} /></span><span className="plugin-listing-copy"><strong>{plugin.name}</strong><small>{plugin.detail || statusLabel(plugin)}</small><em>{onOffLabel(plugin)} · {plugin.bots === "all" ? "All bots" : plugin.bots.length + " bot" + (plugin.bots.length === 1 ? "" : "s")}{plugin.marketplace !== "folder" ? " · " + marketplaceLabel(markets, plugin.marketplace) : " · Computer"}</em></span><ChevronRight size={16} aria-hidden="true" /></button>)}</Group> : <Group><div className="int-empty"><span className="int-empty-icon" aria-hidden="true"><Wrench size={20} /></span><strong>No installed plugins</strong><p>Browse a catalog or add a plugin folder from this computer.</p><button type="button" className="set-button primary" onClick={onAdd}>Browse plugins</button></div></Group>; }

function MarketplacesGroup({ markets, loading, onAdd, onRemove, onRetry }: { markets: PluginMarketplace[]; loading: boolean; onAdd: () => void; onRemove: (market: PluginMarketplace) => void; onRetry: () => void }) {
  return <Group title="Marketplaces" footer="Catalogs are read by the computer. Plugins already installed stay when a catalog is removed." actions={<button type="button" className="set-button" onClick={onAdd}><Plus size={14} /> Add marketplace</button>}>
    {loading && <div className="set-row"><small>Refreshing catalogs…</small></div>}
    {markets.map((market) => <div className="set-row int-item plugin-marketplace-row" key={market.id}><span className="int-glyph" aria-hidden="true"><Globe size={15} /></span><div className="set-label"><span className="int-title"><span className="set-name">{market.name}</span><span className="int-origin">{market.builtIn ? "Built in" : "Added"}</span></span><small className="int-mono int-line" title={market.source}>{market.source}{market.count !== undefined ? " · " + market.count + " plugins" : ""}</small>{market.error && <small className="int-note bad"><i aria-hidden="true" />{market.error} <button type="button" className="set-link int-more" onClick={onRetry}>Retry</button></small>}</div><div className="set-control">{!market.builtIn && <button type="button" className="set-button danger" onClick={() => onRemove(market)}>Remove</button>}</div></div>)}
  </Group>;
}

function PluginDetail({ selection, preview, previewLoading, installed, where, markets, bots, busy, note, error, onBack, onInstall, onConfigure, onEnabled, onBots, onUpdate, onRemove, onSignIn, onRetry }: {
  selection: { kind: "listing" | "installed"; id: string }; preview?: PluginPreview; previewLoading: boolean; installed?: InstalledPlugin; where: Where; markets: PluginMarketplace[]; bots: Bot[]; busy: boolean; note: string; error: string;
  onBack: () => void; onInstall: () => void; onConfigure: (plugin: InstalledPlugin) => void; onEnabled: (plugin: InstalledPlugin, enabled: boolean) => void; onBots: (plugin: InstalledPlugin, bots: "all" | string[]) => void; onUpdate: (plugin: InstalledPlugin) => void; onRemove: (plugin: InstalledPlugin) => void; onSignIn: (serverId: string, name: string) => void; onRetry: () => void;
}) {
  const item = installed ?? preview;
  if (!item)
    return (
      <div className="plugin-detail">
        <button type="button" className="set-link plugin-back" onClick={onBack}><ArrowLeft size={14} /> Back to plugins</button>
        {previewLoading || selection.kind === "installed" ? <p className="set-status">Reading plugin contents…</p> : <Group><ErrorNotice message={error || "This plugin could not be read."} retry={onRetry} /></Group>}
      </div>
    );
  const head = (
    <div className="plugin-detail-head">
      <div>
        <h3>{decisionText(item.name)}</h3>
        <p>{item.description || "A plugin for your bots."}</p>
        <small>{item.marketplace === "folder" ? "Computer" : marketplaceLabel(markets, item.marketplace)}{item.version ? " · v" + item.version : ""}{item.author ? " · " + item.author : ""}</small>
      </div>
      {"homepage" in item && item.homepage && <a href={item.homepage} target="_blank" rel="noreferrer" className="set-link" onClick={(e) => { e.preventDefault(); void api.openLink(item.homepage!); }}>Homepage <ExternalLink size={13} /></a>}
    </div>
  );
  const remove = installed && <button type="button" className="set-button danger" disabled={busy} onClick={() => onRemove(installed)}><Trash2 size={14} /> Remove</button>;
  let body: ReactNode;
  if (!installed) {
    body = <>
      <PluginContentsView plugin={preview!} where={where} />
      {preview!.postInstallMessage && <p className="plugin-postinstall">{preview!.postInstallMessage}</p>}
      <div className="plugin-detail-actions"><button type="button" className="set-button primary" disabled={busy} onClick={onInstall}>{busy ? "Installing…" : "Install plugin"}</button></div>
    </>;
  } else if (linkedError(installed)) {
    // A folder that was linked and could not be copied: nothing of it is used, and it can only be removed.
    body = <>
      <Group title="Status">
        <div className="set-row"><div className="set-label"><span className="set-name">Couldn’t load</span>{installed.detail && <small>{installed.detail}</small>}{installed.folder && <small className="int-mono">{decisionText(installed.folder)}</small>}</div></div>
      </Group>
      <div className="plugin-detail-actions">{remove}</div>
    </>;
  } else {
    const held = heldBack(installed);
    const repair = installed.repair === "update";
    body = <>
      {/* The computer's reason comes first, as it is: Botkins switched this plugin off, or an update is the way back.
          The window itself never holds the switch back (the owner's rule, 2026-11-21: warn a person who turns a
          plugin on, and block only what truly looks malicious). It offers Update first, asks, and shows the
          computer's own answer when the computer refuses. */}
      {held && <p className="plugin-held" role="status"><ShieldAlert size={15} aria-hidden="true" /><span>{installed.detail}</span></p>}
      <Group title="Status">
        <div className="set-row">
          <div className="set-label">
            <span className="set-name">{held ? "Off · Needs review" : statusLabel(installed)}</span>
            {installed.detail && !held && installed.status !== "error" && <small>{installed.detail}</small>}
            {repair && <small>An update writes this plugin’s files again and keeps your settings.</small>}
            {installed.limits && <small>{installed.limits}</small>}
          </div>
          <div className="set-control">
            {repair && <button type="button" className="set-button primary" disabled={busy} onClick={() => onUpdate(installed)}>Update</button>}
            <input type="checkbox" role="switch" className="switch set-switch" aria-label={installed.name + " enabled"} checked={installed.enabled} disabled={busy} onChange={(e) => onEnabled(installed, e.target.checked)} />
          </div>
        </div>
        {installed.status === "error" && !held && <div className="set-row"><small className="int-note bad"><i aria-hidden="true" />{installed.detail || "Plugin failed to load."} <button type="button" className="set-link int-more" onClick={onRetry}>Retry</button></small></div>}
      </Group>
      <Group title="Bots" footer="Choose which bots get this plugin's skills and tools."><PluginBots bots={bots} value={installed.bots} disabled={busy} onChange={(value) => onBots(installed, value)} /></Group>
      {installed.config.length > 0 && <Group title="Settings" footer="Secret values are encrypted on this computer and never shown here."><div className="set-row"><div className="set-label"><span className="set-name">Plugin settings</span><small>{installed.config.filter((field) => field.set).length} of {installed.config.length} set</small></div><div className="set-control"><button type="button" className="set-button" onClick={() => onConfigure(installed)}>Edit settings</button></div></div></Group>}
      <PluginContentsView plugin={installed} where={where} onSignIn={(serverId) => onSignIn(serverId, installed.name)} />
      <div className="plugin-detail-actions">{!repair && <button type="button" className="set-button" disabled={busy} onClick={() => onUpdate(installed)}>Update</button>}{remove}</div>
    </>;
  }
  return <div className="plugin-detail">
    <button type="button" className="set-link plugin-back" onClick={onBack}><ArrowLeft size={14} /> Back to plugins</button>
    {head}
    {body}
    {note && <p className="set-status" role="status">{note}</p>}{error && <ErrorNotice message={error} retry={onRetry} />}
  </div>;
}

function PluginBots({ bots, value, disabled, onChange }: { bots: Bot[]; value: "all" | string[]; disabled?: boolean; onChange: (value: "all" | string[]) => void }) {
  const [draft, setDraft] = useState<"all" | string[]>(value);
  useEffect(() => setDraft(value), [value]);
  const all = draft === "all";
  function chooseScope(next: "all" | "selected") {
    if (next === "all") { setDraft("all"); onChange("all"); return; }
    // The host rejects an empty bot scope. Keep the draft local until the person picks
    // at least one bot, then persist the first valid selection.
    setDraft(draft === "all" ? [] : draft);
    if (draft !== "all") onChange(draft);
  }
  function chooseBot(id: string, checked: boolean) {
    if (draft === "all") return;
    if (!checked && draft.length === 1) return;
    const next = checked ? [...draft, id] : draft.filter((item) => item !== id);
    setDraft(next);
    if (next.length) onChange(next);
  }
  return <div className="plugin-bots"><label><span>Use for</span><select aria-label="Use for" value={all ? "all" : "selected"} disabled={disabled} onChange={(e) => chooseScope(e.target.value as "all" | "selected")}><option value="all">All bots</option><option value="selected">Selected bots</option></select></label>{!all && <div className="plugin-bot-checks">{bots.map((bot) => <label key={bot.id}><input type="checkbox" aria-label={bot.name} checked={draft.includes(bot.id)} disabled={disabled} onChange={(e) => chooseBot(bot.id, e.target.checked)} />{bot.name}</label>)}</div>}</div>;
}

function PluginUpdateReviewSheet({ review, where, busy, close, submit }: { review: UpdateReview; where: Where; busy: boolean; close: () => void; submit: () => void }) {
  return <Sheet title={"Review update · " + review.plugin.name} wide close={close} submit={submit} footer={<><span className="int-sheet-error" role="alert" /> <button type="button" className="set-button" onClick={close}>Cancel</button><button className="set-button primary" disabled={busy}>{busy ? "Updating…" : "Approve update"}</button></>}>
    <p className="plugin-form-intro">Review the new version before it replaces the installed plugin. Everything it runs is below, for this revision.</p>
    <PluginContentsView plugin={review.preview} where={where} />
    {review.preview.postInstallMessage && <p className="plugin-postinstall">{review.preview.postInstallMessage}</p>}
    <p className="plugin-form-intro">Your saved settings and bot scope stay unchanged.</p>
  </Sheet>;
}

function PluginConfigSheet({ title, fields, bots, initialBots, existing, close, submit, busy }: { title: string; fields: (PluginField & { set?: boolean; value?: string })[]; bots: Bot[]; initialBots?: "all" | string[]; existing?: boolean; close: () => void; submit: (values: Record<string, PluginConfigValue>, bots?: "all" | string[]) => void; busy: boolean }) {
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((field) => [field.key, field.secret ? "" : field.value ?? (existing ? "" : field.default ?? "")] )));
  const [picked, setPicked] = useState<Record<string, Picked | undefined>>({});
  const [clear, setClear] = useState<Record<string, boolean>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [selectedBots, setSelectedBots] = useState<"all" | string[]>(initialBots ?? "all");
  const [problem, setProblem] = useState("");
  const saved = useSavedCredentials(fields.some((field) => field.secret));
  function save() {
    const values: Record<string, PluginConfigValue> = {};
    for (const field of fields) {
      // The host may intentionally omit every configured value from a snapshot. An untouched
      // form must be a no-op, rather than writing a manifest default over the saved value.
      if (existing && !touched[field.key]) continue;
      const ref = picked[field.key]?.ref as CredentialRef | undefined;
      const value = text[field.key] ?? "";
      if (clear[field.key]) values[field.key] = null;
      else if (ref) values[field.key] = ref;
      else if (value.length > 0 && (!field.required || value.trim().length > 0)) values[field.key] = value;
      else if (existing && field.set) values[field.key] = null;
      else if (field.default && !field.secret) values[field.key] = field.default;
      else if (field.required) { setProblem("Fill in " + field.label + "."); return; }
    }
    setProblem("");
    submit(values, initialBots === undefined ? undefined : selectedBots);
  }
  return <Sheet title={title} wide close={close} submit={save} footer={<><span className="int-sheet-error" role="alert">{problem}</span><button type="button" className="set-button" onClick={close}>Cancel</button><button className="set-button primary" disabled={busy}>{busy ? "Saving…" : existing ? "Save settings" : "Install"}</button></>}>
    <p className="plugin-form-intro">{existing ? "Values are kept on this computer. Secret fields show only whether they are set." : "Choose which bots use this plugin and provide any settings it needs."}</p>
    {fields.length === 0 ? <p className="set-status">This plugin has no settings.</p> : fields.map((field) => <div className="plugin-field" key={field.key}><label htmlFor={"plugin-field-" + field.key}>{field.label}{field.required && " *"}</label>{field.description && <small>{field.description}</small>}{sentToLines(field).map((line) => <small className="plugin-sent" key={line}>{line}</small>)}{!field.secret && !!field.default && <small className="plugin-sent">{"Default: " + decisionText(field.default)}</small>}<input id={"plugin-field-" + field.key} type={field.secret ? "password" : "text"} value={text[field.key] ?? ""} placeholder={field.secret && existing && field.set ? "Saved securely" : field.default ?? ""} autoComplete="off" onChange={(e) => { setText((all) => ({ ...all, [field.key]: e.target.value })); setPicked((all) => ({ ...all, [field.key]: undefined })); setClear((all) => ({ ...all, [field.key]: false })); setTouched((all) => ({ ...all, [field.key]: true })); }} />{field.secret && <CredentialChoice label={field.label} saved={saved} picked={picked[field.key]} pick={(next) => { setPicked((all) => ({ ...all, [field.key]: next })); setText((all) => ({ ...all, [field.key]: "" })); setClear((all) => ({ ...all, [field.key]: false })); setTouched((all) => ({ ...all, [field.key]: true })); }} disabled={busy} />}{existing && field.set && <label className="plugin-clear"><input type="checkbox" checked={!!clear[field.key]} onChange={(e) => { setClear((all) => ({ ...all, [field.key]: e.target.checked })); setTouched((all) => ({ ...all, [field.key]: true })); }} /> Clear saved value</label>}</div>)}
    {initialBots !== undefined && <div className="plugin-form-bots"><strong>Bots</strong><PluginBots bots={bots} value={selectedBots} disabled={busy} onChange={setSelectedBots} /></div>}
  </Sheet>;
}

function AddMarketplaceSheet({ close, saved }: { close: () => void; saved: (market: PluginMarketplace) => void }) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function add() {
    if (!source.trim()) return;
    setBusy(true); setError("");
    try { saved(await api["plugins.addMarketplace"](source.trim())); } catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return <Sheet title="Add marketplace" close={close} submit={() => void add()} footer={<><span className="int-sheet-error" role="alert">{error}</span><button type="button" className="set-button" onClick={close}>Cancel</button><button className="set-button primary" disabled={busy || !source.trim()}>{busy ? "Adding…" : "Add marketplace"}</button></>}><p className="plugin-form-intro">Add a GitHub repository such as <code>owner/repo</code>, an HTTPS marketplace URL, or a folder marketplace.</p><label className="plugin-field"><span>Marketplace source</span><input autoFocus required value={source} onChange={(e) => setSource(e.target.value)} placeholder="owner/repo or https://…" /></label></Sheet>;
}

function FolderBrowserSheet({ close, choose }: { close: () => void; choose: (path: string) => void }) {
  const [path, setPath] = useState<string>();
  const [data, setData] = useState<{ path: string; parent: string | null; folders: { name: string; path: string }[]; roots?: { name: string; path: string }[] }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api.listFolders?.(path).then((value) => live && setData(value)).catch((e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [path]);
  return <Sheet title="Choose plugin folder" close={close} submit={() => data && choose(data.path)} footer={<><span className="int-sheet-error" role="alert">{error}</span><button type="button" className="set-button" onClick={close}>Cancel</button><button className="set-button primary" disabled={!data}>Choose this folder</button></>}><p className="plugin-form-intro">Choose a folder containing a plugin manifest. Its files will run on this computer after you review and enable it.</p>{data && <div className="plugin-folder-path"><button type="button" className="set-link" disabled={!data.parent} onClick={() => setPath(data.parent ?? undefined)}><ArrowLeft size={13} /> Up</button><code>{data.path}</code></div>}{data?.roots && data.roots.length > 1 && <div className="plugin-folder-roots">{data.roots.map((root) => <button type="button" className="set-button" key={root.path} onClick={() => setPath(root.path)}>{root.name}</button>)}</div>}<div className="plugin-folder-list">{data?.folders.map((folder) => <button type="button" key={folder.path} onClick={() => setPath(folder.path)}><span>{folder.name}</span><ChevronRight size={15} /></button>)}{data && !data.folders.length && <small>No folders here.</small>}{!data && !error && <span className="set-status"><Loader2 size={14} className="spin" /> Reading folders…</span>}</div></Sheet>;
}
