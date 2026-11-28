// Project subpage: To-dos (add field at top, open items in order with hold menu for rename/reorder/delete,
// done items folded under an expandable "N done" row).
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Check, ChevronDown, ChevronUp, ListTodo, Plus, Trash2 } from "lucide-react-native";
import { useMemo, useRef, useState } from "react";
import { Alert, TextInput, type TextInputInstance, View } from "react-native";
import type { Project, ProjectTodo } from "@/link/types";
import { api, attempt } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { EmptyState, Group, HoldMenu, IconButton, Loading, Page, Row, space, T, Tap, useTheme } from "@/ui";
import { moveSteps, orderedTodos } from "./logic";

/** Moves an open to-do past the next open one, as the computer does: one place at a time, over done ones. */
async function moveTodo(project: Project, todo: ProjectTodo, delta: -1 | 1) {
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
        else if (action === "up" || action === "down") void moveTodo(project, todo, action === "up" ? -1 : 1);
        else if (action === "delete") remove();
      }}
    >
      <View style={{ minHeight: 52, flexDirection: "row", alignItems: "center", paddingLeft: space.sm, paddingRight: space.xs, gap: space.sm }}>
        <Tap
          onPress={toggle}
          feel="select"
          sink={0.9}
          hitSlop={0}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: todo.done }}
          accessibilityLabel={(todo.done ? "Reopen " : "Check off ") + todo.text}
          style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
        >
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              borderWidth: 2,
              borderColor: todo.done ? colors.success : colors.lineStrong,
              backgroundColor: todo.done ? colors.success : "transparent",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
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
          <Tap
            onPress={() => setEditing(todo.text)}
            feel="select"
            sink={1}
            hitSlop={0}
            accessibilityLabel={todo.text}
            accessibilityHint="Renames it. Hold for more."
            style={{ flex: 1, minHeight: 44, justifyContent: "center" }}
          >
            <T
              variant="callout"
              color={todo.done ? "muted" : "ink"}
              style={[{ paddingVertical: space.sm }, todo.done && { textDecorationLine: "line-through" }]}
            >
              {todo.text}
            </T>
          </Tap>
        )}
        <IconButton icon={Trash2} label={"Delete " + todo.text} size={44} color={colors.faint} onPress={remove} />
      </View>
    </HoldMenu>
  );
}

function AddTodo({ projectId, inputRef }: { projectId: string; inputRef: React.RefObject<TextInputInstance | null> }) {
  const { colors, dark, type } = useTheme();
  const [text, setText] = useState("");
  const add = () => {
    const clean = text.trim();
    if (!clean) return;
    setText("");
    void attempt(api.addTodo(projectId, clean));
    inputRef.current?.focus();
  };
  return (
    <View style={{ minHeight: 52, flexDirection: "row", alignItems: "center", paddingLeft: space.sm, paddingRight: space.lg, gap: space.sm }}>
      <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
        <Plus size={20} color={colors.accentText} strokeWidth={2.4} />
      </View>
      <TextInput
        ref={inputRef}
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

export function ProjectTodosContent({ project }: { project: Project }) {
  const { colors } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const { open, done } = useMemo(() => orderedTodos(project.todos), [project.todos]);
  const [showDone, setShowDone] = useState(false);
  const inputRef = useRef<TextInputInstance>(null);
  const DoneIcon = showDone ? ChevronUp : ChevronDown;
  const total = open.length + done.length;
  const caption =
    total === 0
      ? "None yet"
      : `${open.length} open${done.length ? ` · ${done.length} done` : ""}`;

  return (
    <Page title="To-dos" caption={caption} keyboard>
      <Stack.Screen
        options={{
          headerRight: () => (
            <IconButton
              icon={Plus}
              label="Add a to-do"
              variant={hasBackdrop ? "glass" : "soft"}
              onPress={() => inputRef.current?.focus()}
            />
          ),
        }}
      />

      <Group>
        <AddTodo key="add" projectId={project.id} inputRef={inputRef} />
        {open.map((todo, index) => (
          <TodoRow key={todo.id} project={project} todo={todo} first={index === 0} last={index === open.length - 1} />
        ))}
      </Group>

      {total === 0 && (
        <EmptyState
          icon={ListTodo}
          title="No to-dos yet"
          text="Track tasks for this project. Bots in this project can add to the list too."
          action="Add a to-do"
          onAction={() => inputRef.current?.focus()}
        />
      )}

      {done.length > 0 && (
        <Group>
          <Row
            key="done-toggle"
            title={`${done.length} done`}
            tone="accent"
            onPress={() => setShowDone(!showDone)}
            trailing={<DoneIcon size={18} color={colors.faint} strokeWidth={2.2} />}
          />
          {showDone ? done.map((todo) => <TodoRow key={todo.id} project={project} todo={todo} first last />) : null}
        </Group>
      )}
    </Page>
  );
}

export default function ProjectTodosPage() {
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
  return <ProjectTodosContent project={project} />;
}
