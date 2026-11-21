// Updating a plugin: the new version is read first and shown (what it adds and runs), and the
// update sends that version's `revision`, so what is installed is what was looked at.
import { router, useLocalSearchParams } from "expo-router";
import { Puzzle } from "lucide-react-native";
import { useEffect, useState } from "react";
import { useOnline } from "@/state/hooks";
import { showToast } from "@/state/store";
import { EmptyState, Loading, Sheet, T } from "@/ui";
import { shownText } from "@/ui/shownText";
import { loadPreview, pluginCalls, useInstalledPlugin, useOlderComputer, usePreview } from "./calls";
import { WhatItAdds, Warnings } from "./parts";
import { askToRun } from "./PluginPage";

export default function UpdateSheet() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const online = useOnline();
  const installed = useInstalledPlugin(id);
  const older = useOlderComputer();
  const loaded = usePreview(id);
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    void loadPreview(id).finally(() => setAsked(true));
  }, [id]);

  const preview = asked ? loaded?.preview : undefined;
  if (!id || !installed) return <Sheet title="Update">{<EmptyState icon={Puzzle} title="This plugin isn't installed" />}</Sheet>;
  if (!preview) return <Sheet title="Update">{asked && loaded?.error ? <EmptyState icon={Puzzle} title="The new version couldn't be read" text={loaded.error} /> : <Loading />}</Sheet>;

  const update = () =>
    askToRun(preview, "update", async () => {
      setBusy(true);
      try {
        await pluginCalls.update(id, preview.revision);
        setBusy(false);
        showToast("Updated", "success");
        router.back();
      } catch (error) {
        setBusy(false);
        const fresh = await loadPreview(id);
        if (fresh && fresh.revision !== preview.revision) showToast("This plugin changed again. Look at it once more.", "info");
        else showToast(error instanceof Error ? error.message : "That didn't work.", "error");
      }
    }, older);

  const versions = [installed.version, preview.version].every(Boolean) && installed.version !== preview.version ? installed.version + " to " + preview.version : preview.version ? "Version " + preview.version : "";
  return (
    <Sheet title={"Update " + shownText(preview.name)} action="Update" onAction={update} actionDisabled={!online || busy} actionLoading={busy}>
      {!!versions && (
        <T variant="subhead" color="muted">
          {versions}
        </T>
      )}
      <Warnings lines={preview.warnings} />
      <WhatItAdds about={preview} older={older} />
    </Sheet>
  );
}
