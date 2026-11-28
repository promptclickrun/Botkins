// Project subpage: Spaces (or Panels when spaces are off).
// Attached spaces as rows; + opens a menu to attach a space; hold menu removes one.
// Project panels appear below, as today.
import { MenuView } from "@react-native-menu/menu";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { LayoutGrid, Plus } from "lucide-react-native";
import { useMemo } from "react";
import { View } from "react-native";
import { openSpace, useSpaces, useSpacesOn } from "@/features/spaces/data";
import { rowLine as spaceRowLine, spaceTitle } from "@/features/spaces/logic";
import { PanelCard as SpacePanelCard } from "@/features/spaces/SpaceView";
import { PanelCard } from "@/features/today/Today";
import type { Panel, Project } from "@/link/types";
import { useBots, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { EmptyState, Group, HoldMenu, IconButton, IconTile, Label, Loading, Page, Row, space, useTheme } from "@/ui";

export function ProjectSpacesContent({ project }: { project: Project }) {
  const { colors } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const todays = usePart("panels");
  const everywhere = usePart("projectPanels");
  const allBots = useBots();
  const spacesOn = useSpacesOn();
  const spaces = useSpaces();

  const mine = useMemo(
    () => ((spacesOn && everywhere) || todays || []).filter((panel) => panel.projectId === project.id),
    [spacesOn, everywhere, todays, project.id],
  );
  const attached = useMemo(() => (spacesOn ? spaces.filter((one) => one.projectId === project.id) : []), [spacesOn, spaces, project.id]);
  const free = useMemo(() => (spacesOn ? spaces.filter((one) => one.mine && !one.projectId) : []), [spacesOn, spaces]);

  const title = spacesOn ? "Spaces" : "Panels";
  const total = attached.length + mine.length;
  const caption =
    total === 0
      ? spacesOn
        ? "None attached"
        : "No panels yet"
      : spacesOn
        ? [
            attached.length ? `${attached.length} ${attached.length === 1 ? "space" : "spaces"}` : "",
            mine.length ? `${mine.length} ${mine.length === 1 ? "panel" : "panels"}` : "",
          ]
            .filter(Boolean)
            .join(" · ")
        : `${mine.length} ${mine.length === 1 ? "panel" : "panels"}`;

  const attachMenuActions = free.length
    ? free.map((one) => ({ id: one.id, title: spaceTitle(one) }))
    : [{ id: "", title: "No space to attach", attributes: { disabled: true } }];

  const attachSpace = (spaceId: string) => {
    if (!spaceId) return;
    void attempt(api["spaces.setProject"](spaceId, project.id));
  };

  return (
    <Page title={title} caption={caption}>
      {spacesOn && (
        <Stack.Screen
          options={{
            headerRight: () => (
              <MenuView
                title="Attach a space"
                actions={attachMenuActions}
                onPressAction={({ nativeEvent }) => attachSpace(nativeEvent.event)}
              >
                <IconButton
                  icon={Plus}
                  label="Attach a space"
                  variant={hasBackdrop ? "glass" : "soft"}
                />
              </MenuView>
            ),
          }}
        />
      )}

      {total === 0 ? (
        spacesOn ? (
          free.length > 0 ? (
            <EmptyState
              icon={LayoutGrid}
              title="No spaces or panels yet"
              text="Attach a space to this project or ask a bot in one of its chats for a panel."
              action={`Attach ${spaceTitle(free[0]!)}`}
              onAction={() => attachSpace(free[0]!.id)}
            />
          ) : (
            <EmptyState
              icon={LayoutGrid}
              title="No spaces or panels yet"
              text="Create a space on Home or ask a bot in one of this project's chats for a panel."
              action="Open chats"
              onAction={() => router.push({ pathname: "/projects/[id]/chats", params: { id: project.id } })}
            />
          )
        ) : (
          <EmptyState
            icon={LayoutGrid}
            title="No panels yet"
            text="Ask a bot in one of this project's chats for a Today panel."
            action="Open chats"
            onAction={() => router.push({ pathname: "/projects/[id]/chats", params: { id: project.id } })}
          />
        )
      ) : (
        <View style={{ gap: space.xl }}>
          {spacesOn && attached.length > 0 && (
            <View>
              <Label>Spaces</Label>
              <Group inset={space.lg + 32 + space.md}>
                {attached.map((one) => (
                  <HoldMenu
                    key={one.id}
                    actions={[
                      {
                        id: "remove",
                        title: "Remove from project",
                        image: "minus.circle",
                        attributes: { destructive: true },
                      },
                    ]}
                    onPressAction={({ nativeEvent }) => {
                      if (nativeEvent.event === "remove") {
                        void attempt(api["spaces.setProject"](one.id, null), "Removed from " + project.name);
                      }
                    }}
                  >
                    <Row
                      leading={<IconTile icon={LayoutGrid} color={colors.info} />}
                      title={spaceTitle(one)}
                      subtitle={spaceRowLine(one)}
                      chevron
                      onPress={() => openSpace(one.id)}
                    />
                  </HoldMenu>
                ))}
              </Group>
            </View>
          )}

          {mine.length > 0 && (
            <View style={{ gap: space.lg }}>
              {spacesOn && <Label>Panels</Label>}
              {mine.map((panel) => {
                const bot = allBots.find((one) => one.id === panel.botId);
                const home = spacesOn ? spaces.find((one) => one.id === panel.spaceId) : undefined;
                return home ? (
                  <SpacePanelCard key={panel.id} panel={panel} bot={bot} changed={false} half={false} space={home} />
                ) : (
                  <PanelCard key={panel.id} panel={panel as Panel} bot={bot} />
                );
              })}
            </View>
          )}
        </View>
      )}
    </Page>
  );
}

export default function ProjectSpacesPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useApp((state) => state.parts.projects?.find((item) => item.id === id));
  const synced = useApp((state) => state.synced);
  if (!project) {
    return (
      <Page>
        {synced ? <EmptyState title="This project is gone" action="Go back" onAction={() => router.back()} /> : <Loading />}
      </Page>
    );
  }
  return <ProjectSpacesContent project={project} />;
}
