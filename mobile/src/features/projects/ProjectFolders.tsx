import { useState } from "react";
import { View } from "react-native";
import type { Project } from "@/link/types";
import { useCapability } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Button, Chip, Field, Label, space } from "@/ui";

export function FolderChoice({ project, value, change }: { project?: Project; value?: string; change: (path: string) => void }) {
  const enabled = useCapability("project-folders-v1");
  if (!enabled || !project?.folders || project.folders.length < 2) return null;
  return <View style={{ gap: space.xs }}><Label>Folder</Label>
    {project.folders.map((path) => <Chip key={path} label={path} selected={path === (value && project.folders?.includes(value) ? value : project.folder)} onPress={() => change(path)} />)}
  </View>;
}

export function CloneForm({ id, name, done }: { id?: string; name?: string; done?: (id: string) => void }) {
  const enabled = useCapability("project-clone-v1");
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState("");
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  if (!enabled) return null;
  if (!open) return <Button title="Add from GitHub" variant="secondary" onPress={() => setOpen(true)} />;
  return <View style={{ gap: space.sm }}>
    <Field label="GitHub repository" value={repo} onChangeText={setRepo} autoCapitalize="none" autoCorrect={false} placeholder="owner/repo" />
    <Field label="Parent folder on the computer" value={parent} onChangeText={setParent} autoCapitalize="none" autoCorrect={false} placeholder="Home folder" />
    <Button title={busy ? "Cloning…" : "Clone repository"} loading={busy} disabled={!repo.trim() || busy} onPress={async () => {
      setBusy(true);
      const project = await attempt(api.cloneProjectRepository(repo, parent, id, { name: name?.trim() || undefined }));
      setBusy(false);
      if (project) { setOpen(false); setRepo(""); done?.(project); }
    }} />
  </View>;
}
