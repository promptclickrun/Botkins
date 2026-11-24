# Botkins design kit

Open studio.html in a browser after extracting the ZIP. Pick a character, palette, and state. Replay restarts a reaction. Save SVG exports that exact combination, including your reduced-motion selection.

## Using the assets

- avatars/ holds 30 transparent vector heads. The ten Bloub-inspired characters are Brim, Clover, Drip, Dune, Gloop, Mallow, Orbit, Pebble, Ripple and Wisp.
- animated/<head>/<state>.svg holds 16 ready-to-use clips per head in its original colors. The files contain embedded CSS animation. Use an image element or a browser-based SVG renderer. System Reduce Motion freezes the pose and preserves the state badge. For an explicit static export, enable Reduced motion in the studio.
- fonts/ contains DejaVu Serif Bold for display and Open Sans Regular for body and labels, with notices. Use the serif for names and short headlines. Use the sans for settings, descriptions, and state labels. On narrow screens, pair a 32px headline with 16px body and 14px labels.
- theme/tokens.json and theme/botkins.css define the core palette and semantic light/dark colors. Set data-theme="dark" on a parent for dark mode. Pair action with onAction for buttons. Use ink for content and muted for secondary text.
- motion/states.json is the renderer-independent motion spec. Its poses are [x, y, rotation] in a 256-unit canvas, pivot (128,172), with equal time between keyframes and ease-in-out between poses. Badges remain anchored. For native renderers without embedded CSS animation, animate the head layer with these values, then draw the badge above it. Keep a readable text label alongside small avatars.
- customize.js and motion/render.js accept original SVG strings. The browser studio works offline. In CommonJS:

```js
const motion = require('./motion/render.js');
const svg = motion.render(originalHeadSvg, 'Listening', {
  palette: 'Tidepool',
  reducedMotion: false
});
```

Palette also accepts four hex colors in shell, accent, faceplate, eye order. An optional eyes value overrides the state expression. Keep the selected Botkin stable as the agent progresses.

## Playback

Listening → Thinking → Planning → Browsing, Coding, or Working → Completed is one typical sequence. Drive transitions from real agent events. Waiting means an external dependency is pending. Needs input means the user has a decision. Retrying marks another attempt. Error is a terminal outcome unless your runtime retries. Activities loop until the next event. Outcomes and reactions play once and hold. Restore Idle or the prior active state when the application dismisses the feedback. See durationMs for each clip's length. Native playback timing and device rendering require host integration.

## Blinking
Blinking is enabled in all base avatars and in every motion export with open eyes. Each Botkin has its own 3.8–5 second cycle and phase offset. Both open eyes close together. The open eye in a wink can blink on its own. Smile and Sleepy keep their drawn eyelids. Use the Blink checkbox in the studio or pass `{blink:false}` to the motion renderer (or as the fourth argument to Botkins.render). Reduced motion also disables blinking.

For a native rig, scale each open eye vertically around its own center. Use normalized keyframes (time, scaleY): (0,1), (.92,1), (.94,.09), (.946,.09), (.97,1), (1,1), with ease-in-out interpolation. Read the cycle and negative delay from the base SVG's blink style to match that character. Keep the mouth, badge, and closed eyelids on separate layers.
