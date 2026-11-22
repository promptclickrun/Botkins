/** What kind of work a tool call is, from its name ("command", "read", "edit", …); "tool" when unknown, null for bookkeeping. */
export function toolKind(name: unknown): string | null;
