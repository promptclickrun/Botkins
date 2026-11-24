// A proactive skill is a reusable way to turn particular sources into a suggestion.
// Recipes contain only known operations and source types. Feedback can change which
// ones the bot tries, without writing to its profile, installed skills or permissions.
import { createHash } from "node:crypto";

export const METHODS = {
  prepare: "Work back from a commitment to something the person can prepare ahead of time.",
  connect: "Connect two facts the person encountered separately and explain the implication.",
  discover: "Find an opportunity to pursue a stated interest or goal, including one they haven't asked about.",
  unblock: "Identify a dependency and suggest the smallest next step that would unblock it.",
  alert: "Identify a material change or deadline and what the person can do about it.",
};
// The model may compose a short procedure out of these checks. Only the step IDs
// survive a run, so fetched text can never become instructions in a learned skill.
export const SKILL_STEPS = {
  window: "Find a usable window before a commitment.",
  prerequisite: "Identify a prerequisite and verify that it is still outstanding.",
  recurrence: "Check whether a pattern recurs on separate occasions.",
  fit: "Test an opportunity against the person's stated constraints.",
  alternatives: "Compare feasible options against the person's priorities.",
  change: "Find what has changed since the person last considered this.",
};
const SOURCES = { goal: "open goals", memory: "saved memory", chat: "past conversations", signal: "Botkins activity", live: "a connected source" };
const METHOD_LABELS = { prepare: "Preparation", connect: "Connections", discover: "Discovery", unblock: "Unblocking work", alert: "Alerts" };
export const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 20);
const normalized = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const probability = (p) => Math.min(.98, Math.max(.02, p));
const MIN_RATINGS = 6;
const PROMOTION_MARGIN = 0.005;
const WINDOW = 80; // Delivered suggestions. Quiet checks do not evict feedback.

// Predict a helpful vote. Starting with small, explicit priors lets the first run
// rank candidates too. All adjustable coefficients are small integer steps from that prior.
function score(features, weights) {
  let p = .50;
  if (features.includes("personal")) p += .10;
  if (features.includes("combined")) p += .09;
  if (features.includes("timely")) p += .12;
  for (const name of features) p += (weights[name] ?? 0) * .05;
  return probability(p);
}

function loss(examples, weights) {
  return examples.reduce((sum, row) => sum + (score(row.features, weights) - Number(row.vote === "up")) ** 2, 0) / examples.length;
}

/** Coordinate hill climbing on mean squared prediction error. Take the single best
 * improving neighbour each step. Validate the finished policy once on the newest third.
 * Replay from the prior when votes change so replacing or removing a vote undoes its effect. */
export function fitPolicy(history, incumbent = {}) {
  const rated = history.filter((row) => row.vote === "up" || row.vote === "down");
  if (rated.length < MIN_RATINGS) return { weights: {}, evaluation: null };
  const split = Math.floor(rated.length * 2 / 3);
  const training = rated.slice(0, split);
  const validation = rated.slice(split);
  const features = new Set(training.flatMap((row) => row.features));
  const axes = [...features].filter((name) => training.filter((row) => row.features.includes(name)).length >= 2);
  const objective = (weights) => loss(training, weights) + .002 * Object.values(weights).reduce((sum, n) => sum + n * n, 0);
  let weights = {};
  let best = objective(weights);
  for (;;) {
    let next = weights;
    for (const name of axes) {
      for (const delta of [-1, 1]) {
        const n = (weights[name] ?? 0) + delta;
        if (Math.abs(n) > 4) continue;
        const candidate = { ...weights, [name]: n };
        const value = objective(candidate);
        if (value < best - 1e-6) {
          best = value;
          next = candidate;
        }
      }
    }
    if (next === weights) break;
    weights = next;
  }
  const baseline = loss(validation, {});
  const challenger = loss(validation, weights);
  const previous = loss(validation, incumbent);
  const keepPrevious = previous + PROMOTION_MARGIN < baseline;
  const promoted = challenger + PROMOTION_MARGIN < (keepPrevious ? previous : baseline);
  return {
    weights: promoted ? weights : keepPrevious ? incumbent : {},
    evaluation: { trained: training.length, tested: validation.length, baseline, previous, challenger, promoted },
  };
}

const recipeKey = (method, sources, steps) => [method, sources.join("+"), steps.join(">")].join(":");
const recipeLabel = (method, sources, steps) =>
  METHOD_LABELS[method] + " from " + sources.map((s) => SOURCES[s]).join(" and ") + (steps.length ? " · " + steps.join(" → ") : "");

/** Identical recipes merge across runs. Two independent votes with a two-vote lead
 * promote or retire one. A changed vote or an aging example can bring it back to trial. */
export function skillCatalog(history) {
  const recipes = new Map();
  for (const { method, sources, steps = [], vote } of history) {
    const key = recipeKey(method, sources, steps);
    if (!recipes.has(key)) recipes.set(key, { key, method, sources, steps, label: recipeLabel(method, sources, steps), up: 0, down: 0 });
    if (vote) recipes.get(key)[vote]++;
  }
  return [...recipes.values()].map((r) => ({ ...r, status: r.up - r.down >= 2 ? "preferred" : r.down - r.up >= 2 ? "retired" : "trial" }));
}

const shortText = (value, limit) => typeof value === "string" && value.trim().length <= limit ? value.trim() : "";

/** A malformed answer is a failed check. Its inputs may be tried again on the next tick. */
export function proposalsFrom(reply) {
  if (reply == null || (typeof reply === "string" && ["", "[SILENT]"].includes(reply.trim()))) return { candidates: [] };
  if (typeof reply === "string" && reply.length <= 16000) {
    try {
      const { candidates, revisit } = JSON.parse(reply.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1"));
      if (Array.isArray(candidates) && candidates.length <= 4) return { candidates, revisit };
    } catch {
      // Report the format error without copying rejected proposals into the run log.
    }
  }
  throw new Error("The model didn't return a list of proactive suggestions. The next check can try again.");
}

/** A one-shot review retains pointers, never the deferred idea or the source text.
 * It must name personal evidence still available at delivery, and a specific future instant. */
export function reviewFrom(revisit, evidence, now) {
  if (typeof revisit?.at !== "string" || !/T.*(?:Z|[+-]\d\d:\d\d)$/i.test(revisit.at)) return null;
  const at = Date.parse(revisit.at);
  if (!Number.isFinite(at) || at < now + 3600_000 || at > now + 30 * 86400_000) return null;
  const refs = revisit.refs;
  if (!Array.isArray(refs) || !refs.length || refs.length > 4) return null;
  const personal = new Set(evidence.filter((e) => ["chat", "memory", "goal"].includes(e.kind)).map((e) => e.id));
  if (refs.some((id) => !personal.has(id))) return null;
  const ids = [...new Set(refs)].sort();
  return { at, refs: ids, key: "review:" + digest(ids.join("\n")) };
}

/**
 * The one thing a candidate offers to do for the person: a short label for a button, and the request the
 * bot is sent when the person takes it. Anything else is no offer; the suggestion itself still stands.
 */
export function offerFrom(offer) {
  const label = shortText(offer?.label, 60);
  const prompt = shortText(offer?.prompt, 1200);
  return label && prompt && !label.includes("\n") ? { label, prompt } : null;
}

/** Select at most one grounded suggestion. The model supplies the ideas, never the score,
 * votes or source types. Unknown evidence, weak candidates and repeats cannot reach delivery. */
export function selectSuggestion(proposals, evidence, learning, recent = []) {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const history = learning?.history ?? [];
  const catalog = new Map(skillCatalog(history).map((r) => [r.key, r]));
  let winner = null;
  for (const proposal of proposals) {
    if (typeof proposal?.method !== "string" || !Object.hasOwn(METHODS, proposal.method)) continue;
    const { method, refs, steps = [] } = proposal;
    if (!Array.isArray(steps) || steps.length > 3 || steps.some((s) => typeof s !== "string" || !Object.hasOwn(SKILL_STEPS, s)) || new Set(steps).size !== steps.length) continue;
    if (!Array.isArray(refs) || !refs.length || refs.length > 4 || refs.some((id) => !byId.has(id))) continue;
    const facts = [...new Set(refs)].map((id) => byId.get(id));
    if (method === "connect" && facts.length < 2) continue;
    const sources = [...new Set(facts.map((e) => e.kind))].sort();
    const recipe = catalog.get(recipeKey(method, sources, steps));
    if (recipe?.status === "retired") continue;
    const title = shortText(proposal.title, 120);
    const why = shortText(proposal.why, 600);
    const next = shortText(proposal.next, 300);
    if (!title || !why || !next || title.includes("\n")) continue;
    const key = digest(facts.map((e) => e.key).sort().join("\n"));
    const wording = digest(normalized(title + " " + why + " " + next));
    if (recent.some((row) => row.key === key || row.wording === wording)) continue;
    const features = [method, ...steps];
    if (sources.some((s) => ["memory", "chat", "goal"].includes(s))) features.push("personal");
    for (const e of facts) if (e.kind === "memory" || e.kind === "goal") features.push(e.id);
    if (sources.length > 1) features.push("combined");
    if (sources.includes("signal") || (sources.includes("live") && proposal.timeSensitive === true)) features.push("timely");
    const priority = probability(score(features, learning?.weights ?? {}) + (recipe?.status === "preferred" ? .04 : 0));
    // One current source can justify a timely alert. A general idea needs a personal anchor.
    if (priority < .55 || (winner && priority <= winner.priority)) continue;
    winner = {
      priority, text: [title, why, next].join("\n\n"), refs, offer: offerFrom(proposal.offer),
      example: { method, sources, steps, features, key, wording, score: Math.round(priority * 100) },
    };
  }
  return winner;
}

export function rememberSuggestion(gate, runId, example) {
  const learning = gate.learning ??= { history: [], weights: {} };
  if (learning.history.some((r) => r.runId === runId)) return;
  learning.history.push({ runId, ...example });
  if (learning.history.length > WINDOW) {
    const evicted = learning.history.shift();
    if (evicted.vote) Object.assign(learning, fitPolicy(learning.history));
  }
}

export function rateSuggestion(learning, runId, vote) {
  if (!learning) return;
  const index = learning.history.findIndex((r) => r.runId === runId);
  const row = learning.history[index];
  if (!row || row.vote === vote) return;
  // Only a newly appended label leaves the incumbent's training split intact.
  // A correction, retraction or late vote gets a clean replay in delivery order.
  const append = !row.vote && !learning.history.slice(index + 1).some((r) => r.vote);
  if (vote) row.vote = vote;
  else delete row.vote;
  Object.assign(learning, fitPolicy(learning.history, append ? learning.weights : {}));
}

/** Only the summary goes to clients. Examples and evidence fingerprints stay on the host. */
export function learningView(learning) {
  const history = learning?.history ?? [];
  const catalog = skillCatalog(history);
  return {
    rated: history.filter((row) => row.vote).length,
    ...(learning?.evaluation && { evaluation: learning.evaluation }),
    preferred: catalog.filter((r) => r.status === "preferred").map((r) => r.label),
    retired: catalog.filter((r) => r.status === "retired").map((r) => r.label),
  };
}
