import { useEffect, useState } from "react";
import type { Calls } from "../desktop/remote/client/types";
import { DiffView } from "./ProjectChanges";
import { RichText } from "./RichText";

function FilePatch({ url, path }: { url: string; path: string }) {
  const [answer, setAnswer] = useState<ReturnType<Calls["link.pullRequestDiff"]>>();
  useEffect(() => {
    let live = true;
    window.botkins["link.pullRequestDiff"]({ url, path }).then(
      (result) => live && setAnswer(result),
      () => live && setAnswer({ available: false, reason: "Couldn't load the diff." }),
    );
    return () => { live = false; };
  }, [url, path]);
  return answer?.available ? <DiffView text={answer.text} /> : <p role="status">{answer?.reason ?? "Loading diff…"}</p>;
}

export function PullRequestPanel({ url }: { url: string }) {
  const [answer, setAnswer] = useState<ReturnType<Calls["link.pullRequest"]>>();
  const [path, setPath] = useState("");
  useEffect(() => {
    let live = true;
    window.botkins["link.pullRequest"]({ url }).then(
      (result) => live && setAnswer(result),
      () => live && setAnswer({ available: false, reason: "Couldn't load the pull request." }),
    );
    return () => { live = false; };
  }, [url]);
  const pr = answer?.available ? answer.pull : undefined;
  return <section className="pr-panel" aria-label="Pull request">
    <button className="textbutton" onClick={() => void window.botkins.openLink(url)}>Open on GitHub</button>
    {pr ? <>
      <h2>{pr.title} <small>#{pr.number}</small></h2>
      <p><span className="badge">{pr.state === "open" && pr.draft ? "draft" : pr.state}</span>{pr.author && " · " + pr.author}</p>
      <p>{pr.head} → {pr.base}</p>
      <small>Created {new Date(pr.createdAt).toLocaleString()}{pr.updatedAt && <> · Updated {new Date(pr.updatedAt).toLocaleString()}</>}</small>
      <h3>Description</h3><RichText text={pr.body || "No description."} />
      <h3>Checks · {pr.summary}</h3>
      {pr.checks.map((check, i) => <p key={i}>{check.name} · {check.result}</p>)}
      <h3>Review</h3><p>{pr.review}</p>
      <h3>Changed files · {pr.files.length}</h3>
      <ul className="pc-files">{pr.files.map((file) => <li key={file.path}>
        <button className="textbutton" aria-expanded={path === file.path} onClick={() => setPath(path === file.path ? "" : file.path)}>
          <span className="pc-path" title={file.path}>{file.path}</span>
          <b className="diff-add">+{file.additions}</b><b className="diff-del">−{file.deletions}</b>
        </button>
        {path === file.path && <FilePatch url={url} path={path} />}
      </li>)}</ul>
    </> : <p role="status">{answer && !answer.available ? answer.reason : "Loading pull request…"}</p>}
  </section>;
}
