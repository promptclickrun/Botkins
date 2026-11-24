// A bot, drawn as its Botkin and acting out what it is doing.
// The head is a picture from the design kit (one per character and palette). A look in colors of
// its own is drawn as the head's layers instead: three masks tinted with the shell, accent and
// faceplate colors, then the shading and the grain (scripts/build-botkins.mjs explains why that is
// exactly what the kit draws). Eyes, mouth, badge and motion are drawn here from the kit's motion
// spec (src/data/botkinMotion.ts): the head layer moves through the state's poses around its
// pivot, open eyes blink, and the badge stays put. The bot's own eye style takes the place of the
// kit's open "oval" eyes; a state with an expression of its own (curious, smiling, sleepy) keeps it.
import { Image } from "expo-image";
import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { AccessibilityInfo, Animated, Easing, type StyleProp, useAnimatedValue, View, type ViewStyle } from "react-native";
import { trackResource } from "@/state/ledger";
import { useAppActive } from "@/state/useAppActive";
import Svg, { Circle, Ellipse, G, Path } from "react-native-svg";
import { BADGE_ICONS, type BotkinClip, type BotkinState, CLIPS, FILLED_BADGES, MOUTHS } from "@/data/botkinMotion";
import { lookOf, type ResolvedLook, resolveLook } from "@/data/botLook";
import type { BotkinLook } from "@/link/types";
import type { AvatarState } from "@/state/hooks";
import { usePrefs } from "@/state/prefs";
import { useAvatarMotion } from "./avatarMotion";
import { avatarBeat, avatarCanMove, avatarMotion, schedulePasses, scheduleRestPasses } from "./avatarRest";
import { useOnShow } from "./useOnShow";

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
const nativeTiming = { useNativeDriver: true, isInteraction: false };
const ease = Easing.inOut(Easing.ease);

/** Hold still until the phone answers, and follow changes while the avatar or dot is mounted. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let acceptInitial = true;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      acceptInitial = false;
      setReduced(value);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (acceptInitial) setReduced(value);
    }, () => {});
    return () => {
      acceptInitial = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

export type BotAvatarProps = {
  /** A bot (its saved look, or its default character), or a look by itself. */
  bot?: { id?: string; look?: BotkinLook };
  look?: BotkinLook;
  state?: AvatarState;
  size?: number;
  /** Kept so older callers compile. Avatars are always drawn bare, with nothing behind them. */
  tile?: boolean;
  /**
   * Left out, an avatar moves only inside an `AvatarMotion` screen (a bot's page). In a chat the
   * header face, the working capsule's face and the live voice dock pass true; nothing else does
   * (avatarMotion.tsx). The phone-wide setting and Reduce Motion still them all, and an avatar whose
   * screen can't be seen, or whose app isn't active, holds still by itself.
   */
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

export const BotAvatar = memo(function BotAvatar({ bot, look: given, state = "idle", size = 52, animated: asked, badge, style }: BotAvatarProps) {
  const screenMoves = useAvatarMotion();
  const animations = usePrefs((prefs) => prefs.avatarAnimations);
  const spec = given ?? lookOf(bot ?? {});
  const colorKey = spec.colors?.join(",");
  const look = useMemo(() => resolveLook(spec), [spec.head, spec.palette, spec.eyes, colorKey]);
  const { head, ink } = look;
  const clip: BotkinClip = CLIPS[CLIP_FOR[state] ?? "idle"];
  const eyes = clip.eyes === "oval" ? look.eyes : clip.eyes;
  const inner = size;
  const unit = inner / 256;
  const reducedMotion = useReducedMotion();
  const moves = avatarCanMove(animations, reducedMotion, asked ?? screenMoves);
  // Under another page, or in a tab that isn't selected, the head holds the pose it has: nothing
  // jumps while the next screen slides over it, and it starts its clip again when it is seen.
  const visible = useOnShow(moves);
  const seen = useAppActive(visible && moves);

  // The head moves through the clip's poses; `step` runs from 0 to the last pose.
  const step = useAnimatedValue(0);
  const lids = useAnimatedValue(1);
  const poses = clip.poses;
  const last = poses.length - 1;
  const motion = avatarMotion[state];
  const { blinkMs, firstBlinkMs } = avatarBeat(head.name);
  useLayoutEffect(() => {
    if (!moves) step.setValue(0);
    if (!moves || !seen || last < 1) return;
    step.setValue(0);
    // Ease each equal-length segment within one timing so a working loop repeats entirely natively.
    const pass = Animated.timing(step, {
      ...nativeTiming,
      duration: clip.durationMs,
      toValue: last,
      easing: (t) => {
        const position = t * last;
        const segment = Math.floor(position);
        return (segment + ease(position - segment)) / last;
      },
    });
    if (motion === "rest") {
      const entry = trackResource("animation", "BotAvatar:rest", state);
      const stop = scheduleRestPasses(head.name, () => {
        entry.bump();
        step.setValue(0);
        pass.start();
      });
      return () => {
        stop();
        pass.stop();
        entry.release();
      };
    }
    const entry = trackResource("animation", "BotAvatar:" + motion, state);
    const animation = motion === "loop" ? Animated.loop(pass) : pass;
    animation.start();
    return () => {
      animation.stop();
      entry.release();
    };
  }, [clip, motion, moves, seen, step, last, head.name, state]);

  const blinks = eyes !== "smile" && eyes !== "sleepy";
  useLayoutEffect(() => {
    lids.setValue(1);
    if (!moves || !seen || !blinks) return;
    const entry = trackResource("animation", "BotAvatar:blink", state);
    const blink = Animated.sequence([
      Animated.timing(lids, { ...nativeTiming, toValue: 0.09, duration: blinkMs * 0.02, easing: ease }),
      Animated.timing(lids, { ...nativeTiming, toValue: 0.09, duration: blinkMs * 0.006 }),
      Animated.timing(lids, { ...nativeTiming, toValue: 1, duration: blinkMs * 0.024, easing: ease }),
    ]);
    const stop = schedulePasses(firstBlinkMs, blinkMs, () => {
      entry.bump();
      blink.start();
    });
    return () => {
      stop();
      blink.stop();
      entry.release();
    };
  }, [moves, seen, blinks, blinkMs, firstBlinkMs, lids, state]);

  const pose = useMemo(() => {
    if (poses.length < 2) return undefined;
    const inputRange = poses.map((_, index) => index);
    return { transform: [
      { translateX: step.interpolate({ inputRange, outputRange: poses.map(([x]) => x * unit) }) },
      { translateY: step.interpolate({ inputRange, outputRange: poses.map(([, y]) => y * unit) }) },
      { rotate: step.interpolate({ inputRange, outputRange: poses.map(([, , angle]) => `${angle}deg`) }) },
    ] };
  }, [poses, step, unit]);
  const blink = { transform: [{ scaleY: lids }] };

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
