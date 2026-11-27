// A project's Jobs: write one prompt or a batch, pick the bots that can open the project, and each prompt
// starts its own chat on its own branch, in a git worktree made from your checkout (desktop/jobs.mjs).
// Finished jobs come back here to be brought into the checkout, or caught up when your branch moved on.
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "glisse";
import { ChevronDown, ChevronRight, GitBranch, GitMerge, MessageCircle, Play, Plus, RefreshCw, Rocket, ShieldCheck, Trash2, X } from "lucide-react";
import { BotAvatar } from "./Avatar";
import { useAsk } from "./Pages";
import { modeLabels } from "./ProjectChanges";
import { FolderChoice } from "./ProjectFolders";
import { canUseProject } from "./access";
import { baseName, jobCounts, jobStage, launchable, projectJobs, STAGE_LABELS, type Draft, type JobStage } from "./jobs";
import type { Chat, ChatMode, JobSetup, JobStatus, Project, State } from "./types";
import "./jobs.css";

const api = window.botkins;
const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const plural = (n: number, one: string, many = one + "s") => n + " " + (n === 1 ? one : many);

export default function ProjectJobs({
  state,
  project,
  openChat,
  manageAccess,
  fail,
}: {
  state: State;
  project: Project;
  openChat: (id: string) => void;
  /** The project's Access section. */
  manageAccess: () => void;
  fail: (e: unknown) => void;
}) {
  const bots = state.bots.filter((b) => canUseProject(state, b, project));
  const blocked = state.bots.filter((b) => !b.hidden && !canUseProject(state, b, project));
  const [folder, setFolder] = useState<string>();
  const [setup, setSetup] = useState<JobSetup | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [where, setWhere] = useState<"worktree" | "checkout">("worktree");
  const [mode, setMode] = useState<ChatMode>(project.mode ?? "default");
  const [carry, setCarry] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([{ id: 1, prompt: "", botIds: bots[0] ? [bots[0].id] : [] }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string>();
  const dialogs = useAsk();
  const jobs = projectJobs(state, project.id);
  const chosenFolder = project.folders?.includes(folder ?? "") ? folder : undefined;
  // The checkout moves when a job is brought in: read it again then, and when the folder changes.
  const broughtIn = jobs.filter((chat) => chat.job?.state === "brought-in").length;
  const load = () =>
    api
      .projectJobSetup(project.id, chosenFolder)
      .then((found) => {
        setSetup(found);
        if (!found.repo) setWhere("checkout");
      })
      .catch((e) => setError(clean(e)));
  useEffect(() => {
    setSetup(null);
    if (project.folder) void load();
    else setWhere("checkout");
  }, [project.id, project.folder, chosenFolder, broughtIn]);
  // A draft whose bot lost its access, or a first draft written before the bots were known, gets the first bot that can open the project.
  useEffect(() => {
    setDrafts((list) => list.map((draft) => ({ ...draft, botIds: draft.botIds.filter((id) => bots.some((b) => b.id === id)).length ? draft.botIds.filter((id) => bots.some((b) => b.id === id)) : bots[0] ? [bots[0].id] : [] })));
  }, [bots.map((b) => b.id).join(",")]);

  const repo = setup?.repo ? setup : null;
  const inCheckout = where === "checkout";
  const needsYes = !inCheckout && !!repo && !repo.approved && !repo.error;
  const { ready, jobs: count } = launchable(drafts);
  const update = (id: number, patch: Partial<Draft>) => setDrafts((list) => list.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
  const toggleBot = (draft: Draft, botId: string) => {
    // Your checkout takes one job at a time, so one bot.
    if (inCheckout) return update(draft.id, { botIds: [botId] });
    const has = draft.botIds.includes(botId);
    if (has && draft.botIds.length === 1) return;
    update(draft.id, { botIds: has ? draft.botIds.filter((id) => id !== botId) : [...draft.botIds, botId] });
  };
  function chooseWhere(next: "worktree" | "checkout") {
    setWhere(next);
    if (next === "checkout") setDrafts((list) => [{ ...list[0], botIds: list[0].botIds.slice(0, 1) }]);
  }
  async function allow() {
    if (!repo) return;
    try {
      await api.approveJobSetup(project.id, chosenFolder, repo.hash);
      await load();
    } catch (e) {
      setError(clean(e));
    }
  }
  async function launch() {
    if (!ready.length || busy) return;
    setError("");
    if (needsYes) {
      setShowSetup(true);
      setError("Allow this repository's setup commands first, or start in your checkout.");
      return;
    }
    if (mode === "yolo" && !(await dialogs.ask({ title: "Start in YOLO mode?", body: "Each request of the bot in " + (count === 1 ? "this job" : "these jobs") + " gets a yes with no question, but for one that leaves the sandbox.", confirm: "Start", danger: true }))) return;
    setBusy(true);
    try {
      for (const draft of ready) {
        await api.startProjectJob(project.id, { botIds: draft.botIds, prompt: draft.prompt.trim(), where, mode: project.folder ? mode : "default", ...(chosenFolder && { folder: chosenFolder }), ...(carry && !inCheckout && { carry: true }) });
        // A draft that started leaves the batch at once: when a later one fails, what is left is what didn't start.
        setDrafts((list) => (list.length > 1 ? list.filter((entry) => entry.id !== draft.id) : [{ id: draft.id + 1, prompt: "", botIds: draft.botIds }]));
      }
      setCarry(false);
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(false);
    }
  }

  const fromLine = repo ? (repo.base ?? "a detached HEAD") + " @ " + (repo.short ?? "no commit") : "";
  return (
    <div className="record-detail project-jobs">
      <section className="page-section" aria-labelledby="jobs-new">
        <div className="group-label">
          <h3 id="jobs-new" className="card-title">
            New jobs
          </h3>
          <span className="spacer" />
          {project.folder && (
            <button type="button" className={"job-checkout-chip" + (needsYes ? " warn" : "")} aria-expanded={showSetup || needsYes} onClick={() => setShowSetup((v) => !v)}>
              <GitBranch size={13} aria-hidden="true" />
              {repo ? baseName(repo.root) + " · " + fromLine + " · " + (repo.changed ? plural(repo.changed, "change") : "Clean") : setup ? "Not a git repository" : "Reading the checkout…"}
            </button>
          )}
        </div>
        <div className="group padded job-composer">
          {bots.length === 0 ? (
            <p className="job-empty">
              No bot can open this project yet.{" "}
              <button type="button" className="link-button" onClick={manageAccess}>
                Manage access
              </button>
            </p>
          ) : (
            <>
              {drafts.map((draft, index) => (
                <div key={draft.id} className="job-draft">
                  {drafts.length > 1 && <span className="job-draft-n">{index + 1}</span>}
                  <div className="job-draft-body">
                    <textarea
                      aria-label={drafts.length > 1 ? "Prompt " + (index + 1) : "Prompt"}
                      rows={drafts.length > 1 ? 2 : 3}
                      maxLength={32000}
                      placeholder={index === 0 ? "What should it do?" : "And another job…"}
                      value={draft.prompt}
                      onChange={(e) => update(draft.id, { prompt: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void launch();
                        }
                      }}
                    />
                    <div className="job-bots" role="group" aria-label={"Bots for prompt " + (index + 1)}>
                      {bots.map((b) => (
                        <button key={b.id} type="button" className="job-bot" aria-pressed={draft.botIds.includes(b.id)} onClick={() => toggleBot(draft, b.id)}>
                          <BotAvatar bot={b} size={20} badge={false} />
                          {b.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  {drafts.length > 1 && (
                    <button type="button" className="icon-button" aria-label={"Remove prompt " + (index + 1)} onClick={() => setDrafts((list) => list.filter((entry) => entry.id !== draft.id))}>
                      <X size={15} />
                    </button>
                  )}
                </div>
              ))}
              <div className="job-options">
                {!inCheckout && drafts.length < 10 && (
                  <button type="button" className="secondary" onClick={() => setDrafts((list) => [...list, { id: Math.max(...list.map((d) => d.id)) + 1, prompt: "", botIds: list.at(-1)!.botIds }])}>
                    <Plus size={14} /> Add a prompt
                  </button>
                )}
                {repo && (
                  <div className="job-seg" role="radiogroup" aria-label="Where it works">
                    <button type="button" role="radio" aria-checked={!inCheckout} onClick={() => chooseWhere("worktree")}>
                      Own worktree
                    </button>
                    <button type="button" role="radio" aria-checked={inCheckout} onClick={() => chooseWhere("checkout")}>
                      Your checkout
                    </button>
                  </div>
                )}
                {project.folder && (
                  <select aria-label="Mode" className="record-select" value={mode} onChange={(e) => setMode(e.target.value as ChatMode)}>
                    {(Object.keys(modeLabels) as ChatMode[]).map((m) => (
                      <option key={m} value={m}>
                        {modeLabels[m].label}
                      </option>
                    ))}
                  </select>
                )}
                <FolderChoice project={project} value={folder} change={setFolder} />
                {repo && !inCheckout && repo.changed > 0 && (
                  <label className="job-carry">
                    <input type="checkbox" checked={carry} onChange={(e) => setCarry(e.target.checked)} />
                    Bring uncommitted changes
                  </label>
                )}
                <span className="spacer" />
                <Button variant="filled" className="lg-compact" icon={<Rocket size={15} />} disabled={!count || busy} onClick={() => void launch()}>
                  {busy ? "Starting…" : count > 1 ? "Start " + count + " jobs" : "Start job"}
                </Button>
              </div>
            </>
          )}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <p className="group-foot">
          {!project.folder
            ? "Each prompt starts its own chat in this project."
            : inCheckout
              ? "Works right in your checkout, one job at a time."
              : repo
                ? "Each bot gets its own chat, on its own branch from " + fromLine + ". Your checkout isn't touched until you bring a job in."
                : "This folder isn't a git repository, so jobs work right in it, one at a time."}
          {blocked.length > 0 && bots.length > 0 && (
            <>
              {" "}
              {blocked.length === 1 ? blocked[0].name + " can't" : plural(blocked.length, "bot") + " can't"} open this project.{" "}
              <button type="button" className="link-button" onClick={manageAccess}>
                Manage access
              </button>
            </>
          )}
        </p>
      </section>

      {project.folder && (showSetup || needsYes) && <WhereItWorks setup={setup} allow={() => void allow()} reload={() => void load()} close={() => setShowSetup(false)} />}

      <section className="page-section" aria-labelledby="jobs-feed">
        <div className="group-label">
          <h3 id="jobs-feed" className="card-title">
            Jobs
          </h3>
          <span className="spacer" />
          <span className="job-counts">{jobCounts(state, jobs)}</span>
        </div>
        {jobs.length ? (
          <div className="group rows job-feed">
            {jobs.map((chat) => (
              <JobRow key={chat.id} state={state} chat={chat} open={openId === chat.id} toggle={() => setOpenId((id) => (id === chat.id ? undefined : chat.id))} openChat={openChat} ask={dialogs.ask} fail={fail} />
            ))}
          </div>
        ) : (
          <p className="group-foot">No jobs yet. Each one you start shows here, with what it changed.</p>
        )}
      </section>
      {dialogs.node}
    </div>
  );
}

/** "Where it works": the checkout jobs start from, the repository's setup commands, and the yes they need. */
function WhereItWorks({ setup, allow, reload, close }: { setup: JobSetup | null; allow: () => void; reload: () => void; close: () => void }) {
  let body: ReactNode;
  if (!setup) body = <p className="job-muted">Reading the checkout…</p>;
  else if (!setup.repo) body = <p className="job-muted">This folder isn't a git repository, so jobs work right in it, one at a time.</p>;
  else
    body = (
      <>
        <dl className="job-facts">
          <dt>Starts from</dt>
          <dd>
            {baseName(setup.root)} · {(setup.base ?? "a detached HEAD") + " @ " + (setup.short ?? "no commit")} · {setup.changed ? plural(setup.changed, "file") + " not committed" : "Clean"}
          </dd>
          <dt>Branches</dt>
          <dd>
            <code>{setup.branch}</code>, in worktrees that Botkins keeps outside your repository
          </dd>
          <dt>On each new worktree</dt>
          <dd>
            {setup.error ? (
              <span className="field-error">{setup.error}</span>
            ) : setup.setup.length ? (
              <pre className="job-commands">{setup.setup.map((line) => "$ " + line).join("\n")}</pre>
            ) : (
              <span className="job-muted">
                Nothing runs. A repository can list setup commands in <code>.botkins/worktrees.json</code>, such as <code>{'{ "setup": ["npm ci"] }'}</code>.
              </span>
            )}
          </dd>
        </dl>
        {!setup.error && setup.setup.length > 0 && !setup.approved && (
          <div className="job-allow">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>These commands come from the repository and run on this computer, as you, in each new worktree.</span>
            <Button variant="filled" className="lg-compact" onClick={allow}>
              Allow them
            </Button>
          </div>
        )}
        {!setup.error && setup.setup.length > 0 && setup.approved && <p className="job-muted">Allowed. A changed list asks again.</p>}
      </>
    );
  return (
    <section className="page-section" aria-labelledby="jobs-where">
      <div className="group-label">
        <h3 id="jobs-where" className="card-title">
          Where it works
        </h3>
        <span className="spacer" />
        <button type="button" className="icon-button" aria-label="Read the checkout again" onClick={reload}>
          <RefreshCw size={14} />
        </button>
        <button type="button" className="icon-button" aria-label="Close" onClick={close}>
          <X size={14} />
        </button>
      </div>
      <div className="group padded">{body}</div>
    </section>
  );
}

function JobRow({
  state,
  chat,
  open,
  toggle,
  openChat,
  ask,
  fail,
}: {
  state: State;
  chat: Chat;
  open: boolean;
  toggle: () => void;
  openChat: (id: string) => void;
  ask: ReturnType<typeof useAsk>["ask"];
  fail: (e: unknown) => void;
}) {
  const job = chat.job!;
  const bot = state.bots.find((b) => b.id === chat.botId);
  const stage = jobStage(state, chat);
  return (
    <div className={"job-item" + (open ? " open" : "")}>
      <div className="group-row job-row">
        <BotAvatar bot={bot} size={32} state={stage === "working" ? "thinking" : "idle"} badge={false} />
        <button type="button" className="row-main" aria-expanded={open} onClick={toggle}>
          <span className="row-title">{chat.title}</span>
          <span className="row-sub">
            {bot?.name ?? "A bot"} · {job.where === "checkout" ? "Your checkout" : job.branch ?? "Making its worktree"}
          </span>
        </button>
        <StageBadge stage={stage} />
        {open ? <ChevronDown size={15} className="row-chevron" aria-hidden="true" /> : <ChevronRight size={15} className="row-chevron" aria-hidden="true" />}
      </div>
      {open && <JobDetail state={state} chat={chat} stage={stage} bot={bot?.name ?? "the bot"} openChat={openChat} ask={ask} fail={fail} />}
    </div>
  );
}

export function StageBadge({ stage }: { stage: JobStage }) {
  return <span className={"job-stage " + stage}>{STAGE_LABELS[stage]}</span>;
}

function JobDetail({
  state,
  chat,
  stage,
  bot,
  openChat,
  ask,
  fail,
}: {
  state: State;
  chat: Chat;
  stage: JobStage;
  bot: string;
  openChat: (id: string) => void;
  ask: ReturnType<typeof useAsk>["ask"];
  fail: (e: unknown) => void;
}) {
  const job = chat.job!;
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [conflicts, setConflicts] = useState<string[]>([]);
  const read = () =>
    api
      .projectJobStatus(chat.id)
      .then(setStatus)
      .catch((e) => fail(e));
  // What it changed moves with the chat: read it again when the job's stage or its messages change.
  useEffect(() => {
    void read();
  }, [chat.id, stage, chat.messages.length, job.state]);
  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    try {
      await fn();
      await read();
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  }
  async function bringIn() {
    if (!status) return;
    const files = status.files?.length ?? 0;
    const yes = await ask({ title: "Bring this job in?", body: "Merges " + status.branch + " (" + plural(files, "file") + ", +" + (status.added ?? 0) + " −" + (status.removed ?? 0) + ") into " + status.base + " in your checkout, then removes its worktree. Its branch stays. Git hooks don't run.", confirm: "Bring in" });
    if (!yes) return;
    await act("bring", async () => {
      const done = await api.bringInJob(chat.id);
      if (!done.ok) setConflicts(done.conflicts);
    });
  }
  async function remove() {
    const yes = await ask({ title: "Remove the worktree?", body: "What wasn't committed is committed on " + (job.branch ?? "its branch") + " first. The branch stays.", confirm: "Remove", danger: true });
    if (yes) await act("remove", () => api.removeJobWorktree(chat.id));
  }
  const clashes = conflicts.length ? conflicts : status?.conflicts ?? [];
  const idle = stage !== "working" && stage !== "setting-up";
  return (
    <div className="job-detail">
      {job.prompt && <p className="job-prompt">“{job.prompt.length > 600 ? job.prompt.slice(0, 600) + "…" : job.prompt}”</p>}
      {job.setupError && (
        <div className="job-note danger" role="alert">
          <strong>Setup failed.</strong> {job.setupError}
        </div>
      )}
      {job.carryFailed && <div className="job-note">Your uncommitted changes didn't apply cleanly, so this worktree started from the last commit.</div>}
      {job.where === "worktree" && status?.branch && (
        <p className="job-line">
          <GitBranch size={13} aria-hidden="true" /> <code>{status.branch}</code> from {status.base} @ {status.baseSha}
          {" · "}
          {plural(status.ahead ?? 0, "commit")} ahead
          {status.behind ? " · " + status.base + " moved " + plural(status.behind, "commit") + " on" : ""}
          {status.uncommitted ? " · " + plural(status.uncommitted, "file") + " not committed" : ""}
        </p>
      )}
      {!!status?.files?.length && (
        <ul className="job-files" aria-label="Changes">
          {status.files.slice(0, 12).map((file) => (
            <li key={file.path}>
              <span className="job-file">{file.path}</span>
              <span className="job-diff">{file.new ? "new" : <><em className="plus">+{file.added}</em> <em className="minus">−{file.removed}</em></>}</span>
            </li>
          ))}
          {status.files.length > 12 && <li className="job-muted">and {status.files.length - 12} more</li>}
        </ul>
      )}
      {clashes.length > 0 && (
        <div className="job-note warn">
          <strong>
            Clashes with {status?.base ?? "your branch"} in {plural(clashes.length, "file")}:
          </strong>{" "}
          {clashes.slice(0, 6).join(", ")}
          {clashes.length > 6 ? " and more" : ""}. Ask {bot} to catch up: it merges {status?.base ?? "your branch"} into its branch in its own worktree. Your checkout isn't touched.
        </div>
      )}
      {job.state === "brought-in" && <p className="job-line">Brought in as {job.mergedSha}. Its branch {job.branch} stays.</p>}
      {status && !status.canBringIn && status.reason && job.state === "open" && !clashes.length && <p className="job-muted">{status.reason}</p>}
      <div className="actionrow job-actions">
        {job.where === "worktree" && job.state === "open" && (
          <Button variant="filled" className="lg-compact" icon={<GitMerge size={15} />} disabled={!status?.canBringIn || !!busy} onClick={() => void bringIn()}>
            {busy === "bring" ? "Bringing in…" : "Bring in"}
          </Button>
        )}
        {job.where === "worktree" && job.state === "open" && idle && (clashes.length > 0 || (status?.behind ?? 0) > 0) && (
          <button type="button" className="secondary" disabled={!!busy} onClick={() => void act("catch", () => api.catchUpJob(chat.id))}>
            <RefreshCw size={14} /> Ask {bot} to catch up
          </button>
        )}
        {idle && job.state === "open" && (job.setup === "failed" || job.setup === "waiting") && (
          <button type="button" className="secondary" disabled={!!busy} onClick={() => void act("start", () => api.startJobTurn(chat.id))}>
            <Play size={14} /> Start anyway
          </button>
        )}
        <button type="button" className="secondary" onClick={() => openChat(chat.id)}>
          <MessageCircle size={14} /> Open chat
        </button>
        {job.where === "worktree" && job.state === "open" && idle && (
          <button type="button" className="secondary danger" disabled={!!busy} onClick={() => void remove()}>
            <Trash2 size={14} /> Remove worktree
          </button>
        )}
      </div>
    </div>
  );
}
