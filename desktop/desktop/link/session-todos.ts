type TaskStatus = { status: string };

function closed(todo: TaskStatus) {
  return todo.status === "done" || todo.status === "cancelled" || todo.status === "failed";
}

/** A turn keeps its last list, including an explicit clear. Only unfinished lists carry forward. */
export function sessionTodos<T extends TaskStatus>(current: T[] | undefined, previous: T[] | undefined) {
  return current ?? (previous?.some((todo) => !closed(todo)) ? previous : undefined);
}

export function todoLabel(todos: TaskStatus[]) {
  return "Todos " + todos.filter(closed).length + "/" + todos.length;
}
