import { type Href, router, Stack, useLocalSearchParams } from "expo-router";
import { MenuView } from "@react-native-menu/menu";
import { Check, ChevronDown, ChevronUp, FolderMinus, FolderOpen, MessagesSquare, Paperclip, Plus, Trash2 } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, TextInput, type TextInputInstance, View } from "react-native";
import { openSpace, useSpaces, useSpacesOn } from "@/features/spaces/data";
import { rowLine as spaceRowLine, spaceTitle } from "@/features/spaces/logic";
import { PanelCard as SpacePanelCard } from "@/features/spaces/SpaceView";
import { PanelCard } from "@/features/today/Today";
import { ArtifactRow } from "@/features/artifacts/ArtifactBits";
import type { Artifact, ChatMode, Panel, Project, ProjectColor, ProjectTodo } from "@/link/types";
import { useBots, useCapability, useChats, useOnline, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { ago } from "@/state/time";
import { BotAvatar, Button, Chip, EmptyState, Field, Group, HoldMenu, IconButton, IconTile, Label, Loading, Page, Row, Segmented, space, T, Tap, useTheme } from "@/ui";
import { PROJECT_COLORS, projectColor } from "./colors";
import { canUseProject, globalAccess, grantOf, toggleProject } from "@/features/bots/projectAccess";
import { ACCESS_REASON, accessVia, artifactCount, MODES, moveSteps, orderedTodos } from "./logic";

export default function ProjectPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useApp((state) => state.parts.projects?.find((item) => item.id === id));
  const synced = useApp((state) => state.synced);
  if (!project)
    return <Page>{synced ? <EmptyState title="This project is gone" action="Go back" onAction={() => router.back()} /> : <Loading />}</Page>;
  return <ProjectDetail project={project} />;
}

function BarButton({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Tap onPress={onPress} feel="select" accessibilityLabel={title} style={{ minWidth: 44, height: 44, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" }}>
      <T variant="headline" color="accentText">
        {title}
      </T>
    </Tap>
  );
}

function ProjectDetail({ project }: { project: Project }) {
  const theme = useTheme();
  const [editing, setEditing] = useState(false);
  const color = projectColor(project.color, theme);
  return (
    <Page title={editing ? undefined : project.name} caption={editing ? undefined : project.description} keyboard>
      <Stack.Screen options={{ headerRight: () => <BarButton title={editing ? "Cancel" : "Edit"} onPress={() => setEditing(!editing)} /> }} />
      {editing ? (
        <EditProject project={project} onDone={() => setEditing(false)} />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: -space.sm }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
          <T variant="footnote" color="muted">
            {"Used " + ago(project.lastUsed)}
          </T>
        </View>
      )}
      <Todos project={project} />
      <Chats project={project} />
      <Artifacts project={project} />
      <Panels project={project} />
      <Access project={project} />
      <Folder project={project} />
      <Group>
        <Row leading={<IconTile icon={Trash2} color={theme.colors.danger} />} title="Delete project" tone="danger" onPress={() => remove(project)} />
      </Group>
    </Page>
  );
}

function remove(project: Project) {
  Alert.alert("Delete " + project.name + "?", "Its chats are kept.", [
    { text: "Cancel", style: "cancel" },
    {
      text: "Delete",
      style: "destructive",
      onPress: () => {
        router.back();
        void attempt(api.removeProject(project.id), "Project deleted");
      },
    },
  ]);
}

// Editing

function EditProject({ project, onDone }: { project: Project; onDone: () => void }) {
  const theme = useTheme();
  const { colors } = theme;
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [color, setColor] = useState<ProjectColor>(project.color ?? "gray");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const ok = await attempt(api.updateProject(project.id, { name: name.trim(), description: description.trim(), color }).then(() => true), "Saved");
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <View style={{ gap: space.lg }}>
      <Field label="Name" value={name} onChangeText={setName} maxLength={80} autoFocus returnKeyType="next" />
      <Field label="Description" placeholder="What it's about" value={description} onChangeText={setDescription} maxLength={200} />
      <View>
        <Label>Color</Label>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }} accessibilityRole="radiogroup">
          {PROJECT_COLORS.map((option) => {
            const on = option.value === color;
            const fill = projectColor(option.value, theme);
            return (
              <Tap
                key={option.value}
                onPress={() => setColor(option.value)}
                feel="select"
                sink={0.9}
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityState={{ selected: on }}
                style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: on ? colors.ink : "transparent" }}
              >
                <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: fill, alignItems: "center", justifyContent: "center" }}>{on && <Check size={16} color={colors.onPrimary} strokeWidth={3} />}</View>
              </Tap>
            );
          })}
        </View>
      </View>
      <Button title="Save" wide onPress={() => void save()} loading={busy} disabled={!name.trim()} />
    </View>
  );
}

// To-dos

/** Moves an open to-do past the next open one, as the computer does: one place at a time, over done ones. */
async function move(project: Project, todo: ProjectTodo, delta: -1 | 1) {
  const steps = moveSteps(project.todos, todo.id, delta);
  await attempt(
    (async () => {
      for (let step = 0; step < steps; step++) await api.moveTodo(project.id, todo.id, delta);
    })(),
  );
}

function TodoRow({ project, todo, first, last }: { project: Project; todo: ProjectTodo; first: boolean; last: boolean }) {
  const { colors, dark, type } = useTheme();
  const [editing, setEditing] = useState<string | null>(null);
  const toggle = () => void attempt(api.updateTodo(project.id, todo.id, { done: !todo.done }));
  const rename = () => {
    const clean = editing?.trim();
    setEditing(null);
    if (clean && clean !== todo.text) void attempt(api.updateTodo(project.id, todo.id, { text: clean }));
  };
  const remove = () =>
    Alert.alert("Delete this to-do?", todo.text, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void attempt(api.deleteTodo(project.id, todo.id)) },
    ]);
  const actions = [
    { id: "rename", title: "Rename", image: "pencil" },
    ...(todo.done
      ? []
      : [
          { id: "up", title: "Move up", image: "arrow.up", attributes: { disabled: first } },
          { id: "down", title: "Move down", image: "arrow.down", attributes: { disabled: last } },
        ]),
    { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
  ];
  return (
    <HoldMenu
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        const action = nativeEvent.event;
        if (action === "rename") setEditing(todo.text);
        else if (action === "up" || action === "down") void move(project, todo, action === "up" ? -1 : 1);
        else if (action === "delete") remove();
      }}
    >
      <View style={{ minHeight: 52, flexDirection: "row", alignItems: "center", paddingLeft: space.sm, paddingRight: space.xs, gap: space.sm }}>
        <Tap onPress={toggle} feel="select" sink={0.9} hitSlop={0} accessibilityRole="checkbox" accessibilityState={{ checked: todo.done }} accessibilityLabel={(todo.done ? "Reopen " : "Check off ") + todo.text} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: todo.done ? colors.success : colors.lineStrong, backgroundColor: todo.done ? colors.success : "transparent", alignItems: "center", justifyContent: "center" }}>
            {todo.done && <Check size={14} color={colors.surface} strokeWidth={3} />}
          </View>
        </Tap>
        {editing !== null ? (
          <TextInput
            value={editing}
            onChangeText={setEditing}
            autoFocus
            maxLength={500}
            keyboardAppearance={dark ? "dark" : "light"}
            selectionColor={colors.accent}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            onSubmitEditing={rename}
            onBlur={rename}
            maxFontSizeMultiplier={1.3}
            accessibilityLabel="To-do text"
            style={[type.callout, { flex: 1, minHeight: 44, color: colors.ink, paddingVertical: 0 }]}
          />
        ) : (
          <Tap onPress={() => setEditing(todo.text)} feel="select" sink={1} hitSlop={0} accessibilityLabel={todo.text} accessibilityHint="Renames it. Hold for more." style={{ flex: 1, minHeight: 44, justifyContent: "center" }}>
            <T variant="callout" color={todo.done ? "muted" : "ink"} style={[{ paddingVertical: space.sm }, todo.done && { textDecorationLine: "line-through" }]}>
              {todo.text}
            </T>
          </Tap>
        )}
        <IconButton icon={Trash2} label={"Delete " + todo.text} size={44} color={colors.faint} onPress={remove} />
      </View>
    </HoldMenu>
  );
}

function AddTodo({ projectId }: { projectId: string }) {
  const { colors, dark, type } = useTheme();
  const [text, setText] = useState("");
  const input = useRef<TextInputInstance>(null);
  const add = () => {
    const clean = text.trim();
    if (!clean) return;
    setText("");
    void attempt(api.addTodo(projectId, clean));
    input.current?.focus();
  };
  return (
    <View style={{ minHeight: 52, flexDirection: "row", alignItems: "center", paddingLeft: space.sm, paddingRight: space.lg, gap: space.sm }}>
      <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
        <Plus size={20} color={colors.accentText} strokeWidth={2.4} />
      </View>
      <TextInput
        ref={input}
        value={text}
        onChangeText={setText}
        placeholder="Add a to-do"
        placeholderTextColor={colors.faint}
        keyboardAppearance={dark ? "dark" : "light"}
        selectionColor={colors.accent}
        returnKeyType="done"
        submitBehavior="submit"
        onSubmitEditing={add}
        maxLength={500}
        maxFontSizeMultiplier={1.3}
        accessibilityLabel="Add a to-do"
        style={[type.callout, { flex: 1, minHeight: 44, color: colors.ink, paddingVertical: 0 }]}
      />
    </View>
  );
}

function Todos({ project }: { project: Project }) {
  const { colors } = useTheme();
  const { open, done } = useMemo(() => orderedTodos(project.todos), [project.todos]);
  const [showDone, setShowDone] = useState(true);
  const DoneIcon = showDone ? ChevronUp : ChevronDown;
  return (
    <View>
      <Label>To-do</Label>
      <Group>
        {open.map((todo, index) => (
          <TodoRow key={todo.id} project={project} todo={todo} first={index === 0} last={index === open.length - 1} />
        ))}
        <AddTodo key="add" projectId={project.id} />
        {done.length > 0 && <Row key="done" title={"Done · " + done.length} tone="accent" onPress={() => setShowDone(!showDone)} trailing={<DoneIcon size={18} color={colors.faint} strokeWidth={2.2} />} />}
        {showDone ? done.map((todo) => <TodoRow key={todo.id} project={project} todo={todo} first last />) : []}
      </Group>
    </View>
  );
}

// Chats

function Chats({ project }: { project: Project }) {
  const chats = useChats();
  const allBots = useBots();
  const bots = useMemo(() => new Map(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const settings = usePart("settings");
  const visible = useMemo(() => allBots.filter((bot) => !bot.hidden || canUseProject(settings, bot, project)), [allBots, settings, project]);
  // A bot without access to the project can't chat in it; the computer would refuse.
  const shown = visible.filter((bot) => canUseProject(settings, bot, project));
  const blocked = visible.filter((bot) => !canUseProject(settings, bot, project));
  const mine = useMemo(() => chats.filter((chat) => chat.projectId === project.id && !chat.archived).sort((a, b) => b.time - a.time), [chats, project.id]);
  const [starting, setStarting] = useState<string | null>(null);
  const [mode, setMode] = useState<ChatMode>("default");
  const start = async (botId: string) => {
    if (starting) return;
    setStarting(botId);
    const id = await attempt(api.startProjectChat([botId], project.id, project.folder ? mode : "default"));
    setStarting(null);
    if (id) router.push({ pathname: "/chat/[id]", params: { id } });
  };
  return (
    <View style={{ gap: space.md }}>
      <View>
        <Label>Chats</Label>
        {mine.length > 0 && (
          <Group>
            {mine.map((chat) => {
              const bot = bots.get(chat.botId);
              return (
                <HoldMenu
                  key={chat.id}
                  actions={[{ id: "remove", title: "Remove from project", image: "folder.badge.minus" }]}
                  onPressAction={({ nativeEvent }) => {
                    // The computer says why when a chat can't leave (it started in the project's folder).
                    if (nativeEvent.event === "remove") void attempt(api.setChatProject(chat.id, null), "Removed from " + project.name);
                  }}
                >
                  <Row
                    leading={<BotAvatar bot={bot ?? { id: chat.botId }} size={36} badge={false} />}
                    title={chat.title || bot?.name || "Chat"}
                    subtitle={bot?.name}
                    value={ago(chat.time)}
                    chevron
                    onPress={() => router.push({ pathname: "/chat/[id]", params: { id: chat.id } })}
                  />
                </HoldMenu>
              );
            })}
          </Group>
        )}
      </View>
      <Button title="Add a chat…" icon={MessagesSquare} variant="secondary" wide onPress={() => router.push({ pathname: "/projects/add-chats", params: { id: project.id } })} />
      {!!project.folder && shown.length > 0 && (
        <View style={{ gap: space.sm }}>
          <Segmented options={MODES} value={mode} onChange={setMode} />
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
            {MODES.find((item) => item.value === mode)!.hint}
          </T>
        </View>
      )}
      {blocked.length > 0 && (
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
          {"No access to this project: " + blocked.map((bot) => bot.name).join(", ")}
        </T>
      )}
      {shown.length > 0 && (
        <View style={{ gap: space.sm }}>
          <T variant="footnote" weight="600" color="muted" style={{ paddingHorizontal: space.xs }}>
            New chat with
          </T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.xl }} contentContainerStyle={{ paddingHorizontal: space.xl, gap: space.sm }}>
            {shown.map((bot) => (
              <Chip key={bot.id} label={bot.name} selected={starting === bot.id} onPress={() => void start(bot.id)} leading={<BotAvatar bot={bot} size={24} badge={false} style={{ marginLeft: -8 }} />} />
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

// Artifacts

/**
 * The artifacts attached to the project ("project-artifacts-v1"): files its bots made or were
 * given, kept in one place. The list is read again when the project's ids change.
 */
function Artifacts({ project }: { project: Project }) {
  const capable = useCapability("project-artifacts-v1");
  const online = useOnline();
  const ids = (project.artifacts ?? []).join(" ");
  const [items, setItems] = useState<Artifact[]>();
  useEffect(() => {
    if (!capable || !online) return;
    let live = true;
    api.projectArtifacts(project.id).then(
      (answer) => live && setItems(answer.items),
      () => live && setItems((held) => held ?? []),
    );
    return () => {
      live = false;
    };
  }, [capable, online, project.id, ids]);
  if (!capable) return null;
  const count = project.artifacts?.length ?? 0;
  return (
    <View style={{ gap: space.md }}>
      <View>
        <Label>Artifacts</Label>
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginBottom: space.sm }}>
          {artifactCount(count)}
        </T>
        {!!items?.length && (
          <Group>
            {items.map((artifact) => (
              <HoldMenu
                key={artifact.id}
                actions={[
                  ...(artifact.chatId ? [{ id: "chat", title: "Go to chat", image: "bubble.left" }] : []),
                  { id: "remove", title: "Remove from project", image: "minus.circle", attributes: { destructive: true } },
                ]}
                onPressAction={({ nativeEvent }) => {
                  if (nativeEvent.event === "chat" && artifact.chatId) router.push({ pathname: "/chat/[id]", params: { id: artifact.chatId, ...(artifact.messageIndex !== undefined && { at: String(artifact.messageIndex) }) } });
                  else if (nativeEvent.event === "remove") void attempt(api.removeProjectArtifact(project.id, artifact.id), "Removed from " + project.name);
                }}
              >
                <ArtifactRow artifact={artifact} />
              </HoldMenu>
            ))}
          </Group>
        )}
      </View>
      <Button title="Attach an artifact…" icon={Paperclip} variant="secondary" wide onPress={() => router.push({ pathname: "/projects/attach", params: { id: project.id } })} />
    </View>
  );
}

// Panels

/**
 * The project's panels. Without spaces they are Today's, each changed from its menu there. With
 * spaces ("spaces-v1") a whole space can belong to a project, beside single panels in any space:
 * the computer names every panel that has a project (`projectPanels`), and each opens in its space.
 */
function Panels({ project }: { project: Project }) {
  const { colors } = useTheme();
  const todays = usePart("panels");
  const everywhere = usePart("projectPanels");
  const allBots = useBots();
  const spacesOn = useSpacesOn();
  const spaces = useSpaces();
  const mine = useMemo(() => ((spacesOn && everywhere) || todays || []).filter((panel) => panel.projectId === project.id), [spacesOn, everywhere, todays, project.id]);
  const attached = spaces.filter((one) => one.projectId === project.id);
  const free = spaces.filter((one) => one.mine && !one.projectId);
  return (
    <View>
      <Label>{spacesOn ? "Spaces and panels" : "Panels"}</Label>
      {spacesOn && (
        <Group>
          {attached.map((one) => (
            <Row
              key={one.id}
              title={spaceTitle(one)}
              subtitle={spaceRowLine(one)}
              onPress={() => openSpace(one.id)}
              trailing={<Button title="Remove" variant="ghost" size="sm" onPress={() => void attempt(api["spaces.setProject"](one.id, null))} accessibilityLabel={"Remove " + spaceTitle(one) + " from this project"} />}
            />
          ))}
          <MenuView title="Attach a space" actions={free.length ? free.map((one) => ({ id: one.id, title: spaceTitle(one) })) : [{ id: "", title: "No space to attach", attributes: { disabled: true } }]} onPressAction={({ nativeEvent }) => nativeEvent.event && void attempt(api["spaces.setProject"](nativeEvent.event, project.id))}>
            <Row title="Attach" tone="accent" trailing={<ChevronDown size={18} color={colors.faint} strokeWidth={2.2} />} />
          </MenuView>
        </Group>
      )}
      {mine.length ? (
        <View style={{ gap: space.lg, marginTop: spacesOn ? space.lg : 0 }}>
          {mine.map((panel) => {
            const bot = allBots.find((one) => one.id === panel.botId);
            const home = spacesOn ? spaces.find((one) => one.id === panel.spaceId) : undefined;
            return home ? <SpacePanelCard key={panel.id} panel={panel} bot={bot} changed={false} half={false} space={home} /> : <PanelCard key={panel.id} panel={panel as Panel} bot={bot} />;
          })}
        </View>
      ) : spacesOn ? null : (
        <T variant="subhead" color="muted" style={{ paddingHorizontal: space.xs }}>
          Ask a bot in one of this project's chats for a Today panel.
        </T>
      )}
    </View>
  );
}

// Access

/** Which bots may chat in the project and keep its to-do list (the computer's Access section). */
function Access({ project }: { project: Project }) {
  const settings = usePart("settings");
  const bots = useBots();
  const everyone = globalAccess(settings);
  return (
    <View>
      <Label>Access</Label>
      <Group>
        {bots.map((bot) => {
          const via = accessVia(settings, bot, project);
          const locked = via === "everyone" || via === "all";
          return (
            <Row
              key={bot.id}
              leading={<BotAvatar bot={bot} size={32} badge={false} />}
              title={bot.name}
              subtitle={ACCESS_REASON[via]}
              toggled={!!via}
              disabled={locked}
              onToggle={(on) => void attempt(api.setBotAccess(bot.id, toggleProject(grantOf(bot), project.id, on)))}
            />
          );
        })}
      </Group>
      <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
        {everyone ? "All bots can use every project. Change it in Settings › Access." : "Bots with access can chat in this project and keep its to-do list."}
      </T>
    </View>
  );
}

// Folder

/** The folder chats in the project run in. A phone can remove it; choosing one needs the computer's own dialog. */
function Folder({ project }: { project: Project }) {
  const { colors } = useTheme();
  const path = project.folder;
  const canFolders = useCapability("folders-v1");
  const pickFolder = () => router.push({ pathname: "/folders", params: { use: "project", id: project.id } } as unknown as Href);
  const remove = () =>
    Alert.alert("Remove the folder from " + project.name + "?", "Chats here lose the coding modes. Nothing in the folder is touched.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove folder", style: "destructive", onPress: () => void attempt(api.updateProject(project.id, { folder: null }), "Folder removed") },
    ]);
  return (
    <View>
      <Label>Folder</Label>
      {path ? (
        <Group>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md }} accessible accessibilityLabel={"Folder on your computer, " + path}>
            <FolderOpen size={18} color={colors.muted} strokeWidth={2.2} />
            <T variant="mono" color="ink2" numberOfLines={2} ellipsizeMode="middle" style={{ flex: 1 }}>
              {path}
            </T>
          </View>
          {canFolders && <Row leading={<IconTile icon={FolderOpen} color={colors.ink2} />} title="Change folder…" onPress={pickFolder} />}
          <Row leading={<IconTile icon={FolderMinus} color={colors.ink2} />} title="Remove folder" onPress={remove} />
        </Group>
      ) : (
        <Group>
          {canFolders ? (
            <Row leading={<IconTile icon={FolderOpen} color={colors.ink2} />} title="Choose folder…" subtitle="For coding modes and changes" onPress={pickFolder} />
          ) : (
            <Row leading={<IconTile icon={FolderOpen} color={colors.ink2} />} title="No folder" subtitle="Update the app on your computer to choose one here" subtitleLines={2} />
          )}
        </Group>
      )}
    </View>
  );
}
