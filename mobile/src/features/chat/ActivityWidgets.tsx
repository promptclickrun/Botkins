// Shared Open-mode (T3 Code) and Fold-mode (OpenBot) activity widgets for chat canvases and feeds.
import {
  Brain,
  ChevronDown,
  ChevronRight,
  Eye,
  FilePenLine,
  FilePlus2,
  Globe,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  MessageCircleQuestion,
  Search,
  Sparkles,
  Terminal,
  Users,
  Wrench,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, type StyleProp, type TextStyle, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import type { Step } from "@/link/types";
import { radius, space, T, Tap, useTheme } from "@/ui";
import {
  type FoldBlock,
  type OpenWorkGroup,
  type ParsedStepInput,
  type StepKind,
  clipLines,
  formatWorkingDuration,
  parseStepInput,
  stepHeadline,
} from "./activityModel";
import { StepMark } from "./bits";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

export function durationLabel(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

function stepSeconds(step: Step): string {
  if (!step.finished) return "";
  return Math.max(0.1, (step.finished - step.started) / 1000).toFixed(1) + "s";
}

/** Category icon for a classified tool kind. */
export function KindIcon({ kind, size = 14, color }: { kind: StepKind; size?: number; color?: string }) {
  const { colors } = useTheme();
  const c = color ?? colors.muted;
  const sw = 2;
  switch (kind) {
    case "command":
      return <Terminal size={size} color={c} strokeWidth={sw} />;
    case "read":
      return <Eye size={size} color={c} strokeWidth={sw} />;
    case "write":
      return <FilePlus2 size={size} color={c} strokeWidth={sw} />;
    case "edit":
      return <FilePenLine size={size} color={c} strokeWidth={sw} />;
    case "search-files":
      return <Search size={size} color={c} strokeWidth={sw} />;
    case "web":
    case "web-page":
      return <Globe size={size} color={c} strokeWidth={sw} />;
    case "ask":
      return <MessageCircleQuestion size={size} color={c} strokeWidth={sw} />;
    case "helper":
      return <Users size={size} color={c} strokeWidth={sw} />;
    case "plan":
      return <ListChecks size={size} color={c} strokeWidth={sw} />;
    case "skill":
      return <Sparkles size={size} color={c} strokeWidth={sw} />;
    case "card":
      return <LayoutGrid size={size} color={c} strokeWidth={sw} />;
    case "panel":
      return <LayoutDashboard size={size} color={c} strokeWidth={sw} />;
    default:
      return <Wrench size={size} color={c} strokeWidth={sw} />;
  }
}

/** OpenBot-style overlapped circular stack of tool-kind icons. */
export function IconStack({
  kinds,
  size = 11,
  badgeSize = 20,
  ringColor,
}: {
  kinds: StepKind[];
  size?: number;
  badgeSize?: number;
  ringColor?: string;
}) {
  const { colors } = useTheme();
  if (!kinds.length) return null;
  const ring = ringColor ?? colors.canvas;
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }} accessibilityElementsHidden>
      {kinds.slice(0, 4).map((kind, i) => (
        <View
          key={kind}
          style={{
            width: badgeSize,
            height: badgeSize,
            borderRadius: badgeSize / 2,
            backgroundColor: colors.surface,
            borderWidth: 1.5,
            borderColor: ring,
            marginLeft: i === 0 ? 0 : -6,
            alignItems: "center",
            justifyContent: "center",
            shadowColor: "#000",
            shadowOpacity: 0.05,
            shadowRadius: 1,
            shadowOffset: { width: 0, height: 0.5 },
          }}
        >
          <View
            style={{
              width: badgeSize - 3,
              height: badgeSize - 3,
              borderRadius: (badgeSize - 3) / 2,
              borderWidth: 1,
              borderColor: colors.line,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <KindIcon kind={kind} size={size} color={colors.muted} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Subtle shimmer pulse for live thinking and work summaries. */
export function ShimmerLabel({
  text,
  active,
  variant = "subhead",
  weight,
  color = "muted",
  numberOfLines,
  style,
}: {
  text: string;
  active: boolean;
  variant?: "subhead" | "footnote" | "caption" | "body";
  weight?: "400" | "500" | "600" | "700";
  color?: "ink" | "ink2" | "muted" | "faint" | "danger" | "success";
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
}) {
  const reduce = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (!active || reduce) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withSequence(withTiming(0.45, { duration: 850 }), withTiming(1, { duration: 850 })),
      -1,
      true,
    );
  }, [active, reduce, opacity]);
  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  if (!active || reduce) {
    return (
      <T variant={variant} weight={weight} color={color} numberOfLines={numberOfLines} style={style}>
        {text}
      </T>
    );
  }
  return (
    <Animated.View style={[animStyle, { flexShrink: 1 }]}>
      <T variant={variant} weight={weight} color={color} numberOfLines={numberOfLines} style={style}>
        {text}
      </T>
    </Animated.View>
  );
}

/** Centered rounded "Working Xm Ys" pill shown while a turn is active in Open mode. */
export function WorkingPill({ startedAt }: { startedAt: number }) {
  const { colors } = useTheme();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  const elapsed = formatWorkingDuration(Math.max(0, now - startedAt));
  return (
    <View style={{ alignItems: "center", paddingVertical: space.xs }} accessibilityRole="text" accessibilityLabel={"Working " + elapsed}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          paddingHorizontal: space.md,
          paddingVertical: 6,
          borderRadius: radius.pill,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.line,
        }}
      >
        <ActivityIndicator size="small" color={colors.muted} style={{ transform: [{ scale: 0.72 }] }} />
        <T variant="footnote" weight="600" color="ink2">
          Working
        </T>
        <T variant="footnote" color="muted" style={{ fontVariant: ["tabular-nums"] }}>
          {elapsed}
        </T>
      </View>
    </View>
  );
}

/** Color-tinted monospace diff lines. */
export function DiffLinesView({
  lines,
  truncated,
}: {
  lines: NonNullable<ParsedStepInput["diff"]>["lines"];
  truncated?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ paddingVertical: 4 }}>
      {lines.map((line, i) => {
        const bg =
          line.kind === "add"
            ? colors.successSoft
            : line.kind === "del"
              ? colors.dangerSoft
              : line.kind === "hunk"
                ? colors.infoSoft
                : "transparent";
        const gutterColor =
          line.kind === "add"
            ? colors.success
            : line.kind === "del"
              ? colors.danger
              : line.kind === "hunk"
                ? colors.info
                : colors.muted;
        const gutter = line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "hunk" ? "@" : " ";
        return (
          <View
            key={i}
            style={{
              flexDirection: "row",
              gap: 6,
              paddingHorizontal: space.sm,
              paddingVertical: 1.5,
              backgroundColor: bg,
            }}
          >
            <T
              variant="caption"
              style={{
                fontFamily: MONO,
                width: 10,
                color: gutterColor,
              }}
            >
              {gutter}
            </T>
            <T
              variant="caption"
              selectable
              color={line.kind === "ctx" ? "muted" : "ink"}
              style={{ fontFamily: MONO, flex: 1, lineHeight: 17 }}
            >
              {line.text || " "}
            </T>
          </View>
        );
      })}
      {truncated && (
        <T variant="caption" color="muted" style={{ paddingHorizontal: space.sm, paddingTop: 4 }}>
          …more lines omitted
        </T>
      )}
    </View>
  );
}

/** Structured detail body for an expanded step (command, diff, or raw input/output). */
export function StepDetailView({ step, parsed = parseStepInput(step) }: { step: Step; parsed?: ParsedStepInput }) {
  const { colors } = useTheme();
  const output = (step.output || "").trim();
  const progress = (step.progress || "").trim();
  if (parsed.command) {
    return (
      <View style={{ gap: 6 }}>
        <View
          style={{
            flexDirection: "row",
            gap: 6,
            paddingHorizontal: space.sm,
            paddingVertical: 6,
            borderRadius: radius.sm,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.line,
          }}
        >
          <T variant="caption" weight="600" color="muted" style={{ fontFamily: MONO }}>
            $
          </T>
          <T variant="caption" selectable color="ink" style={{ fontFamily: MONO, flex: 1 }}>
            {parsed.command}
          </T>
        </View>
        {!!progress && step.status === "Running" && (
          <T variant="caption" selectable color="ink2" style={{ fontFamily: MONO, lineHeight: 17 }}>
            {progress}
          </T>
        )}
        {!!output && (
          <View
            style={{
              padding: space.sm,
              borderRadius: radius.sm,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.line,
            }}
          >
            <T variant="caption" selectable color="ink2" style={{ fontFamily: MONO, lineHeight: 17 }}>
              {output}
            </T>
          </View>
        )}
      </View>
    );
  }
  if (parsed.diff) {
    return (
      <View style={{ gap: 6 }}>
        {!!parsed.filePath && (
          <T variant="caption" color="muted" style={{ fontFamily: MONO }} numberOfLines={1}>
            {parsed.filePath}
          </T>
        )}
        <View
          style={{
            borderRadius: radius.sm,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.line,
            overflow: "hidden",
          }}
        >
          <DiffLinesView lines={parsed.diff.lines} truncated={parsed.diff.truncated} />
        </View>
        {!!output && step.status === "Failed" && (
          <T variant="caption" selectable color="danger" style={{ fontFamily: MONO, lineHeight: 17 }}>
            {output}
          </T>
        )}
      </View>
    );
  }
  return (
    <View style={{ gap: 6 }}>
      {!!step.input && (
        <View
          style={{
            padding: space.sm,
            borderRadius: radius.sm,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.line,
          }}
        >
          <T variant="caption" color="muted" weight="600" style={{ marginBottom: 2 }}>
            Input
          </T>
          <T variant="caption" selectable color="ink2" style={{ fontFamily: MONO, lineHeight: 17 }}>
            {step.input}
          </T>
        </View>
      )}
      {!!progress && (
        <T variant="footnote" color="muted">
          {progress}
        </T>
      )}
      {!!output && (
        <View
          style={{
            padding: space.sm,
            borderRadius: radius.sm,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.line,
          }}
        >
          <T variant="caption" color="muted" weight="600" style={{ marginBottom: 2 }}>
            Output
          </T>
          <T variant="caption" selectable color="ink2" style={{ fontFamily: MONO, lineHeight: 17 }}>
            {output}
          </T>
        </View>
      )}
      {!step.input && !progress && !output && (
        <T variant="caption" color="muted">
          No details
        </T>
      )}
    </View>
  );
}

/** OpenBot elevated compact card for a command/shell step. */
export function CommandCard({
  step,
  parsed = parseStepInput(step),
  live,
}: {
  step: Step;
  parsed?: ParsedStepInput;
  live?: boolean;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const failed = step.status === "Failed";
  const cmd = parsed.command || stepHeadline(step, parsed);
  const rawOut = (step.output || step.progress || "").trim();
  const clipped = clipLines(rawOut, 4, true);
  const took = stepSeconds(step);
  return (
    <View
      style={{
        borderRadius: radius.md,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: failed ? colors.danger : colors.line,
        overflow: "hidden",
      }}
    >
      <Tap
        onPress={() => setExpanded((e) => !e)}
        feel="select"
        sink={0.99}
        accessibilityLabel={"Command: " + cmd}
        accessibilityState={{ expanded }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          paddingHorizontal: space.sm + 2,
          paddingVertical: space.sm,
        }}
      >
        <StepMark status={step.status} size={13} />
        <T variant="caption" weight="700" color="muted" style={{ fontFamily: MONO }}>
          $
        </T>
        <T variant="footnote" color="ink" numberOfLines={1} style={{ fontFamily: MONO, flex: 1 }}>
          {cmd}
        </T>
        {!!took && (
          <T variant="caption" color="muted" style={{ fontVariant: ["tabular-nums"] }}>
            {took}
          </T>
        )}
        {expanded ? (
          <ChevronDown size={14} color={colors.faint} strokeWidth={2.2} />
        ) : (
          <ChevronRight size={14} color={colors.faint} strokeWidth={2.2} />
        )}
      </Tap>
      {(!!rawOut || expanded) && (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.line,
            backgroundColor: colors.canvas,
          }}
        >
          {rawOut ? (
            <>
              <T
                variant="caption"
                selectable
                color="ink2"
                style={{
                  fontFamily: MONO,
                  lineHeight: 17,
                  paddingHorizontal: space.sm + 2,
                  paddingVertical: space.sm,
                }}
              >
                {expanded ? rawOut : clipped.text}
              </T>
              {clipped.clipped && (
                <Tap
                  onPress={() => setExpanded((e) => !e)}
                  feel="select"
                  style={{
                    borderTopWidth: 1,
                    borderTopColor: colors.line,
                    paddingHorizontal: space.sm + 2,
                    paddingVertical: 6,
                  }}
                >
                  <T variant="caption" color="muted">
                    {expanded ? "Show less" : `Show all ${clipped.totalLines} lines`}
                  </T>
                </Tap>
              )}
            </>
          ) : (
            !live && (
              <T variant="caption" color="muted" style={{ paddingHorizontal: space.sm + 2, paddingVertical: space.sm }}>
                No output
              </T>
            )
          )}
        </View>
      )}
    </View>
  );
}

/** OpenBot elevated compact card for a file edit or creation step. */
export function DiffCard({
  step,
  parsed = parseStepInput(step),
}: {
  step: Step;
  parsed?: ParsedStepInput;
  live?: boolean;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const running = step.status === "Running";
  const failed = step.status === "Failed";
  const diff = parsed.diff;
  const previewLimit = 8;
  const previewClipped = !!diff && diff.lines.length > previewLimit;
  const shownLines = diff ? (expanded ? diff.lines : diff.lines.slice(0, previewLimit)) : [];
  const label = parsed.fileName || stepHeadline(step, parsed);
  return (
    <View
      style={{
        borderRadius: radius.md,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: failed ? colors.danger : colors.line,
        overflow: "hidden",
      }}
    >
      <Tap
        onPress={() => setExpanded((e) => !e)}
        feel="select"
        sink={0.99}
        accessibilityLabel={"File change: " + label}
        accessibilityState={{ expanded }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          paddingHorizontal: space.sm + 2,
          paddingVertical: space.sm,
        }}
      >
        {running ? <StepMark status="Running" size={13} /> : <KindIcon kind={parsed.kind} size={14} color={colors.muted} />}
        <T variant="footnote" weight="600" color="ink" numberOfLines={1} style={{ flex: 1 }}>
          {label}
        </T>
        {diff && (
          <View style={{ flexDirection: "row", gap: 5 }}>
            {diff.added > 0 && (
              <T variant="caption" weight="600" color="success" style={{ fontFamily: MONO }}>
                +{diff.added}
              </T>
            )}
            {diff.removed > 0 && (
              <T variant="caption" weight="600" color="danger" style={{ fontFamily: MONO }}>
                -{diff.removed}
              </T>
            )}
          </View>
        )}
        {expanded ? (
          <ChevronDown size={14} color={colors.faint} strokeWidth={2.2} />
        ) : (
          <ChevronRight size={14} color={colors.faint} strokeWidth={2.2} />
        )}
      </Tap>
      {diff && shownLines.length > 0 && (
        <View style={{ borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.canvas }}>
          <DiffLinesView lines={shownLines} truncated={expanded && diff.truncated} />
          {previewClipped && (
            <Tap
              onPress={() => setExpanded((e) => !e)}
              feel="select"
              style={{
                borderTopWidth: 1,
                borderTopColor: colors.line,
                paddingHorizontal: space.sm + 2,
                paddingVertical: 6,
              }}
            >
              <T variant="caption" color="muted">
                {expanded ? "Show fewer lines" : `Show all ${diff.lines.length} lines`}
              </T>
            </Tap>
          )}
        </View>
      )}
      {!diff && expanded && (
        <View style={{ borderTopWidth: 1, borderTopColor: colors.line, padding: space.sm, backgroundColor: colors.canvas }}>
          <StepDetailView step={step} parsed={parsed} />
        </View>
      )}
    </View>
  );
}

/** Single expandable step inside an Open-mode group or expanded Fold group. */
function ExpandableStepRow({ step }: { step: Step }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const parsed = parseStepInput(step);
  const took = stepSeconds(step);
  return (
    <View>
      <Tap
        onPress={() => setOpen((o) => !o)}
        feel="select"
        accessibilityState={{ expanded: open }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          paddingVertical: 5,
        }}
      >
        <StepMark status={step.status} size={13} />
        <T variant="footnote" color="ink2" numberOfLines={1} style={{ flex: 1 }}>
          {stepHeadline(step, parsed)}
        </T>
        {parsed.diff && (
          <View style={{ flexDirection: "row", gap: 4 }}>
            {parsed.diff.added > 0 && (
              <T variant="caption" weight="600" color="success" style={{ fontFamily: MONO }}>
                +{parsed.diff.added}
              </T>
            )}
            {parsed.diff.removed > 0 && (
              <T variant="caption" weight="600" color="danger" style={{ fontFamily: MONO }}>
                -{parsed.diff.removed}
              </T>
            )}
          </View>
        )}
        {!!took && (
          <T variant="caption" color="muted" style={{ fontVariant: ["tabular-nums"] }}>
            {took}
          </T>
        )}
        {open ? (
          <ChevronDown size={13} color={colors.faint} strokeWidth={2.2} />
        ) : (
          <ChevronRight size={13} color={colors.faint} strokeWidth={2.2} />
        )}
      </Tap>
      {open && (
        <View style={{ paddingLeft: 20, paddingBottom: 6 }}>
          <StepDetailView step={step} parsed={parsed} />
        </View>
      )}
    </View>
  );
}

/** T3 Code Open-mode frameless inline work-group row: [icon] [summary] [chevron]. */
export function OpenWorkGroupRow({ group }: { group: OpenWorkGroup }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const single = group.steps.length === 1 ? group.steps[0] : undefined;
  const singleParsed = single ? parseStepInput(single) : undefined;
  const liveTailStep = group.running
    ? [...group.steps].reverse().find((s) => s.status === "Running" && (s.progress || s.output))
    : undefined;
  const liveTail = liveTailStep
    ? (liveTailStep.progress || liveTailStep.output || "").trim().split("\n").at(-1)?.slice(-120)
    : undefined;

  return (
    <View>
      <Tap
        onPress={() => setOpen((o) => !o)}
        feel="select"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={group.label}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 34,
          paddingVertical: 4,
        }}
      >
        <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
          {group.running ? (
            <ActivityIndicator size="small" color={colors.muted} style={{ transform: [{ scale: 0.72 }] }} />
          ) : (
            <KindIcon
              kind={group.primaryKind}
              size={15}
              color={group.failedCount > 0 ? colors.danger : colors.muted}
            />
          )}
        </View>
        <ShimmerLabel
          active={group.running}
          text={group.label}
          variant="subhead"
          weight="500"
          color="muted"
          numberOfLines={1}
          style={{ flexShrink: 1 }}
        />
        {singleParsed?.diff && (
          <View style={{ flexDirection: "row", gap: 4 }}>
            {singleParsed.diff.added > 0 && (
              <T variant="caption" weight="600" color="success" style={{ fontFamily: MONO }}>
                +{singleParsed.diff.added}
              </T>
            )}
            {singleParsed.diff.removed > 0 && (
              <T variant="caption" weight="600" color="danger" style={{ fontFamily: MONO }}>
                -{singleParsed.diff.removed}
              </T>
            )}
          </View>
        )}
        {group.failedCount > 0 && (
          <T variant="caption" weight="600" color="danger">
            · {group.failedCount} failed
          </T>
        )}
        {open ? (
          <ChevronDown size={14} color={colors.faint} strokeWidth={2.2} />
        ) : (
          <ChevronRight size={14} color={colors.faint} strokeWidth={2.2} />
        )}
      </Tap>
      {!open && !!liveTail && (
        <T variant="caption" color="muted" numberOfLines={1} style={{ fontFamily: MONO, paddingLeft: 24, paddingBottom: 2 }}>
          {liveTail}
        </T>
      )}
      {open && (
        <View
          style={{
            marginLeft: 7,
            paddingLeft: 14,
            borderLeftWidth: 1,
            borderLeftColor: colors.line,
            paddingVertical: 4,
            marginBottom: 4,
          }}
        >
          {single ? (
            <StepDetailView step={single} parsed={singleParsed} />
          ) : (
            group.steps.map((s) => <ExpandableStepRow key={s.id} step={s} />)
          )}
        </View>
      )}
    </View>
  );
}

/** OpenBot quiet folded tool line with IconStack + summary + chevron. */
export function FoldToolLine({
  kinds,
  label,
  meta,
  failedCount = 0,
  running = false,
  expanded = false,
  onPress,
  ringColor,
}: {
  kinds: StepKind[];
  label: string;
  meta?: string;
  failedCount?: number;
  running?: boolean;
  expanded?: boolean;
  onPress: () => void;
  ringColor?: string;
}) {
  const { colors } = useTheme();
  return (
    <Tap
      onPress={onPress}
      feel="select"
      accessibilityState={{ expanded }}
      accessibilityLabel={label + (meta ? ", " + meta : "")}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: 34,
        paddingVertical: 4,
      }}
    >
      {kinds.length > 0 && <IconStack kinds={kinds} size={11} ringColor={ringColor} />}
      <ShimmerLabel
        active={running}
        text={label}
        variant="footnote"
        weight="500"
        color="muted"
        numberOfLines={1}
        style={{ flexShrink: 1 }}
      />
      {failedCount > 0 && (
        <T variant="caption" weight="600" color="danger">
          {failedCount} failed
        </T>
      )}
      {!!meta && (
        <T variant="caption" color="faint" style={{ fontVariant: ["tabular-nums"] }}>
          {meta}
        </T>
      )}
      {expanded ? (
        <ChevronDown size={14} color={colors.faint} strokeWidth={2.2} />
      ) : (
        <ChevronRight size={14} color={colors.faint} strokeWidth={2.2} />
      )}
    </Tap>
  );
}

function FoldGroupRow({ block }: { block: Extract<FoldBlock, { kind: "group" }> }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const single = block.steps.length === 1 ? block.steps[0] : undefined;
  return (
    <View>
      <FoldToolLine
        kinds={block.kinds}
        label={block.label}
        failedCount={block.failedCount}
        running={block.running}
        expanded={open}
        onPress={() => setOpen((o) => !o)}
      />
      {open && (
        <View
          style={{
            marginLeft: 10,
            paddingLeft: 12,
            borderLeftWidth: 1,
            borderLeftColor: colors.line,
            paddingVertical: 4,
          }}
        >
          {single ? (
            <StepDetailView step={single} />
          ) : (
            block.steps.map((s) => <ExpandableStepRow key={s.id} step={s} />)
          )}
        </View>
      )}
    </View>
  );
}

/** Expanded Fold-mode contents: elevated CommandCard/DiffCard frames plus folded non-coding groups. */
export function FoldBlockList({ blocks }: { blocks: FoldBlock[] }) {
  return (
    <View style={{ gap: space.sm, paddingTop: 4 }}>
      {blocks.map((b) => {
        if (b.kind === "command") return <CommandCard key={b.id} step={b.step} parsed={b.parsed} />;
        if (b.kind === "diff") return <DiffCard key={b.id} step={b.step} parsed={b.parsed} />;
        return <FoldGroupRow key={b.id} block={b} />;
      })}
    </View>
  );
}

/**
 * Reasoning block for both live and completed turns.
 * Open mode (`fold={false}`): T3 Code frameless inline brain + non-italic readable prose, default open.
 * Fold mode (`fold={true}`): OpenBot quiet single-line disclosure (with live shimmer), default collapsed.
 */
export function ThinkingBlock({
  text,
  title,
  running,
  fold,
}: {
  text: string;
  title: string;
  running: boolean;
  fold: boolean;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(!fold);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    setOpen(!fold);
  }, [fold]);
  const clean = text.replace(/\*\*(.+?)\*\*/g, "$1").trim();
  if (!clean) return null;
  const long = clean.length > (fold ? 420 : 750) || clean.split("\n").length > (fold ? 6 : 10);

  return (
    <View>
      <Tap
        onPress={() => setOpen((o) => !o)}
        feel="select"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          minHeight: 32,
          paddingVertical: 3,
        }}
      >
        <Brain size={14} color={colors.muted} strokeWidth={2} />
        <ShimmerLabel
          active={running}
          text={title}
          variant="subhead"
          weight="500"
          color="muted"
          numberOfLines={1}
          style={{ flexShrink: 1 }}
        />
        {open ? (
          <ChevronDown size={13} color={colors.faint} strokeWidth={2.2} />
        ) : (
          <ChevronRight size={13} color={colors.faint} strokeWidth={2.2} />
        )}
      </Tap>
      {open && (
        <View
          style={
            fold
              ? {
                  marginLeft: 6,
                  paddingLeft: 12,
                  borderLeftWidth: 1.5,
                  borderLeftColor: colors.line,
                  paddingTop: 2,
                  paddingBottom: 4,
                }
              : {
                  paddingLeft: 21,
                  paddingTop: 2,
                  paddingBottom: 4,
                }
          }
        >
          <T
            variant="subhead"
            color="muted"
            selectable
            numberOfLines={!showAll && !running ? (fold ? 6 : 12) : undefined}
            style={{ lineHeight: 21 }}
          >
            {clean}
          </T>
          {long && !running && (
            <Tap onPress={() => setShowAll((s) => !s)} feel="select" style={{ paddingTop: 4, alignSelf: "flex-start" }}>
              <T variant="caption" weight="600" color="muted">
                {showAll ? "Show less" : "Show more"}
              </T>
            </Tap>
          )}
        </View>
      )}
    </View>
  );
}
