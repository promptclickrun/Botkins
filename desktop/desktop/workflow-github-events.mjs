// Canonical GitHub trigger event types, legacy event migration, multi-repo normalization,
// trigger filter evaluation, and 24-field event payload builder.
// Kept separate from workflow-github.mjs so P1 (relay ingress / persisted cursors) and P2
// (expanded triggers + native GitHub output) stay cleanly decoupled.

import { findMentionInText, parseMentionHandles } from "./workflow-github.mjs";

export const WORKFLOW_GITHUB_EVENTS = [
  "issue.opened",
  "issue.closed",
  "issue.labeled",
  "pr.opened",
  "pr.updated",
  "pr.reviewRequested",
  "pr.reviewSubmitted",
  "pr.checksFailed",
  "pr.merged",
  "comment",
  "mention",
  "assigned",
];

export const WORKFLOW_GITHUB_EVENT_SET = new Set(WORKFLOW_GITHUB_EVENTS);
export const WORKFLOW_GITHUB_REPOS_LIMIT = 100;
export const WORKFLOW_GITHUB_FILTERS = ["notBot", "firstTime", "title", "branch"];

/** Maps legacy Botkins event names to canonical event names (one legacy event may map to 1+ canonical events). */
export const LEGACY_GITHUB_EVENT_MAP = {
  pr_opened: ["pr.opened"],
  pr_updated: ["pr.updated", "pr.merged"],
  pr_review: ["pr.reviewSubmitted"],
  ci_status: ["pr.checksFailed"],
  issue_opened: ["issue.opened"],
  issue_updated: ["issue.closed", "issue.labeled"],
  issue_comment: ["comment"],
  user_mentioned: ["mention"],
  bot_mentioned: ["mention"],
};

const CANONICAL_BY_LOWER = new Map(WORKFLOW_GITHUB_EVENTS.map((ev) => [ev.toLowerCase(), ev]));
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const FIRST_TIME_ASSOCIATIONS = new Set(["FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR"]);
const FAILING_CHECK_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

/**
 * Normalizes a GitHub trigger's `repos` / `repositories` / legacy single `repo` fields into a
 * deduplicated (case-insensitive) array of valid `owner/repo` strings, capped at 100.
 */
export function normalizeGithubRepos(config = {}) {
  const candidates = [];
  if (Array.isArray(config?.repos)) candidates.push(...config.repos);
  else if (typeof config?.repos === "string" && config.repos.trim()) candidates.push(...config.repos.split(/[\n,]+/));
  if (Array.isArray(config?.repositories)) candidates.push(...config.repositories);
  else if (typeof config?.repositories === "string" && config.repositories.trim()) {
    candidates.push(...config.repositories.split(/[\n,]+/));
  }
  if (typeof config?.repo === "string" && config.repo.trim()) {
    candidates.push(...config.repo.split(/[\n,]+/));
  }

  const seen = new Set();
  const out = [];
  for (const raw of candidates) {
    const cleaned = String(raw ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned || !REPO_RE.test(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= WORKFLOW_GITHUB_REPOS_LIMIT) break;
  }
  return out;
}

/**
 * Maps a single canonical or legacy event name to an array of canonical event names.
 * Returns `[]` if unrecognized.
 */
export function mapGithubEventName(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  const canonical = CANONICAL_BY_LOWER.get(s.toLowerCase());
  if (canonical) return [canonical];
  const mapped = LEGACY_GITHUB_EVENT_MAP[s.toLowerCase()];
  return mapped ? [...mapped] : [];
}

/**
 * Normalizes a GitHub trigger's event list into canonical event names, preserving legacy event
 * mappings so saved workflows continue to work unchanged.
 * Returns `{ canonical: string[], legacy: string[], explicit: boolean }`.
 */
export function normalizeGithubEvents(rawEvents) {
  const rawList = Array.isArray(rawEvents)
    ? rawEvents.map((s) => String(s ?? "").trim()).filter(Boolean)
    : typeof rawEvents === "string" && rawEvents.trim()
      ? rawEvents.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

  if (!rawList.length) {
    return { canonical: [], legacy: [], explicit: false };
  }

  const canonical = [];
  const legacy = [];
  const seen = new Set();
  for (const raw of rawList) {
    const low = raw.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LEGACY_GITHUB_EVENT_MAP, low)) {
      if (!legacy.includes(low)) legacy.push(low);
    }
    for (const mapped of mapGithubEventName(raw)) {
      if (!seen.has(mapped)) {
        seen.add(mapped);
        canonical.push(mapped);
      }
    }
  }
  return { canonical, legacy, explicit: true };
}

/** Normalizes a label list (array of strings/objects or comma/newline-separated string). */
export function normalizeLabelList(raw) {
  const items = Array.isArray(raw)
    ? raw.map((l) => (typeof l === "string" ? l : l?.name ?? ""))
    : typeof raw === "string" && raw.trim()
      ? raw.split(/[\n,]+/)
      : [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const s = String(item ?? "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Normalizes an assignee list (array of strings/user objects or comma-separated string). */
export function normalizeAssigneeList(raw) {
  const items = Array.isArray(raw)
    ? raw.map((u) => (typeof u === "string" ? u : u?.login ?? ""))
    : typeof raw === "string" && raw.trim()
      ? raw.split(/[\n,]+/)
      : [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const s = String(item ?? "").trim().replace(/^@/, "");
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Migrates a GitHub trigger node's `config` in place / returns normalized copy:
 * - populates `repos[]` from `repos`, `repositories`, or legacy `repo` (keeping `repo: repos[0]` for older UIs)
 * - migrates legacy `events` to canonical names while preserving legacy semantics when explicitly configured
 * - normalizes `labels[]`, `notBot` (default true), `firstTime`, `titleContains` / `titleText`, `baseBranch`, `filters[]`
 */
export function normalizeGithubTriggerConfig(rawConfig = {}) {
  const cfg = rawConfig && typeof rawConfig === "object" ? structuredClone(rawConfig) : {};
  if (rawConfig && !Array.isArray(rawConfig.repos) && !Array.isArray(rawConfig.repositories) && typeof rawConfig.repo === "string" && rawConfig.repo.trim()) {
    cfg._legacyRepoOnly = true;
  }
  const repos = normalizeGithubRepos(cfg);
  if (repos.length) {
    cfg.repos = repos;
    cfg.repo = repos[0];
  } else if (Array.isArray(cfg.repos)) {
    cfg.repos = [];
  }

  const evInfo = normalizeGithubEvents(cfg.events);
  if (evInfo.explicit) {
    // Preserve raw legacy list if any legacy names were supplied so poll-mode emits legacy event names when expected,
    // while canonical `events` holds the normalized canonical event names.
    if (evInfo.legacy.length && !Array.isArray(cfg._legacyEvents)) {
      cfg._legacyEvents = evInfo.legacy;
    }
    if (evInfo.canonical.length) {
      cfg.events = evInfo.canonical;
    }
  }

  // Normalize labels
  if (cfg.labels !== undefined) {
    cfg.labels = normalizeLabelList(cfg.labels);
  }

  // Normalize boolean / filter-array settings: `notBot` defaults ON unless explicitly disabled
  const hasFiltersArray = Array.isArray(cfg.filters);
  const filtersSet = new Set(hasFiltersArray ? cfg.filters.map((f) => String(f).trim()) : []);
  if (cfg.notBot === undefined) {
    cfg.notBot = hasFiltersArray ? filtersSet.has("notBot") : true;
  } else {
    cfg.notBot = Boolean(cfg.notBot);
  }
  if (cfg.firstTime === undefined && hasFiltersArray) {
    cfg.firstTime = filtersSet.has("firstTime");
  } else if (cfg.firstTime !== undefined) {
    cfg.firstTime = Boolean(cfg.firstTime);
  }

  if (cfg.titleContains === undefined && typeof cfg.titleText === "string") {
    cfg.titleContains = cfg.titleText.trim();
  } else if (typeof cfg.titleContains === "string") {
    cfg.titleContains = cfg.titleContains.trim();
  }
  if (typeof cfg.baseBranch === "string") {
    cfg.baseBranch = cfg.baseBranch.trim();
  }

  // Normalize mention handles (both legacy `mentionHandle` string and `mentionHandles[]` array)
  if (Array.isArray(cfg.mentionHandles)) {
    cfg.mentionHandles = cfg.mentionHandles
      .map((h) => String(h ?? "").trim().replace(/^@+/, "").toLowerCase())
      .filter((h) => /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(h));
  }

  return cfg;
}

/** Detects whether a GitHub user object or login looks like a bot account. */
export function isGithubBotActor(userOrLogin, explicitType = "") {
  if (explicitType && String(explicitType).toLowerCase() === "bot") return true;
  if (userOrLogin && typeof userOrLogin === "object") {
    if (String(userOrLogin.type || "").toLowerCase() === "bot") return true;
    const login = String(userOrLogin.login || "").toLowerCase();
    if (login.endsWith("[bot]")) return true;
    return false;
  }
  const login = String(userOrLogin || "").trim().toLowerCase();
  return login.endsWith("[bot]");
}

/**
 * Evaluates all GitHub trigger filters against a normalized GitHub event payload + metadata.
 * Returns `{ pass: true }` or `{ pass: false, reason: string }`.
 */
export function evaluateGithubTriggerFilters(config = {}, eventPayload = {}, meta = {}) {
  const cfg = normalizeGithubTriggerConfig(config);

  // 1. Repository match (case-insensitive)
  const repos = normalizeGithubRepos(cfg);
  if (repos.length) {
    const evRepo = String(eventPayload.repository || eventPayload.repo || "").trim().toLowerCase();
    if (!evRepo || !repos.some((r) => r.toLowerCase() === evRepo)) {
      return { pass: false, reason: "repo" };
    }
  }

    const evInfo = normalizeGithubEvents(cfg.events);
    if (evInfo.explicit && evInfo.canonical.length) {
      const incomingCanonical = mapGithubEventName(eventPayload.event);
      const matches = incomingCanonical.some((c) => evInfo.canonical.includes(c));
      if (!matches) return { pass: false, reason: "event" };
    }

  // 3. notBot filter (default true)
  const notBotEnabled = cfg.notBot !== false;
  if (notBotEnabled) {
    const senderBot = isGithubBotActor(meta.sender ?? eventPayload.sender, meta.senderType);
    const authorBot = isGithubBotActor(meta.author ?? eventPayload.author, meta.authorType);
    if (senderBot || authorBot) return { pass: false, reason: "notBot" };
  }

  // 4. firstTime contributor filter
  if (cfg.firstTime === true) {
    const assoc = String(eventPayload.author_association || "").toUpperCase();
    if (!FIRST_TIME_ASSOCIATIONS.has(assoc)) return { pass: false, reason: "firstTime" };
  }

  // 5. labels filter (active when non-empty; matches added_label on issue.labeled, else any item label)
  const wantedLabels = normalizeLabelList(cfg.labels);
  if (wantedLabels.length) {
    const wantedLow = new Set(wantedLabels.map((l) => l.toLowerCase()));
    const canonicalEv = mapGithubEventName(eventPayload.event)[0] || eventPayload.event;
    if (canonicalEv === "issue.labeled") {
      const added = String(eventPayload.added_label || "").trim().toLowerCase();
      if (!added || !wantedLow.has(added)) return { pass: false, reason: "labels" };
    } else {
      const itemLabels = normalizeLabelList(eventPayload.labels);
      if (!itemLabels.some((l) => wantedLow.has(l.toLowerCase()))) return { pass: false, reason: "labels" };
    }
  }

  // 6. title contains filter (case-insensitive substring)
  const titleNeedle = String(cfg.titleContains || cfg.titleText || "").trim();
  const titleFilterActive = Boolean(titleNeedle) && (!Array.isArray(cfg.filters) || cfg.filters.includes("title") || Boolean(cfg.titleContains));
  if (titleFilterActive && titleNeedle) {
    const title = String(eventPayload.title || "");
    if (!title.toLowerCase().includes(titleNeedle.toLowerCase())) return { pass: false, reason: "title" };
  }

  // 7. baseBranch filter (exact match against PR base_branch for pr.* events)
  const baseBranch = String(cfg.baseBranch || "").trim();
  const baseFilterActive = Boolean(baseBranch) && (!Array.isArray(cfg.filters) || cfg.filters.includes("branch") || Boolean(cfg.baseBranch));
  if (baseFilterActive && baseBranch) {
    const canonicalEv = mapGithubEventName(eventPayload.event)[0] || eventPayload.event;
    const isPrEvent = Boolean(eventPayload.pull_request) || String(canonicalEv).startsWith("pr.");
    if (isPrEvent) {
      if (String(eventPayload.base_branch || "") !== baseBranch) return { pass: false, reason: "baseBranch" };
    }
  }

  // 8. Legacy head-branch substring filter (`config.branch`) and exact author filter (`config.author`)
  const headBranchFilter = String(cfg.branch || "").trim().toLowerCase();
  if (headBranchFilter && (eventPayload.pull_request || eventPayload.item_type === "pr")) {
    const headBranch = String(eventPayload.head_branch || eventPayload.branch || "").toLowerCase();
    if (!headBranch.includes(headBranchFilter)) return { pass: false, reason: "branch" };
  }
  const authorFilter = String(cfg.author || "").trim().toLowerCase();
  if (authorFilter) {
    const author = String(eventPayload.author || "").toLowerCase();
    if (author !== authorFilter) return { pass: false, reason: "author" };
  }

  return { pass: true };
}

/**
 * Builds the 24-field canonical GitHub trigger payload (plus legacy aliases `repo`, `branch`,
 * `ci_status`, `item_type` so existing saved templates keep working).
 */
export function buildGithubTriggerPayload(repo, event, item = {}, opts = {}) {
  const labelsList = Array.isArray(opts.labelsList)
    ? normalizeLabelList(opts.labelsList)
    : normalizeLabelList(opts.labels ?? item.labels);
  const assigneesList = Array.isArray(opts.assigneesList)
    ? normalizeAssigneeList(opts.assigneesList)
    : normalizeAssigneeList(opts.assignees ?? item.assignees);
  const author =
    typeof opts.author === "string"
      ? opts.author
      : typeof item.author === "string"
        ? item.author
        : item.author?.login || item.user?.login || "";
  const sender =
    typeof opts.sender === "string"
      ? opts.sender
      : typeof item.sender === "string"
        ? item.sender
        : item.sender?.login || author;
  const pullRequest =
    typeof opts.pullRequest === "boolean"
      ? opts.pullRequest
      : opts.itemType === "pr" || Boolean(item.pull_request || item.headRefName || item.baseRefName || item.base?.ref);
  const headBranch = opts.headBranch ?? item.headRefName ?? item.head?.ref ?? item.branch ?? "";
  const baseBranch = opts.baseBranch ?? item.baseRefName ?? item.base?.ref ?? "";
  const headSha = opts.headSha ?? item.headRefOid ?? item.head?.sha ?? "";
  const state = String(opts.state ?? item.state ?? "open").toLowerCase();
  const merged =
    typeof opts.merged === "boolean"
      ? opts.merged
      : Boolean(item.merged || item.mergedAt || item.merged_at || state === "merged");
  const reviewState = String(opts.reviewState ?? opts.review ?? item.reviewDecision ?? item.review?.state ?? "").toLowerCase();
  const reviewBody = String(opts.reviewBody ?? item.review?.body ?? "");
  const isComment = opts.itemType === "comment" || event === "comment" || event === "issue_comment";
  const commentBody = String(opts.commentBody ?? (isComment ? item.body || "" : ""));
  const commentUrl = String(opts.commentUrl ?? (isComment ? item.url || item.html_url || "" : ""));
  const checkConclusion = String(opts.checkConclusion ?? opts.ci ?? "").toLowerCase();
  const authorAssociation = String(opts.authorAssociation ?? item.authorAssociation ?? item.author_association ?? "").toUpperCase();
  const addedLabel = String(opts.addedLabel ?? "");
  const mention = String(opts.mention ?? "");
  const itemType = opts.itemType || (isComment ? "comment" : pullRequest ? "pr" : "issue");

  return {
    // 24 canonical typed fields
    event,
    repository: repo,
    number: Number(item.number) || 0,
    pull_request: pullRequest,
    title: String(item.title || ""),
    body: String(item.body || ""),
    url: String(item.url || item.html_url || ""),
    state,
    author,
    sender,
    author_association: authorAssociation,
    labels: labelsList,
    added_label: addedLabel,
    assignees: assigneesList,
    base_branch: String(baseBranch),
    head_branch: String(headBranch),
    head_sha: String(headSha),
    merged,
    review_state: reviewState,
    review_body: reviewBody,
    comment_body: commentBody,
    comment_url: commentUrl,
    check_conclusion: checkConclusion,
    mention,
    // Legacy compatibility aliases (kept in context so old saved templates continue to resolve)
    repo,
    branch: String(headBranch),
    ci_status: opts.ci ?? (checkConclusion || "none"),
    item_type: itemType,
  };
}

/** Checks whether a check_suite / statusCheckRollup indicates a failing check conclusion. */
export function extractFailingCheckConclusion(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return "";
  for (const item of rollup) {
    const c = String(item?.conclusion || item?.state || "").toLowerCase();
    if (FAILING_CHECK_CONCLUSIONS.has(c)) return c;
    if (c === "error") return "failure";
  }
  return "";
}

/**
 * Normalizes a raw GitHub webhook payload `(rawEvent, payload)` into 0..N canonical candidate events.
 * Useful both for direct webhook delivery and tests.
 */
export function normalizeRawGithubWebhook(rawEvent, payload = {}, options = {}) {
  const repo = payload?.repository?.full_name || "";
  if (!repo) return [];
  const action = String(payload?.action || "").toLowerCase();
  const sender = payload?.sender || {};
  const mentionHandles = Array.isArray(options.mentionHandles)
    ? options.mentionHandles
    : parseMentionHandles(options.mentionHandle, "");

  const candidates = [];
  const pushWithMention = (ev, item, extra = {}) => {
    const base = buildGithubTriggerPayload(repo, ev, item, {
      sender: sender.login || "",
      ...extra,
    });
    candidates.push({
      event: ev,
      payload: base,
      sender,
      author: item.user || item.author || {},
    });
    const textForMention = extra.mentionText ?? `${item.title || ""}\n${item.body || ""}`;
    if (mentionHandles.length && textForMention) {
      const hit = findMentionInText(textForMention, mentionHandles);
      if (hit) {
        candidates.push({
          event: "mention",
          payload: buildGithubTriggerPayload(repo, "mention", item, {
            sender: sender.login || "",
            ...extra,
            mention: hit,
          }),
          sender,
          author: item.user || item.author || {},
        });
      }
    }
  };

  if (rawEvent === "issues" && payload.issue) {
    const issue = payload.issue;
    const common = { pullRequest: Boolean(issue.pull_request), itemType: "issue" };
    if (action === "opened") pushWithMention("issue.opened", issue, common);
    else if (action === "closed") pushWithMention("issue.closed", issue, { ...common, state: "closed" });
    else if (action === "labeled") {
      pushWithMention("issue.labeled", issue, { ...common, addedLabel: payload.label?.name || "" });
    } else if (action === "assigned") {
      pushWithMention("assigned", issue, common);
    }
  } else if (rawEvent === "pull_request" && payload.pull_request) {
    const pr = payload.pull_request;
    const common = { pullRequest: true, itemType: "pr" };
    if (action === "opened") pushWithMention("pr.opened", pr, common);
    else if (action === "synchronize" || action === "edited") pushWithMention("pr.updated", pr, common);
    else if (action === "review_requested") pushWithMention("pr.reviewRequested", pr, common);
    else if (action === "assigned") pushWithMention("assigned", pr, common);
    else if (action === "closed" && pr.merged === true) {
      pushWithMention("pr.merged", pr, { ...common, merged: true, state: "merged" });
    }
  } else if (rawEvent === "pull_request_review" && payload.pull_request && payload.review) {
    if (action === "submitted") {
      const pr = payload.pull_request;
      const review = payload.review;
      pushWithMention("pr.reviewSubmitted", pr, {
        pullRequest: true,
        itemType: "pr",
        reviewState: String(review.state || "").toLowerCase(),
        reviewBody: review.body || "",
        mentionText: review.body || "",
        author: review.user?.login || pr.user?.login || "",
      });
    }
  } else if (rawEvent === "issue_comment" && payload.issue && payload.comment) {
    if (action === "created") {
      const issue = payload.issue;
      const comment = payload.comment;
      pushWithMention(
        "comment",
        {
          ...issue,
          body: comment.body || "",
          user: comment.user,
          author_association: comment.author_association ?? issue.author_association,
        },
        {
          pullRequest: Boolean(issue.pull_request),
          itemType: "comment",
          commentBody: comment.body || "",
          commentUrl: comment.html_url || "",
          mentionText: comment.body || "",
          author: comment.user?.login || "",
        },
      );
    }
  } else if (rawEvent === "check_suite" && payload.check_suite) {
    const suite = payload.check_suite;
    const conclusion = String(suite.conclusion || "").toLowerCase();
    if (action === "completed" && FAILING_CHECK_CONCLUSIONS.has(conclusion)) {
      const prs = Array.isArray(suite.pull_requests) ? suite.pull_requests : [];
      for (const pr of prs) {
        pushWithMention("pr.checksFailed", pr, {
          pullRequest: true,
          itemType: "pr",
          headBranch: pr.head?.ref || suite.head_branch || "",
          baseBranch: pr.base?.ref || "",
          headSha: pr.head?.sha || suite.head_sha || "",
          checkConclusion: conclusion,
        });
      }
    }
  }

  return candidates;
}
