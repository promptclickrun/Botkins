// "Where it works" (the sheet `/projects/where`, from a project's Jobs; the computer's words): the checkout new
// worktrees start from, the branches they get, and the setup commands from the repository's .botkins/worktrees.json.
// Those come from the repository and run on the computer, so they run only once the person allowed this list.
import { useLocalSearchParams } from "expo-router";
import { ShieldCheck } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import type { Project } from "@/link/types";
import { usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Button, EmptyState, Group, Label, Loading, radius, Row, Sheet, space, T, useTheme } from "@/ui";
import { baseName } from "./jobLogic";
import { useJobSetup } from "./Jobs";

export default function WhereItWorks() {
  const { id, folder } = useLocalSearchParams<{ id: string; folder?: string }>();
  const project = usePart("projects")?.find((item) => item.id === id);
  if (!project)
    return (
      <Sheet title="Where it works">
        <EmptyState title="This project is gone" />
      </Sheet>
    );
  return <Where project={project} folder={folder} />;
}

function Where({ project, folder }: { project: Project; folder?: string }) {
  const { colors } = useTheme();
  const { setup, load } = useJobSetup(project, folder, 0);
  const [busy, setBusy] = useState(false);
  const allow = async () => {
    if (!setup?.repo || busy) return;
    setBusy(true);
    await attempt(api.approveJobSetup(project.id, folder, setup.hash), "Allowed");
    setBusy(false);
    load();
  };
  let body;
  if (!project.folder) body = <EmptyState title="This project has no folder" />;
  else if (!setup) body = <Loading />;
  else if (!setup.repo)
    body = (
      <T variant="callout" color="muted" style={{ paddingHorizontal: space.xs }}>
        This folder isn't a git repository, so jobs work right in it, one at a time.
      </T>
    );
  else
    body = (
      <View style={{ gap: space.lg }}>
        <View>
          <Label>Starts from your checkout</Label>
          <Group>
            <Row title={baseName(setup.root)} subtitle={(setup.base ?? "a detached HEAD") + " @ " + (setup.short ?? "no commit")} value={setup.changed ? setup.changed + " changed" : "Clean"} />
          </Group>
        </View>
        <View>
          <Label>On each new worktree</Label>
          {setup.error ? (
            <T variant="callout" color="danger" style={{ paddingHorizontal: space.xs }}>
              {setup.error}
            </T>
          ) : setup.setup.length ? (
            <View style={{ borderRadius: radius.md, padding: space.md, backgroundColor: colors.sunken }}>
              <T variant="mono">{setup.setup.map((line) => "$ " + line).join("\n")}</T>
            </View>
          ) : (
            <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
              Nothing runs. A repository can list setup commands in .botkins/worktrees.json.
            </T>
          )}
          {!setup.error && setup.setup.length > 0 && (
            <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
              {setup.approved ? "Allowed. A changed list asks again." : "These come from the repository and run on your computer, in each new worktree."}
            </T>
          )}
        </View>
        <View>
          <Label>Names and cleanup</Label>
          <Group>
            <Row title="Branch" value={setup.branch} />
            <Row title="Once brought in" value="Remove the folder" />
          </Group>
        </View>
        {!setup.error && setup.setup.length > 0 && !setup.approved && <Button title="Allow these commands" icon={ShieldCheck} wide loading={busy} onPress={() => void allow()} />}
      </View>
    );
  return <Sheet title="Where it works">{body}</Sheet>;
}
