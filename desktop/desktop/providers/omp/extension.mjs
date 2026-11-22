// Botkins inside OMP. OMP loads MCP connections from this session's isolated agent/mcp.json;
// the extension only supplies Botkins' plan providers, prompt and approval callback.
import { botkinsPrompt, makeBotkinsExtension } from "../pi/extension-shared.mjs";

export { botkinsPrompt };
const file = process.env.BOTKINS_OMP_SESSION;
delete process.env.BOTKINS_OMP_SESSION;
export default makeBotkinsExtension(file, { mcp: false });
