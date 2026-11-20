// Contacts tools, through expo-contacts' object API (SDK 58).
import { type Access, accessOf, requireAccess } from "./access";
import { type Args, checkArgs, DeviceError, limitOf, optList, optString, reqString } from "./args";
import { contactsModule, need } from "./native";
import { argsOf } from "./tools";
import { appleLabel, cleanLabel, clip, compact, contactDate, contactSummary, fit, matchContact } from "./shape";

export async function contactsAccess(): Promise<Access> {
  const Contacts = contactsModule();
  if (!Contacts) return { state: "unavailable" };
  return accessOf(await Contacts.getPermissionsAsync());
}
export async function askContacts(): Promise<Access> {
  const Contacts = contactsModule();
  if (!Contacts) return { state: "unavailable" };
  return accessOf(await Contacts.requestPermissionsAsync());
}
/** With limited access (iOS 18), lets the person share more contacts. */
export async function chooseMoreContacts(): Promise<void> {
  await need(contactsModule).Contact.presentAccessPicker();
}

async function ready() {
  const Contacts = need(contactsModule);
  requireAccess("contacts", accessOf(await Contacts.getPermissionsAsync()));
  return Contacts;
}

async function search(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_contacts_search"));
  const query = reqString(args, "query", 200);
  const limit = limitOf(args, 20, 100);
  const Contacts = await ready();
  const F = Contacts.ContactField;
  // A search reads only what it compares and returns, for every contact, then matches here: the
  // phone's own search finds names only, and a bot may search by number or email.
  const all = await Contacts.Contact.getAllDetails([F.FULL_NAME, F.GIVEN_NAME, F.FAMILY_NAME, F.COMPANY, F.PHONES, F.EMAILS] as const);
  const found = all.filter((card) => matchContact(card, query));
  return fit({ contacts: found.slice(0, limit).map(contactSummary), ...(found.length > limit && { more: found.length - limit }) }, "contacts");
}

async function get(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_contacts_get"));
  const id = reqString(args, "id", 500);
  const Contacts = await ready();
  const F = Contacts.ContactField;
  const fields = [F.FULL_NAME, F.GIVEN_NAME, F.MIDDLE_NAME, F.FAMILY_NAME, F.NICKNAME, F.COMPANY, F.DEPARTMENT, F.JOB_TITLE, F.BIRTHDAY, F.PHONES, F.EMAILS, F.ADDRESSES, F.URL_ADDRESSES, F.SOCIAL_PROFILES, F.RELATIONS, F.DATES, F.NOTE] as const;
  let card;
  try {
    // The note is left out by the phone unless the app may read notes.
    card = await new Contacts.Contact(id).getDetails(fields);
  } catch {
    throw new DeviceError("No contact with that id.");
  }
  return fit(
    compact({
      ...contactSummary(card),
      middleName: clip(card.middleName, 100),
      nickname: clip(card.nickname, 100),
      department: clip(card.department, 200),
      jobTitle: clip(card.jobTitle, 200),
      birthday: contactDate(card.birthday),
      addresses: (card.addresses ?? []).slice(0, 20).map((address) => compact({ label: cleanLabel(address.label), street: clip(address.street, 300), city: clip(address.city, 100), region: clip(address.region ?? address.state, 100), postcode: clip(address.postcode, 30), country: clip(address.country, 100) })),
      urls: (card.urlAddresses ?? []).slice(0, 20).map((url) => compact({ label: cleanLabel(url.label), url: clip(url.url, 500) })),
      social: (card.socialProfiles ?? []).slice(0, 20).map((profile) => compact({ service: clip(profile.service, 60), username: clip(profile.username, 120), url: clip(profile.url, 500) })),
      relations: (card.relations ?? []).slice(0, 20).map((relation) => compact({ label: cleanLabel(relation.label), name: clip(relation.name, 120) })),
      dates: (card.dates ?? []).slice(0, 20).map((date) => compact({ label: cleanLabel(date.label), date: contactDate(date.date) })),
      note: clip(card.note, 2000),
    }),
    "addresses",
  );
}

function phonesOf(args: Args) {
  return optList(args, "phones", (entry) => {
    const number = reqString(entry, "number", 60).trim();
    return compact({ label: appleLabel(optString(entry, "label", 60), "phone"), number });
  });
}
function emailsOf(args: Args) {
  return optList(args, "emails", (entry) => {
    const address = reqString(entry, "email", 320).trim();
    if (!address.includes("@")) throw new DeviceError(JSON.stringify(address.slice(0, 80)) + " isn't an email address.");
    return compact({ label: appleLabel(optString(entry, "label", 60), "email"), address });
  });
}

/** The fields a contact takes, from a tool's arguments. */
function record(args: Args) {
  return compact({
    givenName: optString(args, "firstName", 200)?.trim(),
    familyName: optString(args, "lastName", 200)?.trim(),
    company: optString(args, "company", 200)?.trim(),
    jobTitle: optString(args, "jobTitle", 200)?.trim(),
    phones: phonesOf(args),
    emails: emailsOf(args),
  });
}

/** A note needs a permission Apple grants apps one by one; without it the rest is still saved. */
async function saveNote(contact: { setNote(note: string | null): Promise<boolean> }, note: string | undefined) {
  if (note === undefined) return undefined;
  try {
    await contact.setNote(note);
    return undefined;
  } catch {
    return "The note wasn't saved: this phone doesn't let Botkins write contact notes.";
  }
}

async function create(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_contacts_create"));
  const fields = record(args);
  const note = optString(args, "note", 5000);
  if (!fields.givenName && !fields.familyName && !fields.company && !fields.phones?.length && !fields.emails?.length) throw new DeviceError("Give a name, a company, a phone number or an email.");
  const Contacts = await ready();
  const contact = await Contacts.Contact.create(fields);
  const warning = await saveNote(contact, note);
  return compact({ id: contact.id, warning });
}

async function update(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_contacts_update"));
  const id = reqString(args, "id", 500);
  const fields = record(args);
  const note = optString(args, "note", 5000);
  if (!Object.keys(fields).length && note === undefined) throw new DeviceError("Give at least one field to change.");
  const Contacts = await ready();
  const contact = new Contacts.Contact(id);
  try {
    await contact.getFullName();
  } catch {
    throw new DeviceError("No contact with that id.");
  }
  // A list given replaces the list the contact has: new entries only, so the old ones go.
  if (Object.keys(fields).length) await contact.patch(fields);
  const warning = await saveNote(contact, note);
  return compact({ id, updated: true, warning });
}

export const contactsTools = {
  phone_contacts_search: search,
  phone_contacts_get: get,
  phone_contacts_create: create,
  phone_contacts_update: update,
};
