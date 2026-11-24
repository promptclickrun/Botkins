export const originalHeadIds: string[];
export const HEADS_CAPABILITY: string;
export const headCapabilities: string[];
export const headIds: string[];
export function makeHeadPicker<T extends { id: string }>(heads: T[]): (capabilities?: readonly string[]) => T[];
