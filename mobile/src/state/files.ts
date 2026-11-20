// Files that pass between the phone and the computer where the app on the computer would open a
// dialog. A file the computer hands over goes to the phone's share sheet (Save to Files, AirDrop,
// Mail), and a file the person picks in the Files app is read as text for the computer. Nothing here
// keeps a file: what is shared sits in the phone's cache until the next one replaces it.
import { Directory, File, Paths } from "expo-file-system";
import { Share } from "react-native";
import type { SharedFile } from "@/link/types";
import { cleanFileName, isTextFile, MAX_PICKED_BYTES, TOO_BIG } from "./fileText";
import { showToast } from "./store";

type DocumentPicker = typeof import("expo-document-picker");
const NEEDS_UPDATE = "This needs the newest Botkins app.";

/** Loaded on first use, so a build without the package still opens (the action that needs it says so). */
function documentPicker(): DocumentPicker | null {
  try {
    return require("expo-document-picker") as DocumentPicker;
  } catch {
    return null;
  }
}

/**
 * Hands a file from the computer to the share sheet. Resolves true when the person did something
 * with it (saved it, sent it), false when they closed the sheet.
 */
export async function shareFile(file: SharedFile): Promise<boolean> {
  // One folder, emptied each time: the last file stays only until the next one.
  const folder = new Directory(Paths.cache, "botkins-shared");
  if (folder.exists) folder.delete();
  folder.create({ intermediates: true });
  const local = new File(folder, cleanFileName(file.name));
  local.create({ overwrite: true });
  if (isTextFile(file)) local.write(file.text);
  else local.write(file.base64, { encoding: "base64" });
  const result = await Share.share({ url: local.uri });
  return result.action !== Share.dismissedAction;
}

/** Hands a file already on the phone (a `file://` uri) to the share sheet. Resolves true when the person did something with it. */
export async function shareLocalFile(uri: string): Promise<boolean> {
  const result = await Share.share({ url: uri });
  return result.action !== Share.dismissedAction;
}

/** Asks the computer for a file and shares it. A failure is shown as a toast; `done` is said when the person saved or sent it. */
export async function shareFrom(work: Promise<SharedFile>, done?: string): Promise<void> {
  try {
    if ((await shareFile(await work)) && done) showToast(done, "success");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "That didn't work.", "error");
  }
}

/**
 * Lets the person pick one file in the Files app and reads it as text. Resolves null when they
 * cancel. Throws a sentence when the file is too big or can't be read.
 */
export async function pickTextFile(types: string | string[] = ["application/json", "text/plain"]): Promise<{ name: string; text: string } | null> {
  const picker = documentPicker();
  if (!picker) throw new Error(NEEDS_UPDATE);
  const result = await picker.getDocumentAsync({ type: types, multiple: false, copyToCacheDirectory: true });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  const file = new File(asset.uri);
  try {
    if ((asset.size ?? file.size ?? 0) > MAX_PICKED_BYTES) throw new Error(TOO_BIG);
    let text: string;
    try {
      text = await file.text();
    } catch {
      throw new Error("Botkins couldn't read " + asset.name + ".");
    }
    return { name: cleanFileName(asset.name, "file"), text };
  } finally {
    // The picker made a copy for us; it is not needed after it is read.
    try {
      file.delete();
    } catch {
      // Already gone.
    }
  }
}
