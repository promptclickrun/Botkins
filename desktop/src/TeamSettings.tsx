import { useEffect, useState } from "react";
import {
  Check,
  ChevronLeft,
  Copy,
  Laptop,
  Link,
  Plus,
  Smartphone,
  Trash2,
  Users,
} from "lucide-react";
import { BotAvatar } from "./Avatar";
import { Group, Row, Sheet, errorText } from "./SettingsRows";
import { useAsk } from "./Pages";
import { when } from "./wikiModel";
import type {
  Bot,
  OwnerTeam,
  State,
  TeamGroup,
  TeamInvite,
  TeamRequest,
  TeamRole,
  TeamScope,
} from "./types";
import "./team.css";

const api = window.botkins;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SCOPES: { id: TeamScope; label: string; actions: string[] }[] = [
  { id: "agents", label: "Agents", actions: ["view", "chat", "create", "manage", "delete"] },
  { id: "today", label: "Today", actions: ["view", "use", "create", "manage", "delete"] },
  { id: "skills", label: "Skills", actions: ["read", "use", "create", "manage", "delete"] },
  { id: "mcp", label: "MCP Servers", actions: ["view", "use", "create", "manage", "delete"] },
  { id: "plugins", label: "Plugins", actions: ["view", "use", "install", "manage", "uninstall"] },
  { id: "settings", label: "Settings", actions: ["view", "manage"] },
];
const ACTION_LABEL: Record<string, string> = {
  view: "Can view",
  chat: "Can chat",
  use: "Can use",
  read: "Can read",
  create: "Can create",
  install: "Can install",
  manage: "Can manage",
  delete: "Can delete",
  uninstall: "Can uninstall",
};
export type TeamView = "requests" | "invite" | "members" | "groups" | "roles";
const VIEWS: { id: TeamView; label: string }[] = [
  { id: "requests", label: "Requests" },
  { id: "invite", label: "Invite" },
  { id: "members", label: "Members" },
  { id: "groups", label: "Groups" },
  { id: "roles", label: "Roles" },
];
const ownerTeam = (state: State): OwnerTeam | undefined =>
  state.team && "roles" in state.team ? state.team : undefined;
const formatCode = (code: string) => {
  const clean = code.replace(/[^0-9A-Z]/gi, "").toUpperCase();
  return clean.length === 10 ? clean.slice(0, 5) + "-" + clean.slice(5) : clean;
};
const roleId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return "r_" + [...bytes].map((byte) => CROCKFORD[byte % CROCKFORD.length]).join("");
};
const groupId = () => "g_" + crypto.randomUUID();
const deviceName = (kind: string, platform: string) =>
  [kind === "desktop" ? "Computer" : "Phone", platform].filter(Boolean).join(" · ");

type Actions = {
  busy: boolean;
  fail: (error: unknown) => void;
  run: (work: () => Promise<void>) => Promise<void>;
  team: OwnerTeam;
  update: (team: OwnerTeam) => void;
};

/** Settings › Team: people, their groups and what their roles may use. */
export default function TeamSettings({ state, initialView = "requests" }: { state: State; initialView?: TeamView }) {
  const [team, setTeam] = useState<OwnerTeam | undefined>(() => ownerTeam(state));
  const [view, setView] = useState<TeamView>(initialView);
  const [name, setName] = useState(team?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editingRole, setEditingRole] = useState<TeamRole>();
  useEffect(() => {
    if (initialView) setView(initialView);
  }, [initialView]);
  useEffect(() => {
    const next = ownerTeam(state);
    if (next) {
      setTeam(next);
      setName(next.name);
    }
  }, [state.team]);
  useEffect(() => {
    if (!team) void api.team().then(setTeam).catch((e) => setError(errorText(e)));
  }, []);
  if (!team)
    return (
      <p className="set-status" role="status">
        Checking team…
      </p>
    );
  const update = (next: OwnerTeam) => {
    setTeam(next);
    setName(next.name);
  };
  const fail = (cause: unknown) => setError(errorText(cause));
  const run = async (work: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const actions: Actions = { busy, fail, run, team, update };
  return (
    <div className="int-section team-settings">
      <Group title="Team name">
        <form
          className="set-row team-name-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && name.trim() !== team.name)
              void run(async () => update(await api.renameTeam(name)));
          }}
        >
          <div className="set-label">
            <label htmlFor="team-name">Name</label>
          </div>
          <div className="set-control">
            <input
              id="team-name"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
            />
            <button type="submit" className="set-button" disabled={busy || !name.trim() || name.trim() === team.name}>
              Save
            </button>
          </div>
        </form>
      </Group>
      <div className="team-views" role="tablist" aria-label="Team">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={view === item.id && !editingRole}
            onClick={() => {
              setEditingRole(undefined);
              setView(item.id);
            }}
          >
            {item.label}
            {item.id === "requests" && team.requests.length > 0 && (
              <span className="team-count">{team.requests.length}</span>
            )}
          </button>
        ))}
      </div>
      {editingRole ? (
        <RoleEditor
          role={editingRole}
          bots={state.bots}
          back={() => setEditingRole(undefined)}
          {...actions}
        />
      ) : (
        <>
          {view === "requests" && <Requests {...actions} />}
          {view === "invite" && <Invites {...actions} />}
          {view === "members" && <Members {...actions} />}
          {view === "groups" && <Groups {...actions} />}
          {view === "roles" && <Roles {...actions} edit={setEditingRole} />}
        </>
      )}
      {error && (
        <p className="set-status error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Requests({ team, update, run, busy }: Actions) {
  const [groups, setGroups] = useState<Record<string, string>>({});
  const invite = (request: TeamRequest) => team.invites.find((item) => item.id === request.inviteId);
  const picked = (request: TeamRequest) => groups[request.id] || invite(request)?.groupId || team.groups[0]?.id;
  return (
    <Group title="Pending requests">
      {!team.requests.length ? (
        <div className="set-row">
          <div className="set-label">
            <small>No join requests yet.</small>
          </div>
        </div>
      ) : (
        team.requests.map((request) => {
          const source = invite(request);
          const group = team.groups.find((item) => item.id === source?.groupId);
          return (
            <div className="set-row team-request" key={request.id}>
              <span className="team-person" aria-hidden="true">
                <Users size={16} />
              </span>
              <div className="set-label">
                <span className="set-name">{request.name}</span>
                <small className="int-line">
                  {deviceName(request.kind, request.platform)} · {when(request.at)}
                </small>
                <small className="int-line">
                  Invite {source ? formatCode(source.code) : "no longer available"} · {group?.name ?? "Original group"}
                </small>
              </div>
              <div className="set-control team-request-actions">
                <select
                  aria-label={"Group for " + request.name}
                  value={picked(request)}
                  onChange={(event) => setGroups((now) => ({ ...now, [request.id]: event.target.value }))}
                >
                  {team.groups.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="set-button primary"
                  disabled={busy || !picked(request)}
                  onClick={() =>
                    void run(async () => update(await api.approveTeamRequest(request.id, picked(request))))
                  }
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="set-button"
                  disabled={busy}
                  onClick={() => void run(async () => update(await api.denyTeamRequest(request.id)))}
                >
                  Deny
                </button>
              </div>
            </div>
          );
        })
      )}
    </Group>
  );
}

function Invites({ team, update, run, busy }: Actions) {
  const [groupId, setGroup] = useState(team.groups[0]?.id ?? "g_everyone");
  const [days, setDays] = useState(7);
  const [maxUses, setMaxUses] = useState(1);
  const [created, setCreated] = useState<TeamInvite>();
  const [copied, setCopied] = useState("");
  const live = team.invites.filter((invite) => !invite.revoked && invite.expiresAt > Date.now() && invite.uses < invite.maxUses);
  useEffect(() => {
    if (!team.groups.some((group) => group.id === groupId)) setGroup(team.groups[0]?.id ?? "g_everyone");
  }, [team.groups, groupId]);
  const copy = async (value: string, kind: string) => {
    await api.copyText(value);
    setCopied(kind);
    setTimeout(() => setCopied(""), 1600);
  };
  const shown = created ?? live[0];
  return (
    <>
      <Group title="Create an invite">
        <Row label="Group">
          {(id) => (
            <select id={id} value={groupId} onChange={(event) => setGroup(event.target.value)}>
              {team.groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          )}
        </Row>
        <Row label="Expires">
          {(id) => (
            <select id={id} value={days} onChange={(event) => setDays(Number(event.target.value))}>
              <option value={1}>In 1 day</option>
              <option value={7}>In 7 days</option>
              <option value={30}>In 30 days</option>
            </select>
          )}
        </Row>
        <Row label="Uses">
          {(id) => (
            <select id={id} value={maxUses} onChange={(event) => setMaxUses(Number(event.target.value))}>
              <option value={1}>1 use</option>
              <option value={5}>5 uses</option>
              <option value={25}>25 uses</option>
            </select>
          )}
        </Row>
        <div className="set-actions">
          <button
            type="button"
            className="set-button primary"
            disabled={busy || !groupId}
            onClick={() =>
              void run(async () => {
                const invite = await api.createTeamInvite({ groupId, days, maxUses });
                setCreated(invite);
                update(await api.team());
              })
            }
          >
            Create invite
          </button>
        </div>
      </Group>
      {shown && (
        <Group title="Invite">
          <div className="set-row stacked team-invite-card">
            <code className="team-invite-code">{formatCode(shown.code)}</code>
            <button type="button" className="set-button" onClick={() => void copy(formatCode(shown.code), "code")}>
              {copied === "code" ? <Check size={14} /> : <Copy size={14} />} {copied === "code" ? "Copied" : "Copy code"}
            </button>
            <div className="team-invite-link">
              <Link size={14} aria-hidden="true" />
              <code>{shown.link}</code>
              <button type="button" className="set-button" onClick={() => void copy(shown.link, "link")}>
                {copied === "link" ? "Copied" : "Copy link"}
              </button>
            </div>
          </div>
          {shown.published === false && (
            <p className="team-invite-note">
              Codes work when Relay is on in Settings › Phone. This link still works on your network.
            </p>
          )}
        </Group>
      )}
      <Group title="Live invites">
        {!live.length ? (
          <div className="set-row">
            <div className="set-label">
              <small>No live invites.</small>
            </div>
          </div>
        ) : (
          live.map((invite) => (
            <div className="set-row int-item compact team-live-invite" key={invite.id}>
              <div className="set-label">
                <span className="set-name int-mono">{formatCode(invite.code)}</span>
                <small>
                  {team.groups.find((group) => group.id === invite.groupId)?.name ?? "Group"} ·{" "}
                  {invite.uses} of {invite.maxUses} uses · Expires {new Date(invite.expiresAt).toLocaleDateString()}
                </small>
              </div>
              <div className="set-control">
                <button type="button" className="set-button" onClick={() => setCreated(invite)}>
                  Show
                </button>
                <button
                  type="button"
                  className="set-button danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      update(await api.revokeTeamInvite(invite.id));
                      if (created?.id === invite.id) setCreated(undefined);
                    })
                  }
                >
                  Revoke
                </button>
              </div>
            </div>
          ))
        )}
      </Group>
    </>
  );
}

function Members({ team, update, run, busy }: Actions) {
  const dialogs = useAsk();
  return (
    <Group title="Members">
      {!team.members.length ? (
        <div className="set-row">
          <div className="set-label">
            <small>No one has joined yet.</small>
          </div>
        </div>
      ) : (
        team.members.map((member) => (
          <div className="set-row team-member" key={member.id}>
            <span className="team-person" aria-hidden="true">
              <Users size={16} />
            </span>
            <div className="set-label">
              <span className="set-name">{member.name}</span>
              <small>Joined {new Date(member.joinedAt).toLocaleDateString()}</small>
              {!!member.devices?.length && (
                <span className="team-devices">
                  {member.devices.map((device) => (
                    <span key={device.id}>
                      <i className="team-online" data-online={device.connected} />
                      {device.kind === "desktop" ? <Laptop size={12} /> : <Smartphone size={12} />}
                      {device.name} · {deviceName(device.kind, device.platform)}
                    </span>
                  ))}
                </span>
              )}
            </div>
            <div className="set-control team-member-actions">
              <select
                aria-label={"Group for " + member.name}
                value={member.groupId}
                disabled={busy}
                onChange={(event) =>
                  void run(async () => update(await api.moveTeamMember(member.id, event.target.value)))
                }
              >
                {team.groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="set-button danger"
                aria-label={"Remove " + member.name}
                disabled={busy}
                onClick={() =>
                  void dialogs
                    .ask({
                      title: "Remove " + member.name + "?",
                      body: "Their devices lose access to this team at once.",
                      confirm: "Remove",
                      danger: true,
                    })
                    .then((ok) => {
                      if (ok) void run(async () => update(await api.removeTeamMember(member.id)));
                    })
                }
              >
                <Trash2 size={13} /> Remove
              </button>
            </div>
          </div>
        ))
      )}
      {dialogs.node}
    </Group>
  );
}

function Groups({ team, update, run, busy }: Actions) {
  const [editor, setEditor] = useState<{ group?: TeamGroup; name: string; roleId: string }>();
  const [deleting, setDeleting] = useState<TeamGroup>();
  const [moveTo, setMoveTo] = useState("");
  const openDelete = (group: TeamGroup) => {
    setDeleting(group);
    setMoveTo(team.groups.find((item) => item.id !== group.id)?.id ?? "");
  };
  return (
    <>
      <Group
        title="Groups"
        actions={
          <button
            type="button"
            className="set-button primary"
            onClick={() => setEditor({ name: "", roleId: team.roles[0]?.id ?? "" })}
          >
            <Plus size={14} /> New group
          </button>
        }
      >
        {team.groups.map((group) => (
          <div className="set-row int-item compact team-group" key={group.id}>
            <div className="set-label">
              <span className="set-name">{group.name}</span>
              <small>{team.members.filter((member) => member.groupId === group.id).length} members</small>
            </div>
            <div className="set-control">
              <select
                aria-label={"Role for " + group.name}
                value={group.roleId}
                disabled={busy}
                onChange={(event) =>
                  void run(async () => update(await api.saveTeamGroup({ ...group, roleId: event.target.value })))
                }
              >
                {team.roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="set-button"
                onClick={() => setEditor({ group, name: group.name, roleId: group.roleId })}
              >
                Rename
              </button>
              <button
                type="button"
                className="set-button danger"
                disabled={group.id === "g_everyone" || busy}
                aria-label={"Delete " + group.name}
                onClick={() => openDelete(group)}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </Group>
      {editor && (
        <Sheet
          title={editor.group ? "Rename " + editor.group.name : "New group"}
          close={() => setEditor(undefined)}
          submit={() =>
            void run(async () => {
              update(
                await api.saveTeamGroup({
                  id: editor.group?.id ?? groupId(),
                  name: editor.name,
                  roleId: editor.roleId,
                }),
              );
              setEditor(undefined);
            })
          }
          footer={
            <>
              <button type="button" className="set-button" onClick={() => setEditor(undefined)}>
                Cancel
              </button>
              <button className="set-button primary" disabled={busy || !editor.name.trim() || !editor.roleId}>
                {editor.group ? "Save" : "Create group"}
              </button>
            </>
          }
        >
          <label>
            Name
            <input autoFocus required maxLength={40} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} />
          </label>
          <label>
            Role
            <select value={editor.roleId} onChange={(event) => setEditor({ ...editor, roleId: event.target.value })}>
              {team.roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>
        </Sheet>
      )}
      {deleting && (
        <Sheet
          title={"Delete " + deleting.name + "?"}
          close={() => setDeleting(undefined)}
          submit={() =>
            void run(async () => {
              update(await api.deleteTeamGroup(deleting.id, moveTo));
              setDeleting(undefined);
            })
          }
          footer={
            <>
              <button type="button" className="set-button" onClick={() => setDeleting(undefined)}>
                Cancel
              </button>
              <button className="set-button danger" disabled={busy || !moveTo}>
                Delete
              </button>
            </>
          }
        >
          <p>Choose where to move this group's members, invites and pending requests.</p>
          <label>
            Move to
            <select value={moveTo} onChange={(event) => setMoveTo(event.target.value)}>
              {team.groups.filter((group) => group.id !== deleting.id).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
        </Sheet>
      )}
    </>
  );
}

function Roles({ team, update, run, busy, edit }: Actions & { edit: (role: TeamRole) => void }) {
  const makeRole = () =>
    edit({
      id: roleId(),
      name: "New role",
      perms: { agents: [], today: [], skills: [], mcp: [], plugins: [], settings: [] },
      bots: "all",
    });
  return (
    <Group
      title="Roles"
      actions={
        <button type="button" className="set-button primary" onClick={makeRole}>
          <Plus size={14} /> New role
        </button>
      }
    >
      {team.roles.map((role) => {
        const used = team.groups.filter((group) => group.roleId === role.id).length;
        return (
          <div className="set-row int-item compact team-role" key={role.id}>
            <div className="set-label">
              <span className="set-name">{role.name}</span>
              <small>
                {used} {used === 1 ? "group" : "groups"} ·{" "}
                {role.bots === "all" ? "All agents" : role.bots.length + " visible agents"}
              </small>
            </div>
            <div className="set-control">
              <button type="button" className="set-button" onClick={() => edit(structuredClone(role))}>
                Edit
              </button>
              <button
                type="button"
                className="set-button danger"
                disabled={busy || used > 0}
                title={used ? "Move every group off this role before deleting it." : undefined}
                onClick={() => void run(async () => update(await api.deleteTeamRole(role.id)))}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}
    </Group>
  );
}

function RoleEditor({
  role,
  bots,
  update,
  run,
  busy,
  back,
}: Actions & { role: TeamRole; bots: Bot[]; back: () => void }) {
  const [draft, setDraft] = useState(structuredClone(role));
  const allAgents = draft.bots === "all";
  const selected = Array.isArray(draft.bots) ? draft.bots : [];
  const setAction = (scope: TeamScope, action: string, checked: boolean) => {
    setDraft((current) => {
      const actions = SCOPES.find((item) => item.id === scope)!.actions;
      let next = [...current.perms[scope]];
      if (action === actions[0] && !checked) next = [];
      else if (checked) {
        next.push(action);
        if (action !== actions[0]) next.push(actions[0]);
      } else next = next.filter((item) => item !== action);
      return { ...current, perms: { ...current.perms, [scope]: [...new Set(next)] } };
    });
  };
  const setBot = (botId: string, checked: boolean) => {
    setDraft((current) => ({
      ...current,
      bots: checked
        ? [...new Set([...(Array.isArray(current.bots) ? current.bots : []), botId])]
        : Array.isArray(current.bots)
          ? current.bots.filter((id) => id !== botId)
          : [],
    }));
  };
  return (
    <div className="team-role-editor">
      <button type="button" className="set-link team-role-back" onClick={back}>
        <ChevronLeft size={14} /> All roles
      </button>
      <Group title="Role">
        <Row label="Name">
          {(id) => (
            <input
              id={id}
              value={draft.name}
              maxLength={40}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          )}
        </Row>
      </Group>
      <Group title="Permissions">
        {SCOPES.map((scope) => (
          <div className="team-scope" key={scope.id}>
            <strong>{scope.label}</strong>
            <div>
              {scope.actions.map((action) => (
                <label key={action}>
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch"
                    checked={draft.perms[scope.id].includes(action)}
                    onChange={(event) => setAction(scope.id, action, event.target.checked)}
                  />
                  <span>{ACTION_LABEL[action]}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </Group>
      <Group title="Visible agents">
        <div className="set-row team-agent-mode">
          <label>
            <input
              type="radio"
              name={"team-role-bots-" + draft.id}
              checked={allAgents}
              onChange={() => setDraft({ ...draft, bots: "all" })}
            />
            All agents
          </label>
          <label>
            <input
              type="radio"
              name={"team-role-bots-" + draft.id}
              checked={!allAgents}
              onChange={() => setDraft({ ...draft, bots: [] })}
            />
            Pick specific agents
          </label>
        </div>
        {!allAgents && (
          <div className="team-agent-list">
            {bots.map((bot) => (
              <label key={bot.id}>
                <BotAvatar bot={bot} size={28} />
                <span>{bot.name}</span>
                <input type="checkbox" checked={selected.includes(bot.id)} onChange={(event) => setBot(bot.id, event.target.checked)} />
              </label>
            ))}
          </div>
        )}
        <div className="set-actions">
          <button type="button" className="set-button" onClick={back}>
            Cancel
          </button>
          <button
            type="button"
            className="set-button primary"
            disabled={busy || !draft.name.trim()}
            onClick={() =>
              void run(async () => {
                update(await api.saveTeamRole(draft));
                back();
              })
            }
          >
            Save role
          </button>
        </div>
      </Group>
    </div>
  );
}
