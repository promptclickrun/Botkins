import { router, useLocalSearchParams, usePreventRemove } from "expo-router";
import { Bold, Code, Heading, Italic, Link, List, ListChecks, type LucideIcon, Quote } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, TextInput, type TextInputInstance, View } from "react-native";
import { KeyboardAwareScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { EmptyState, Field, Loading, Segmented, Sheet, space, Tap, useTheme } from "@/ui";
import { loadPage, useWiki, useWikiTree } from "./data";
import { CHANGED, folderName, isGenerated, message, pageTitle, templateFor } from "./model";
import { openPage } from "./nav";
import { Prose } from "./Prose";

const TOOLBAR = 46;

/** Writes a page: an existing one (`path`), or a new one in a section (`folder`). */
export default function WikiEditor() {
  const { path, folder } = useLocalSearchParams<{ path?: string; folder?: string }>();
  // A page made here from its section's template, now open to write.
  const [made, setMade] = useState<string>();
  const editing = made ?? path;
  if (editing) return <EditPage key={editing} path={editing} made={!!made} />;
  return <NewPage folder={folder ?? ""} onMade={setMade} />;
}

function EditPage({ path, made }: { path: string; made: boolean }) {
  const cached = useWiki((held) => held.pages[path]);
  const [page, setPage] = useState(cached ?? undefined);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let live = true;
    void loadPage(path).then((fresh) => {
      if (!live) return;
      if (fresh) setPage(fresh);
      else if (useWiki.getState().pages[path] === null) setGone(true);
    });
    return () => {
      live = false;
    };
  }, [path]);

  if (gone)
    return (
      <Sheet title="Edit page">
        <EmptyState title="This page is gone" action="Go back" onAction={() => router.back()} />
      </Sheet>
    );
  if (!page)
    return (
      <Sheet title="Edit page">
        <Loading />
      </Sheet>
    );
  if (page.generated || isGenerated(path))
    return (
      <Sheet title={page.title}>
        <EmptyState title="Your computer keeps this page" text="Change the other pages and it follows." />
      </Sheet>
    );
  // A newer copy than the one the phone held starts the writer again (keyed by base) before much is typed.
  return <Writer key={page.base} mode={{ kind: "edit", path, title: pageTitle(page), made }} content={page.content} base={page.base} />;
}

function NewPage({ folder, onMade }: { folder: string; onMade: (path: string) => void }) {
  const { tree } = useWikiTree();
  const template = templateFor(tree, folder);
  if (!tree)
    return (
      <Sheet title="New page">
        <Loading />
      </Sheet>
    );
  return <Writer mode={{ kind: "new", folder, template: !!template, onMade }} content="" />;
}

type Mode = { kind: "edit"; path: string; title: string; made: boolean } | { kind: "new"; folder: string; template: boolean; onMade: (path: string) => void };
type Exit = { open?: string };

function Writer({ mode, content, base: startBase }: { mode: Mode; content: string; base?: string }) {
  const { colors, dark, type } = useTheme();
  const insets = useSafeAreaInsets();
  const area = useRef<TextInputInstance>(null);
  const [text, setText] = useState(content);
  const [baseline, setBaseline] = useState(content);
  const [base, setBase] = useState(startBase);
  const [title, setTitle] = useState("");
  const [view, setView] = useState<"write" | "preview">("write");
  const [focused, setFocused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exit, setExit] = useState<Exit>();
  const selection = useRef({ start: content.length, end: content.length });
  // A new page made by an earlier tap on Save, whose text didn't save.
  const made = useRef<string | undefined>(undefined);

  const isNew = mode.kind === "new";
  // A new page from a template is made first, then written in this sheet.
  const outlineFirst = isNew && mode.template;
  const dirty = !exit && (isNew ? !!title.trim() || !!text.trim() : text !== baseline);

  usePreventRemove(dirty, ({ repeat }) =>
    Alert.alert("Discard your changes?", undefined, [
      { text: "Keep writing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: repeat },
    ]),
  );
  // Leaves once the guard above has let go.
  useEffect(() => {
    if (!exit) return;
    router.back();
    if (exit.open) openPage(exit.open);
  }, [exit]);

  const write = async (path: string, against: string | undefined) => {
    try {
      await api.saveWikiPage(path, text, against);
      showToast("Saved", "success");
      setExit({ open: mode.kind === "edit" && mode.made ? path : undefined });
    } catch (error) {
      setSaving(false);
      if (CHANGED.test(message(error))) conflict(path);
      else showToast(message(error), "error");
    }
  };
  const conflict = (path: string) =>
    Alert.alert("This page changed while you were editing", "It was saved somewhere else meanwhile.", [
      {
        text: "Keep mine",
        onPress: async () => {
          const fresh = await attempt(api.wikiPage(path));
          if (!fresh) return;
          setSaving(true);
          await write(path, fresh.base);
        },
      },
      {
        text: "Use theirs",
        onPress: async () => {
          const fresh = await attempt(api.wikiPage(path));
          if (!fresh) return;
          setText(fresh.content);
          setBaseline(fresh.content);
          setBase(fresh.base);
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);

  const save = async () => {
    if (mode.kind === "edit") {
      if (!text.trim()) return showToast("A page needs some text. To remove it, use Delete.", "error");
      setSaving(true);
      return write(mode.path, base);
    }
    const name = title.trim();
    if (!name) return;
    setSaving(true);
    const path = made.current ?? (await attempt(api.createWikiPage({ folder: mode.folder, title: name })));
    if (!path) return setSaving(false);
    if (outlineFirst) return mode.onMade(path);
    made.current = path;
    if (text.trim()) {
      const body = /^#\s+\S/m.test(text) ? text : "# " + name + "\n\n" + text;
      const saved = await attempt(api.wikiPage(path).then((fresh) => api.saveWikiPage(path, body, fresh.base)));
      if (!saved) return setSaving(false);
    }
    showToast("Page created", "success");
    setExit({ open: path });
  };

  const edit = (change: (text: string, start: number, end: number) => Change) => {
    const { start, end } = selection.current;
    const next = change(text, Math.min(start, end), Math.max(start, end));
    setText(next.text);
    selection.current = { start: next.start, end: next.end };
    setTimeout(() => area.current?.setSelection(next.start, next.end), 0);
  };

  const sheetTitle = mode.kind === "edit" ? mode.title : "New page" + (mode.folder ? " in " + folderName(mode.folder) : "");
  const action = mode.kind === "edit" ? "Save" : outlineFirst ? "Create" : "Save";
  const canSave = mode.kind === "edit" ? text !== baseline : !!title.trim();

  return (
    <Sheet
      title={sheetTitle}
      action={action}
      onAction={() => void save()}
      actionDisabled={!canSave}
      actionLoading={saving}
      scroll={false}
      contentStyle={{ paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0, gap: 0 }}
      footer={
        focused && view === "write" ? (
          <KeyboardStickyView>
            <Toolbar onEdit={edit} />
          </KeyboardStickyView>
        ) : undefined
      }
    >
      <KeyboardAwareScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: space.xl, paddingTop: space.sm, paddingBottom: insets.bottom + space.xxl, gap: space.lg }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
        bottomOffset={TOOLBAR + space.xl}
      >
        {isNew && (
          <Field
            label="Title"
            placeholder="Page title"
            value={title}
            onChangeText={setTitle}
            autoFocus
            returnKeyType={outlineFirst ? "done" : "next"}
            onSubmitEditing={() => (outlineFirst ? void save() : area.current?.focus())}
            submitBehavior={outlineFirst ? "blurAndSubmit" : "submit"}
            hint={outlineFirst ? "Starts from the " + folderName(mode.folder) + " template" : undefined}
            maxLength={120}
          />
        )}
        {!outlineFirst && (
          <>
            <Segmented
              options={[
                { value: "write", label: "Write" },
                { value: "preview", label: "Preview" },
              ]}
              value={view}
              onChange={setView}
            />
            {view === "preview" ? (
              text.trim() ? (
                <Prose text={text} />
              ) : (
                <EmptyState title="Nothing to show yet" style={{ paddingVertical: space.huge }} />
              )
            ) : (
              <TextInput
                ref={area}
                value={text}
                onChangeText={setText}
                onSelectionChange={(event) => (selection.current = event.nativeEvent.selection)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                multiline
                scrollEnabled={false}
                autoFocus={mode.kind === "edit" && mode.made}
                placeholder={isNew ? "Write in Markdown" : "This page is empty"}
                placeholderTextColor={colors.faint}
                keyboardAppearance={dark ? "dark" : "light"}
                selectionColor={colors.accent}
                textAlignVertical="top"
                maxFontSizeMultiplier={1.6}
                accessibilityLabel="Page text"
                style={[type.body, { lineHeight: Math.round(type.body.fontSize * 1.6), color: colors.ink, minHeight: 360, paddingTop: 0, paddingBottom: space.lg }]}
              />
            )}
          </>
        )}
      </KeyboardAwareScrollView>
    </Sheet>
  );
}

// The toolbar above the keyboard: Markdown at the caret.

type Change = { text: string; start: number; end: number };

/** Puts `before` and `after` around the selection, or a placeholder when nothing is selected. */
const wrap =
  (before: string, after: string, placeholder: string) =>
  (text: string, start: number, end: number): Change => {
    const inner = text.slice(start, end) || placeholder;
    return { text: text.slice(0, start) + before + inner + after + text.slice(end), start: start + before.length, end: start + before.length + inner.length };
  };

/** Adds `prefix` to each line in the selection, or takes it off when every line has it. */
const prefixLines =
  (prefix: string, existing: RegExp) =>
  (text: string, start: number, end: number): Change => {
    const from = text.lastIndexOf("\n", start - 1) + 1;
    const stop = text.indexOf("\n", end);
    const to = stop === -1 ? text.length : stop;
    const lines = text.slice(from, to).split("\n");
    const off = lines.every((line) => line.startsWith(prefix));
    const changed = lines.map((line) => (off ? line.slice(prefix.length) : prefix + line.replace(existing, ""))).join("\n");
    const caret = from + changed.length;
    return { text: text.slice(0, from) + changed + text.slice(to), start: lines.length > 1 ? from : caret, end: caret };
  };

const LIST_MARK = /^(\s*([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?|>\s?|#{1,6}\s+)/;

const code = (text: string, start: number, end: number): Change =>
  text.slice(start, end).includes("\n") ? wrap("```\n", "\n```", "")(text, start, end) : wrap("`", "`", "code")(text, start, end);

const link = (text: string, start: number, end: number): Change => {
  if (start === end) return wrap("[", "](https://)", "link text")(text, start, end);
  // The words are chosen: select the address to type over.
  const next = text.slice(0, start) + "[" + text.slice(start, end) + "](https://)" + text.slice(end);
  const at = end + 3;
  return { text: next, start: at, end: at + 8 };
};

const TOOLS: { icon: LucideIcon; label: string; change: (text: string, start: number, end: number) => Change }[] = [
  { icon: Heading, label: "Heading", change: prefixLines("## ", LIST_MARK) },
  { icon: Bold, label: "Bold", change: wrap("**", "**", "bold") },
  { icon: Italic, label: "Italic", change: wrap("_", "_", "italic") },
  { icon: List, label: "List", change: prefixLines("- ", LIST_MARK) },
  { icon: ListChecks, label: "Task", change: prefixLines("- [ ] ", LIST_MARK) },
  { icon: Link, label: "Link", change: link },
  { icon: Quote, label: "Quote", change: prefixLines("> ", LIST_MARK) },
  { icon: Code, label: "Code", change: code },
];

function Toolbar({ onEdit }: { onEdit: (change: (text: string, start: number, end: number) => Change) => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ height: TOOLBAR, flexDirection: "row", alignItems: "center", justifyContent: "space-around", paddingHorizontal: space.sm, backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
      {TOOLS.map((tool) => (
        <Tap key={tool.label} onPress={() => onEdit(tool.change)} feel="select" sink={0.85} accessibilityLabel={tool.label} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <tool.icon size={19} color={colors.ink2} strokeWidth={2.2} />
        </Tap>
      ))}
    </View>
  );
}
