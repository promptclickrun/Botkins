// What the Device access screen shows and asks iOS for, per source.
import { CalendarDays, Contact, HeartPulse, Images, type LucideIcon, Mail, MapPin } from "lucide-react-native";
import type { Access } from "@/device/access";
import { askCalendar, calendarAccess } from "@/device/calendar";
import { askContacts, chooseMoreContacts, contactsAccess } from "@/device/contacts";
import { askHealth, healthAccess } from "@/device/health";
import { askLocation, locationAccess } from "@/device/location";
import { mailReady } from "@/device/mail";
import { askPhotos, chooseMorePhotos, photosAccess } from "@/device/photos";
import type { DeviceLevel, DeviceSource } from "@/link/types";
import { brand } from "@/ui";

type On = Exclude<DeviceLevel, "off">;

export type SourceUI = {
  icon: LucideIcon;
  color: string;
  /** One short line per level: what bots may do. */
  says: Partial<Record<DeviceLevel, string>>;
  /** The segment's words for a level, where they differ from Read and Interact. */
  labels?: Partial<Record<DeviceLevel, string>>;
  /** A short line that is always shown (Mail's limit). */
  note?: string;
  /** What iOS allows now, without asking. */
  check: (level: On) => Promise<Access>;
  /** Asks iOS for what `level` needs. */
  ask: (level: On) => Promise<Access>;
  /** With limited access, lets the person share more. */
  more?: { label: string; run: () => Promise<void> };
};

const mailAccess = async (): Promise<Access> => ((await mailReady()) ? { state: "granted" } : { state: "unavailable", reason: "Set up Mail on this iPhone first" });

export const SOURCE_UI: Record<DeviceSource, SourceUI> = {
  calendar: {
    icon: CalendarDays,
    color: brand.clay,
    says: { off: "Bots can't see your calendar", read: "Bots can see your events", interact: "Bots can also add and change events" },
    check: () => calendarAccess(),
    ask: () => askCalendar(),
  },
  contacts: {
    icon: Contact,
    color: brand.tide,
    says: { off: "Bots can't see your contacts", read: "Bots can look up your contacts", interact: "Bots can also add and change contacts" },
    check: () => contactsAccess(),
    ask: () => askContacts(),
    more: { label: "Choose more contacts", run: chooseMoreContacts },
  },
  health: {
    icon: HeartPulse,
    color: brand.rose,
    says: { off: "Bots can't see your Health data", read: "Bots can read your activity, sleep and more", interact: "Bots can also log water, weight and more" },
    check: (level) => healthAccess(level),
    ask: (level) => askHealth(level),
  },
  location: {
    icon: MapPin,
    color: brand.fern,
    says: { off: "Bots can't see where you are", read: "Bots can see where your phone is, while Botkins is open" },
    check: () => locationAccess(),
    ask: () => askLocation(),
  },
  photos: {
    icon: Images,
    color: brand.honey,
    says: { off: "Bots can't see your photos", read: "Bots can list your photos and look at the ones they ask for" },
    check: () => photosAccess(),
    ask: () => askPhotos(),
    more: { label: "Choose more photos", run: chooseMorePhotos },
  },
  mail: {
    icon: Mail,
    color: brand.clay,
    says: { off: "Bots can't write email here", interact: "Bots can fill in an email for you to send" },
    labels: { interact: "Compose" },
    note: "iPhone doesn't let apps read mail. Reading is set up on your Mac.",
    check: () => mailAccess(),
    ask: () => mailAccess(),
  },
};
