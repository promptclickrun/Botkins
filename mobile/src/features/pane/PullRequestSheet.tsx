import { useEffect, useState } from "react";
import { View } from "react-native";
import type { Calls } from "@/link/types";
import { api } from "@/state/link";
import { Badge, Group, Markdown, Row, Sheet, T, space } from "@/ui";
import { openLink } from "@/ui/LinkHold";
import { DiffView } from "../chat/Changes";

function FilePatch({ url, path }: { url: string; path: string }) {
  const [answer, setAnswer] = useState<ReturnType<Calls["link.pullRequestDiff"]>>();
  useEffect(() => {
    let live = true;
    api["link.pullRequestDiff"]({ url, path }).then(
      (result) => live && setAnswer(result),
      () => live && setAnswer({ available: false, reason: "Couldn't load the diff." }),
    );
    return () => { live = false; };
  }, [url, path]);
  return answer?.available ? <DiffView text={answer.text} /> : <T>{answer?.reason ?? "Loading diff…"}</T>;
}

export function PullRequestSheet({ url }: { url: string }) {
  const [answer, setAnswer] = useState<ReturnType<Calls["link.pullRequest"]>>();
  const [path, setPath] = useState("");
  useEffect(() => {
    let live = true;
    api["link.pullRequest"]({ url }).then(
      (result) => live && setAnswer(result),
      () => live && setAnswer({ available: false, reason: "Couldn't load the pull request." }),
    );
    return () => { live = false; };
  }, [url]);
  const pr = answer?.available ? answer.pull : undefined;
  return <Sheet title="Pull request">
    <Row title="Open on GitHub" chevron onPress={() => openLink(url)} />
    {pr ? <View style={{ gap: space.md }}>
      <T variant="title2">{pr.title} #{pr.number}</T>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Badge label={pr.state === "open" && pr.draft ? "draft" : pr.state} />
        {!!pr.author && <T>{pr.author}</T>}
      </View>
      <T>{pr.head} → {pr.base}</T>
      <T variant="footnote" color="muted">Created {new Date(pr.createdAt).toLocaleString()}{pr.updatedAt && " · Updated " + new Date(pr.updatedAt).toLocaleString()}</T>
      <T variant="headline">Description</T><Markdown text={pr.body || "No description."} />
      <T variant="headline">Checks · {pr.summary}</T>
      {!!pr.checks.length && <Group>{pr.checks.map((check, i) => <Row key={i} title={check.name} value={check.result} />)}</Group>}
      <T variant="headline">Review</T><T>{pr.review}</T>
      <T variant="headline">Changed files · {pr.files.length}</T>
      <Group>{pr.files.map((file) => <View key={file.path}>
        <Row title={file.path} value={"+" + file.additions + " −" + file.deletions} onPress={() => setPath(path === file.path ? "" : file.path)} />
        {path === file.path && <FilePatch url={url} path={path} />}
      </View>)}</Group>
    </View> : <T>{answer && !answer.available ? answer.reason : "Loading pull request…"}</T>}
  </Sheet>;
}
