// The notes of a panel that is an app on the whole screen, as a sheet the panel's bar opens: the
// notes, the field to write one, and when the panel's routine refreshes it. The same rules as the
// notes under any other panel: who may write and who may remove are the same.
import { useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { myself } from "@/features/chat/people";
import { cronLabel } from "@/features/work/cron";
import { usePart } from "@/state/hooks";
import { EmptyState, Sheet, T } from "@/ui";
import { useSpace, useSpaceContent } from "./data";
import { Notes } from "./Notes";

export default function NotesSheet() {
  const { spaceId, panelId } = useLocalSearchParams<{ spaceId: string; panelId: string }>();
  const space = useSpace(spaceId);
  const panel = useSpaceContent(spaceId).content?.panels.find((one) => one.id === panelId);
  const me = myself(usePart("meta"));
  if (!space || !panel) return <Sheet title="Notes"><EmptyState title="This panel no longer exists." /></Sheet>;
  const routine = panel.routine;
  const empty = !(panel.notes?.length) && !(space.can === "own" || space.can === "edit");
  return (
    <Sheet title="Notes">
      {!!routine && (
        <View>
          <T variant="footnote" color="muted">
            {"Refreshes " + cronLabel(routine.cron).toLowerCase() + " · " + routine.timezone}
          </T>
        </View>
      )}
      {empty ? <EmptyState title="No notes yet." /> : <Notes panel={panel} space={space} me={me} label={false} />}
    </Sheet>
  );
}
