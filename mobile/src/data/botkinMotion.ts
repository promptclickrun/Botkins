// Generated from design/botkins-kit/motion/catalog.js (the kit's renderer-independent motion spec).
// Poses are [x, y, rotation] in a 256-unit canvas around the pivot (128, 172), with equal time
// between them and ease-in-out from one to the next. Activities loop; outcomes and reactions play
// once and hold.

export type BotkinEyes = "oval" | "button" | "smile" | "sleepy" | "wink" | "curious";
export type BotkinClip = { name: string; loop: boolean; durationMs: number; eyes: BotkinEyes; badge: string | null; color: string; poses: [number, number, number][]; mouth: "smile" | "laugh" | "sad" | null };

export const CLIPS = {
  "idle": {
    "name": "Idle",
    "loop": true,
    "durationMs": 3400,
    "eyes": "oval",
    "badge": null,
    "color": "#70834B",
    "poses": [
      [
        0,
        0,
        0
      ],
      [
        0,
        -2,
        0.6
      ],
      [
        0,
        0,
        0
      ]
    ],
    "mouth": null
  },
  "listening": {
    "name": "Listening",
    "loop": true,
    "durationMs": 1800,
    "eyes": "curious",
    "badge": "sound",
    "color": "#548376",
    "poses": [
      [
        -1,
        0,
        -3
      ],
      [
        1,
        -2,
        -6
      ],
      [
        -1,
        0,
        -3
      ]
    ],
    "mouth": null
  },
  "thinking": {
    "name": "Thinking",
    "loop": true,
    "durationMs": 2400,
    "eyes": "curious",
    "badge": "dots",
    "color": "#E8A945",
    "poses": [
      [
        0,
        0,
        0
      ],
      [
        1,
        -3,
        4
      ],
      [
        2,
        -3,
        5
      ],
      [
        0,
        0,
        0
      ]
    ],
    "mouth": null
  },
  "planning": {
    "name": "Planning",
    "loop": true,
    "durationMs": 2100,
    "eyes": "oval",
    "badge": "list",
    "color": "#70834B",
    "poses": [
      [
        0,
        0,
        0
      ],
      [
        -2,
        -2,
        -2
      ],
      [
        0,
        -2,
        1
      ],
      [
        0,
        0,
        0
      ]
    ],
    "mouth": null
  },
  "browsing": {
    "name": "Browsing",
    "loop": true,
    "durationMs": 2100,
    "eyes": "oval",
    "badge": "search",
    "color": "#548376",
    "poses": [
      [
        -3,
        0,
        -3
      ],
      [
        4,
        -2,
        4
      ],
      [
        -3,
        0,
        -3
      ]
    ],
    "mouth": null
  },
  "coding": {
    "name": "Coding",
    "loop": true,
    "durationMs": 980,
    "eyes": "oval",
    "badge": "code",
    "color": "#B45432",
    "poses": [
      [
        0,
        0,
        0
      ],
      [
        -1,
        1,
        -1.5
      ],
      [
        0,
        0,
        0
      ],
      [
        1,
        1,
        1.5
      ],
      [
        0,
        0,
        0
      ]
    ],
    "mouth": null
  },
  "working": {
    "name": "Working",
    "loop": true,
    "durationMs": 1500,
    "eyes": "oval",
    "badge": "gear",
    "color": "#E8A945",
    "poses": [
      [
        0,
        0,
        0
      ],
      [
        0,
        -3,
        -2
      ],
      [
        0,
        0,
        0
      ],
      [
        0,
        -3,
        2
      ],
      [
        0,
        0,
        0
      ]
    ],
    "mouth": null
  },
  "waiting": {
    "name": "Waiting",
    "loop": true,
    "durationMs": 3100,
    "eyes": "sleepy",
    "badge": "clock",
    "color": "#E8A945",
    "poses": [
      [
        0,
        0,
        0
      ],
      [
        0,
        2,
        -1
      ],
      [
        0,
        0,
        0
      ]
    ],
    "mouth": null
  },
  "needs-input": {
    "name": "Needs input",
    "loop": true,
    "durationMs": 2300,
    "eyes": "curious",
    "badge": "question",
    "color": "#B45432",
    "poses": [
      [
        0,
        0,
        0
      ],
      [
        0,
        -3,
        -4
      ],
      [
        0,
        0,
        0
      ]
    ],
    "mouth": null
  },
  "retrying": {
    "name": "Retrying",
    "loop": true,
    "durationMs": 1650,
    "eyes": "oval",
    "badge": "retry",
    "color": "#B45432",
    "poses": [
      [
        0,
        0,
        0
      ],
      [
        -2,
        1,
        -3
      ],
      [
        1,
        -2,
        2
      ],
      [
        0,
        0,
        0
      ]
    ],
    "mouth": null
  },
  "completed": {
    "name": "Completed",
    "loop": false,
    "durationMs": 950,
    "eyes": "smile",
    "badge": "check",
    "color": "#70834B",
    "poses": [
      [
        0,
        0,
        0
      ],
      [
        0,
        2,
        0
      ],
      [
        0,
        -9,
        -3
      ],
      [
        0,
        0,
        2
      ],
      [
        0,
        0,
        0
      ]
    ],
    "mouth": null
  },
  "error": {
    "name": "Error",
    "loop": false,
    "durationMs": 740,
    "eyes": "curious",
    "badge": "alert",
    "color": "#B45432",
    "poses": [
      [
        0,
        0,
        0
      ],
      [
        -4,
        0,
        -2
      ],
      [
        4,
        0,
        2
      ],
      [
        -2,
        0,
        -1
      ],
      [
        0,
        0,
        0
      ]
    ],
    "mouth": null
  },
  "like": {
    "name": "Like",
    "loop": false,
    "durationMs": 900,
    "eyes": "wink",
    "badge": "thumb",
    "color": "#E8A945",
    "poses": [
      [
        0,
        0,
        0
      ],
      [
        0,
        3,
        3
      ],
      [
        0,
        -4,
        -2
      ],
      [
        0,
        0,
        0
      ]
    ],
    "mouth": null
  },
  "love": {
    "name": "Love",
    "loop": false,
    "durationMs": 1250,
    "eyes": "smile",
    "badge": "heart",
    "color": "#BB6776",
    "poses": [
      [
        0,
        0,
        0
      ],
      [
        0,
        -4,
        -5
      ],
      [
        0,
        -3,
        2
      ],
      [
        0,
        0,
        0
      ]
    ],
    "mouth": "smile"
  },
  "laugh": {
    "name": "Laugh",
    "loop": false,
    "durationMs": 1050,
    "eyes": "smile",
    "badge": "spark",
    "color": "#E8A945",
    "poses": [
      [
        0,
        0,
        0
      ],
      [
        0,
        -7,
        -3
      ],
      [
        0,
        1,
        2
      ],
      [
        0,
        -5,
        -2
      ],
      [
        0,
        0,
        0
      ]
    ],
    "mouth": "laugh"
  },
  "sad": {
    "name": "Sad",
    "loop": false,
    "durationMs": 1450,
    "eyes": "sleepy",
    "badge": "drop",
    "color": "#548376",
    "poses": [
      [
        0,
        0,
        0
      ],
      [
        0,
        4,
        -6
      ],
      [
        0,
        3,
        -4
      ]
    ],
    "mouth": "sad"
  }
} as const satisfies Record<string, BotkinClip>;
export type BotkinState = keyof typeof CLIPS;

/** The badge drawings, in a 32-unit box. */
export const BADGE_ICONS: Record<string, string> = {
  "sound": "M5 14v4m5-9v14m6-18v22m6-18v14m5-9v4",
  "dots": "M6 16h.1M16 16h.1M26 16h.1",
  "list": "M6 8h2m5 0h13M6 16h2m5 0h13M6 24h2m5 0h13",
  "search": "M21 21l7 7M23 14a9 9 0 1 1-18 0 9 9 0 1 1 18 0",
  "code": "M10 9l-7 7 7 7m12-14 7 7-7 7m-4-18-4 22",
  "gear": "M16 3v5m0 16v5M3 16h5m16 0h5M7 7l4 4m10 10 4 4M7 25l4-4m10-10 4-4M24 16a8 8 0 1 1-16 0 8 8 0 1 1 16 0",
  "clock": "M28 16a12 12 0 1 1-24 0 12 12 0 1 1 24 0M16 8v9l6 3",
  "question": "M9 10c1-9 18-8 15 2-1 4-8 5-8 10m0 5h.2",
  "retry": "M26 13a10 10 0 1 0-2 10m3-18v9h-9",
  "check": "M5 16l8 8L28 8",
  "alert": "M16 5v14m0 7h.2",
  "thumb": "M5 15h5v13H5z M10 16l6-8 1-5q5 0 4 6l-1 5h6q3 0 2 4l-2 8q-1 2-4 2H10z",
  "heart": "M16 27C11 23 2 17 3 10 4 3 12 3 16 9 21 2 29 4 29 11 29 17 21 24 16 27Z",
  "spark": "M16 3q1 11 11 13-10 2-11 13Q14 18 4 16 14 14 16 3Z",
  "drop": "M16 3C13 10 6 16 6 21a10 10 0 0 0 20 0c0-5-6-11-10-18Z"
};
/** Badges that are filled shapes; the rest are line drawings. */
export const FILLED_BADGES = ["heart", "spark", "drop"];
export const MOUTHS = { smile: "m-6 0q6 7 12 0", laugh: "m-8 0q8 4 16 0-1 14-9 12-6-1-7-12z", sad: "m-6 3q6-8 12 0" } as const;
