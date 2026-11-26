import { useState } from "react";
import { View } from "react-native";
import type { AgentTemplateBundle } from "@/link/types";
import { cadenceLabel } from "@/state/time";
import { Group, Label, Row, space, T } from "@/ui";

export function TemplateBundle({ bundle, supported }: { bundle?: AgentTemplateBundle; supported: boolean }) {
  if (!bundle?.skills?.length && !bundle?.routines?.length) return null;
  return (
    <View style={{ gap: space.lg }}>
      {!!bundle.skills?.length && (
        <View>
          <Label>Skills for this bot</Label>
          <Group>
            {bundle.skills.map((skill) => <BundleItem key={skill.name} name={skill.name} detail={skill.description} instructions={skill.instructions} />)}
          </Group>
        </View>
      )}
      {!!bundle.routines?.length && (
        <View>
          <Label>Routines for this bot</Label>
          <Group>
            {bundle.routines.map((routine) => <BundleItem key={routine.name} name={routine.name} detail={cadenceLabel(routine.cadence)} instructions={routine.instructions} />)}
          </Group>
          <T variant="footnote" color="muted" style={{ marginTop: space.sm }}>Routines start paused. Turn them on in Routines.</T>
        </View>
      )}
      {!supported && <T variant="footnote" color="muted">Update the app on your computer to include these items when creating this bot.</T>}
    </View>
  );
}

function BundleItem({ name, detail, instructions }: { name: string; detail: string; instructions: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Row title={name} titleLines={0} subtitle={detail} subtitleLines={0} onPress={() => setOpen(!open)} value={open ? "Hide instructions" : "Instructions"} />
      {open && <T variant="subhead" color="ink2" selectable style={{ paddingHorizontal: space.lg, paddingBottom: space.lg }}>{instructions}</T>}
    </View>
  );
}
