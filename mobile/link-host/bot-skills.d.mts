type NamedSkill = { name: string; description: string };
type SharedSkill = NamedSkill & { enabled: boolean; command?: string };
/** A bundled skill has no shared workspace entry. */
export function botSkillRows<T extends SharedSkill>(
  shared: T[],
  bot?: { bundle?: { skills?: NamedSkill[] } },
  disabled?: string[],
): (NamedSkill & { enabled: boolean; shared: T | null })[];
