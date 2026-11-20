// Adding a marketplace: a GitHub repository (owner/repo), a web address, or a folder on the computer.
import { router } from "expo-router";
import { useState } from "react";
import { useOnline } from "@/state/hooks";
import { showToast } from "@/state/store";
import { Field, Sheet } from "@/ui";
import { loadMarketplaces, pluginCalls } from "./calls";
import { isMarketplaceSource } from "./logic";

export default function AddMarketplace() {
  const online = useOnline();
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = online && !busy && isMarketplaceSource(source);
  const add = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const market = await pluginCalls.addMarketplace(source.trim());
      void loadMarketplaces();
      router.back();
      if (market.error) showToast(market.name + " was added, but " + market.error.charAt(0).toLowerCase() + market.error.slice(1), "info");
      else showToast(market.name + " added", "success");
    } catch (error) {
      setBusy(false);
      showToast(error instanceof Error ? error.message : "That didn't work.", "error");
    }
  };
  return (
    <Sheet title="Add a marketplace" action="Add" onAction={() => void add()} actionDisabled={!ready} actionLoading={busy}>
      <Field
        label="Repository or address"
        hint="owner/repo, owner/repo#branch, or an https address"
        placeholder="owner/repo"
        value={source}
        onChangeText={setSource}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        keyboardType="url"
        returnKeyType="done"
        onSubmitEditing={() => void add()}
        editable={!busy}
      />
    </Sheet>
  );
}
