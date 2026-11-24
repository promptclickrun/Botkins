export const SILENT: "[SILENT]";
export function isSilent(text: unknown): boolean;
export function isSilentMessage(message: { role: string; text?: string }): boolean;
export function mayBeSilent(text?: string): boolean;
export function visibleStream(text?: string): string;
