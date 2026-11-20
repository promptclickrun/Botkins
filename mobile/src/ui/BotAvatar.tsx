// A bot, drawn as its Botkin and acting out what it is doing.
// The head is a picture from the design kit (one per character and palette). A look in colors of
// its own is drawn as the head's layers instead: three masks tinted with the shell, accent and
// faceplate colors, then the shading and the grain (scripts/build-botkins.mjs explains why that is
// exactly what the kit draws). Eyes, mouth, badge and motion are drawn here from the kit's motion
// spec (src/data/botkinMotion.ts): the head layer moves through the state's poses around its
// pivot, open eyes blink, and the badge stays put. The bot's own eye style takes the place of the
// kit's open "oval" eyes; a state with an expression of its own (curious, smiling, sleepy) keeps it.
import { Image } from "expo-image";
import { memo, type ReactNode, useEffect, useMemo } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import Animated, { cancelAnimation, Easing, interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import Svg, { Circle, Ellipse, G, Path } from "react-native-svg";
import { BADGE_ICONS, type BotkinClip, type BotkinState, CLIPS, FILLED_BADGES, MOUTHS } from "@/data/botkinMotion";
import { lookOf, type ResolvedLook, resolveLook } from "@/data/botLook";
import type { BotkinLook } from "@/link/types";
import type { AvatarState } from "@/state/hooks";

const CLIP_FOR: Record<AvatarState, BotkinState> = {
  idle: "idle",
  listening: "listening",
  thinking: "thinking",
  planning: "planning",
  browsing: "browsing",
  coding: "coding",
  working: "working",
  "needs-input": "needs-input",
  retrying: "retrying",
  completed: "completed",
  error: "error",
  like: "like",
  love: "love",
  laugh: "laugh",
  sad: "sad",
  waiting: "needs-input",
  pending: "waiting",
  talking: "listening",
  happy: "completed",
  sleeping: "waiting",
};

const fill = { position: "absolute", left: 0, top: 0, right: 0, bottom: 0 } as const;
const BOX = "0 0 256 256";
const hash = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0);

export type BotAvatarProps = {
  /** A bot (its saved look, or its default character), or a look by itself. */
  bot?: { id?: string; look?: BotkinLook };
  look?: BotkinLook;
  state?: AvatarState;
  size?: number;
  /** Kept so older callers compile. Avatars are always drawn bare, with nothing behind them. */
  tile?: boolean;
  /** Every avatar moves. Pass false only for a picture that must hold still; the phone's Reduce Motion stills them all. */
  animated?: boolean;
  /** The state's badge at the corner. On by default from 40 points up. */
  badge?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** The head without eyes: the kit's picture for a palette, or the tinted layers for custom colors. */
function Head({ look, size }: { look: ResolvedLook; size: number }) {
  const box = { width: size, height: size };
  if (!look.custom) return <Image source={look.image} style={box} contentFit="contain" />;
  const { layers, colors } = look.custom;
  const stack: [number | null, string | undefined][] = [
    [layers.shell, colors[0]],
    [layers.accent, colors[1]],
    [layers.paper, colors[2]],
    [layers.shade, undefined],
    [layers.rest, undefined],
  ];
  return (
    <View style={box}>
      {stack.map(([source, color], index) => (source == null ? null : <Image key={index} source={source} tintColor={color ?? null} style={[fill, box]} contentFit="contain" transition={null} />))}
    </View>
  );
}

export const BotAvatar = memo(function BotAvatar({ bot, look: given, state = "idle", size = 52, animated = true, badge, style }: BotAvatarProps) {
  const spec = given ?? lookOf(bot ?? {});
  const colorKey = spec.colors?.join(",");
  const look = useMemo(() => resolveLook(spec), [spec.head, spec.palette, spec.eyes, colorKey]);
  const { head, ink } = look;
  const clip: BotkinClip = CLIPS[CLIP_FOR[state] ?? "idle"];
  const eyes = clip.eyes === "oval" ? look.eyes : clip.eyes;
  const inner = size;
  const unit = inner / 256;
  const still = useReducedMotion() || !animated;

  // The head moves through the clip's poses; `step` runs from 0 to the last pose.
  const step = useSharedValue(0);
  const lids = useSharedValue(1);
  const poses = clip.poses;
  const last = poses.length - 1;
  useEffect(() => {
    cancelAnimation(step);
    step.value = 0;
    if (still || last < 1) return;
    const each = clip.durationMs / last;
    const moves = poses.slice(1).map((_, index) => withTiming(index + 1, { duration: each, easing: Easing.inOut(Easing.ease) }));
    step.value = clip.loop ? withRepeat(withSequence(...moves, withTiming(0, { duration: 0 })), -1) : withSequence(...moves);
    return () => cancelAnimation(step);
  }, [clip, still, step, poses, last]);

  // Each character blinks on its own beat (3.8 to 5 seconds), so a screen of them never blinks in step.
  const blinks = eyes !== "smile" && eyes !== "sleepy";
  useEffect(() => {
    cancelAnimation(lids);
    lids.value = 1;
    if (still || !blinks) return;
    const seed = hash(head.name);
    const period = 3800 + (seed % 1201);
    const ease = { easing: Easing.inOut(Easing.ease) };
    lids.value = withDelay(
      seed % 2200,
      withRepeat(withSequence(withTiming(1, { duration: period * 0.92 }), withTiming(0.09, { duration: period * 0.02, ...ease }), withTiming(0.09, { duration: period * 0.006 }), withTiming(1, { duration: period * 0.024, ...ease }), withTiming(1, { duration: period * 0.03 })), -1),
    );
    return () => cancelAnimation(lids);
  }, [still, blinks, head.name, lids]);

  const range = useMemo(() => poses.map((_, index) => index), [poses]);
  const xs = useMemo(() => poses.map((pose) => pose[0] * unit), [poses, unit]);
  const ys = useMemo(() => poses.map((pose) => pose[1] * unit), [poses, unit]);
  const turns = useMemo(() => poses.map((pose) => pose[2]), [poses]);
  const pose = useAnimatedStyle(() => {
    if (range.length < 2) return { transform: [] };
    return { transform: [{ translateX: interpolate(step.value, range, xs) }, { translateY: interpolate(step.value, range, ys) }, { rotate: `${interpolate(step.value, range, turns)}deg` }] };
  });
  const blink = useAnimatedStyle(() => ({ transform: [{ scaleY: lids.value }] }));

  // Eyes: open ones go on the blinking layer, drawn lids and the mouth stay on the head.
  const { left, right, y } = head;
  const open: ReactNode[] = [];
  const drawn: ReactNode[] = [];
  [left, right].forEach((x, index) => {
    const arc = eyes === "smile" || eyes === "sleepy" || (eyes === "wink" && index === 1);
    if (arc) drawn.push(<Path key={"lid" + index} d={`M${x - 9} ${y + 3}q9 ${eyes === "sleepy" ? 7 : -11} 18 0`} stroke={ink} strokeWidth={5.5} strokeLinecap="round" fill="none" />);
    else open.push(<Ellipse key={"eye" + index} cx={x} cy={eyes === "curious" && index === 0 ? y - 3 : y} rx={8.5} ry={eyes === "button" ? 8.5 : eyes === "curious" && index === 1 ? 12 : 17} fill={ink} />);
  });
  if (clip.mouth) drawn.push(<Path key="mouth" transform={`translate(${(left + right) / 2} ${y + 17})`} d={MOUTHS[clip.mouth]} fill={clip.mouth === "laugh" ? ink : "none"} stroke={ink} strokeWidth={3} strokeLinecap="round" />);
  const place = `translate(${head.tx} ${head.ty}) scale(${head.scale})`;
  const eyeLine = ((head.ty + head.scale * y) / 256) * 100;

  const icon = clip.badge ? BADGE_ICONS[clip.badge] : null;
  const showBadge = !!icon && (badge ?? inner >= 40);

  const figure = (
    <View style={{ width: inner, height: inner }}>
      <Animated.View style={[fill, { transformOrigin: "50% 67.19%" }, pose]}>
        <Head look={look} size={inner} />
        {drawn.length > 0 && (
          <Svg width={inner} height={inner} viewBox={BOX} style={fill}>
            <G transform={place}>{drawn}</G>
          </Svg>
        )}
        {open.length > 0 && (
          <Animated.View style={[fill, { transformOrigin: `50% ${eyeLine}%` }, blink]}>
            <Svg width={inner} height={inner} viewBox={BOX}>
              <G transform={place}>{open}</G>
            </Svg>
          </Animated.View>
        )}
      </Animated.View>
      {showBadge && (
        <Svg width={inner} height={inner} viewBox={BOX} style={fill}>
          <G transform="translate(191 181)">
            <Circle cx={22} cy={22} r={24} fill="#fff1d8" stroke="#644533" strokeWidth={2} />
            <Circle cx={22} cy={22} r={20} fill={clip.color} />
            <Path transform="translate(8 8) scale(.875)" d={icon} fill={FILLED_BADGES.includes(clip.badge!) ? "#fff1d8" : "none"} stroke="#392a22" strokeWidth={clip.badge === "dots" ? 5 : 2.7} strokeLinecap="round" strokeLinejoin="round" />
          </G>
        </Svg>
      )}
    </View>
  );
  return <View style={style}>{figure}</View>;
});
