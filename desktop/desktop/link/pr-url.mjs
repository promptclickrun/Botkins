// Accept only github.com pull request permalinks. Return the canonical overview URL.
export function pullRequestUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  const match = /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]{1,100})\/pull\/([1-9]\d{0,8})(?:\/(?:files|commits))?\/?(?:#[^\s]*)?$/i.exec(value);
  if (!match || match[2] === "." || match[2] === "..") return null;
  const repository = match[1] + "/" + match[2];
  return { repository, number: Number(match[3]), url: "https://github.com/" + repository + "/pull/" + match[3] };
}
