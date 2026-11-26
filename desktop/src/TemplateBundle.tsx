import { cadenceSummary } from "./Routines";
import { Group } from "./SettingsRows";
import type { AgentTemplateBundle, State } from "./types";

export function supportsTemplateBundles(remote?: State["remote"]) {
  return !remote?.using || remote.using.capabilities.includes("agent-template-bundles-v1");
}

export function TemplateBundle({ bundle, supported }: { bundle?: AgentTemplateBundle; supported: boolean }) {
  if (!bundle?.skills?.length && !bundle?.routines?.length) return null;
  return (
    <div className="template-bundle">
      {!!bundle.skills?.length && (
        <Group title="Skills for this bot">
          {bundle.skills.map((skill) => <BundleItem key={skill.name} name={skill.name} detail={skill.description} instructions={skill.instructions} />)}
        </Group>
      )}
      {!!bundle.routines?.length && (
        <Group title="Routines for this bot" footer="Routines start paused. Turn them on in Routines.">
          {bundle.routines.map((routine) => <BundleItem key={routine.name} name={routine.name} detail={cadenceSummary(routine.cadence)} instructions={routine.instructions} />)}
        </Group>
      )}
      {!supported && <p className="set-foot">Update the app on your computer to include these items when creating this bot.</p>}
    </div>
  );
}

function BundleItem({ name, detail, instructions }: { name: string; detail: string; instructions: string }) {
  return (
    <details className="set-row agent-instructions">
      <summary><strong>{name}</strong> · {detail}</summary>
      <p>{instructions}</p>
    </details>
  );
}
