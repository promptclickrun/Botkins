// Runs one phone tool for a bot and turns the outcome into an answer. It never throws.
import type { DeviceAnswer } from "@/link/types";
import { loadDevicePrefs, useDevicePrefs } from "@/state/devicePrefs";
import { DeviceError } from "./args";
import { calendarTools } from "./calendar";
import { contactsTools } from "./contacts";
import { healthTools } from "./health";
import { locationTools } from "./location";
import { mailTools } from "./mail";
import { musicTools } from "./music";
import { photosTools } from "./photos";
import { allows, type PhoneToolName, SOURCE_NAMES, toolOf } from "./tools";

/** What a runner may need beyond its arguments: the ask's id, to fetch a file the computer sends along. */
export type RunContext = { askId?: string };
type Runner = (args: unknown, context: RunContext) => Promise<unknown>;

/** Every tool's runner, by name. tests/device.test.ts checks each name in DEVICE_TOOLS has one. */
export const RUNNERS: Record<PhoneToolName, Runner> = { ...calendarTools, ...contactsTools, ...healthTools, ...locationTools, ...photosTools, ...musicTools, ...mailTools };

export async function runDeviceTool(tool: string, args: unknown, context: RunContext = {}): Promise<DeviceAnswer> {
  const spec = toolOf(tool);
  try {
    const run = spec && RUNNERS[tool as PhoneToolName];
    if (!spec || !run) return { ok: false, error: "This phone has no tool named " + String(tool).slice(0, 60) + ". Botkins on the phone may need an update." };
    // The computer's list of tools can be behind: this phone's own switch decides.
    await loadDevicePrefs();
    if (!allows(useDevicePrefs.getState().sources, spec.source, spec.level)) {
      const on = useDevicePrefs.getState().sources[spec.source];
      return { ok: false, error: SOURCE_NAMES[spec.source] + (on ? " is set to read only on this phone." : " is off on this phone.") };
    }
    const result = await run(args, context);
    return { ok: true, result: result ?? null };
  } catch (error) {
    // Only sentences written for a bot go back; anything else could carry what a tool read.
    return { ok: false, error: error instanceof DeviceError ? error.message : (spec ? SOURCE_NAMES[spec.source] + " on the phone" : "The phone") + " couldn't do that just now." };
  }
}
