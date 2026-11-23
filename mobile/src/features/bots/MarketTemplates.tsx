import { useEffect, useEffectEvent, useState } from "react";
import type { MarketAgent, MarketAgentTemplate } from "@/link/types";
import { useCapability, useOnline } from "@/state/hooks";
import { api } from "@/state/link";
import { BotAvatar, EmptyState, Group, Loading, Row } from "@/ui";
import { AGENTS_CAPABILITY, templateAvailability } from "@/features/market/agents/logic";

export function MarketTemplates({ pick }: { pick: (template: MarketAgentTemplate) => void }) {
  const unavailable = templateAvailability(useCapability(AGENTS_CAPABILITY), useOnline());
  const [agents, setAgents] = useState<MarketAgent[]>();
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  const [tries, setTries] = useState(0);
  const apply = useEffectEvent(pick);

  useEffect(() => {
    if (unavailable) return;
    let live = true;
    setError("");
    const read = id
      ? api["agents.template"](id).then((template) => live && apply(template))
      : api["agents.browse"]({}).then((page) => live && setAgents(page.agents));
    read.catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Couldn't read the marketplace."));
    return () => { live = false; };
  }, [unavailable, id, tries]);

  if (unavailable) return <EmptyState title={unavailable} />;
  if (error) return <EmptyState title="Couldn't read the marketplace" text={error} action="Try again" onAction={() => setTries(tries + 1)} />;
  if (!agents || id) return <Loading label={id ? "Reading the template…" : "Loading agents…"} />;
  if (!agents.length) return <EmptyState title="No agents here yet" />;
  return (
    <Group>
      {agents.map((agent) => (
        <Row key={agent.id} title={agent.name} subtitle={[agent.role, agent.summary].filter(Boolean).join("\n")} subtitleLines={3} leading={<BotAvatar bot={agent} size={40} />} onPress={() => setId(agent.id)} />
      ))}
    </Group>
  );
}
