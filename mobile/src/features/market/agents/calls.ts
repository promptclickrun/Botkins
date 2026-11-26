import { api } from "@/state/link";

/** An older computer only accepts the template id. */
export function readAgentTemplate(id: string, bundlesSupported: boolean) {
  return bundlesSupported ? api["agents.template"](id, 2) : api["agents.template"](id);
}
