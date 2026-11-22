import { MenuView } from "@react-native-menu/menu";
import { router, Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Ellipsis } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Alert, Linking, Modal, View } from "react-native";
import type { WikiPage as Page_, WikiTree, WikiVersion } from "@/link/types";
import { isConversation, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast, useApp } from "@/state/store";
import { EmptyState, Group, Label, Loading, Page, Row, Sheet, space, T, Tap, useTextPrompt, useTheme } from "@/ui";
import { forgetPage, loadPage, moveCached, useWikiPage, useWikiTree } from "./data";
import { dateTime, fileOf, folderName, folderOf, fromTemplate, GUIDE, isGenerated, message, NAME_LINK, pageLookup, pageTitle, resolveLink, resolveName, sectionOf, sections, slug, when, withTitle } from "./model";
import { type LinkKind, Prose } from "./Prose";
import { editPage, exportWiki, openPage } from "./nav";


/** One wiki page, set for reading, with what links to it and its earlier versions. */
export default function WikiPage() {
  const { path = "" } = useLocalSearchParams<{ path: string }>();
  const { page, error, history } = useWikiPage(path);
  const { tree } = useWikiTree();
  const online = useOnline();

  if (page === null)
    return (
      <Page>
        <EmptyState title="This page is gone" action="Go back" onAction={() => router.back()} />
      </Page>
    );
  if (!page)
    return <Page>{error && online ? <EmptyState title="Couldn't open this page" text={error} action="Try again" onAction={() => void loadPage(path)} /> : <Loading />}</Page>;
  return <Reader page={page} tree={tree} history={history} />;
}

function BarButton({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Tap onPress={onPress} feel="select" accessibilityLabel={title} style={{ minWidth: 44, height: 44, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" }}>
      <T variant="headline" color="accentText">
        {title}
      </T>
    </Tap>
  );
}

function Reader({ page, tree, history }: { page: Page_; tree?: WikiTree; history?: WikiVersion[] }) {
  const [version, setVersion] = useState<WikiVersion>();
  const [allVersions, setAllVersions] = useState(false);
  const lookup = useMemo(() => pageLookup([...(tree?.pages.map((p) => p.path) ?? []), GUIDE, "index.md", "log.md"]), [tree]);
  const titleOf = (path: string) => {
    const info = tree?.pages.find((p) => p.path === path);
    return info ? pageTitle(info) : fileOf(path).replace(/\.md$/i, "");
  };

  /** Where a link on this page goes: another page (written or not), or null for the web. */
  const target = (href: string) => {
    if (href.startsWith(NAME_LINK)) return resolveName(tree?.pages ?? [], decodeURIComponent(href.slice(NAME_LINK.length)));
    const hit = resolveLink(page.path, href, lookup);
    // Before the tree has come, every page link is taken to exist; the page says when it doesn't.
    return hit && !tree ? { ...hit, exists: true } : hit;
  };
  const kindOf = (href: string): LinkKind => {
    const hit = target(href);
    return !hit ? "web" : hit.exists ? "page" : "missing";
  };
  const onLink = (href: string, label: string) => {
    const hit = target(href);
    if (!hit) {
      if (/^https?:\/\//i.test(href)) void WebBrowser.openBrowserAsync(href).catch(() => {});
      else if (/^(mailto|tel):/i.test(href)) void Linking.openURL(href).catch(() => {});
      return;
    }
    if (hit.exists) return openPage(hit.path);
    if (page.generated) return;
    const name = page.missing.find((m) => m.path === hit.path)?.label || label;
    const section = sectionOf(hit.path);
    Alert.alert("Create “" + name + "”?", "No page for this yet. It goes " + (section ? "in " + folderName(section) : "at the top of the wiki") + ".", [
      { text: "Cancel", style: "cancel" },
      { text: "Create page", onPress: () => void createAt(hit.path, name, tree) },
    ]);
  };

  const editable = !page.generated;
  const shown = history ? (allVersions ? history : history.slice(0, 5)) : [];
  const backlinks = page.backlinks.filter((path) => !isGenerated(path));

  return (
    <Page>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              {editable && <BarButton title="Edit" onPress={() => editPage(page.path)} />}
              <PageMenu page={page} tree={tree} />
            </View>
          ),
        }}
      />
      <View style={{ gap: space.xs }}>
        <T variant="title1" accessibilityRole="header">
          {pageTitle(page)}
        </T>
        {!page.generated && !!page.updatedAt && (
          <T variant="footnote" color="muted">
            {page.template ? "New pages in " + folderName(folderOf(page.path)) + " start from this" : "Edited " + when(page.updatedAt)}
          </T>
        )}
      </View>
      <Prose text={page.content} onLink={onLink} kindOf={kindOf} hideTitle={!page.template} />
      {backlinks.length > 0 && (
        <View>
          <Label>Linked from</Label>
          <Group>
            {backlinks.map((path) => (
              <Row key={path} title={titleOf(path)} subtitle={sectionOf(path) ? folderName(sectionOf(path)) : undefined} onPress={() => openPage(path)} />
            ))}
          </Group>
        </View>
      )}
      {shown.length > 0 && (
        <View>
          <Label>History</Label>
          <Group>
            {shown.map((entry) => (
              <Row key={entry.id} title={dateTime(entry.time)} subtitle={"Until " + (entry.by === "You" ? "you" : entry.by) + " changed it"} chevron onPress={() => setVersion(entry)} />
            ))}
            {!allVersions && history!.length > shown.length && <Row key="all" title={"Show all " + history!.length} tone="accent" onPress={() => setAllVersions(true)} />}
          </Group>
        </View>
      )}
      {version && <VersionSheet path={page.path} version={version} onClose={() => setVersion(undefined)} />}
    </Page>
  );
}

/** Makes a page a link points at, from its section's outline, then opens it to write. */
async function createAt(path: string, title: string, tree: WikiTree | undefined) {
  try {
    const there = await api.wikiPage(path).then(
      () => true,
      () => false,
    );
    if (!there) {
      const template = tree?.pages.find((p) => p.path === sectionOf(path) + "/_template.md");
      const outline = template ? (await api.wikiPage(template.path)).content : undefined;
      await api.saveWikiPage(path, fromTemplate(outline, title));
    }
    openPage(path);
    editPage(path);
  } catch (error) {
    showToast(message(error), "error");
  }
}

function PageMenu({ page, tree }: { page: Page_; tree?: WikiTree }) {
  const { colors } = useTheme();
  const prompt = useTextPrompt();
  const fixed = page.path === GUIDE || !!page.generated;
  const movable = !fixed && !page.template;
  const here = folderOf(page.path);
  const places = [...(tree ? sections(tree) : []), ...(here ? [""] : [])].filter((folder) => folder !== here);

  const rename = () => prompt.ask({ title: "Rename page", value: page.title, confirm: "Rename", onSubmit: (title) => void renamePage(page, title) });
  const remove = () =>
    Alert.alert("Delete “" + pageTitle(page) + "”?", "Links to it will show as not written yet.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          if ((await attempt(api.deleteWiki(page.path), "Page deleted")) === undefined) return;
          router.back();
          forgetPage(page.path);
        },
      },
    ]);

  const actions = [
    ...(!page.generated && !page.template ? [{ id: "ask", title: "Ask a bot about this page", image: "bubble.left" }] : []),
    ...(movable
      ? [
          {
            id: "move",
            title: "Rename or move",
            image: "folder",
            subactions: [
              { id: "rename", title: "Rename…", image: "pencil" },
              ...places.map((folder) => ({ id: "to:" + folder, title: "Move to " + (folder ? folderName(folder) : "the top") })),
            ],
          },
        ]
      : []),
    ...(!page.generated && !page.template ? [{ id: "export", title: "Export…", image: "square.and.arrow.up" }] : []),
    ...(!fixed ? [{ id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } }] : []),
  ];
  if (!actions.length) return null;
  return (
    <>
    {prompt.node}
    <MenuView
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        const id = nativeEvent.event;
        if (id === "ask") void askAbout(page);
        else if (id === "rename") rename();
        else if (id.startsWith("to:")) void movePage(page, id.slice(3));
        else if (id === "export") exportWiki(page.path);
        else if (id === "delete") remove();
      }}
    >
      <View accessible accessibilityRole="button" accessibilityLabel="Page options" style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
        <Ellipsis size={22} color={colors.ink} strokeWidth={2.2} />
      </View>
    </MenuView>
    </>
  );
}

/** Opens the primary bot's chat with a message about the page started. */
async function askAbout(page: Page_) {
  const { bots, chats } = useApp.getState().parts;
  const bot = bots?.[0];
  if (!bot) return showToast("Add a bot first", "info");
  const latest = (chats ?? []).filter((chat) => chat.botId === bot.id && !chat.botIds && isConversation(chat)).sort((a, b) => b.time - a.time)[0];
  const id = latest?.id ?? (await attempt(api.createChat(bot.id)));
  if (!id) return;
  router.push({ pathname: "/chat/[id]", params: { id, draft: "About the wiki page “" + page.title + "” (" + page.path + "): " } });
}

/** A new title: the file is renamed to match, and the page's heading says it. */
async function renamePage(page: Page_, title: string) {
  if (!title || title === page.title) return;
  try {
    const folder = folderOf(page.path);
    const to = (folder ? folder + "/" : "") + (slug(title) || "page") + ".md";
    const path = to.toLowerCase() === page.path.toLowerCase() ? page.path : await api.moveWiki(page.path, to);
    const fresh = await api.wikiPage(path);
    await api.saveWikiPage(path, withTitle(fresh.content, title), fresh.base);
    moved(page.path, path);
    showToast("Renamed", "success");
  } catch (error) {
    showToast(message(error), "error");
  }
}

async function movePage(page: Page_, folder: string) {
  const path = await attempt(api.moveWiki(page.path, (folder ? folder + "/" : "") + fileOf(page.path)), "Moved to " + (folder ? folderName(folder) : "the top"));
  if (path) moved(page.path, path);
}

function moved(from: string, to: string) {
  if (from === to) return;
  moveCached(from, to);
  router.setParams({ path: to });
}

/** An earlier version of the page, to read and to bring back. */
function VersionSheet({ path, version, onClose }: { path: string; version: WikiVersion; onClose: () => void }) {
  // undefined while it loads, null when it couldn't be read.
  const [text, setText] = useState<string | null>();
  const [restoring, setRestoring] = useState(false);
  useEffect(() => {
    let live = true;
    api.wikiVersion(path, version.id).then(
      (content) => live && setText(content),
      () => live && setText(null),
    );
    return () => {
      live = false;
    };
  }, [path, version.id]);

  const restore = () =>
    Alert.alert("Restore this version?", "The page as it is now is kept in its history.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Restore",
        onPress: async () => {
          setRestoring(true);
          const done = await attempt(api.restoreWikiVersion(path, version.id), "Restored");
          setRestoring(false);
          if (done) onClose();
        },
      },
    ]);

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Sheet title={dateTime(version.time)} action="Restore" onAction={restore} actionDisabled={text == null} actionLoading={restoring} onClose={onClose}>
        {text === undefined ? <Loading /> : text === null ? <EmptyState title="Couldn't read this version" /> : <Prose text={text} />}
      </Sheet>
    </Modal>
  );
}
