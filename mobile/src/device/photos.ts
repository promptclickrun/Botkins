// Photos tools, through expo-media-library's object API (SDK 58). A photo a bot asks to see is
// shrunk on the phone and sent to the computer as one of this phone's uploads.
import { File, Paths } from "expo-file-system";
import { upload } from "@/features/chat/uploads";
import { api } from "@/state/link";
import { type Access, accessOf, requireAccess } from "./access";
import { checkArgs, DeviceError, isoLocal, limitOf, optNumber, optString, optWhen, reqString } from "./args";
import { manipulatorModule, mediaModule, need } from "./native";
import { argsOf } from "./tools";
import { compact, fit, fold, round } from "./shape";

export async function photosAccess(): Promise<Access> {
  const Media = mediaModule();
  if (!Media) return { state: "unavailable" };
  return accessOf(await Media.getPermissionsAsync(false));
}
export async function askPhotos(): Promise<Access> {
  const Media = mediaModule();
  if (!Media) return { state: "unavailable" };
  return accessOf(await Media.requestPermissionsAsync(false));
}
/** With limited access, lets the person pick which photos Botkins can see. */
export async function chooseMorePhotos(): Promise<void> {
  await need(mediaModule).presentPermissionsPicker();
}

async function ready() {
  const Media = need(mediaModule);
  requireAccess("photos", accessOf(await Media.getPermissionsAsync(false)));
  return Media;
}

const KINDS = ["photo", "video", "any"] as const;

async function recent(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_photos_recent"));
  const limit = limitOf(args, 20, 100);
  const from = optWhen(args, "from");
  const to = optWhen(args, "to");
  const albumName = optString(args, "album", 200)?.trim();
  const kind = optString(args, "kind", 10) ?? "any";
  if (!(KINDS as readonly string[]).includes(kind)) throw new DeviceError("`kind` must be photo, video or any.");
  const Media = await ready();
  const { MediaType, AssetField } = Media;
  let query = new Media.Query().orderBy({ key: AssetField.CREATION_TIME, ascending: false }).limit(limit);
  if (kind === "photo") query = query.eq(AssetField.MEDIA_TYPE, MediaType.IMAGE);
  else if (kind === "video") query = query.eq(AssetField.MEDIA_TYPE, MediaType.VIDEO);
  else query = query.within(AssetField.MEDIA_TYPE, [MediaType.IMAGE, MediaType.VIDEO]);
  // Times in a query are in milliseconds.
  if (from) query = query.gte(AssetField.CREATION_TIME, from.date.getTime());
  if (to) query = query.lte(AssetField.CREATION_TIME, (to.dateOnly && from && to.date.getTime() <= from.date.getTime() ? to.date.getTime() + 86_400_000 : to.date.getTime()));
  if (albumName) {
    const albums = await Media.Album.getAlbumsMetadata();
    const match = albums.find((album) => fold(album.title) === fold(albumName));
    if (!match) throw new DeviceError("No album named " + JSON.stringify(albumName.slice(0, 80)) + ".");
    query = query.album(new Media.Album(match.id));
  }
  const found = await query.exeForMetadata();
  const items = await Promise.all(
    found.map(async (asset) => {
      let place: { latitude: number; longitude: number } | undefined;
      try {
        const where = await new Media.Asset(asset.id).getLocation();
        if (where) place = { latitude: round(where.latitude, 4), longitude: round(where.longitude, 4) };
      } catch {
        // A photo without a place.
      }
      return compact({
        id: asset.id,
        takenAt: asset.creationTime ? isoLocal(asset.creationTime) : undefined,
        kind: asset.mediaType === MediaType.VIDEO ? "video" : asset.mediaType === MediaType.IMAGE ? "photo" : String(asset.mediaType),
        width: asset.width ?? undefined,
        height: asset.height ?? undefined,
        durationSeconds: asset.duration ? round(asset.duration / 1000, 1) : undefined,
        favorite: asset.isFavorite || undefined,
        screenshot: asset.mediaSubtypes?.includes(Media.MediaSubtype.SCREENSHOT) || undefined,
        place,
      });
    }),
  );
  return fit({ items }, "items");
}

async function get(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_photos_get"));
  const id = reqString(args, "id", 500);
  const maxSize = Math.round(optNumber(args, "maxSize", { min: 64, max: 4000 }) ?? 1600);
  const Media = await ready();
  const Manipulator = need(manipulatorModule);
  const asset = new Media.Asset(id);
  let info;
  try {
    info = await asset.getInfo();
  } catch {
    throw new DeviceError("No photo with that id.");
  }
  if (info.mediaType === Media.MediaType.VIDEO) throw new DeviceError("That is a video. Only photos can be brought over.");
  if (info.mediaType !== Media.MediaType.IMAGE) throw new DeviceError("That isn't a photo.");
  let uri: string;
  try {
    // A photo kept only in iCloud is downloaded first.
    uri = await asset.getUri();
  } catch {
    throw new DeviceError("The phone couldn't open that photo. It may still be in iCloud.");
  }
  const longest = Math.max(info.width, info.height, 1);
  const scale = Math.min(1, maxSize / longest);
  const width = Math.max(1, Math.round(info.width * scale));
  const height = Math.max(1, Math.round(info.height * scale));
  // Decoded at about the size it ends up, so a 48 MP photo never sits whole in memory.
  const context = Manipulator.ImageManipulator.manipulate(uri, { maxWidth: maxSize, maxHeight: maxSize });
  const image = await context.resize(info.width >= info.height ? { width } : { height }).renderAsync();
  const saved = await image.saveAsync({ format: Manipulator.SaveFormat.JPEG, compress: 0.82 });
  const name = (info.filename || "photo").replace(/\.[^.]+$/, "") + ".jpg";
  try {
    const sent = await upload(saved.uri, name, () => {}, () => false).catch(() => {
      throw new DeviceError("The photo couldn't be sent to the computer.");
    });
    return compact({ path: sent.path, name: sent.name, width: saved.width, height: saved.height, takenAt: info.creationTime ? isoLocal(info.creationTime) : undefined });
  } finally {
    try {
      new File(saved.uri).delete();
    } catch {
      // The shrunk copy is in the app's cache; the system clears it later.
    }
  }
}

/** Saves a picture the computer sends along to the photo library, and to an album when one is named. */
async function save(raw: unknown, context: { askId?: string } = {}) {
  const args = checkArgs(raw, argsOf("phone_photos_save"));
  const albumName = optString(args, "album", 100)?.trim();
  const Media = need(mediaModule);
  // An album needs the whole library; a plain save needs only permission to add.
  requireAccess("photos", accessOf(await Media.getPermissionsAsync(!albumName)));
  if (!context.askId) throw new DeviceError("The picture didn't arrive.");
  let sent: { name: string; data: string };
  try {
    sent = await api["link.device.file"](context.askId);
  } catch {
    throw new DeviceError("The picture couldn't be fetched from the computer.");
  }
  const binary = atob(sent.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const name = (sent.name || "picture.jpg").replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
  const file = new File(Paths.cache, "botkins-save-" + Date.now() + "-" + name);
  try {
    file.create({ overwrite: true });
    file.write(bytes);
    const asset = await Media.Asset.create(file.uri);
    if (albumName) {
      const album = await Media.Album.get(albumName);
      if (album) await album.add(asset);
      else await Media.Album.create(albumName, [asset], false);
    }
    return compact({ id: asset.id, album: albumName || undefined });
  } catch (error) {
    if (error instanceof DeviceError) throw error;
    throw new DeviceError("The phone couldn't save that picture.");
  } finally {
    try {
      file.delete();
    } catch {
      // It is in the app's cache; the system clears it later.
    }
  }
}

export const photosTools = {
  phone_photos_recent: recent,
  phone_photos_get: get,
  phone_photos_save: save,
};
