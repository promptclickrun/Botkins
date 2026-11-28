// Virtualized pickers and delivery log modals/panels for mobile GitHub workflows.
// Uses FlatList / SectionList (never unvirtualized .map() over large repo, label, assignee, or delivery lists),
// wraps floating/action controls cleanly, preserves >= 48dp touch targets, and triggers haptics on selection.
import { AlertTriangle, Check, ExternalLink, Filter, KeyRound, Link2, Play, Plus, RefreshCw, Repeat, ShieldAlert, WifiOff, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { FlatList, Linking, Modal, SectionList, View } from "react-native";
import type { WorkflowGithubAssigneeOption, WorkflowGithubDelivery, WorkflowGithubLabelOption } from "@/link/types";
import { Button, EmptyState, Field, Glass, Group, haptic, IconButton, radius, space, T, Tap, useTheme } from "@/ui";
import {
  filterLabelOptions,
  type GithubAccessAlert,
  groupDeliveriesByOutcome,
  groupReposByOwner,
  latestReplayableDelivery,
  normalizeLabelColor,
  SKIP_REASON_META,
  WORKFLOW_GITHUB_EVENT_LABELS,
} from "./github";

function relTime(iso: string) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diff = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function GithubAccessAlertsMobile({
  alerts,
  onConnect,
  onOpenGithub,
}: {
  alerts: GithubAccessAlert[];
  onConnect: () => void;
  onOpenGithub: () => void;
}) {
  const { colors } = useTheme();
  if (!alerts.length) return null;
  return (
    <View style={{ gap: space.sm }}>
      {alerts.map((alert) => {
        const isDanger = alert.kind === "missing";
        return (
          <View
            key={alert.kind}
            style={{
              padding: space.md,
              borderRadius: radius.md,
              backgroundColor: isDanger ? colors.dangerSoft : colors.warningSoft,
              borderWidth: 1,
              borderColor: isDanger ? colors.danger : colors.warning,
              gap: space.sm,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
              <AlertTriangle size={16} color={isDanger ? colors.danger : colors.warning} style={{ marginTop: 2 }} />
              <View style={{ flex: 1, gap: 2 }}>
                <T variant="subhead" weight="700">
                  {alert.title}
                </T>
                <T variant="footnote" color="ink2">
                  {alert.detail}
                </T>
              </View>
            </View>
            <View style={{ flexDirection: "row" }}>
              {alert.action === "github" ? (
                <Button title="Open GitHub" size="sm" variant="secondary" icon={ExternalLink} onPress={onOpenGithub} />
              ) : (
                <Button
                  title={alert.action === "reconnect" ? "Reconnect GitHub" : "Connect GitHub"}
                  size="sm"
                  icon={KeyRound}
                  onPress={onConnect}
                />
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** Virtualized owner-grouped multi-repo picker modal (SectionList). */
export function GithubRepoPickerModal({
  visible,
  selected,
  available,
  multi = true,
  onChange,
  onClose,
}: {
  visible: boolean;
  selected: string[];
  available: string[];
  multi?: boolean;
  onChange: (next: string[]) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState("");

  const allRepos = useMemo(() => [...new Set([...selected, ...available])], [selected, available]);
  const sections = useMemo(
    () => groupReposByOwner(allRepos, query).map((g) => ({ title: g.owner, data: g.repos })),
    [allRepos, query],
  );
  const selectedLower = useMemo(() => new Set(selected.map((r) => r.toLowerCase())), [selected]);

  const toggle = (repo: string) => {
    haptic.select();
    if (!multi) {
      onChange([repo]);
      onClose();
      return;
    }
    const low = repo.toLowerCase();
    const next = selectedLower.has(low)
      ? selected.filter((r) => r.toLowerCase() !== low)
      : [...selected, repo];
    onChange(next);
  };

  const addCustom = () => {
    const cleaned = custom.trim().replace(/^\/+|\/+$/g, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(cleaned)) return;
    haptic.select();
    if (!multi) {
      onChange([cleaned]);
      setCustom("");
      onClose();
      return;
    }
    if (!selectedLower.has(cleaned.toLowerCase())) {
      onChange([...selected, cleaned]);
    }
    setCustom("");
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.canvas }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            borderBottomWidth: 1,
            borderColor: colors.line,
            backgroundColor: colors.surface,
          }}
        >
          <T variant="headline" weight="700">
            {multi ? `Repositories (${selected.length})` : "Choose repository"}
          </T>
          <Button title="Done" size="sm" onPress={onClose} />
        </View>

        <View style={{ padding: space.md, gap: space.sm, borderBottomWidth: 1, borderColor: colors.line }}>
          <Field
            placeholder="Search by owner or repo…"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <Field
                placeholder="Add owner/repo manually"
                value={custom}
                onChangeText={setCustom}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <Button
              title="Add"
              size="sm"
              variant="secondary"
              icon={Plus}
              disabled={!/^[\w.-]+\/[\w.-]+$/.test(custom.trim())}
              onPress={addCustom}
            />
          </View>
        </View>

        <SectionList
          sections={sections}
          keyExtractor={(item) => item}
          stickySectionHeadersEnabled
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: space.xxl }}
          ListEmptyComponent={
            <View style={{ padding: space.lg }}>
              <EmptyState title="No repositories" text={query.trim() ? "Try another search or add owner/repo above." : "Connect GitHub or add owner/repo above."} />
            </View>
          }
          renderSectionHeader={({ section }) => (
            <View
              style={{
                paddingHorizontal: space.lg,
                paddingVertical: space.xs,
                backgroundColor: colors.sunken,
                borderBottomWidth: 1,
                borderColor: colors.line,
              }}
            >
              <T variant="caption" color="muted" weight="700">
                {section.title}
              </T>
            </View>
          )}
          renderItem={({ item }) => {
            const active = selectedLower.has(item.toLowerCase());
            const repoName = item.slice(item.indexOf("/") + 1);
            return (
              <Tap
                onPress={() => toggle(item)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: active }}
                style={{
                  minHeight: 48,
                  paddingHorizontal: space.lg,
                  paddingVertical: space.sm,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderBottomWidth: 1,
                  borderColor: colors.line,
                  backgroundColor: active ? colors.accentSoft : colors.surface,
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T variant="body" weight={active ? "700" : "500"} numberOfLines={1}>
                    {repoName}
                  </T>
                  <T variant="caption" color="muted" numberOfLines={1}>
                    {item}
                  </T>
                </View>
                {active && <Check size={18} color={colors.accent} />}
              </Tap>
            );
          }}
        />
      </View>
    </Modal>
  );
}

/** Virtualized color-coded label picker modal (FlatList). */
export function GithubLabelPickerModal({
  visible,
  title = "Labels",
  selected,
  catalog,
  loading,
  onChange,
  onClose,
}: {
  visible: boolean;
  title?: string;
  selected: string[];
  catalog: WorkflowGithubLabelOption[];
  loading: boolean;
  onChange: (next: string[]) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState("");

  const options = useMemo(() => filterLabelOptions(catalog, selected, query), [catalog, selected, query]);
  const selectedLower = useMemo(() => new Set(selected.map((s) => s.toLowerCase())), [selected]);

  const toggle = (name: string) => {
    haptic.select();
    const low = name.toLowerCase();
    onChange(selectedLower.has(low) ? selected.filter((s) => s.toLowerCase() !== low) : [...selected, name]);
  };

  const addCustom = () => {
    const cleaned = custom.trim();
    if (!cleaned) return;
    haptic.select();
    if (!selectedLower.has(cleaned.toLowerCase())) onChange([...selected, cleaned]);
    setCustom("");
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.canvas }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            borderBottomWidth: 1,
            borderColor: colors.line,
            backgroundColor: colors.surface,
          }}
        >
          <T variant="headline" weight="700">
            {title} {selected.length > 0 ? `(${selected.length})` : ""}
          </T>
          <Button title="Done" size="sm" onPress={onClose} />
        </View>

        <View style={{ padding: space.md, gap: space.sm, borderBottomWidth: 1, borderColor: colors.line }}>
          <Field placeholder="Filter labels…" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} />
          <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <Field placeholder="Add custom label" value={custom} onChangeText={setCustom} autoCapitalize="none" autoCorrect={false} />
            </View>
            <Button title="Add" size="sm" variant="secondary" icon={Plus} disabled={!custom.trim()} onPress={addCustom} />
          </View>
        </View>

        <FlatList
          data={options}
          keyExtractor={(item) => item.name.toLowerCase()}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: space.xxl }}
          ListEmptyComponent={
            <View style={{ padding: space.lg }}>
              <EmptyState title={loading ? "Loading labels…" : "No labels"} text="Select a repository or add a custom label above." />
            </View>
          }
          renderItem={({ item }) => {
            const active = selectedLower.has(item.name.toLowerCase());
            const hex = normalizeLabelColor(item.color);
            return (
              <Tap
                onPress={() => toggle(item.name)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: active }}
                style={{
                  minHeight: 48,
                  paddingHorizontal: space.lg,
                  paddingVertical: space.sm,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.md,
                  borderBottomWidth: 1,
                  borderColor: colors.line,
                  backgroundColor: active ? colors.accentSoft : colors.surface,
                }}
              >
                <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: hex, borderWidth: 1, borderColor: colors.lineStrong }} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T variant="body" weight={active ? "700" : "500"} numberOfLines={1}>
                    {item.name}
                  </T>
                  {!!item.description && (
                    <T variant="caption" color="muted" numberOfLines={1}>
                      {item.description}
                    </T>
                  )}
                </View>
                {active && <Check size={18} color={colors.accent} />}
              </Tap>
            );
          }}
        />
      </View>
    </Modal>
  );
}

/** Virtualized collaborator / reviewer picker modal (FlatList). */
export function GithubPeoplePickerModal({
  visible,
  title,
  selected,
  catalog,
  loading,
  onChange,
  onClose,
}: {
  visible: boolean;
  title: string;
  selected: string[];
  catalog: WorkflowGithubAssigneeOption[];
  loading: boolean;
  onChange: (next: string[]) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState("");

  const selectedLower = useMemo(() => new Set(selected.map((p) => p.toLowerCase())), [selected]);
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const seen = new Set<string>();
    const out: Array<{ login: string }> = [];
    for (const u of catalog) {
      const k = u.login.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ login: u.login });
      }
    }
    for (const p of selected) {
      const k = p.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ login: p });
      }
    }
    return out.filter((u) => !needle || u.login.toLowerCase().includes(needle));
  }, [catalog, selected, query]);

  const toggle = (login: string) => {
    haptic.select();
    const clean = login.trim().replace(/^@/, "");
    const low = clean.toLowerCase();
    onChange(selectedLower.has(low) ? selected.filter((p) => p.toLowerCase() !== low) : [...selected, clean]);
  };

  const addCustom = () => {
    const clean = custom.trim().replace(/^@/, "");
    if (!clean) return;
    haptic.select();
    if (!selectedLower.has(clean.toLowerCase())) onChange([...selected, clean]);
    setCustom("");
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.canvas }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            borderBottomWidth: 1,
            borderColor: colors.line,
            backgroundColor: colors.surface,
          }}
        >
          <T variant="headline" weight="700">
            {title} {selected.length > 0 ? `(${selected.length})` : ""}
          </T>
          <Button title="Done" size="sm" onPress={onClose} />
        </View>

        <View style={{ padding: space.md, gap: space.sm, borderBottomWidth: 1, borderColor: colors.line }}>
          <Field placeholder="Filter GitHub usernames…" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} />
          <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <Field placeholder="Add @username" value={custom} onChangeText={setCustom} autoCapitalize="none" autoCorrect={false} />
            </View>
            <Button title="Add" size="sm" variant="secondary" icon={Plus} disabled={!custom.trim()} onPress={addCustom} />
          </View>
        </View>

        <FlatList
          data={options}
          keyExtractor={(item) => item.login.toLowerCase()}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: space.xxl }}
          ListEmptyComponent={
            <View style={{ padding: space.lg }}>
              <EmptyState title={loading ? "Loading collaborators…" : "No collaborators"} text="Add a GitHub username above." />
            </View>
          }
          renderItem={({ item }) => {
            const active = selectedLower.has(item.login.toLowerCase());
            return (
              <Tap
                onPress={() => toggle(item.login)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: active }}
                style={{
                  minHeight: 48,
                  paddingHorizontal: space.lg,
                  paddingVertical: space.sm,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderBottomWidth: 1,
                  borderColor: colors.line,
                  backgroundColor: active ? colors.accentSoft : colors.surface,
                }}
              >
                <T variant="body" weight={active ? "700" : "500"}>
                  @{item.login}
                </T>
                {active && <Check size={18} color={colors.accent} />}
              </Tap>
            );
          }}
        />
      </View>
    </Modal>
  );
}

function skipIcon(reason: WorkflowGithubDelivery["reason"], color: string) {
  switch (reason) {
    case "self":
      return <Repeat size={13} color={color} />;
    case "chain":
      return <Link2 size={13} color={color} />;
    case "offline":
      return <WifiOff size={13} color={color} />;
    case "refused":
      return <ShieldAlert size={13} color={color} />;
    default:
      return <Filter size={13} color={color} />;
  }
}

/** Virtualized grouped delivery log modal (SectionList: waiting / started / skipped) with "Run last event". */
export function GithubDeliveriesModal({
  visible,
  deliveries,
  loading,
  replaying,
  onRefresh,
  onReplayLast,
  onClose,
}: {
  visible: boolean;
  deliveries: WorkflowGithubDelivery[];
  loading: boolean;
  replaying: boolean;
  onRefresh: () => void;
  onReplayLast: () => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const sections = useMemo(
    () => groupDeliveriesByOutcome(deliveries).map((g) => ({ title: g.label, outcome: g.outcome, data: g.items })),
    [deliveries],
  );
  const replayable = useMemo(() => latestReplayableDelivery(deliveries), [deliveries]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.canvas }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            borderBottomWidth: 1,
            borderColor: colors.line,
            backgroundColor: colors.surface,
          }}
        >
          <T variant="headline" weight="700">
            GitHub deliveries
          </T>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
            <IconButton icon={RefreshCw} label="Refresh deliveries" size={40} onPress={onRefresh} />
            <Button title="Done" size="sm" onPress={onClose} />
          </View>
        </View>

        <SectionList
          sections={sections}
          keyExtractor={(item) => item.deliveryId}
          stickySectionHeadersEnabled
          contentContainerStyle={{ paddingBottom: 96 }}
          ListEmptyComponent={
            <View style={{ padding: space.lg }}>
              <EmptyState title={loading ? "Loading deliveries…" : "No deliveries yet"} text="Waiting, started, and skipped GitHub events appear here." />
            </View>
          }
          renderSectionHeader={({ section }) => (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: space.lg,
                paddingVertical: space.xs,
                backgroundColor: colors.sunken,
                borderBottomWidth: 1,
                borderColor: colors.line,
              }}
            >
              <T
                variant="caption"
                weight="700"
                color={section.outcome === "waiting" ? "warning" : section.outcome === "started" ? "success" : "muted"}
              >
                {section.title.toUpperCase()}
              </T>
              <T variant="caption" color="muted">
                {section.data.length}
              </T>
            </View>
          )}
          renderItem={({ item }) => {
            const reasonMeta = item.reason ? SKIP_REASON_META[item.reason] : null;
            return (
              <Tap
                disabled={!item.url}
                onPress={() => item.url && void Linking.openURL(item.url)}
                style={{
                  minHeight: 56,
                  paddingHorizontal: space.lg,
                  paddingVertical: space.sm,
                  borderBottomWidth: 1,
                  borderColor: colors.line,
                  backgroundColor: colors.surface,
                  gap: 3,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                  <T variant="subhead" weight="700" numberOfLines={1} style={{ flex: 1 }}>
                    {WORKFLOW_GITHUB_EVENT_LABELS[item.event] || item.event}
                    {item.repository ? ` · ${item.repository}${item.number ? `#${item.number}` : ""}` : ""}
                  </T>
                  <T variant="caption" color="muted">
                    {relTime(item.receivedAt)}
                  </T>
                </View>
                {!!item.title && (
                  <T variant="footnote" color="ink2" numberOfLines={1}>
                    {item.title}
                  </T>
                )}
                {reasonMeta && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                    {skipIcon(item.reason, colors.muted)}
                    <T variant="caption" color="muted">
                      {reasonMeta.label}
                      {item.reasonDetail ? ` (${item.reasonDetail})` : ""}
                    </T>
                  </View>
                )}
              </Tap>
            );
          }}
        />

        <View style={{ position: "absolute", left: space.lg, right: space.lg, bottom: space.lg, alignItems: "center" }}>
          <Glass interactive style={{ borderRadius: radius.pill, padding: space.xs }}>
            <Button
              title={replaying ? "Replaying…" : "Run last event"}
              icon={Play}
              disabled={!replayable || replaying}
              onPress={() => {
                haptic.select();
                onReplayLast();
              }}
            />
          </Glass>
        </View>
      </View>
    </Modal>
  );
}

/** Compact selected-item chips with remove button for StepSheet summaries. */
export function SelectedChipRow({
  items,
  colorFor,
  onRemove,
}: {
  items: string[];
  colorFor?: (item: string) => string | null;
  onRemove: (item: string) => void;
}) {
  const { colors } = useTheme();
  if (!items.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
      {items.map((item) => {
        const dot = colorFor?.(item);
        return (
          <Tap
            key={item}
            onPress={() => {
              haptic.select();
              onRemove(item);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${item}`}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: space.sm,
              paddingVertical: 6,
              borderRadius: radius.pill,
              backgroundColor: colors.accentSoft,
              borderWidth: 1,
              borderColor: colors.accent,
            }}
          >
            {!!dot && <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: dot }} />}
            <T variant="caption" weight="600" color="accentText">
              {item}
            </T>
            <X size={12} color={colors.accentText} />
          </Tap>
        );
      })}
    </View>
  );
}

export function GithubDeliveryPreviewCard({
  deliveries,
  replaying,
  onOpenAll,
  onReplayLast,
}: {
  deliveries: WorkflowGithubDelivery[];
  replaying: boolean;
  onOpenAll: () => void;
  onReplayLast: () => void;
}) {
  const { colors } = useTheme();
  const groups = useMemo(() => groupDeliveriesByOutcome(deliveries), [deliveries]);
  const replayable = useMemo(() => latestReplayableDelivery(deliveries), [deliveries]);
  const waitingCount = groups.find((g) => g.outcome === "waiting")?.items.length ?? 0;
  const startedCount = groups.find((g) => g.outcome === "started")?.items.length ?? 0;
  const skippedCount = groups.find((g) => g.outcome === "skipped")?.items.length ?? 0;

  return (
    <Group>
      <View style={{ padding: space.md, gap: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
          <T variant="subhead" weight="700">
            Recent deliveries
          </T>
          <T variant="caption" color="muted">
            {deliveries.length === 0
              ? "None yet"
              : `${waitingCount} waiting · ${startedCount} started · ${skippedCount} skipped`}
          </T>
        </View>

        {deliveries.slice(0, 3).map((d) => {
          const reasonMeta = d.reason ? SKIP_REASON_META[d.reason] : null;
          return (
            <View
              key={d.deliveryId}
              style={{
                paddingVertical: space.xs,
                borderTopWidth: 1,
                borderColor: colors.line,
                gap: 2,
              }}
            >
              <T variant="footnote" weight="600" numberOfLines={1}>
                {WORKFLOW_GITHUB_EVENT_LABELS[d.event] || d.event}
                {d.repository ? ` · ${d.repository}${d.number ? `#${d.number}` : ""}` : ""}
              </T>
              <T variant="caption" color={d.outcome === "waiting" ? "warning" : d.outcome === "started" ? "success" : "muted"}>
                {d.outcome}
                {reasonMeta ? ` · ${reasonMeta.label}` : ""}
                {d.receivedAt ? ` · ${relTime(d.receivedAt)}` : ""}
              </T>
            </View>
          );
        })}

        <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap", paddingTop: space.xs }}>
          <Button
            title={replaying ? "Replaying…" : "Run last event"}
            size="sm"
            icon={Play}
            disabled={!replayable || replaying}
            onPress={() => {
              haptic.select();
              onReplayLast();
            }}
          />
          <Button
            title={`View all (${deliveries.length})`}
            size="sm"
            variant="secondary"
            onPress={() => {
              haptic.select();
              onOpenAll();
            }}
          />
        </View>
      </View>
    </Group>
  );
}
