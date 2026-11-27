// Actionable card posted by a workflow chat output: needs-you badge, summary/blocks, Dispatch, Dismiss.
import { AlertCircle, ArrowUpRight, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Send, X } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import type { PanelBlock, WorkflowActionCard as ActionCardData } from "@/link/types";
import { usePart } from "@/state/hooks";
import { chatCardAction } from "@/state/link";
import { openLink } from "@/ui/LinkHold";
import { Badge, Blocks, Button, Markdown, radius, space, T, Tap, useTheme } from "@/ui";
import { openChat } from "./navigate";
import { myself, OWNER } from "./people";

type Props = {
  chatId: string;
  card: ActionCardData;
  rich: boolean;
  onOpenChat?: (chatId: string) => void;
};

/** Concise plain summary lines from blocks for rich-cards-off mode. */
function compactLines(blocks: PanelBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "badges" && b.items.length) {
      out.push(b.items.map((i) => i.label).join(" · "));
    } else if (b.type === "markdown" && b.text.trim()) {
      out.push(b.text.trim());
    } else if (b.type === "metric") {
      out.push(`${b.label}: ${b.value}`);
    } else if (b.type === "list" && b.items.length) {
      out.push(b.items.join(" · "));
    }
  }
  return out;
}

export function WorkflowActionCard({ chatId, card, rich, onOpenChat }: Props) {
  const { colors } = useTheme();
  const meta = usePart("meta");
  const readOnly = myself(meta) !== OWNER;
  const [busy, setBusy] = useState<"dispatch" | "dismiss" | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  const dismissed = card.state === "dismissed";
  const dispatched = card.state === "dispatched";
  const open = card.state === "open";
  const botLabel = card.dispatchedBotName || card.dispatch?.botName || "bot";
  const dispatchLabel = card.dispatch?.label?.trim() || (card.dispatch?.botName ? `Dispatch to ${card.dispatch.botName}` : "Dispatch");

  const runAction = async (action: "dispatch" | "dismiss") => {
    if (busy || readOnly) return;
    setBusy(action);
    setError("");
    try {
      await chatCardAction(chatId, card.id, action);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const openDispatched = () => {
    if (!card.dispatchedChatId) return;
    if (onOpenChat) onOpenChat(card.dispatchedChatId);
    else openChat(card.dispatchedChatId);
  };

  const bodyContent = (
    <View style={{ gap: space.sm }}>
      {!!card.subtitle && (
        rich ? (
          <Markdown text={card.subtitle} size="small" color={colors.muted} />
        ) : (
          <T variant="footnote" color="muted">
            {card.subtitle}
          </T>
        )
      )}
      {card.blocks.length > 0 &&
        (rich ? (
          <Blocks blocks={card.blocks} title={card.title} />
        ) : (
          <View style={{ gap: space.xs }}>
            {compactLines(card.blocks).map((line, i) => (
              <T key={i} variant="footnote" color="muted">
                {line}
              </T>
            ))}
          </View>
        ))}
      {!!card.link?.url && (
        <Tap
          onPress={() => openLink(card.link!.url)}
          accessibilityLabel={card.link.label || "View comment"}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", paddingVertical: 2 }}
        >
          <ExternalLink size={13} color={colors.accent} strokeWidth={2.2} />
          <T variant="footnote" weight="600" style={{ color: colors.accent }}>
            {card.link.label || "View comment"}
          </T>
        </Tap>
      )}
    </View>
  );

  if (dismissed) {
    return (
      <View
        style={{
          backgroundColor: colors.sunken,
          borderRadius: radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
          padding: space.md,
          gap: space.sm,
          opacity: 0.72,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
            <Badge label="Dismissed" tone="neutral" />
            <T variant="footnote" color="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
              {card.title}
            </T>
          </View>
          <Tap
            onPress={() => setExpanded((v) => !v)}
            accessibilityLabel={expanded ? "Hide dismissed card details" : "Show dismissed card details"}
            style={{ flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 6, paddingVertical: 4 }}
          >
            {expanded ? <ChevronDown size={14} color={colors.muted} /> : <ChevronRight size={14} color={colors.muted} />}
            <T variant="caption" color="muted" weight="600">
              {expanded ? "Hide" : "Show"}
            </T>
          </Tap>
        </View>
        {expanded && bodyContent}
      </View>
    );
  }

  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: card.needsYou && open ? colors.warning : colors.line,
        padding: space.md,
        gap: space.md,
      }}
    >
      <View style={{ gap: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, flexWrap: "wrap" }}>
          <Badge
            label={card.needsYou ? "Needs your direction" : "No input needed"}
            tone={card.needsYou ? "warning" : "success"}
            icon={card.needsYou ? AlertCircle : CheckCircle2}
          />
          {dispatched && <Badge label={`Dispatched to ${botLabel}`} tone="accent" />}
        </View>
        <T variant="headline" weight="700">
          {card.title}
        </T>
      </View>

      {bodyContent}

      {!!error && (
        <T variant="footnote" color="danger">
          {error}
        </T>
      )}

      {open && !readOnly && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap", paddingTop: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
          {!!card.dispatch && (
            <Button
              title={busy === "dispatch" ? "Dispatching…" : dispatchLabel}
              icon={Send}
              size="sm"
              disabled={busy !== null}
              onPress={() => void runAction("dispatch")}
              accessibilityLabel={dispatchLabel}
            />
          )}
          <Button
            title={busy === "dismiss" ? "Dismissing…" : "Dismiss"}
            icon={X}
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onPress={() => void runAction("dismiss")}
            accessibilityLabel="Dismiss"
          />
        </View>
      )}

      {open && readOnly && (
        <T variant="caption" color="muted">
          Only the host owner can dispatch or dismiss this card.
        </T>
      )}

      {dispatched && (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, flexWrap: "wrap", paddingTop: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
          <T variant="footnote" color="muted" style={{ flexShrink: 1 }}>
            {`Dispatched to ${botLabel}`}
          </T>
          {!!card.dispatchedChatId && (
            <Button
              title="Open chat"
              icon={ArrowUpRight}
              variant="secondary"
              size="sm"
              onPress={openDispatched}
              accessibilityLabel={`Open chat with ${botLabel}`}
            />
          )}
        </View>
      )}
    </View>
  );
}
