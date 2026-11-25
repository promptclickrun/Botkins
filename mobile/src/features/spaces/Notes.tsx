// A panel's notes: short notes people wrote on it, and a field to write one. An opened panel shows
// them under its blocks; an app that fills the screen shows them in the notes sheet instead.
import { Trash2 } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import type { PanelView, SpaceSummary } from "@/link/types";
import { api, attempt } from "@/state/link";
import { ago } from "@/state/time";
import { Button, Field, Group, IconButton, Label, space as gap, T, useTheme } from "@/ui";

/** A person removes their own note; the maker and the owner remove any. Only those who may change the space write one. */
export function Notes({ panel, space, me, label = true }: { panel: PanelView; space: SpaceSummary; me: string; label?: boolean }) {
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const acts = space.can === "own" || space.can === "edit";
  const notes = panel.notes ?? [];
  if (!acts && !notes.length) return null;
  const add = async () => {
    const note = text.trim();
    if (!note || saving) return;
    setSaving(true);
    const done = await attempt(api["spaces.note"](panel.id, note));
    setSaving(false);
    if (done) setText("");
  };
  return (
    <View>
      {label && <Label>Notes</Label>}
      {notes.length > 0 && (
        <Group>
          {notes.map((note) => (
            <View key={note.id} style={{ paddingHorizontal: gap.lg, paddingVertical: gap.md, flexDirection: "row", alignItems: "flex-start", gap: gap.md }}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T variant="footnote" color="muted">
                  {note.name + " · " + ago(note.at)}
                </T>
                <T variant="callout">{note.text}</T>
              </View>
              {(note.by === me || space.can === "own") && <IconButton icon={Trash2} label={"Remove note by " + note.name} color={colors.muted} onPress={() => void attempt(api["spaces.removeNote"](panel.id, note.id))} />}
            </View>
          ))}
        </Group>
      )}
      {acts && (
        <View style={{ gap: gap.sm, marginTop: notes.length ? gap.md : 0 }}>
          <Field placeholder="Write a note" value={text} onChangeText={setText} area maxLength={2000} />
          {!!text.trim() && <Button title="Add note" variant="secondary" size="sm" onPress={() => void add()} loading={saving} style={{ alignSelf: "flex-start" }} />}
        </View>
      )}
    </View>
  );
}
