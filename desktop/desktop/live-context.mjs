import { readProfile } from "./bot-profile-files.mjs";

const NAME_LIMIT = 80;
const NOTE_LIMIT = 2000;

/**
 * The small, local context a live voice may use in addition to its bot and chat. Profile files
 * are read through the same bounded, no-symlink reader used by profile tools; nothing here reads
 * a home-folder file or an OS account name. A person's name is optional until the app has one in
 * its settings or an explicit `Name: …` line in USER.md.
 *
 * USER.md is what the bot knows about the computer's owner. A call a team member starts
 * (`memberId`) gets none of it, and not the owner's name: only the bot's own identity.
 */
export function liveContextFor(workspace, { chatId, botId, memberId } = {}) {
  const state = workspace?.state;
  const chat = state?.chats?.find((item) => item.id === chatId);
  const bot = state?.bots?.find((item) => item.id === botId);
  if (!chat || !bot || (chat.botId !== botId && !(chat.botIds ?? []).includes(botId))) return {};
  const settings = state.settings ?? {};
  const profile = (file) => {
    try {
      return readProfile(workspace, botId, file).trim();
    } catch {
      return "";
    }
  };
  const identity = profile("IDENTITY.md").slice(0, NOTE_LIMIT);
  if (memberId) return identity ? { identity } : {};
  const userSource = profile("USER.md");
  // The desktop currently has no separate account-name setting. A future chosen name may use
  // settings.userName; otherwise only an explicit `Name: …` line in the person's USER.md counts.
  const fromFile = /^\s*Name\s*:\s*(.{1,80}?)\s*$/im.exec(userSource)?.[1]?.trim();
  const userName = typeof settings.userName === "string" && settings.userName.trim() ? settings.userName.trim() : fromFile;
  const user = userSource.slice(0, NOTE_LIMIT);
  return {
    ...(userName && { userName: userName.trim().slice(0, NAME_LIMIT) }),
    ...(identity && { identity }),
    ...(user && { user }),
  };
}
