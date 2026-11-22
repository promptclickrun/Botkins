import { useEffect, useState, type HTMLAttributes, type SyntheticEvent } from "react";
import { FolderOpen, FolderPlus, Pencil, Plus, Search, ShieldAlert, Sparkles, Trash2, X } from "lucide-react";
import type { InstalledPlugin, SkillFolders, SkillInfo } from "./types";
import { decisionText, readTold, skillsOff, toldKey, writeTold } from "./pluginStarts";
import { useAsk } from "./Pages";
import { Group, Sheet, errorText } from "./SettingsRows";
import "./integrations.css";
import "./plugins.css";

const api = window.botkins;
/** React bubbles a nested dialog's cancel (Escape) through the component tree; this stops it at a wrapper. */
export const stopCancel = { onCancel: (e: SyntheticEvent) => e.stopPropagation() } as HTMLAttributes<HTMLDivElement>;
export const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
const plural = (n: number, one: string, many = one + "s") => n + " " + (n === 1 ? one : many);

export type SkillList = { skills: SkillInfo[] } & SkillFolders;

/** Every skill Botkins can see. The list is not in the live snapshot, so it is fetched, and fetched again when `stamp` changes. */
export function useSkills(stamp: string) {
  const [list, setList] = useState<SkillList>();
  const [error, setError] = useState("");
  const load = () =>
    api
      .skills()
      .then((l) => {
        setList(l);
        setError("");
      })
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, [stamp]);
  return { list, error, reload: load };
}

/** Where a skill comes from, as a short label. */
export function skillOrigin(skill: SkillInfo, list?: SkillList) {
  if (skill.origin === "built-in") return "Built in";
  if (skill.origin !== "folder") return "Botkins";
  const folder = list?.folders.find((f) => f.id === skill.folderId);
  return folder ? folderName(folder.path) : "Linked folder";
}

/** Settings › Skills: every skill for every bot, with New skill, Add from folder…, linked folders and plugins. */
/** Where the window keeps which "skills are off" notices the person closed. */
const TOLD = "botkins.plugins.skillsOffTold";

export default function SkillsSettings({
  stamp,
  plugins = [],
  hostId = "",
  openPlugin,
}: {
  stamp: string;
  /** The installed plugins, for the skills that are off with their plugin. */
  plugins?: InstalledPlugin[];
  /** The computer in use, when it is another one: what was told is kept for each computer. */
  hostId?: string;
  /** Opens an installed plugin's page in Settings › Marketplace. */
  openPlugin?: (id: string) => void;
}) {
  const { list, error: loadError, reload } = useSkills(stamp);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ name?: string } | null>(null);
  const [told, setTold] = useState(() => readTold(TOLD));
  /** A plugin folder that "Add from folder…" installed as a plugin just now. */
  const [installed, setInstalled] = useState<{ id: string; name: string; enabled: boolean }>();
  // Skills that are off because Botkins switched their plugin off: said here, where they are missed, one time.
  const missed = skillsOff(plugins, told, hostId);
  function close(plugin: InstalledPlugin) {
    const next = [...told, toldKey(plugin, hostId)];
    setTold(next);
    writeTold(TOLD, next);
  }
  const [platform, setPlatform] = useState("darwin");
  const dialogs = useAsk();
  useEffect(() => {
    api
      .appInfo()
      .then((i) => setPlatform(i.platform))
      .catch(() => {});
  }, []);
  const reveal = platform === "win32" ? "Show in Explorer" : platform === "darwin" ? "Show in Finder" : "Show in folder";
  async function run(fn: () => Promise<unknown>, done?: string) {
    setError("");
    setNote("");
    try {
      await fn();
      if (done) setNote(done);
    } catch (e) {
      setError(errorText(e));
    }
    await reload();
  }
  async function addFolder() {
    setError("");
    setNote("");
    try {
      const r = await api.addSkillFolder();
      if (!r) return;
      // A plugin folder is never linked for its skills: the computer installs it as a plugin.
      if (r.kind === "plugin" && r.id) {
        setInstalled({ id: r.id, name: r.name, enabled: r.enabled === true });
        await reload();
        return;
      }
      setNote(
        r.kind === "skill"
          ? "Added the skill " + r.name + "."
          : r.kind === "plugin"
            ? "Added the plugin " + r.name + "."
            : "Linked " + r.name + " (" + plural(r.count ?? 0, "skill") + ").",
      );
    } catch (e) {
      setError(errorText(e));
    }
    await reload();
  }
  async function remove(skill: SkillInfo) {
    const ok = await dialogs.ask({
      title: "Remove " + skill.name + "?",
      body: "Botkins deletes this skill's folder and no bot can use it any more.",
      confirm: "Remove",
      danger: true,
    });
    if (ok) await run(() => api.removeSkill(skill.name), "Removed " + skill.name + ".");
  }
  const skills = list?.skills ?? [];
  const q = query.trim().toLowerCase();
  const shown = q ? skills.filter((s) => (s.name + " " + s.description + " " + skillOrigin(s, list)).toLowerCase().includes(q)) : skills;
  const off = skills.filter((s) => !s.enabled).length;
  const actions = (
    <span className="int-actions">
      <button type="button" className="set-button" onClick={() => void addFolder()}>
        <FolderPlus size={14} />
        Add from folder…
      </button>
      <button type="button" className="set-button primary" onClick={() => setEditing({})}>
        <Plus size={14} />
        New skill
      </button>
    </span>
  );
  return (
    // Escape in a sheet or question closes only that, not Settings.
    <div className="int-section" {...stopCancel}>
      {list && skills.length > 0 && (
        <div className="set-toolbar int-toolbar">
          {skills.length > 8 ? (
            <label className="int-filter">
              <Search size={14} aria-hidden="true" />
              <input type="search" aria-label="Filter skills" placeholder="Filter skills" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
          ) : (
            <span className="int-count">
              {plural(skills.length, "skill")}
              {off ? " · " + off + " off" : ""}
            </span>
          )}
          {actions}
        </div>
      )}
      {installed && (
        <div className="plugin-notice" role="status" aria-label={decisionText(installed.name) + " was installed as a plugin"}>
          <ShieldAlert size={16} aria-hidden="true" />
          <div>
            <strong>{decisionText(installed.name)} was installed as a plugin</strong>
            <p>{installed.enabled ? "Its skills are on. Open the plugin to see what it runs." : "It is switched off, so its skills are off. Review what it runs, then turn it on."}</p>
          </div>
          {openPlugin && (
            <button type="button" className="set-button" onClick={() => openPlugin(installed.id)}>
              Open plugin
            </button>
          )}
          <button type="button" className="plugin-notice-close" aria-label="Close" onClick={() => setInstalled(undefined)}>
            <X size={15} />
          </button>
        </div>
      )}
      {missed.map((plugin) => (
        <div className="plugin-notice" role="status" aria-label={"Skills from " + decisionText(plugin.name) + " are off"} key={plugin.id}>
          <ShieldAlert size={16} aria-hidden="true" />
          <div>
            <strong>Skills from {decisionText(plugin.name)} are off</strong>
            <p>They are part of a plugin that is switched off. Review it, then turn it on.</p>
          </div>
          {openPlugin && (
            <button
              type="button"
              className="set-button"
              onClick={() => {
                close(plugin);
                openPlugin(plugin.id);
              }}
            >
              Open plugin
            </button>
          )}
          <button type="button" className="plugin-notice-close" aria-label={"Close the notice about " + decisionText(plugin.name)} onClick={() => close(plugin)}>
            <X size={15} />
          </button>
        </div>
      ))}
      {note && (
        <p className="set-status" role="status">
          {note}
        </p>
      )}
      {(error || loadError) && (
        <p className="set-status error-text" role="alert">
          {error || loadError}
        </p>
      )}
      {!list ? (
        <p className="set-status">Loading skills…</p>
      ) : skills.length === 0 ? (
        <Group>
          <div className="int-empty">
            <span className="int-empty-icon" aria-hidden="true">
              <Sparkles size={20} />
            </span>
            <strong>No skills yet</strong>
            <p>A skill teaches every bot how to do one kind of task.</p>
            {actions}
          </div>
        </Group>
      ) : (
        <Group footer="Every bot can use the skills that are on.">
          {shown.map((s) => (
            <div className="set-row int-item" key={s.name}>
              <div className="set-label">
                <span className="int-title">
                  <span className="set-name">{s.name}</span>
                  <span className="int-origin">{skillOrigin(s, list)}</span>
                </span>
                {s.description && (
                  <small className="int-clamp" id={"skill-desc-" + s.name} title={s.description}>
                    {s.description}
                  </small>
                )}
                {s.unavailable && <small className="int-note">{s.unavailable}</small>}
              </div>
              <div className="set-control int-trailing">
                {s.editable && (
                  <button type="button" className="int-icon" aria-label={"Edit " + s.name} title="Edit" onClick={() => setEditing({ name: s.name })}>
                    <Pencil size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className="int-icon"
                  aria-label={reveal + ": " + s.name}
                  title={reveal}
                  onClick={() => void api.revealSkill(s.name).catch((e) => setError(errorText(e)))}
                >
                  <FolderOpen size={14} />
                </button>
                {s.editable && (
                  <button type="button" className="int-icon danger" aria-label={"Remove " + s.name} title="Remove…" onClick={() => void remove(s)}>
                    <Trash2 size={14} />
                  </button>
                )}
                <input
                  type="checkbox"
                  role="switch"
                  className="switch set-switch"
                  aria-label={s.name}
                  aria-describedby={s.description ? "skill-desc-" + s.name : undefined}
                  checked={s.enabled}
                  onChange={(e) => void run(() => api.setSkillEnabled(s.name, e.target.checked))}
                />
              </div>
            </div>
          ))}
          {shown.length === 0 && (
            <div className="set-row">
              <small>No skills match “{query.trim()}”.</small>
            </div>
          )}
        </Group>
      )}
      {list && list.folders.length > 0 && (
        <Group title="Linked folders" footer="Edit them in their folder. Botkins reads them when a chat starts.">
          {list.folders.map((f) => (
            <div className="set-row int-item" key={f.id}>
              <div className="set-label">
                <span className="int-title">
                  <span className="set-name">{folderName(f.path)}</span>
                  {f.missing ? <span className="int-origin warn">Missing</span> : <span className="int-origin">{plural(f.skills, "skill")}</span>}
                </span>
                <small className="int-mono int-line" title={f.path}>
                  {f.path}
                </small>
              </div>
              <div className="set-control">
                <button type="button" className="set-button" aria-label={"Remove the folder " + folderName(f.path)} onClick={() => void run(() => api.removeSkillFolder(f.id), "Unlinked " + folderName(f.path) + ".")}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </Group>
      )}
      {list && list.plugins.length > 0 && (
        <Group title="Plugins" footer="A plugin brings its own skills, commands and MCP servers.">
          {list.plugins.map((f) => (
            <div className="set-row int-item" key={f.id}>
              <div className="set-label">
                <span className="int-title">
                  <span className="set-name">{folderName(f.path)}</span>
                  {f.missing && <span className="int-origin warn">Missing</span>}
                </span>
                <small className="int-mono int-line" title={f.path}>
                  {f.path}
                </small>
              </div>
              <div className="set-control">
                <button type="button" className="set-button" aria-label={"Remove the plugin " + folderName(f.path)} onClick={() => void run(() => api.removeSkillFolder(f.id), "Removed the plugin " + folderName(f.path) + ".")}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </Group>
      )}
      {editing && (
        <SkillSheet
          name={editing.name}
          close={() => setEditing(null)}
          saved={(name, created) => {
            setEditing(null);
            setError("");
            setNote(created ? "Created the skill " + name + "." : "Saved " + name + ".");
            void reload();
          }}
        />
      )}
      {dialogs.node}
    </div>
  );
}

/** New skill / Edit skill: name, a one-line description of when to use it, and the instructions. */
function SkillSheet({ name, close, saved }: { name?: string; close: () => void; saved: (name: string, created: boolean) => void }) {
  const [draft, setDraft] = useState({ name: name ?? "", description: "", instructions: "" });
  const [loading, setLoading] = useState(!!name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!name) return;
    api
      .readSkill(name)
      .then((s) => setDraft({ name: s.name, description: s.description, instructions: s.instructions }))
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [name]);
  const field = (k: keyof typeof draft) => ({
    value: draft[k],
    disabled: loading,
    onChange: (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value })),
  });
  async function submit() {
    if (!draft.name.trim() || !draft.description.trim() || !draft.instructions.trim()) {
      setError("Fill in the name, when to use it and the instructions.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const id = await api.saveSkill({ ...draft, ...(name && { original: name }) });
      saved(id, !name);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={name ? "Edit skill" : "New skill"}
      wide
      close={close}
      submit={() => void submit()}
      footer={
        <>
          {error && (
            <span className="int-sheet-error" role="alert">
              {error}
            </span>
          )}
          <button type="button" className="set-button" onClick={close}>
            Cancel
          </button>
          <button className="set-button primary" disabled={busy || loading}>
            {busy ? "Saving…" : name ? "Save skill" : "Create skill"}
          </button>
        </>
      }
    >
      <label>
        Name
        <input required maxLength={64} autoFocus={!name} spellCheck={false} placeholder="release-notes" {...field("name")} />
        <small className="int-hint">Lowercase letters, numbers and dashes. Bots see this name.</small>
      </label>
      <label>
        When to use it
        <input required maxLength={600} placeholder="Use when writing release notes from a list of changes." {...field("description")} />
      </label>
      <label>
        Instructions
        <textarea
          required
          className="int-mono-area"
          rows={12}
          maxLength={60000}
          spellCheck={false}
          placeholder={"# Release notes\n\n1. Group the changes by area.\n2. Write one plain sentence for each."}
          {...field("instructions")}
        />
        <small className="int-hint">Markdown. Saved as SKILL.md in the skill's folder.</small>
      </label>
    </Sheet>
  );
}
