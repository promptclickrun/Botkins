// "Bring in your agents": the agents a person already has in a provider's own tool (for GitHub
// Copilot, the ones in ~/.copilot/agents), each offered as a bot with the same instructions. It is
// the first step on a computer with no bots, as in the app on the computer, and stays reachable from
// New bot. The computer copies each agent; its files stay as they are.
import { router } from "expo-router";
import { Bot as BotIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { ImportableAgent } from "@/link/types";
import { useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { Button, EmptyState, Group, Loading, Row, Sheet, space, T } from "@/ui";
import { addLabel, agentLine, agentNotes, canAdd, copyLine, firstPick, foundLine, pickedKeys } from "./agents";

export default function BringAgents() {
  const online = useOnline();
  const [agents, setAgents] = useState<ImportableAgent[]>();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!online) return;
    let live = true;
    api.importableAgents().then(
      (list) => {
        if (!live) return;
        setAgents(list);
        setPicked(firstPick(list));
      },
      // Without the list the person can still make a bot by hand.
      () => live && setAgents([]),
    );
    return () => {
      live = false;
    };
  }, [online]);

  const keys = agents ? pickedKeys(agents, picked) : [];
  const add = async () => {
    if (!keys.length || busy) return;
    setBusy(true);
    const made = await attempt(api.importAgents(keys));
    setBusy(false);
    if (!made) return;
    showToast(made.length === 1 ? "1 bot added" : made.length + " bots added", "success");
    router.back();
  };
  const fresh = () => router.replace("/bot/new");

  return (
    <Sheet title="Bring in your agents" action={agents?.length ? addLabel(keys.length) : undefined} onAction={() => void add()} actionDisabled={!keys.length || busy || !online} actionLoading={busy}>
      {!agents ? (
        <Loading />
      ) : agents.length === 0 ? (
        <EmptyState icon={BotIcon} title="No agents found" text="Botkins looks for the agents you use with your providers on your computer." action="Create a new bot" onAction={fresh} />
      ) : (
        <>
          <T variant="subhead" color="muted">
            {foundLine(agents)}
          </T>
          <Group>
            {agents.map((agent) => (
              <View key={agent.key}>
                <Row
                  title={agent.name}
                  subtitle={agentLine(agent)}
                  subtitleLines={3}
                  disabled={!canAdd(agent) || busy}
                  toggled={canAdd(agent) && picked.includes(agent.key)}
                  onToggle={(on) => setPicked((list) => (on ? [...list, agent.key] : list.filter((key) => key !== agent.key)))}
                />
                {(agentNotes(agent).length > 0 || (!!agent.modelName && !agent.problem)) && (
                  <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.xs }}>
                    {!!agent.modelName && !agent.problem && (
                      <T variant="footnote" color="ink2">
                        {agent.modelName}
                      </T>
                    )}
                    {agentNotes(agent).map((note) => (
                      <T key={note} variant="footnote" color="muted">
                        {note}
                      </T>
                    ))}
                  </View>
                )}
              </View>
            ))}
          </Group>
          <Button title="Create a new bot instead" variant="ghost" onPress={fresh} style={{ alignSelf: "center" }} />
          <T variant="footnote" color="muted" center>
            {copyLine(agents)}
          </T>
        </>
      )}
    </Sheet>
  );
}
