// Botkins' extension inside Pi (desktop/providers/pi/index.mjs loads it with `-e`).
//
// Pi reads BOTKINS_PI_SESSION, the path of a file Botkins writes for this session (mode 0600, in
// Botkins' own data folder), and does four things with it:
//   - registers the plan connections the turn's model answers on (the gateway, desktop/harness);
//   - registers the session's MCP servers, Botkins' own tools among them, as direct tools;
//   - writes the system prompt for each run: Pi's own, less its section on Pi's documentation,
//     with the bot's instructions after it, read again each time, so a change of memory or
//     instructions needs no restart (botkinsPrompt);
//   - asks Botkins before a tool runs, through Pi's extension dialog (`select`), so Botkins'
//     approval rules and the person decide. Botkins' own tools never ask.
// The file's path is taken out of the environment once read, so the commands the model runs
// don't inherit it.
import { ASK, botkinsPrompt, makeBotkinsExtension } from "./extension-shared.mjs";

export { ASK, botkinsPrompt };
const file = process.env.BOTKINS_PI_SESSION;
delete process.env.BOTKINS_PI_SESSION;
export default makeBotkinsExtension(file);
