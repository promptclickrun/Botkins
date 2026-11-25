// Settings › Profile › Your picture: the picture people see beside your messages and in tags. It is
// kept on the computer the team belongs to, never in the hosted profile, and only you set yours.
import { useRef, useState } from "react";
import { ImageUp, Trash2 } from "lucide-react";
import { AVATAR_TYPES, avatarFromFile } from "./avatarImage";
import { PersonBadge } from "./PersonBadge";
import { viewerOf } from "./peopleView";
import { Group, errorText } from "./SettingsRows";
import type { State } from "./types";

export function YourPicture({ state }: { state: State }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const me = viewerOf(state);
  const team = state.team;
  const people = team && "people" in team ? team.people : undefined;
  const mine = people?.find((person) => person.id === me);
  const name = mine?.name || (team && "me" in team ? team.me.name : state.profile?.profile?.name) || "You";
  const emoji = me === "owner" && !state.remote?.using ? state.profile?.profile?.avatar : undefined;
  const avatar = mine?.avatar;

  const change = async (next: () => Promise<string | null>) => {
    setBusy(true);
    setError("");
    try {
      await window.botkins.setMyAvatar(await next());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group title="Your picture" footer="People on your team see it beside your messages and when someone mentions you. It stays on this computer's team, not in your hosted profile.">
      <div className="your-picture">
        <PersonBadge person={{ id: me, name, avatar, emoji }} size={64} className="your-picture-preview" />
        <div className="your-picture-body">
          <span className="set-name">{avatar ? "Your picture is set." : "No picture yet. People see your initial."}</span>
          {error && <span className="your-picture-error" role="alert">{error}</span>}
          <div className="your-picture-actions">
            <button type="button" className="set-button" disabled={busy} onClick={() => input.current?.click()}>
              <ImageUp size={14} aria-hidden="true" />
              <span>{busy ? "Saving…" : "Upload picture…"}</span>
            </button>
            {avatar && (
              <button type="button" className="set-button" disabled={busy} onClick={() => void change(async () => null)}>
                <Trash2 size={14} aria-hidden="true" />
                <span>Remove</span>
              </button>
            )}
          </div>
        </div>
        <input
          ref={input}
          type="file"
          accept={AVATAR_TYPES}
          hidden
          aria-label="Choose a picture"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void change(() => avatarFromFile(file));
          }}
        />
      </div>
    </Group>
  );
}
