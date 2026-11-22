import { OMP_ID, PiProvider } from "../pi/index.mjs";

/** OMP is a Pi-compatible harness with its own binary, RPC-UI protocol and MCP configuration. It loads the Marketplace Pi packages Pi loads (`packages` in runtime.mjs is Pi's). */
export class OmpProvider extends PiProvider {
  constructor(options = {}) {
    super({ ...options, runtime: OMP_ID });
  }
}
