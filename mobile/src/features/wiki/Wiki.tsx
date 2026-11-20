import { type MenuAction, MenuView } from "@react-native-menu/menu";
import { router, Stack } from "expo-router";
import { BookOpen, ChevronRight, CircleHelp, Ellipsis, FileText, Inbox, Plus, Search, Share, Sparkles, X } from "lucide-react-native";
import { type ReactElement, useEffect, useState } from "react";
import { Alert, Platform, TextInput, View } from "react-native";
import type { WikiTree } from "@/link/types";
import { useBots } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast } from "@/state/store";
import { Button, EmptyState, Group, HoldMenu, IconButton, IconTile, Label, Loading, Page, radius, Row, space, T, Tap, useTheme } from "@/ui";
import { loadTree, useWikiTree } from "./data";
import { editPage, exportWiki, newPageIn, openPage } from "./nav";
import { folderName, foldersIn, hasPages, NEW_TEMPLATE, pagesAt, pagesIn, plural, renamedFolder, sections, suggestedLine, when, WIKI_ASKS } from "./model";


/** The wiki: its sections and pages, or what a search finds. */
export default function Wiki() {
  const { tree, refreshing, refresh } = useWikiTree();
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;

  return (
    <Page title="Wiki" onRefresh={searching ? undefined : refresh} refreshing={refreshing}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              {!!tree && hasPages(tree) && <IconButton icon={Share} label="Export" size={44} onPress={() => exportWiki()} />}
              <AddMenu tree={tree} />
            </View>
          ),
        }}
      />
      {tree && (hasPages(tree) || searching) && <SearchField value={query} onChange={setQuery} />}
      {searching ? <Results query={query.trim()} /> : !tree ? <Loading /> : <Tree tree={tree} />}
    </Page>
  );
}

function AddMenu({ tree }: { tree?: WikiTree }) {
  const { colors } = useTheme();
  const list = tree ? sections(tree) : [];
  const button = (
    <View accessible accessibilityRole="button" accessibilityLabel="New page" style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
      <Plus size={24} color={colors.ink} strokeWidth={2.2} />
    </View>
  );
  if (!list.length)
    return (
      <Tap onPress={() => newPageIn("")} feel="select" sink={0.9} accessibilityLabel="New page">
        {button}
      </Tap>
    );
  const newSection = () =>
    Alert.prompt(
      "New section",
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Add", onPress: (name?: string) => void (name?.trim() && attempt(api.createWikiFolder({ parent: "", name: name.trim() }), "Section added")) },
      ],
      "plain-text",
    );
  return (
    <MenuView
      title="New page in"
      actions={[
        ...list.map((folder) => ({ id: "in:" + folder, title: folderName(folder) })),
        ...(Platform.OS === "ios" ? [{ id: "section", title: "New section…", image: "folder.badge.plus" }] : []),
      ]}
      onPressAction={({ nativeEvent }) => {
        const id = nativeEvent.event;
        if (id === "section") newSection();
        else if (id.startsWith("in:")) newPageIn(id.slice(3));
      }}
    >
      {button}
    </MenuView>
  );
}

function SearchField({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const { colors, dark, type, control } = useTheme();
  return (
    <View style={{ height: control.field, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.md, borderRadius: radius.md, backgroundColor: colors.sunken, marginTop: -space.sm }}>
      <Search size={17} color={colors.muted} strokeWidth={2.3} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Search the wiki"
        placeholderTextColor={colors.faint}
        keyboardAppearance={dark ? "dark" : "light"}
        selectionColor={colors.accent}
        autoCorrect={false}
        returnKeyType="search"
        maxFontSizeMultiplier={1.3}
        accessibilityLabel="Search the wiki"
        style={[type.callout, { flex: 1, color: colors.ink, paddingVertical: 0, height: control.field }]}
      />
      {!!value && (
        <Tap onPress={() => onChange("")} accessibilityLabel="Clear search" feel="select" sink={0.9} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: colors.faint, alignItems: "center", justifyContent: "center" }}>
            <X size={12} color={colors.sunken} strokeWidth={3} />
          </View>
        </Tap>
      )}
    </View>
  );
}

type Hit = { path: string; title: string; snippet: string };

/** What a search finds. The last results stay on screen while the next ones load. */
function Results({ query }: { query: string }) {
  const [found, setFound] = useState<{ query: string; hits: Hit[] }>();
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api.searchWiki(query).then(
        (hits) => live && setFound({ query, hits }),
        () => live && setFound({ query, hits: [] }),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  if (!found) return null;
  if (!found.hits.length)
    return (
      <T variant="subhead" color="muted" center style={{ paddingVertical: space.huge }}>
        {"Nothing matches “" + found.query + "”"}
      </T>
    );
  return (
    <Group>
      {found.hits.map((hit) => (
        <Row key={hit.path} title={hit.title} subtitle={hit.snippet || undefined} subtitleLines={2} onPress={() => openPage(hit.path)} />
      ))}
    </Group>
  );
}

function Tree({ tree }: { tree: WikiTree }) {
  const { colors } = useTheme();
  // Folders inside a section open in place.
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (!hasPages(tree))
    return (
      <EmptyState
        icon={BookOpen}
        title="No pages yet"
        text="You and your bots keep notes here."
        action="Write the first page"
        onAction={() => newPageIn(sections(tree)[0] ?? "")}
      />
    );

  const rows = (folder: string, depth: number): ReactElement[] => {
    const out: ReactElement[] = [];
    const indent = depth > 0 ? <View style={{ width: depth * space.lg }} /> : undefined;
    for (const page of pagesAt(tree, folder))
      out.push(
        <Row
          key={page.path}
          leading={indent}
          title={page.title}
          subtitle={page.updatedAt ? "Edited " + when(page.updatedAt) : undefined}
          onPress={() => openPage(page.path)}
        />,
      );
    for (const sub of foldersIn(tree, folder)) {
      const expanded = !!open[sub];
      out.push(
        <HoldMenu key={"folder:" + sub} actions={folderActions(sub)} onPressAction={({ nativeEvent }) => folderAction(tree, sub, nativeEvent.event)}>
          <Row
            leading={
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                {indent}
                <View style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}>
                  <ChevronRight size={18} color={colors.muted} strokeWidth={2.4} />
                </View>
              </View>
            }
            title={folderName(sub)}
            value={String(tree.pages.filter((page) => !page.template && page.path.startsWith(sub + "/")).length)}
            onPress={() => setOpen((held) => ({ ...held, [sub]: !expanded }))}
          />
        </HoldMenu>,
      );
      if (expanded) out.push(...rows(sub, depth + 1));
    }
    return out;
  };

  const top = rows("", 0);
  return (
    <>
      <Suggested tree={tree} />
      {top.length > 0 && <Group>{top}</Group>}
      {sections(tree).map((section) => {
        const inside = rows(section, 0);
        return (
          <View key={section}>
            <SectionHead tree={tree} folder={section} />
            <Group>{inside.length ? inside : <Row title="Write a page" tone="accent" onPress={() => newPageIn(section)} />}</Group>
          </View>
        );
      })}
      <AskBot />
      <Group>
        <Row leading={<IconTile icon={CircleHelp} color={colors.ink2} />} title="How this wiki works" chevron onPress={() => openPage(tree.guide)} />
      </Group>
    </>
  );
}

// A section's or folder's menu, as on the computer: New page, New folder inside…, Rename…, Edit template (sections only), Delete….

/** Typing a name needs Alert.prompt, which only an iPhone has. */
const canPrompt = Platform.OS === "ios";

function folderActions(folder: string): MenuAction[] {
  const section = !folder.includes("/");
  return [
    { id: "page", title: "New page", image: "doc.badge.plus" },
    ...(canPrompt ? [{ id: "folder", title: "New folder inside…", image: "folder.badge.plus" }] : []),
    ...(canPrompt ? [{ id: "rename", title: "Rename…", image: "pencil" }] : []),
    ...(section ? [{ id: "template", title: "Edit template", image: "doc.text" }] : []),
    { id: "delete", title: "Delete…", image: "trash", attributes: { destructive: true } },
  ];
}

function folderAction(tree: WikiTree, folder: string, action: string) {
  const name = folderName(folder);
  if (action === "page") newPageIn(folder);
  else if (action === "folder")
    Alert.prompt("New folder in " + name, undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Create folder", onPress: (value?: string) => void (value?.trim() && attempt(api.createWikiFolder({ parent: folder, name: value.trim() }), "Folder added").then(() => loadTree())) },
    ]);
  else if (action === "rename")
    Alert.prompt(
      "Rename “" + name + "”",
      "Links to its pages are updated.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Rename",
          onPress: (value?: string) => {
            const next = renamedFolder(folder, value ?? "");
            if (next && next !== folder) void attempt(api.moveWiki(folder, next), "Renamed").then(() => loadTree());
          },
        },
      ],
      "plain-text",
      name,
    );
  else if (action === "template") void editTemplate(tree, folder);
  else if (action === "delete") {
    const count = pagesIn(tree, folder).length;
    Alert.alert("Delete the section “" + name + "”?", count ? "Its " + plural(count, "page") + " will be deleted with it." : "It has no pages.", [
      { text: "Cancel", style: "cancel" },
      { text: count ? "Delete section and pages" : "Delete section", style: "destructive", onPress: () => void attempt(api.deleteWiki(folder), name + " was deleted.").then(() => loadTree()) },
    ]);
  }
}

/** Opens the section's template to edit, writing the computer's starting outline first when it has none. */
async function editTemplate(tree: WikiTree, folder: string) {
  const path = folder + "/_template.md";
  if (!tree.pages.some((page) => page.path === path)) {
    const made = await attempt(api.saveWikiPage(path, NEW_TEMPLATE));
    if (!made) return;
    void loadTree();
  }
  editPage(path);
}

/** A section's name with its menu beside it. */
function SectionHead({ tree, folder }: { tree: WikiTree; folder: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <View style={{ flex: 1 }}>
        <Label style={{ marginBottom: 0 }}>{folderName(folder)}</Label>
      </View>
      <MenuView title={folderName(folder)} actions={folderActions(folder)} onPressAction={({ nativeEvent }) => folderAction(tree, folder, nativeEvent.event)}>
        <View accessible accessibilityRole="button" accessibilityLabel={folderName(folder) + " options"} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <Ellipsis size={18} color={colors.muted} strokeWidth={2.2} />
        </View>
      </MenuView>
    </View>
  );
}

/** Projects that have no wiki page yet, and a button that makes their pages. */
function Suggested({ tree }: { tree: WikiTree }) {
  const { colors } = useTheme();
  const [adding, setAdding] = useState(false);
  const projects = tree.suggested?.projects ?? [];
  if (!projects.length) return null;
  const add = async () => {
    setAdding(true);
    let made = 0;
    for (const project of projects) {
      const path = await attempt(api.createWikiPageFor({ kind: "project", id: project.id }));
      if (!path) break;
      made++;
    }
    setAdding(false);
    void loadTree();
    if (made) showToast("Added " + plural(made, "page"), "success");
  };
  return (
    <Group>
      <Row
        leading={<IconTile icon={Inbox} color={colors.ink2} />}
        title={plural(projects.length, "project") + (projects.length === 1 ? " has" : " have") + " no page yet"}
        subtitle={suggestedLine(tree)}
        subtitleLines={2}
        trailing={<Button title={projects.length === 1 ? "Add page" : "Add pages"} variant="ghost" size="sm" loading={adding} onPress={() => void add()} />}
      />
    </Group>
  );
}

/** "Ask <bot>": a new chat with the first bot, with the computer's prompt waiting in the message box. */
function AskBot() {
  const { colors } = useTheme();
  const bot = useBots()[0];
  if (!bot) return null;
  const start = async (prompt: string) => {
    const id = await attempt(api.createChat(bot.id));
    if (id) router.push({ pathname: "/chat/[id]", params: { id, draft: prompt } });
  };
  return (
    <View>
      <Label>{"Ask " + bot.name}</Label>
      <Group>
        {WIKI_ASKS.map((ask) => (
          <Row key={ask.id} leading={<IconTile icon={ask.id === "file" ? FileText : Sparkles} color={colors.ink2} />} title={ask.title} subtitle={ask.subtitle} chevron onPress={() => void start(ask.prompt)} />
        ))}
      </Group>
    </View>
  );
}
