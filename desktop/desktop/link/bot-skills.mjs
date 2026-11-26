/** The skills shown on a bot's page, with the same name precedence as its sessions. */
export function botSkillRows(shared, bot, disabled = []) {
  const bundled = (bot?.bundle?.skills ?? []).map(({ name, description }) => ({ name, description, enabled: true, shared: null }));
  const ownNames = new Set(bundled.map((skill) => skill.name));
  return [
    ...bundled,
    ...shared.filter((skill) => !skill.command && !ownNames.has(skill.name)).map((skill) => ({
      name: skill.name, description: skill.description, enabled: skill.enabled !== false && !disabled.includes(skill.name), shared: skill,
    })),
  ];
}
