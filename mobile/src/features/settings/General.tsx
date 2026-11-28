// Settings › General, as on the computer: the default model, the harness bots' turns run in, and the
// computer's own background settings (run at startup, storage), each on its page.
import { type Href, router } from "expo-router";
import { Cpu, HardDrive, Sparkles } from "lucide-react-native";
import { describeChoice, useDefaultProvider } from "@/features/models/shared";
import { useCapability, useModels, usePart, useSettings } from "@/state/hooks";
import { brand, Group, IconTile, Page, ProviderIcon, Row } from "@/ui";
import { harnessName } from "./Harness";

export default function General() {
  const settings = useSettings();
  const models = useModels();
  const defaultProvider = useDefaultProvider();
  const meta = usePart("meta");
  const claudeArtifacts = useCapability("claude-artifacts-v1");
  const owner = meta?.you?.kind !== "member";
  const model = describeChoice(settings?.model, models, defaultProvider);
  return (
    <Page title="General">
      <Group>
        <Row leading={<ProviderIcon provider={model.provider} name={model.providerLabel} size={32} tile />} title="Default model" value={models && settings ? model.name : undefined} chevron onPress={() => router.push("/models")} />
        {owner && !!settings?.harness && <Row leading={<IconTile icon={Cpu} color={brand.tide} />} title="Harness" value={harnessName(settings.harness)} chevron onPress={() => router.push("/settings/harness")} />}
        {owner && claudeArtifacts && (
          <Row
            leading={<IconTile icon={Sparkles} color={brand.tide} />}
            title="Claude artifacts"
            subtitle="Availability, model, standing grants"
            value={settings?.claudeArtifactModel ? settings.claudeArtifactModel[0].toUpperCase() + settings.claudeArtifactModel.slice(1) : "Haiku"}
            chevron
            onPress={() => router.push("/settings/claude-artifacts" as Href)}
          />
        )}
        {owner && <Row leading={<IconTile icon={HardDrive} color={brand.tide} />} title="Background and storage" subtitle="Run at startup, keep running, cache" chevron onPress={() => router.push("/settings/desktop" as Href)} />}
      </Group>
    </Page>
  );
}
