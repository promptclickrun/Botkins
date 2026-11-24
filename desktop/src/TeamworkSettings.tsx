import type { State } from "./types";
import { BotAvatar } from "./Avatar";
import { Group, SwitchRow, errorText } from "./SettingsRows";
import "./integrations.css";

/** Settings › Teamwork: whether bots may hand part of a request to another bot, and which bots take part. */
export default function TeamworkSettings({
  state,
  on,
  change,
  fail,
}: {
  state: State;
  on: boolean;
  change: (on: boolean) => void;
  fail: (message: string) => void;
}) {
  return (
    <div className="int-section">
      <Group footer="A bot can ask a teammate here or on another computer in your profile. The other computer asks you to approve the message before its bot answers.">
        <SwitchRow label="Bots ask each other for help" checked={on} onChange={change} />
      </Group>
      <Group title="Bots" footer={on ? "A bot that doesn't take part neither asks for help nor is asked." : "Turn on Teamwork above to choose which bots take part."}>
        {state.bots.map((b) => {
          const id = "team-" + b.id;
          return (
            <div className={"set-row int-item int-bot" + (on ? "" : " off")} key={b.id}>
              <BotAvatar bot={b} size={28} />
              <div className="set-label">
                <span className="set-name" id={id}>
                  {b.name}
                </span>
                <small className="int-line">{b.role}</small>
              </div>
              <div className="set-control">
                <span className="int-switch-label" aria-hidden="true">
                  Takes part
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="switch set-switch"
                  aria-label={b.name + " takes part"}
                  disabled={!on}
                  checked={b.teamwork !== false}
                  onChange={(e) => void window.botkins.setBotFlags(b.id, { teamwork: e.target.checked }).catch((err) => fail(errorText(err)))}
                />
              </div>
            </div>
          );
        })}
      </Group>
    </div>
  );
}
