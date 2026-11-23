import { Ban, Circle, CircleCheck, CircleDashed, CircleX } from "lucide-react-native";
import { View } from "react-native";
import type { Todo } from "@/link/types";
import { Group, space, T, useTheme } from "@/ui";

function TodoMark({ status }: { status: Todo["status"] }) {
  const { colors } = useTheme();
  if (status === "done") return <CircleCheck size={20} color={colors.success} strokeWidth={2.2} />;
  if (status === "in_progress") return <CircleDashed size={20} color={colors.accent} strokeWidth={2.2} />;
  if (status === "failed") return <CircleX size={20} color={colors.danger} strokeWidth={2.2} />;
  if (status === "blocked") return <CircleX size={20} color={colors.warning} strokeWidth={2.2} />;
  if (status === "cancelled") return <Ban size={20} color={colors.faint} strokeWidth={2.2} />;
  return <Circle size={20} color={colors.faint} strokeWidth={2.2} />;
}

export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <Group>
      {todos.map((todo) => (
        <View key={todo.id} style={{ minHeight: 48, paddingHorizontal: space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: space.md }} accessibilityLabel={todo.title + ", " + todo.status.replace("_", " ")}>
          <TodoMark status={todo.status} />
          <T variant="callout" color={todo.status === "done" || todo.status === "cancelled" ? "muted" : "ink"} style={{ flex: 1, textDecorationLine: todo.status === "cancelled" ? "line-through" : "none" }}>
            {todo.title}
          </T>
        </View>
      ))}
    </Group>
  );
}
