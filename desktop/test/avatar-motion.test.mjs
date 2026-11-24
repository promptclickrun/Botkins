// The agent you're with moves; lists hold still (the owner's rule, 2026-11-24, the phone's too:
// ../mobile/AGENTS.md design rule 10). An avatar is still unless it passes `animated`, and only these
// places may. Add a place only with the owner's word.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const src = new URL("../src/", import.meta.url);
const MOVING = {
  "BotProfile.tsx": 1, // the bot's own page
  "ChatView.tsx": 3, // the chat header's face, a group header's faces, the live line while a turn runs
  "ChatSide.tsx": 1, // the chat's details panel, beside the chat
  "LiveVoice.tsx": 1, // live voice
  "BotStudio.tsx": 1, // the look editor's preview
};

test("only the agent you're with asks for motion", () => {
  const asking = {};
  for (const file of readdirSync(src).filter((name) => name.endsWith(".tsx"))) {
    const text = readFileSync(new URL(file, src), "utf8");
    const tags = text.match(/<BotAvatar\b[\s\S]*?\/>/g) ?? [];
    // `animated` on its own, or with any value but `false`; `animated={moving}` hands a caller's choice on.
    const count = tags.filter((tag) => /\sanimated(?!=\{(?:false|moving)\})(?:=\{[^}]*\})?[\s/]/.test(tag)).length
      + (text.match(/stillFace\(\d+, true\)/g) ?? []).length;
    if (count) asking[file] = count;
  }
  assert.deepEqual(asking, MOVING);
});

test("an avatar holds still unless it is asked to move", () => {
  const avatar = readFileSync(new URL("Avatar.tsx", src), "utf8");
  assert.match(avatar, /useContext\(AvatarAnimationSetting\) && animated === true/);
});
