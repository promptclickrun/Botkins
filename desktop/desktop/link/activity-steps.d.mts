export function backgroundShell(name: string, source: string | undefined, args: unknown): boolean;
export function isBackgroundStep(step: { name: string; source?: string; input?: string; background?: boolean }): boolean;
export function activitySteps<S extends { id: string; name: string; started: number; input?: string; source?: string; agentId?: string }>(
  steps?: readonly S[], agents?: readonly { id: string }[],
): { tools: S[]; background: S[]; byAgent: Map<string, S[]> };
