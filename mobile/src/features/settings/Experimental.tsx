// Settings › Experimental, as on the computer (desktop/src/ExperimentalSettings.tsx): the Proactive agent's
// switch for the computer (the owner's alone), and the bots that have one. Each bot's own switch and settings
// are on its page.
import { type Href, router } from "expo-router";
import { Alert, View } from "react-native";
import { proactiveBots, proactiveSummary } from "@/features/bots/proactive";
import { useBots, usePart, useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Group, Label, Loading, Page, Row, T } from "@/ui";

export default function Experimental() {
  const settings = useSettings();
  const bots = useBots();
  const part = usePart("proactive");
  if (!settings)
    return (
      <Page title="Experimental">
        <Loading />
      </Page>
    );
  const on = settings.proactive?.enabled === true;
  const set = (enabled: boolean) => void attempt(api.setPreferences({ proactive: { enabled } }));
  const turnOn = (enabled: boolean) =>
    enabled
      ? Alert.alert("Turn on the Proactive agent?", "Every bot that was set up to look out for someone wakes on its own, reads what its tools reach (such as your inbox and calendar) and messages them, with nobody watching. Each wake uses the model.", [
          { text: "Cancel", style: "cancel" },
          { text: "Turn on", onPress: () => set(true) },
        ])
      : set(false);
  const listed = proactiveBots(part, bots);
  return (
    <Page title="Experimental">
      <T variant="footnote" color="muted">
        These are new. They may change or go away, and they can use your model more than you expect.
      </T>
      <View>
        <Label>Proactive agent</Label>
        <Group>
          <Row title="Proactive agent" subtitle="Turns the feature on for this computer. Team members can't change it" toggled={on} onToggle={turnOn} />
        </Group>
        <T variant="footnote" color="muted">
          A bot that looks around, tells you what matters and offers to take care of it. It is on from the start, and a bot does nothing until you set it up on its page. Off pauses every bot's agent and keeps what each was set to. A check reads and drafts only: it never sends, posts, buys or deletes until you take its offer.
        </T>
      </View>
      <View>
        <Label>Bots with a Proactive agent</Label>
        <Group>
          {listed.length ? (
            listed.map(({ bot, p }) => (
              <Row
                key={bot.id}
                title={bot.name}
                subtitle={p.setUp ? proactiveSummary(p) + (Object.keys(p.people ?? {}).length > 1 ? " · " + Object.keys(p.people ?? {}).length + " people" : "") : "Not set up yet"}
                value={on ? undefined : "Paused"}
                chevron
                onPress={() => router.push(("/bot/" + encodeURIComponent(bot.id) + "/proactive") as Href)}
              />
            ))
          ) : (
            <Row title="No bot yet" subtitle="Set up Proactive on a bot's page" />
          )}
        </Group>
      </View>
    </Page>
  );
}
