import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button, SearchField } from "glisse";
import type { CatalogSkill, CatalogPreview, FeaturedSkill, SkillInfo, SkillSource, State } from "./types";
import { Group, Sheet, errorText } from "./SettingsRows";
import { useAsk } from "./Pages";
import { teamCan } from "./teamAccess";
import "./plugins.css";

// Marketplace › Skills: with no search, a featured shelf (skills from known repositories at a
// pinned commit, each with its license and author) and the skills built into Botkins; a search
// asks skills.sh. A featured skill is previewed and installed exactly as a skills.sh one.

const api = window.botkins;
const FEATURED = "skills-featured-v1";

/** What a preview was opened from: a search result or a featured skill. */
type Origin = { id: string; label: string; link?: { url: string; text: string } };

const short = (commit: string) => commit.slice(0, 7);

export default function MarketSkills({ state, refreshed, openSkill }: { state: State; refreshed: number; openSkill: (name: string) => void }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<CatalogSkill[]>();
  const [featured, setFeatured] = useState<FeaturedSkill[]>();
  const [builtIn, setBuiltIn] = useState<SkillInfo[]>();
  const [detail, setDetail] = useState<{ from: Origin; preview: CatalogPreview }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const dialogs = useAsk();
  const using = state.remote?.using;
  const supported = !using || using.capabilities.includes("skills-catalog-v1");
  const shelf = supported && (!using || using.capabilities.includes(FEATURED)) && typeof api["skillsCatalog.featured"] === "function";
  useEffect(() => {
    let live = true;
    setRows(undefined);
    setError("");
    if (!supported || query.trim().length < 2) return;
    const timer = setTimeout(
      () =>
        api["skillsCatalog.search"](query).then(
          (next) => {
            if (live) setRows(next);
          },
          (e) => {
            if (live) setError(errorText(e));
          },
        ),
      250,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, supported, refreshed, revision]);
  // The shelf and the built-in skills, read on the first visit and after each install.
  useEffect(() => {
    let live = true;
    if (shelf)
      api["skillsCatalog.featured"]().then(
        (next) => live && setFeatured(next),
        (e) => live && setError(errorText(e)),
      );
    api.skills().then(
      (next) => live && setBuiltIn(next.skills.filter((skill) => skill.origin === "built-in")),
      () => live && setBuiltIn([]),
    );
    return () => {
      live = false;
    };
  }, [shelf, refreshed, revision, using?.id]);
  const groups = useMemo(() => {
    const out = new Map<string, FeaturedSkill[]>();
    for (const skill of featured ?? []) out.set(skill.group, [...(out.get(skill.group) ?? []), skill]);
    return [...out];
  }, [featured]);

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
  async function install() {
    if (!detail) return;
    const { token } = detail.preview;
    let result = await api["skillsCatalog.install"](token);
    if (result.conflicts.length) {
      if (!(await dialogs.ask({ title: "Replace existing skills?", body: result.conflicts.join(", "), confirm: "Replace", danger: true }))) return;
      result = await api["skillsCatalog.install"](token, result.conflicts);
    }
    if (!result.added.length) throw new Error("The skills changed. Open the preview again.");
    setDetail({ ...detail, preview: { ...detail.preview, installed: result.added[0] } });
    setRevision((n) => n + 1);
  }
  const preview = (from: Origin) => void act(async () => setDetail({ from, preview: await api["skillsCatalog.preview"](from.id) }));
  if (!supported) return <p className="set-status">Update the app on your computer to browse skills.</p>;
  const message = error && (
    <p role="alert" className="set-status error-text">
      {error}
    </p>
  );
  const outLink = (url: string, text: string) => (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void api.openLink(url).catch((e) => setError(errorText(e)));
      }}
    >
      {text}
    </a>
  );
  const link = (row: CatalogSkill) => outLink("https://skills.sh/" + row.id, "Open on skills.sh");
  const openButton = (name: string) => (
    <Button variant="glass" className="lg-compact" onClick={() => openSkill(name)}>
      Installed · Open skill
    </Button>
  );
  const searching = query.trim().length > 0;
  const source: SkillSource | undefined = detail?.preview.source;
  return (
    <>
      <div className="set-toolbar int-toolbar plugin-toolbar">
        <SearchField aria-label="Search skills" placeholder="Search skills" maxLength={200} value={query} onValueChange={setQuery} />
      </div>
      {query.trim().length === 1 && <p className="set-status">Enter at least two characters.</p>}
      {query.trim().length >= 2 && !error && !rows && <p className="set-status">Searching…</p>}
      {!detail && message}
      {!searching && (
        <>
          {shelf && !featured && !error && <p className="set-status">Loading skills…</p>}
          {groups.map(([group, skills]) => (
            <Group key={group} title={group}>
              {skills.map((skill) => (
                <div className="set-row" key={skill.id}>
                  <div className="set-label">
                    <strong>{skill.name}</strong>
                    <small>{skill.summary}</small>
                    <small>
                      {skill.author} · {skill.license}
                    </small>
                  </div>
                  {skill.installed ? (
                    openButton(skill.installed)
                  ) : (
                    <button className="set-button" disabled={busy} onClick={() => preview({ id: skill.id, label: skill.author + " · " + skill.license })}>
                      Preview
                    </button>
                  )}
                </div>
              ))}
            </Group>
          ))}
          {!!builtIn?.length && (
            <Group title="Built into Botkins">
              {builtIn.map((skill) => (
                <div className="set-row" key={skill.name}>
                  <div className="set-label">
                    <strong>{skill.name}</strong>
                    {skill.description && <small>{skill.description}</small>}
                  </div>
                  <button className="set-button" onClick={() => openSkill(skill.name)}>
                    Open
                  </button>
                </div>
              ))}
            </Group>
          )}
        </>
      )}
      {rows && (
        <Group title="On skills.sh">
          {!rows.length && <p className="set-status">No matching skills.</p>}
          {rows.map((row) => (
            <div className="set-row" key={row.id}>
              <div className="set-label">
                <strong>{row.name}</strong>
                <small>
                  {row.source} · {row.installs.toLocaleString()} installs
                </small>
              </div>
              {row.available && !row.installed && link(row)}
              {row.installed ? (
                openButton(row.installed)
              ) : row.available ? (
                <button className="set-button" disabled={busy} onClick={() => preview({ id: row.id, label: row.source, link: { url: "https://skills.sh/" + row.id, text: "Open on skills.sh" } })}>
                  Preview
                </button>
              ) : (
                link(row)
              )}
            </div>
          ))}
        </Group>
      )}
      {detail && (
        <Sheet
          wide
          title={detail.preview.name}
          close={() => setDetail(undefined)}
          submit={() => {}}
          footer={
            <>
              {message}
              {detail.preview.installed ? (
                <button type="button" className="set-button" onClick={() => openSkill(detail.preview.installed!)}>
                  Installed · Open skill
                </button>
              ) : (
                <button type="button" className="set-button primary" disabled={busy || !teamCan(state, "skills", "create")} onClick={() => void act(install)}>
                  Install
                </button>
              )}
            </>
          }
        >
          <p>{detail.preview.description}</p>
          {source ? (
            <Group>
              <div className="set-row stacked">
                <dl className="plugin-facts">
                  <dt>License</dt>
                  <dd>
                    <span className="plugin-plain">{source.license}</span>
                  </dd>
                  <dt>Author</dt>
                  <dd>
                    <span className="plugin-plain">{source.author}</span>
                  </dd>
                  <dt>Source</dt>
                  <dd>
                    <span className="plugin-plain">
                      {outLink(source.url, source.repo + "@" + short(source.commit))} <ExternalLink size={12} aria-hidden="true" />
                    </span>
                  </dd>
                  {!!detail.preview.files?.length && (
                    <>
                      <dt>Files</dt>
                      <dd>
                        <span className="plugin-words">
                          {detail.preview.files.map((file) => (
                            <span key={file}>{file}</span>
                          ))}
                        </span>
                      </dd>
                    </>
                  )}
                </dl>
              </div>
            </Group>
          ) : (
            <p>
              {detail.from.label}
              {detail.from.link && <> · {outLink(detail.from.link.url, detail.from.link.text)}</>}
            </p>
          )}
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{detail.preview.text}</pre>
        </Sheet>
      )}
      {dialogs.node}
    </>
  );
}
