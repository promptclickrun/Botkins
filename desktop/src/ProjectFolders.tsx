import { useState } from "react";
import type { Project, State } from "./types";

export const projectCapability = (state: State, name: string) => !state.remote?.using || !!state.remote.using.capabilities?.includes(name);

export function FolderChoice({ project, value, change }: { project?: Project; value?: string; change: (path: string) => void }) {
  if (!project?.folders || project.folders.length < 2) return null;
  return <label className="field-inline compact">Folder
    <select aria-label="Folder" value={value && project.folders.includes(value) ? value : project.folder} onChange={(e) => change(e.target.value)}>
      {project.folders.map((path) => <option key={path}>{path}</option>)}
    </select>
  </label>;
}

export function CloneFields({ repo, parent, setRepo, setParent }: { repo: string; parent: string; setRepo: (s: string) => void; setParent: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" onClick={() => setOpen(true)}>Add from GitHub</button>;
  return <>
    <label className="field">GitHub repository<input value={repo} placeholder="owner/repo" onChange={(e) => setRepo(e.target.value)} /></label>
    <label className="field">Parent folder on the computer<input value={parent} placeholder="Home folder" onChange={(e) => setParent(e.target.value)} /></label>
  </>;
}
