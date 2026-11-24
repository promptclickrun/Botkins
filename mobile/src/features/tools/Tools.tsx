import { type Href, router, Stack } from "expo-router";
import { Globe, Import, LayoutGrid, Plus, Smartphone, Store, Terminal, Wrench } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { countOn } from "@/device/tools";
import { useDevicePrefs } from "@/state/devicePrefs";
import { useCan, useMember, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Badge, brand, EmptyState, Group, IconButton, IconTile, Loading, Page, Row, space, useTheme } from "@/ui";
import { attentionOf, whereOf } from "./shared";

const add = () => router.push({ pathname: "/tools/[id]", params: { id: "new" } });

/** The MCP servers on the computer, each with its switch. */
export default function Tools() {
  const { colors } = useTheme();
  const servers = usePart("mcp");
  const canView = useCan("mcp", "view");
  const canCreate = useCan("mcp", "create");
  const canManage = useCan("mcp", "manage");
  const canPlugins = useCan("plugins", "view");
  const member = useMember();
  const deviceOn = useDevicePrefs((state) => countOn(state.sources));
  // A switch holds its new place until the computer says it changed.
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const toggle = async (id: string, on: boolean) => {
    setPending((held) => ({ ...held, [id]: on }));
    await attempt(api.setMcpServerEnabled(id, on));
    setPending(({ [id]: _, ...rest }) => rest);
  };

  return (
    <Page title="Tools" caption="MCP servers your bots can use">
      <Stack.Screen
        options={{
          headerRight: canCreate ? () => (
            <View style={{ flexDirection: "row" }}>
              {!member && <IconButton icon={Import} label="Import MCP servers" size={44} onPress={() => router.push("/tools/import" as Href)} />}
              <IconButton icon={Plus} label="Add a tool" size={44} onPress={add} />
            </View>
          ) : undefined,
        }}
      />
      {!member && <Group>
        <Row leading={<IconTile icon={Smartphone} color={brand.tide} size={36} />} title="Device access" subtitle="Calendar, contacts, Health and more" value={deviceOn ? deviceOn + " on" : "Off"} chevron onPress={() => router.push("/tools/device")} />
      </Group>}
      {!canView ? (
        <EmptyState title="Your team role can't view tools" />
      ) : !servers ? (
        <Loading />
      ) : servers.length === 0 ? (
        <EmptyState icon={Wrench} title="No tools yet" action={canCreate ? "Add a tool" : undefined} onAction={canCreate ? add : undefined} />
      ) : (
        <Group>
          {servers.map((server) => {
            const attention = attentionOf(server);
            return (
              <Row
                key={server.id}
                leading={<IconTile icon={server.type === "stdio" ? Terminal : Globe} color={brand.clay} size={36} />}
                title={server.name}
                subtitle={whereOf(server) || undefined}
                trailing={attention ? <Badge label={attention} tone="warning" /> : undefined}
                toggled={canManage ? (pending[server.id] ?? server.enabled) : undefined}
                onToggle={canManage ? (on) => void toggle(server.id, on) : undefined}
                onPress={() => router.push({ pathname: "/tools/[id]", params: { id: server.id } })}
              />
            );
          })}
        </Group>
      )}
      {(canView || canPlugins) && <View style={{ marginTop: servers?.length === 0 ? -space.lg : 0 }}>
        <Group>
          {canView && <Row leading={<IconTile icon={LayoutGrid} color={colors.ink2} />} title="Browse apps" chevron onPress={() => router.push("/market/apps" as Href)} />}
          {canPlugins && <Row leading={<IconTile icon={Store} color={colors.ink2} />} title="Add from the Marketplace" chevron onPress={() => router.push("/market")} />}
        </Group>
      </View>}
    </Page>
  );
}
