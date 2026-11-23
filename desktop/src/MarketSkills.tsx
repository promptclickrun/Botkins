import { useEffect, useState } from "react";
import type { CatalogSkill, CatalogPreview, State } from "./types";
import { Group, Sheet, errorText } from "./SettingsRows";
import { useAsk } from "./Pages";
import { teamCan } from "./teamAccess";

const api = window.botkins;
export default function MarketSkills({ state, refreshed, openSkill }: { state: State; refreshed: number; openSkill: (name: string) => void }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<CatalogSkill[]>();
  const [detail, setDetail] = useState<{ row: CatalogSkill; preview: CatalogPreview }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const dialogs = useAsk();
  const supported = !state.remote?.using || state.remote.using.capabilities.includes("skills-catalog-v1");
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
  if (!supported) return <p className="set-status">Update the app on your computer to browse skills.</p>;
  const message = error && (
    <p role="alert" className="set-status error-text">
      {error}
    </p>
  );
  const link = (row: CatalogSkill) => (
    <a
      href={"https://skills.sh/" + row.id}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void api.openLink("https://skills.sh/" + row.id).catch((e) => setError(errorText(e)));
      }}
    >
      Open on skills.sh
    </a>
  );
  return (
    <>
      <label className="int-filter">
        <input
          type="search"
          aria-label="Search skills"
          placeholder="Search skills"
          maxLength={200}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {!query.trim() && (
        <div className="int-actions">
          {["design", "react", "testing", "docs", "writing"].map((q) => (
            <button key={q} className="set-button" onClick={() => setQuery(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
      {query.trim().length === 1 && <p className="set-status">Enter at least two characters.</p>}
      {query.trim().length >= 2 && !error && !rows && <p className="set-status">Searching…</p>}
      {!detail && message}
      {rows && (
        <Group>
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
                <button className="set-button" onClick={() => openSkill(row.installed!)}>
                  Installed · Open skill
                </button>
              ) : row.available ? (
                <button
                  className="set-button"
                  disabled={busy}
                  onClick={() => void act(async () => setDetail({ row, preview: await api["skillsCatalog.preview"](row.id) }))}
                >
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
                <button
                  type="button"
                  className="set-button primary"
                  disabled={busy || !teamCan(state, "skills", "create")}
                  onClick={() => void act(install)}
                >
                  Install
                </button>
              )}
            </>
          }
        >
          <p>{detail.preview.description}</p>
          <p>
            {detail.row.source} · {link(detail.row)}
          </p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{detail.preview.text}</pre>
        </Sheet>
      )}
      {dialogs.node}
    </>
  );
}
