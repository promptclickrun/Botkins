import { useEffect, useState } from "react";
import type { MarketCatalog as Catalog, MarketPackReview, MarketPluginReview, MarketSkillReview, MarketTemplateReview, State } from "./types";
import { Group, Sheet, errorText } from "./SettingsRows";
import { cadenceSummary } from "./Routines";
import { teamCan } from "./teamAccess";
import "./plugins.css";

// The "Botkins" shelf of Marketplace › Skills (marketplace format version 2, desktop/catalog-v2.mjs):
// the skills, packs and bot templates the marketplaces list, each read at its catalog's commit. Every
// install opens one review first, with everything it installs.

const api = window.botkins;
export const MARKETPLACE_V2 = "marketplace-v2-v1";

export function supportsMarketV2(remote: State["remote"]) {
  const using = remote?.using;
  return (!using || using.capabilities.includes(MARKETPLACE_V2)) && typeof api["market.catalog"] === "function";
}

type Review =
  | { kind: "skill"; review: MarketSkillReview; image?: string }
  | { kind: "pack"; review: MarketPackReview }
  | { kind: "template"; review: MarketTemplateReview };

const TOOL_WORDS: Record<string, string> = { shell: "shell", node: "Node", python: "Python", browser: "browser", network: "network" };
const words = (tools: string[]) => tools.map((tool) => TOOL_WORDS[tool] ?? tool).join(", ");

export default function MarketCatalog({ state, refreshed }: { state: State; refreshed: number }) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [open, setOpen] = useState<Review>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [revision, setRevision] = useState(0);
  const [bots, setBots] = useState<string[]>([]);
  const [routinesOn, setRoutinesOn] = useState<string[]>([]);
  const canInstall = !state.remote?.using || teamCan(state, "skills", "manage");
  useEffect(() => {
    let live = true;
    api["market.catalog"]().then(
      (next) => live && setCatalog(next),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [refreshed, revision]);
  if (!catalog || (!catalog.skills.length && !catalog.packs.length && !catalog.templates.length)) return null;

  async function act(work: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const openSkill = (id: string, hasPreview: boolean) =>
    void act(async () => {
      const review = await api["market.skillPreview"](id);
      setBots([]);
      setDone("");
      setOpen({ kind: "skill", review });
      if (hasPreview) api["market.skillImage"](id).then((image) => setOpen((was) => (was?.kind === "skill" && was.review.listing.id === id ? { ...was, image } : was)), () => {});
    });
  const openPack = (id: string) =>
    void act(async () => {
      setBots([]);
      setDone("");
      setOpen({ kind: "pack", review: await api["market.packPreview"](id) });
    });
  const openTemplate = (id: string) =>
    void act(async () => {
      const review = await api["market.templatePreview"](id);
      setDone("");
      setRoutinesOn(review.routines.map((r) => r.name));
      setOpen({ kind: "template", review });
    });
  const scope = bots.length ? bots : "all";
  async function install() {
    if (!open) return;
    if (open.kind === "skill") {
      const result = await api["market.skillInstall"](open.review.token, { bots: scope });
      if (result.conflicts.length) throw new Error("A skill named " + result.conflicts.join(", ") + " is installed already. Choose bots to give this one to them only.");
      setDone("Installed " + result.added.join(", ") + ".");
    } else if (open.kind === "pack") {
      const result = await api["market.packInstall"](open.review.token, { bots: scope, commit: open.review.commit });
      if (result.conflicts.length) throw new Error("A skill named " + result.conflicts.join(", ") + " is installed already. Choose bots to give the pack to them only.");
      setDone("Installed " + [...result.added, ...result.plugins].join(", ") + ".");
    } else {
      await api["market.templateInstall"](open.review.token, { commit: open.review.commit, routines: routinesOn });
      setDone("Made the bot " + open.review.name + ".");
    }
    setRevision((n) => n + 1);
  }
  const botPicker = (
    <Group title="For" footer="No bot chosen: every bot gets it, as a shared skill.">
      {state.bots.map((bot) => (
        <label className="set-row" key={bot.id}>
          <span className="set-label">{bot.name}</span>
          <input type="checkbox" checked={bots.includes(bot.id)} onChange={(e) => setBots(e.target.checked ? [...bots, bot.id] : bots.filter((id) => id !== bot.id))} />
        </label>
      ))}
    </Group>
  );
  return (
    <>
      <Group title="Botkins">
        {catalog.skills.map((skill) => (
          <div className="set-row" key={skill.id}>
            <div className="set-label">
              <strong>{skill.name}</strong>
              <small>{skill.summary}</small>
              <small>
                v{skill.version} · {skill.license}
                {skill.requires.tools.length ? " · needs " + words(skill.requires.tools) : ""}
                {skill.update ? " · update available" : skill.installed ? " · installed" : ""}
              </small>
              {skill.warnings.map((warning) => (
                <small key={warning} className="error-text">{warning}</small>
              ))}
            </div>
            <button className="set-button" disabled={busy} onClick={() => openSkill(skill.id, skill.hasPreview)}>
              {skill.update ? "Update" : "Preview"}
            </button>
          </div>
        ))}
        {catalog.packs.map((pack) => (
          <div className="set-row" key={pack.id}>
            <div className="set-label">
              <strong>{pack.name}</strong>
              <small>{pack.summary}</small>
              <small>Pack · v{pack.version} · {pack.skills.length + pack.plugins.length} items</small>
            </div>
            <button className="set-button" disabled={busy} onClick={() => openPack(pack.id)}>Preview</button>
          </div>
        ))}
        {catalog.templates.map((template) => (
          <div className="set-row" key={template.id}>
            <div className="set-label">
              <strong>{template.name}</strong>
              <small>{template.summary || template.role}</small>
              <small>Bot template{template.version ? " · v" + template.version : ""}</small>
            </div>
            <button className="set-button" disabled={busy} onClick={() => openTemplate(template.id)}>Preview</button>
          </div>
        ))}
      </Group>
      {!open && error && <p role="alert" className="set-status error-text">{error}</p>}
      {open && (
        <Sheet
          wide
          title={open.kind === "skill" ? open.review.name : open.review.name}
          close={() => setOpen(undefined)}
          submit={() => {}}
          footer={
            <>
              {error && <p role="alert" className="set-status error-text">{error}</p>}
              {done ? (
                <p className="set-status">{done}</p>
              ) : (
                <button type="button" className="set-button primary" disabled={busy || !canInstall} onClick={() => void act(install)}>
                  {open.kind === "template" ? "Create bot" : open.kind === "skill" && open.review.update ? "Update" : "Install"}
                </button>
              )}
            </>
          }
        >
          {open.kind === "skill" && (
            <>
              {open.image && <img src={open.image} alt="" style={{ maxWidth: "100%", borderRadius: 8 }} />}
              <SkillFacts review={open.review} />
              {open.review.update && <UpdateDiff update={open.review.update} />}
              {botPicker}
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{open.review.text}</pre>
            </>
          )}
          {open.kind === "pack" && (
            <>
              <p>{open.review.summary}</p>
              {open.review.skills.map((skill) => <SkillFacts key={skill.token} review={skill} />)}
              <Plugins plugins={open.review.plugins} />
              {botPicker}
            </>
          )}
          {open.kind === "template" && (
            <>
              <p><strong>{open.review.role}</strong></p>
              {open.review.summary && <p>{open.review.summary}</p>}
              <Group title="Instructions" footer="Someone else wrote these instructions: read them first.">
                <pre className="set-row" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{open.review.instructions}</pre>
              </Group>
              {open.review.skills.map((skill) => <SkillFacts key={skill.token} review={skill} />)}
              {!!open.review.privateSkills.length && (
                <Group title="Skills for this bot only">
                  {open.review.privateSkills.map((skill) => (
                    <details className="set-row bundle-item" key={skill.name} open>
                      <summary><strong>{skill.name}</strong> · {skill.description}</summary>
                      <p style={{ whiteSpace: "pre-wrap" }}>{skill.instructions}</p>
                    </details>
                  ))}
                </Group>
              )}
              <Plugins plugins={open.review.plugins} />
              {!!open.review.routines.length && (
                <Group title="Routines" footer="A routine starts paused unless the template marks it active. Turn one off to leave it out.">
                  {open.review.routines.map((routine) => (
                    <div className="set-row stacked" key={routine.name}>
                      <label className="set-label">
                        <span>
                          <input type="checkbox" checked={routinesOn.includes(routine.name)} onChange={(e) => setRoutinesOn(e.target.checked ? [...routinesOn, routine.name] : routinesOn.filter((n) => n !== routine.name))} />{" "}
                          <strong>{routine.name}</strong> · {cadenceSummary(routine.cadence)} · {routine.active ? "starts active" : "starts paused"}
                        </span>
                      </label>
                      <p style={{ whiteSpace: "pre-wrap" }}>{routine.instructions}</p>
                    </div>
                  ))}
                </Group>
              )}
            </>
          )}
        </Sheet>
      )}
    </>
  );
}

function SkillFacts({ review }: { review: MarketSkillReview }) {
  const { listing } = review;
  return (
    <Group title={review.name + " " + listing.version}>
      <div className="set-row stacked">
        <dl className="plugin-facts">
          <dt>License</dt>
          <dd><span className="plugin-plain">{listing.license}</span></dd>
          <dt>From</dt>
          <dd><span className="plugin-plain">{listing.marketplaceName} @ {listing.commit.slice(0, 7)}</span></dd>
          <dt>Files</dt>
          <dd><span className="plugin-plain">{review.files.length} files, {Math.ceil(review.size / 1024)} KiB</span></dd>
          {!!review.executable.length && (
            <>
              <dt>Executable</dt>
              <dd><span className="plugin-words">{review.executable.map((file) => <span key={file}>{file}</span>)}</span></dd>
            </>
          )}
          {!!listing.requires.tools.length && (
            <>
              <dt>Needs</dt>
              <dd><span className="plugin-plain">{words(listing.requires.tools)}</span></dd>
            </>
          )}
          {!!listing.requires.optional.length && (
            <>
              <dt>Uses if there</dt>
              <dd><span className="plugin-plain">{words(listing.requires.optional)}</span></dd>
            </>
          )}
        </dl>
        {listing.warnings.map((warning) => <p key={warning} className="error-text">{warning}</p>)}
        <p className="set-foot">Installing a skill never runs anything.</p>
      </div>
    </Group>
  );
}

function UpdateDiff({ update }: { update: NonNullable<MarketSkillReview["update"]> }) {
  const rows: [string, string[]][] = [["Added", update.added], ["Changed", update.changed], ["Removed", update.removed]];
  return (
    <Group title={"Update " + update.from + " → " + update.to}>
      {rows.map(([label, files]) =>
        files.length ? (
          <div className="set-row stacked" key={label}>
            <span className="set-name">{label}</span>
            <span className="plugin-words">{files.map((file) => <span key={file}>{file}</span>)}</span>
          </div>
        ) : null,
      )}
    </Group>
  );
}

function Plugins({ plugins }: { plugins: MarketPluginReview[] }) {
  if (!plugins.length) return null;
  return (
    <Group title="Plugins">
      {plugins.map((plugin) => (
        <div className="set-row stacked" key={plugin.id}>
          <strong>{plugin.name}{plugin.version ? " " + plugin.version : ""}{plugin.installed ? (plugin.installed.matchesRevision === false ? " · installed (different revision)" : " · installed") : ""}</strong>
          {plugin.description && <small>{plugin.description}</small>}
          {(plugin.contents?.mcpServers ?? []).map((server) => (
            <small key={server.name}>Tool {server.name}: {server.kind === "remote" ? server.url : [server.command, ...(server.args ?? [])].join(" ")}</small>
          ))}
          {(plugin.contents?.hooks ?? []).map((hook, i) => (
            <small key={i}>Hook at {hook.event}: {hook.command}</small>
          ))}
          {plugin.installed?.matchesRevision === false && (
            <small className="error-text">Installed at a different revision. Update it in Marketplace › Plugins first.</small>
          )}
          {(plugin.warnings ?? []).map((warning) => <small key={warning} className="error-text">{warning}</small>)}
        </div>
      ))}
    </Group>
  );
}
