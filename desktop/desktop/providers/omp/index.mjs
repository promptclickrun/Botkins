import { OMP_ID, PiProvider } from "../pi/index.mjs";

/**
 * OMP is a Pi-compatible harness with its own binary, RPC-UI protocol and MCP configuration.
 * Botkins runs it with an isolated `botkins.yml` that disables OMP's shared MCP daemon and
 * shell-command tool wrapper (`tools.commands: false`) so Botkins bridge tools and configured
 * MCP servers are exposed directly to models as typed tool schemas. It loads the Marketplace Pi
 * packages Pi loads (`packages` in runtime.mjs is Pi's).
 */
export class OmpProvider extends PiProvider {
  constructor(options = {}) {
    super({ ...options, runtime: OMP_ID });
  }
}
