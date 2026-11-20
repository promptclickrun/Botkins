export type PathSpan = { path: string; start: number; end: number; media: boolean };
export function findPathSpans(text: string): PathSpan[];
export function findPathCandidates(text: string): string[];
