// The workflow as a canvas: drag with one finger to move around, pinch to zoom, hold a step to move it.
// Edges are SVG under the steps. A plus at each way out adds a step there.
import { LocateFixed, Minus, Plus, Rows3, TriangleAlert } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import { GestureDetector, useCompetingGestures, usePanGesture, usePinchGesture, useSimultaneousGestures, useTapGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Path, Text as SvgText } from "react-native-svg";
import type { WorkflowNode } from "@/link/types";
import { haptic, IconButton, radius, space, T, Tap, tint, useTheme } from "@/ui";
import type { NodeFieldAnalysis } from "./fields";
import { BRANCH_LABEL, type Branch, branchesOf, branchOf, bounds, type Graph, NODE_H, NODE_W, summary } from "./graph";
import { iconFor, useKindColor } from "./parts";

type Props = {
  graph: Graph;
  analysis: Record<string, NodeFieldAnalysis>;
  /** "across" in landscape, "down" in portrait: where the plus sits and how Tidy lays steps out. */
  direction: "across" | "down";
  botName: (id?: string, name?: string) => string | undefined;
  editable: boolean;
  onOpen: (id: string) => void;
  onAdd: (from: string, branch: Branch) => void;
  onMove: (id: string, position: { x: number; y: number }) => void;
  onTidy: () => void;
};

const MIN_SCALE = 0.35;
const MAX_SCALE = 2;
const PAD = 120;

export function Canvas({ graph, analysis, direction, botName, editable, onOpen, onAdd, onMove, onTidy }: Props) {
  const { colors } = useTheme();
  const [view, setView] = useState({ w: 0, h: 0 });
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const start = useSharedValue({ x: 0, y: 0, scale: 1 });
  const dragging = useSharedValue(false);
  const box = useMemo(() => bounds(graph), [graph]);
  // While a step is dragged, it draws where the finger is; the graph moves once it is dropped.
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const shown = useMemo(() => (drag ? { ...graph, nodes: graph.nodes.map((n) => (n.id === drag.id ? { ...n, position: { x: n.position.x + drag.dx, y: n.position.y + drag.dy } } : n)) } : graph), [graph, drag]);

  const fit = (animate = true) => {
    if (!view.w || !view.h) return;
    const s = Math.max(MIN_SCALE, Math.min(1.1, (view.w - 48) / box.w, (view.h - 120) / box.h));
    // Scale is about the content's top-left (transformOrigin 0 0), so the offset puts the box's middle in the view's middle.
    const tx = view.w / 2 - (box.x + box.w / 2) * s;
    const ty = (view.h - 60) / 2 - (box.y + box.h / 2) * s;
    const set = (v: { value: number }, to: number) => (v.value = animate ? withTiming(to, { duration: 260 }) : to);
    set(scale, s);
    set(x, tx);
    set(y, ty);
  };
  const fitted = useRef(false);
  useEffect(() => {
    if (!view.w || fitted.current) return;
    fitted.current = true;
    fit(false);
  }, [view.w, view.h]);
  // Rotating changes the view's shape: fit again so nothing ends up off screen.
  const lastShape = useRef(direction);
  useEffect(() => {
    if (lastShape.current === direction) return;
    lastShape.current = direction;
    fit();
  }, [direction, view.w]);

  const zoomBy = (factor: number) => {
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale.value * factor));
    const cx = view.w / 2;
    const cy = view.h / 2;
    x.value = withTiming(cx - ((cx - x.value) / scale.value) * next, { duration: 180 });
    y.value = withTiming(cy - ((cy - y.value) / scale.value) * next, { duration: 180 });
    scale.value = withTiming(next, { duration: 180 });
  };

  // One finger moves around; two belong to the pinch, which also follows the fingers' middle.
  const pan = usePanGesture({
    maxPointers: 1,
    onBegin: () => {
      "worklet";
      start.value = { x: x.value, y: y.value, scale: scale.value };
    },
    onUpdate: (e) => {
      "worklet";
      if (dragging.value) return;
      x.value = start.value.x + e.translationX;
      y.value = start.value.y + e.translationY;
    },
  });
  const pinch = usePinchGesture({
    onBegin: () => {
      "worklet";
      start.value = { x: x.value, y: y.value, scale: scale.value };
    },
    onUpdate: (e) => {
      "worklet";
      if (dragging.value) return;
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, start.value.scale * e.scale));
      // Keep the point under the fingers still while zooming.
      x.value = e.focalX - ((e.focalX - start.value.x) / start.value.scale) * next;
      y.value = e.focalY - ((e.focalY - start.value.y) / start.value.scale) * next;
      scale.value = next;
    },
    onDeactivate: () => {
      "worklet";
      start.value = { x: x.value, y: y.value, scale: scale.value };
    },
  });
  const moveAround = useSimultaneousGestures(pan, pinch);
  const content = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }));

  const kindColor = useKindColor();
  const byId = useMemo(() => new Map(shown.nodes.map((n) => [n.id, n])), [shown]);
  const width = box.x + box.w + PAD * 2;
  const height = box.y + box.h + PAD * 2;

  const edges = shown.edges.map((e) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return null;
    const across = b.position.x >= a.position.x + NODE_W * 0.75 || (b.position.x > a.position.x && Math.abs(b.position.y - a.position.y) < NODE_H);
    const [sx, sy] = across ? [a.position.x + NODE_W, a.position.y + NODE_H / 2] : [a.position.x + NODE_W / 2, a.position.y + NODE_H];
    const [tx, ty] = across ? [b.position.x, b.position.y + NODE_H / 2] : [b.position.x + NODE_W / 2, b.position.y];
    const bend = across ? Math.max(40, Math.abs(tx - sx) / 2) : Math.max(30, Math.abs(ty - sy) / 2);
    const d = across ? `M${sx},${sy} C${sx + bend},${sy} ${tx - bend},${ty} ${tx},${ty}` : `M${sx},${sy} C${sx},${sy + bend} ${tx},${ty - bend} ${tx},${ty}`;
    const branch = branchOf(e, a);
    const tone = branch === "no" || branch === "rejected" ? colors.danger : branch === "yes" || branch === "approved" ? colors.success : colors.lineStrong;
    return { id: e.id, d, tone, label: branch === "default" ? null : BRANCH_LABEL[branch], mx: (sx + tx) / 2, my: (sy + ty) / 2 - 6, tx, ty, across };
  });

  return (
    <View style={{ flex: 1, overflow: "hidden", backgroundColor: colors.sunken }} onLayout={(e: LayoutChangeEvent) => setView({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      <GestureDetector gesture={moveAround}>
        <View style={{ flex: 1 }} collapsable={false}>
          <Animated.View style={[{ position: "absolute", left: 0, top: 0, width, height, transformOrigin: "0 0" }, content]}>
            <Svg width={width} height={height} style={{ position: "absolute", left: 0, top: 0 }} pointerEvents="none">
              {edges.map(
                (e) =>
                  e && (
                    <Path key={e.id} d={e.d} stroke={e.tone} strokeWidth={2} fill="none" strokeLinecap="round" />
                  ),
              )}
              {edges.map(
                (e) =>
                  e?.label && (
                    <SvgText key={e.id + "l"} x={e.mx} y={e.my} fill={e.tone} fontSize={12} fontWeight="600" textAnchor="middle">
                      {e.label}
                    </SvgText>
                  ),
              )}
            </Svg>
            {shown.nodes.map((n) => (
              <CanvasNode
                key={n.id}
                node={n}
                color={kindColor(n.kind)}
                caption={summary(n, botName)}
                problems={(analysis[n.id]?.problems.length ?? 0) + (analysis[n.id] && !analysis[n.id].reachable ? 1 : 0)}
                editable={editable}
                scale={scale}
                dragging={dragging}
                onOpen={() => onOpen(n.id)}
                onDrag={(dx, dy) => setDrag({ id: n.id, dx, dy })}
                onDrop={(dx, dy) => {
                  setDrag(null);
                  if (Math.abs(dx) + Math.abs(dy) > 2) onMove(n.id, { x: n.position.x + dx, y: n.position.y + dy });
                }}
              />
            ))}
            {editable &&
              !drag &&
              shown.nodes.flatMap((n) => {
                const ways = branchesOf(n.kind) ?? ["default" as Branch];
                return ways.map((b, i) => {
                  const taken = shown.edges.some((e) => e.from === n.id && branchOf(e, n) === b);
                  const offset = ways.length > 1 ? (i === 0 ? -0.22 : 0.22) : 0;
                  const px = direction === "across" ? n.position.x + NODE_W + 14 : n.position.x + NODE_W * (0.5 + offset) - 14;
                  const py = direction === "across" ? n.position.y + NODE_H * (0.5 + offset) - 14 : n.position.y + NODE_H + 10;
                  return (
                    <Tap
                      key={n.id + b}
                      onPress={() => onAdd(n.id, b)}
                      accessibilityRole="button"
                      accessibilityLabel={`Add a step after ${n.label}${b === "default" ? "" : ", " + BRANCH_LABEL[b]}`}
                      hitSlop={10}
                      style={{
                        position: "absolute",
                        left: px,
                        top: py,
                        width: 28,
                        height: 28,
                        borderRadius: 14,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: taken ? colors.surface : colors.accent,
                        borderWidth: taken ? 1 : 0,
                        borderColor: colors.lineStrong,
                      }}
                    >
                      <Plus size={16} color={taken ? colors.ink2 : colors.onAccent} strokeWidth={2.4} />
                    </Tap>
                  );
                });
              })}
          </Animated.View>
        </View>
      </GestureDetector>
      <View style={{ position: "absolute", right: space.md, bottom: space.md, flexDirection: "row", gap: space.sm, padding: space.xs, borderRadius: radius.pill, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.line }}>
        <IconButton icon={Minus} label="Zoom out" size={36} onPress={() => zoomBy(1 / 1.25)} />
        <IconButton icon={Plus} label="Zoom in" size={36} onPress={() => zoomBy(1.25)} />
        <IconButton icon={LocateFixed} label="Fit the workflow" size={36} onPress={() => fit()} />
        {editable && (
          <IconButton
            icon={Rows3}
            label={direction === "across" ? "Tidy, left to right" : "Tidy, top to bottom"}
            size={36}
            onPress={() => {
              haptic.select();
              onTidy();
              fitted.current = false;
              setTimeout(() => fit(), 30);
            }}
          />
        )}
      </View>
    </View>
  );
}

function CanvasNode({ node, color, caption, problems, editable, scale, dragging, onOpen, onDrag, onDrop }: {
  node: WorkflowNode;
  color: string;
  caption: string;
  problems: number;
  editable: boolean;
  scale: { value: number };
  dragging: { value: boolean };
  onOpen: () => void;
  onDrag: (dx: number, dy: number) => void;
  onDrop: (dx: number, dy: number) => void;
}) {
  const { colors } = useTheme();
  const Icon = iconFor(node);
  const last = useRef({ dx: 0, dy: 0 });
  const hold = usePanGesture({
    runOnJS: true,
    enabled: editable,
    activateAfterLongPress: 280,
    onActivate: () => {
      haptic.select();
      dragging.value = true;
      last.current = { dx: 0, dy: 0 };
    },
    onUpdate: (e) => {
      const s = scale.value || 1;
      last.current = { dx: e.translationX / s, dy: e.translationY / s };
      onDrag(last.current.dx, last.current.dy);
    },
    onDeactivate: () => {
      dragging.value = false;
      onDrop(last.current.dx, last.current.dy);
    },
    onFinalize: () => {
      dragging.value = false;
    },
  });
  const tap = useTapGesture({ runOnJS: true, onActivate: () => onOpen() });
  const gesture = useCompetingGestures(hold, tap);
  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={`${node.label}. ${caption}${problems ? `. ${problems} to fix` : ""}`}
        accessibilityHint={editable ? "Opens the step. Hold and drag to move it." : "Opens the step."}
        style={{
          position: "absolute",
          left: node.position.x,
          top: node.position.y,
          width: NODE_W,
          height: NODE_H,
          borderRadius: radius.md,
          backgroundColor: colors.surface,
          borderWidth: 1.5,
          borderColor: problems ? colors.warning : tint(color, 0.45),
          padding: space.sm,
          flexDirection: "row",
          gap: space.sm,
          alignItems: "center",
        }}
      >
        <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: tint(color, 0.18), alignItems: "center", justifyContent: "center" }}>
          <Icon size={18} color={color} strokeWidth={2.2} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="footnote" weight="700" numberOfLines={1}>
            {node.label}
          </T>
          <T variant="caption" color="muted" numberOfLines={2}>
            {caption}
          </T>
        </View>
        {problems > 0 && <TriangleAlert size={16} color={colors.warning} />}
      </View>
    </GestureDetector>
  );
}
