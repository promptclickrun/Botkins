// The Botkins link for a desktop app. See README.md in this folder for how an app adopts it.
export { LinkHost, PROTOCOL } from "./server.mjs";
export { REMOTE_METHODS } from "./methods.mjs";
export { qrModules, qrPath, qrSvg, qrText } from "./qr.mjs";
export { reachable } from "./net.mjs";
export { DEFAULT_PORT } from "./store.mjs";
export { GRANT_CAPABILITY, GRANT_LEVELS, grantMessage } from "./grant.mjs";
export { DEFAULT_RELAY_URL, RelayLink } from "./relay.mjs";
export { BUILTIN_ROLES, EVERYONE_GROUP, MEMBER_PREFERENCE_FIELDS, TEAM_METHODS, authorize, cleanGroup, cleanRole, filterParts, formatCode, normalizeCode, teamPart } from "./team.mjs";
export { isRoutineChat } from "./routine-chat.mjs";
