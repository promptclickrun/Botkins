import type { Parts, Scope, TeamPart } from "@/link/types";

export const SCOPE_ACTIONS = {
  agents: ["view", "chat", "create", "manage", "delete"],
  today: ["view", "use", "create", "manage", "delete"],
  skills: ["read", "use", "create", "manage", "delete"],
  mcp: ["view", "use", "create", "manage", "delete"],
  plugins: ["view", "use", "install", "manage", "uninstall"],
  settings: ["view", "manage"],
} as const satisfies Record<Scope, readonly string[]>;

type TeamState = {
  meta?: Partial<Parts["meta"]> | { you?: Parts["meta"]["you"] };
  team?: TeamPart;
};

function memberPerms(parts: TeamState) {
  const team = parts.team;
  return team && "me" in team ? team.me.role.perms : undefined;
}

export function can(parts: TeamState, scope: Scope, action: string): boolean {
  if (parts.meta?.you?.kind !== "member") return true;
  const actions = memberPerms(parts)?.[scope] ?? [];
  if (actions.includes(action)) return true;
  return action === SCOPE_ACTIONS[scope][0] && actions.some((allowed) => SCOPE_ACTIONS[scope].some((known) => known === allowed));
}

export function toggleRoleAction<T extends Partial<Record<Scope, string[]>>>(perms: T, scope: Scope, action: string, enabled: boolean): T {
  const all = SCOPE_ACTIONS[scope] as readonly string[];
  const first = all[0]!;
  const before = new Set(perms[scope] ?? []);
  if (!enabled) {
    if (action === first) before.clear();
    else before.delete(action);
  } else {
    before.add(action);
    if (action !== first) before.add(first);
  }
  return { ...perms, [scope]: all.filter((item) => before.has(item)) } as T;
}
