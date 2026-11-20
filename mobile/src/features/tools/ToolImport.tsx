// Tools › Import…: paste the "mcpServers" block from another app's settings, or take it from a file
// in the Files app ("From a file…"). The phone reads the file and sends its text; the computer opens
// no dialog.
import { router } from "expo-router";
import { FileUp } from "lucide-react-native";
import { useState } from "react";
import { pickTextFile } from "@/state/files";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { Button, Field, Sheet } from "@/ui";
import { importText } from "./shared";

const EXAMPLE = '{\n  "mcpServers": {\n    "github": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-github"]\n    }\n  }\n}';

export default function ToolImport() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (json: string) => {
    setBusy(true);
    const result = await attempt(api.importMcpServers(json));
    setBusy(false);
    if (!result) return;
    showToast(importText(result), result.added.length ? "success" : "info");
    router.back();
  };
  const run = () => send(text);
  // A picked file is imported at once, as on the computer.
  const fromFile = async () => {
    const file = await pickTextFile().catch((error: unknown) => void showToast(error instanceof Error ? error.message : "Couldn't open that.", "error"));
    if (file) await send(file.text);
  };
  return (
    <Sheet title="Import MCP servers" action="Import" onAction={() => void run()} actionDisabled={!text.trim()} actionLoading={busy}>
      <Field
        label="MCP JSON"
        placeholder={EXAMPLE}
        hint="Servers whose names already exist are skipped."
        value={text}
        onChangeText={setText}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        mono
        area
        autoFocus
        style={{ minHeight: 220 }}
      />
      <Button title="From a file…" icon={FileUp} variant="secondary" disabled={busy} onPress={() => void fromFile()} />
    </Sheet>
  );
}
