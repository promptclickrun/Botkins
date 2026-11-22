import { OMP_ID, PiProvider } from "../pi/index.mjs";

/** OMP is a Pi-compatible harness with its own binary, RPC-UI protocol and MCP configuration. */
export class OmpProvider extends PiProvider {
  constructor(options = {}) {
    super({ ...options, runtime: OMP_ID });
  }
}
