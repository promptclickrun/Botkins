// The workflow designer: the route `/workflow/[id]` ("new" makes one first).
// Design shows one column of steps on a phone held upright, and the canvas on a tablet or in landscape; Runs lists recent runs.
// Edits stay in a draft until Save; leaving with changes asks first.
import * as ScreenOrientation from "expo-screen-orientation";
import { router, Stack, usePreventRemove } from "expo-router";
import { HeaderHeightContext } from "expo-router/react-navigation";
import { MenuView } from "@react-native-menu/menu";
import { CornerDownRight, Ellipsis, LayoutGrid, List, Play, Plus, TriangleAlert } from "lucide-react-native";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Modal, Platform, ScrollView, Switch, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { openChat } from "@/features/chat/navigate";
import type { Workflow, WorkflowNode, WorkflowTriggerKind } from "@/link/types";
import { useBots, useCan, useWorkflowRuns, useWorkflows } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { BackdropLayer, Button, EmptyState, Group, haptic, IconButton, Label, Loading, radius, Row, Segmented, Sheet, space, switchColors, T, Tap, tint, useShape, useTheme, useTextPrompt } from "@/ui";
import { Canvas } from "./Canvas";
import { analyzeWorkflowFields } from "./fields";
import {
  addTrigger,
  BRANCH_LABEL,
  type Branch,
  canRemove,
  flowFrom,
  type FlowItem,
  type Graph,
  insertStep,
  KIND_HINT,
  KIND_LABEL,
  moveNode,
  needsTidy,
  newId,
  newStep,
  newTrigger,
  orphans,
  removeStep,
  starter,
  STEP_KINDS,
  type StepKind,
  summary,
  tidy,
  TRIGGER_KINDS,
  TRIGGER_LABEL,
  updateNode,
} from "./graph";
import { iconFor, TRIGGER_ICON, useKindColor } from "./parts";
import { RunsView } from "./Runs";
import { StepSheet } from "./StepSheet";

type View_ = "flow" | "canvas";
type Adding = { from: string; branch: Branch } | { trigger: true } | null;

const sameGraph = (a: Graph, b: Graph) => JSON.stringify(a) === JSON.stringify(b);
const graphOf = (w: Workflow): Graph => ({ nodes: w.nodes, edges: w.edges });

export function WorkflowDesigner({ id }: { id: string }) {
  if (id === "new") return <NewWorkflow />;
  return <Designer id={id} />;
}

/** Makes a workflow that runs by hand and posts to a chat, then opens it in place of this screen. */
function NewWorkflow() {
  const canCreate = useCan("today", "create");
  const [failed, setFailed] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (!canCreate || started.current) return;
    started.current = true;
    let live = true;
    void attempt(api.workflowCreate({ name: "New workflow", enabled: true, ...starter() })).then((made) => {
      if (!live) return;
      if (made) router.replace({ pathname: "/workflow/[id]", params: { id: made.id } });
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [canCreate]);
  if (!canCreate || failed) return <EmptyState title={canCreate ? "Couldn't make the workflow" : "You can't make workflows"} action="Back" onAction={() => router.back()} />;
  return <Loading />;
}

function Designer({ id }: { id: string }) {
  const { colors } = useTheme();
  const workflows = useWorkflows();
  const workflow = workflows.find((w) => w.id === id);
  const runs = useWorkflowRuns(id);
  const bots = useBots();
  const canEdit = useCan("today", "manage");
  const canCreate = useCan("today", "create");
  const canDelete = useCan("today", "delete");
  const canUse = useCan("today", "use");
  const shape = useShape();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const insets = useSafeAreaInsets();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const backdrop = usePrefs((prefs) => prefs.backdrop);
  const hasBackdrop = backdrop !== "clean";
  const prompt = useTextPrompt();

  const [tab, setTab] = useState<"design" | "runs">("design");
  // A tablet, or any phone on its side, opens on the canvas; a phone held upright on the list.
  const roomy = shape.wide || landscape;
  const [chosen, setChosen] = useState<View_ | null>(null);
  const view: View_ = chosen ?? (roomy ? "canvas" : "flow");
  const [draft, setDraft] = useState<Graph | null>(null);
  const [base, setBase] = useState<Graph | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<Adding>(null);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Set once the person chose to leave: the guard below lets go, then this goes back.
  const [exit, setExit] = useState(false);
  useEffect(() => {
    if (exit) router.back();
  }, [exit]);

  // The draft starts from what the computer has; when the computer's copy changes and nothing is edited, follow it.
  useEffect(() => {
    if (!workflow) return;
    const theirs = graphOf(workflow);
    if (!draft || (base && sameGraph(draft, base))) {
      const laid = needsTidy(theirs) ? tidy(theirs, "across") : theirs;
      setDraft(laid);
      setBase(laid);
    }
  }, [workflow?.updatedAt]);

  // The canvas can turn with the device, even where the rest of the app is held upright.
  useEffect(() => {
    if (tab !== "design" || view !== "canvas") return;
    let showing = true;
    let previous: ScreenOrientation.OrientationLock | undefined;
    const unlock = ScreenOrientation.getOrientationLockAsync()
      .then((lock) => {
        previous = lock;
        if (showing) return ScreenOrientation.unlockAsync();
      })
      .catch(() => {});
    return () => {
      showing = false;
      void unlock
        .then(() => (previous !== undefined && previous !== ScreenOrientation.OrientationLock.DEFAULT ? ScreenOrientation.lockAsync(previous) : undefined))
        .catch(() => {});
    };
  }, [tab, view]);

  const dirty = !!draft && !!base && !sameGraph(draft, base) && !leaving && !exit;
  usePreventRemove(dirty, ({ repeat }) =>
    Alert.alert("Save your changes?", "This workflow has edits that aren't saved.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: repeat },
      { text: "Save", onPress: () => void save().then((ok) => ok && setExit(true)) },
    ]),
  );

  const analysis = useMemo(() => (workflow && draft ? analyzeWorkflowFields({ ...workflow, ...draft }) : {}), [workflow, draft]);
  const issues = useMemo(() => {
    if (!draft) return [];
    const out: { nodeId: string; text: string }[] = [];
    for (const n of draft.nodes) {
      for (const p of analysis[n.id]?.problems ?? []) out.push({ nodeId: n.id, text: `${n.label}: ${p.message}` });
      if (n.kind === "output" && !String(n.config?.template ?? "").trim()) out.push({ nodeId: n.id, text: `${n.label}: the message is empty, so the run fails here.` });
      if (n.kind === "agent" && !n.config?.botId && !n.config?.botName) out.push({ nodeId: n.id, text: `${n.label}: choose a bot.` });
      if (n.kind === "agent" && !String(n.config?.prompt ?? "").trim()) out.push({ nodeId: n.id, text: `${n.label}: write a prompt.` });
    }
    for (const n of orphans(draft)) out.push({ nodeId: n.id, text: `${n.label}: no step leads here, so it never runs.` });
    return out;
  }, [draft, analysis]);

  if (!workflow) return <EmptyState title="Workflow not found" text="It may have been deleted on the computer." action="Back" onAction={() => router.back()} />;
  if (!draft) return <Loading />;

  const botName = (botId?: string, name?: string) => (botId ? bots.find((b) => b.id === botId)?.name : undefined) ?? name;
  const editable = canEdit;
  const change = (next: Graph) => setDraft(next);

  async function save(): Promise<boolean> {
    if (!draft || !workflow) return false;
    setSaving(true);
    try {
      const saved = await attempt(api.workflowUpdate(workflow.id, { nodes: draft.nodes, edges: draft.edges }), "Workflow saved");
      if (!saved) return false;
      haptic.success();
      const laid = needsTidy(graphOf(saved)) ? tidy(graphOf(saved), "across") : graphOf(saved);
      setDraft(laid);
      setBase(laid);
      return true;
    } finally {
      setSaving(false);
    }
  }

  const add = (kind: StepKind) => {
    if (!adding || "trigger" in adding) return;
    const step = newStep(kind, newId(kind, draft.nodes.map((n) => n.id)));
    change(insertStep(draft, adding.from, adding.branch, step));
    setAdding(null);
    setTimeout(() => setEditing(step.id), 350);
  };
  const addTriggerOf = (kind: WorkflowTriggerKind) => {
    const t = newTrigger(kind, newId("trigger", draft.nodes.map((n) => n.id)));
    change(addTrigger(draft, t));
    setAdding(null);
    setTimeout(() => setEditing(t.id), 350);
  };

  const askAlfie = () => {
    const bot = bots.find((b) => b.name.toLowerCase() === "alfie") ?? bots[0];
    if (!bot) return;
    void attempt(api.mainChat(bot.id)).then((chatId) => {
      if (chatId) openChat(chatId, { draft: `Change my workflow "${workflow.name}" (id ${workflow.id}): ` });
    });
  };

  const more = [
    ...(canEdit ? [{ id: "rename", title: "Rename", image: "pencil" }] : []),
    ...(canCreate ? [{ id: "duplicate", title: "Duplicate", image: "plus.square.on.square" }] : []),
    ...(bots.length ? [{ id: "ask", title: "Ask a bot to change it", image: "sparkles" }] : []),
    ...(canDelete ? [{ id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } }] : []),
  ];
  const onMore = (action: string) => {
    if (action === "rename")
      prompt.ask({
        title: "Rename workflow",
        value: workflow.name,
        max: 80,
        onSubmit: (name) => void attempt(api.workflowUpdate(workflow.id, { name }), "Renamed"),
      });
    else if (action === "duplicate")
      void attempt(api.workflowCreate({ name: `${workflow.name} copy`.slice(0, 80), description: workflow.description, enabled: false, nodes: draft.nodes, edges: draft.edges }), "Duplicated, paused").then((made) => {
        if (made) router.push({ pathname: "/workflow/[id]", params: { id: made.id } });
      });
    else if (action === "ask") askAlfie();
    else if (action === "delete")
      Alert.alert(`Delete ${workflow.name}?`, "Its run history goes too.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            void attempt(api.workflowDelete(workflow.id), "Workflow deleted").then((ok) => {
              if (!ok) return;
              setLeaving(true);
              setTimeout(() => router.back(), 0);
            }),
        },
      ]);
  };

  const triggers = draft.nodes.filter((n) => n.kind === "trigger");
  const editingNode = editing ? draft.nodes.find((n) => n.id === editing) ?? null : null;
  const topPad = hasBackdrop && Platform.OS === "ios" ? headerHeight : 0;
  const sidePad = { paddingLeft: space.lg + (shape.wide ? 0 : insets.left), paddingRight: space.lg + (shape.wide ? 0 : insets.right) };

  const headerRight = () => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      {dirty && editable && <Button title="Save" size="sm" loading={saving} onPress={() => void save()} />}
      {more.length > 0 && (
        <MenuView title={workflow.name} actions={more} onPressAction={({ nativeEvent }) => onMore(nativeEvent.event)}>
          <View accessible accessibilityRole="button" accessibilityLabel="More" style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}>
            <Ellipsis size={22} color={colors.ink} />
          </View>
        </MenuView>
      )}
    </View>
  );

  const toolbar = (
    <View style={[{ paddingTop: topPad + space.sm, paddingBottom: space.sm, gap: space.sm }, sidePad]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <T variant="title1" weight="700" numberOfLines={1} style={{ flex: 1 }} accessibilityRole="header">
          {workflow.name}
        </T>
        {tab === "design" && (
          <IconButton
            icon={view === "canvas" ? List : LayoutGrid}
            label={view === "canvas" ? "Show as a list" : "Show on a canvas"}
            variant="soft"
            size={36}
            onPress={() => {
              haptic.select();
              setChosen(view === "canvas" ? "flow" : "canvas");
            }}
          />
        )}
      </View>
      <Segmented options={[{ value: "design", label: "Design" }, { value: "runs", label: runs.length ? `Runs · ${runs.length}` : "Runs" }]} value={tab} onChange={setTab} />
    </View>
  );

  const footer = tab === "design" && (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: space.md, paddingTop: space.sm, paddingBottom: Math.max(insets.bottom, space.md), borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: hasBackdrop ? tint(colors.surface, 0.92) : colors.surface }, sidePad]}>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Switch
          value={workflow.enabled}
          disabled={!canEdit}
          onValueChange={(next) => {
            haptic.select();
            void attempt(next ? api.workflowResume(workflow.id) : api.workflowPause(workflow.id), next ? "Workflow on" : "Workflow paused");
          }}
          {...switchColors(colors, workflow.enabled)}
          accessibilityLabel={workflow.enabled ? "On" : "Paused"}
        />
        <T variant="footnote" color="muted" numberOfLines={2} style={{ flex: 1 }}>
          {workflow.enabled ? "On: triggers start runs" : "Paused: only Run now works"}
        </T>
      </View>
      {canUse && (
        <Button
          title="Run now"
          icon={Play}
          size="md"
          disabled={dirty}
          onPress={() =>
            void attempt(api.workflowRun(workflow.id), "Workflow started").then((run) => {
              if (run) setTab("runs");
            })
          }
        />
      )}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: hasBackdrop ? "transparent" : colors.canvas }}>
      {hasBackdrop && <BackdropLayer backdrop={backdrop} />}
      <Stack.Screen options={{ headerRight }} />
      {toolbar}
      {tab === "runs" ? (
        <RunsView workflow={workflow} runs={runs} nodes={draft.nodes} canUse={canUse} />
      ) : view === "canvas" ? (
        <Canvas
          graph={draft}
          analysis={analysis}
          direction={landscape || shape.wide ? "across" : "down"}
          botName={botName}
          editable={editable}
          onOpen={setEditing}
          onAdd={(from, branch) => setAdding({ from, branch })}
          onMove={(nodeId, position) => change(moveNode(draft, nodeId, position))}
          onTidy={() => change(tidy(draft, landscape || shape.wide ? "across" : "down"))}
        />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={[{ paddingTop: space.sm, paddingBottom: space.xxl, gap: space.md }, sidePad, { maxWidth: 720, width: "100%", alignSelf: "center" }]}>
          {issues.length > 0 && <Issues issues={issues} onOpen={setEditing} />}
          <Label>{triggers.length > 1 ? "Starts when any of these happen" : "Starts when"}</Label>
          {triggers.map((t) => (
            <StepCard key={t.id} node={t} caption={summary(t, botName)} problems={0} onPress={() => setEditing(t.id)} />
          ))}
          {editable && (
            <Tap onPress={() => setAdding({ trigger: true })} accessibilityRole="button" style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: space.xs, paddingVertical: space.xs }}>
              <Plus size={14} color={colors.accentText} />
              <T variant="footnote" color="accentText" weight="600">
                Add another trigger
              </T>
            </Tap>
          )}
          {triggers[0] && <Flow items={flowFrom(draft, triggers[0].id, "default")} graph={draft} analysis={analysis} botName={botName} editable={editable} onOpen={setEditing} onAdd={(from, branch) => setAdding({ from, branch })} />}
          {orphans(draft).length > 0 && (
            <>
              <Label>Not connected</Label>
              {orphans(draft).map((n) => (
                <StepCard key={n.id} node={n} caption={summary(n, botName)} problems={1} onPress={() => setEditing(n.id)} />
              ))}
            </>
          )}
        </ScrollView>
      )}
      {footer}
      <StepSheet
        node={editingNode}
        analysis={editingNode ? analysis[editingNode.id] : undefined}
        canRemove={!!editingNode && editable && canRemove(draft, editingNode.id)}
        onChange={(next: WorkflowNode) => change(updateNode(draft, next.id, next))}
        onRemove={() => editing && change(removeStep(draft, editing))}
        onClose={() => setEditing(null)}
      />
      <AddSheet adding={adding} onStep={add} onTrigger={addTriggerOf} onClose={() => setAdding(null)} />
      {prompt.node}
    </View>
  );
}

function Issues({ issues, onOpen }: { issues: { nodeId: string; text: string }[]; onOpen: (id: string) => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ borderRadius: radius.md, padding: space.md, gap: space.xs, backgroundColor: colors.warningSoft }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <TriangleAlert size={16} color={colors.warning} />
        <T variant="callout" weight="700">
          {issues.length === 1 ? "1 thing to fix" : `${issues.length} things to fix`}
        </T>
      </View>
      {issues.slice(0, 5).map((i, n) => (
        <Tap key={n} onPress={() => onOpen(i.nodeId)} accessibilityRole="button">
          <T variant="footnote" numberOfLines={2}>
            {"· " + i.text}
          </T>
        </Tap>
      ))}
    </View>
  );
}

function StepCard({ node, caption, problems, onPress }: { node: WorkflowNode; caption: string; problems: number; onPress: () => void }) {
  const { colors } = useTheme();
  const kindColor = useKindColor();
  const color = kindColor(node.kind);
  const Icon = iconFor(node);
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${node.label}. ${caption}${problems ? ". Needs a fix" : ""}`}
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: problems ? colors.warning : colors.line }}
    >
      <View style={{ width: 38, height: 38, borderRadius: 11, backgroundColor: tint(color, 0.18), alignItems: "center", justifyContent: "center" }}>
        <Icon size={19} color={color} strokeWidth={2.2} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="caption" color="muted" weight="600">
          {node.kind === "trigger" ? "Trigger" : KIND_LABEL[node.kind]}
        </T>
        <T variant="callout" weight="700" numberOfLines={1}>
          {node.label}
        </T>
        <T variant="footnote" color="muted" numberOfLines={2}>
          {caption}
        </T>
      </View>
      {problems > 0 && <TriangleAlert size={16} color={colors.warning} />}
    </Tap>
  );
}

function Connector({ onAdd, label }: { onAdd?: () => void; label?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: "center", gap: 2 }}>
      <View style={{ width: 2, height: 10, backgroundColor: colors.lineStrong }} />
      {onAdd ? (
        <Tap onPress={onAdd} hitSlop={10} accessibilityRole="button" accessibilityLabel={label ?? "Add a step here"} style={{ width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.lineStrong }}>
          <Plus size={15} color={colors.ink2} strokeWidth={2.4} />
        </Tap>
      ) : null}
      <View style={{ width: 2, height: 10, backgroundColor: colors.lineStrong }} />
    </View>
  );
}

function Flow({ items, graph, analysis, botName, editable, onOpen, onAdd }: {
  items: FlowItem[];
  graph: Graph;
  analysis: ReturnType<typeof analyzeWorkflowFields>;
  botName: (id?: string, name?: string) => string | undefined;
  editable: boolean;
  onOpen: (id: string) => void;
  onAdd: (from: string, branch: Branch) => void;
}) {
  const { colors } = useTheme();
  return (
    <View>
      {items.map((item, i) => {
        if (item.type === "step")
          return (
            <View key={item.node.id}>
              <Connector onAdd={editable ? () => onAdd(item.from, item.branch) : undefined} label={`Add a step before ${item.node.label}`} />
              <StepCard node={item.node} caption={summary(item.node, botName)} problems={(analysis[item.node.id]?.problems.length ?? 0) + (analysis[item.node.id]?.reachable === false ? 1 : 0)} onPress={() => onOpen(item.node.id)} />
            </View>
          );
        if (item.type === "jump")
          return (
            <View key={"j" + i}>
              <Connector />
              <Tap onPress={() => onOpen(item.to.id)} accessibilityRole="button" style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderStyle: "dashed", borderColor: colors.lineStrong }}>
                <CornerDownRight size={16} color={colors.muted} />
                <T variant="footnote" color="muted">{`Goes on to ${item.to.label}`}</T>
              </Tap>
            </View>
          );
        if (item.type === "add")
          return editable ? (
            <View key={"a" + i} style={{ alignItems: "center" }}>
              <View style={{ width: 2, height: 10, backgroundColor: colors.lineStrong }} />
              <Tap onPress={() => onAdd(item.from, item.branch)} accessibilityRole="button" accessibilityLabel={`Add a step${item.branch === "default" ? "" : " on " + BRANCH_LABEL[item.branch]}`} style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: colors.accentSoft }}>
                <Plus size={15} color={colors.accentText} strokeWidth={2.4} />
                <T variant="footnote" weight="700" color="accentText">
                  Add step
                </T>
              </Tap>
            </View>
          ) : (
            <View key={"a" + i} style={{ alignItems: "center", paddingTop: space.sm }}>
              <T variant="caption" color="faint">End</T>
            </View>
          );
        return (
          <View key={"l" + item.node.id} style={{ gap: space.sm, marginTop: space.sm }}>
            {item.lanes.map((lane) => {
              const tone = lane.branch === "no" || lane.branch === "rejected" ? colors.danger : colors.success;
              return (
                <View key={lane.branch} style={{ borderLeftWidth: 3, borderLeftColor: tone, paddingLeft: space.md, marginLeft: space.sm }}>
                  <View style={{ alignSelf: "flex-start", paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: tint(tone, 0.16) }}>
                    <T variant="caption" weight="700" style={{ color: tone }}>
                      {BRANCH_LABEL[lane.branch]}
                    </T>
                  </View>
                  <Flow items={lane.items} graph={graph} analysis={analysis} botName={botName} editable={editable} onOpen={onOpen} onAdd={onAdd} />
                </View>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

function AddSheet({ adding, onStep, onTrigger, onClose }: { adding: Adding; onStep: (kind: StepKind) => void; onTrigger: (kind: WorkflowTriggerKind) => void; onClose: () => void }) {
  const kindColor = useKindColor();
  const { colors } = useTheme();
  const trigger = !!adding && "trigger" in adding;
  const where = adding && !("trigger" in adding) && adding.branch !== "default" ? ` on ${BRANCH_LABEL[adding.branch]}` : "";
  return (
    <Modal visible={!!adding} animationType="slide" presentationStyle="pageSheet" supportedOrientations={["portrait", "landscape", "landscape-left", "landscape-right"]} onRequestClose={onClose}>
      <Sheet title={trigger ? "Add a trigger" : `Add a step${where}`} onClose={onClose}>
        <Group>
          {trigger
            ? TRIGGER_KINDS.map((k) => {
                const Icon = TRIGGER_ICON[k];
                return <Row key={k} title={TRIGGER_LABEL[k]} leading={<Icon size={20} color={colors.accent} />} chevron onPress={() => onTrigger(k)} />;
              })
            : STEP_KINDS.map((k) => {
                const Icon = iconFor({ kind: k });
                return <Row key={k} title={KIND_LABEL[k]} subtitle={KIND_HINT[k]} subtitleLines={2} leading={<Icon size={20} color={kindColor(k)} />} chevron onPress={() => onStep(k)} />;
              })}
        </Group>
      </Sheet>
    </Modal>
  );
}
