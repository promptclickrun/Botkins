/** A model id as a name people read: "gpt-6.2-sol" → "GPT-6.2 Sol". */
export function friendlyModel(id: string | null | undefined): string;
/** A catalog entry's name, or its id made readable when the name is missing or is an id itself. */
export function friendlyName(name: string | null | undefined, id: string): string;
