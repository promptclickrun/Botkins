import type { MemberTeam, State, TeamScope } from "./types";

export const TeamAction: Record<TeamScope, string> = {
  agents: "view",
  today: "view",
  skills: "read",
  mcp: "view",
  plugins: "view",
  settings: "view",
};

export function memberTeam(state: State): MemberTeam | undefined {
  return state.team && "me" in state.team ? state.team : undefined;
}

export function teamCan(state: State, scope: TeamScope, action: string = TeamAction[scope]): boolean {
  const member = memberTeam(state);
  if (member) return !!member.me.role.perms[scope]?.includes(action);
  return state.remote?.using?.member !== true;
}
