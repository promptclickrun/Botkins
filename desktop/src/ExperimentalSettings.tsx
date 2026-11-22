import { useState } from "react";
import type { Bot, Preferences, ProactiveSettings, State } from "./types";
import { openBotPage } from "./access";
import { proactiveOf } from "./BotProactive";
import { useAsk } from "./Pages";
import { Group, Row, SwitchRow, ValueRow, errorText } from "./SettingsRows";

const minutes = (m: number) => (m < 60 ? m + " minutes" : m / 60 + (m === 60 ? " hour" : " hours"));

/** Settings › Experimental: features that are new and may change. */
export default function ExperimentalSettings({ state, bots, settings, change }: { state: State; bots: Bot[]; settings: Preferences; change: (patch: { proactive: Partial<ProactiveSettings> }) => Promise<void> }) {
  const [error, setError] = useState("");
  const dialogs = useAsk();
  const on = settings.proactive?.enabled === true;
  const set = (enabled: boolean) => {
    setError("");
    void change({ proactive: { enabled } }).catch((e) => setError(errorText(e)));
  };
  const turnOn = async () => {
    const yes = await dialogs.ask({
      title: "Turn on the Proactive agent?",
      body: "Every bot that has its own Proactive agent switched on wakes on its own, reads what its tools reach (such as your inbox and calendar) and messages you, with nobody watching. Each wake uses the model.",
      confirm: "Turn on",
    });
    if (yes) set(true);
  };
  const proactive = bots.flatMap((bot) => {
    const entry = state.proactive?.bots[bot.id];
    return entry?.enabled ? [{ bot, p: proactiveOf(entry) }] : [];
  });
  return (
    <>
      <p className="set-status">These are new. They may change or go away, and they can use your model more than you expect.</p>
      <Group
        title="Proactive agent"
        footer="A bot that tells you what you need to know before you ask. Botkins checks for changes with no model, and wakes the bot only when something changed or a look around is due. The bot reads and drafts only: it never sends, posts, buys or deletes on its own. This switch is for the whole computer: off pauses every bot's agent and keeps what each was set to. Each bot's own switch and settings are on its page."
      >
        <SwitchRow label="Proactive agent" help="Turns the feature on for this computer. Team members can't change it." checked={on} onChange={(next) => (next ? void turnOn() : set(false))} />
      </Group>
      <Group title="Bots with a Proactive agent" footer={on ? "Open a bot's page to turn its agent on or off and to change how it works." : "Paused while the switch above is off. Open a bot's page to change its agent."}>
        {proactive.length ? (
          proactive.map(({ bot, p }) => (
            <Row
              key={bot.id}
              label={bot.name}
              help={"Checks every " + minutes(p.every) + (p.sweepHours ? ", looks around every " + minutes(p.sweepHours * 60) : "") + ". Alerts today: " + (p.pings ?? 0) + " of " + p.maxPerDay + "." + (p.person && p.person !== "owner" ? " Works for a team member." : "")}
            >
              {() => (
                <button type="button" onClick={() => openBotPage(bot.id)}>
                  Open {bot.name}
                </button>
              )}
            </Row>
          ))
        ) : (
          <ValueRow label="No bot yet" value="—" help="Turn on Proactive on a bot's page." />
        )}
      </Group>
      {error && (
        <p className="set-status error-text" role="alert">
          {error}
        </p>
      )}
      {dialogs.node}
    </>
  );
}
