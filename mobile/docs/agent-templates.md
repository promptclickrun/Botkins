# Agent templates in the Marketplace

A marketplace can offer agent templates: a bot's name, role, about line, instructions and look, ready to become a bot. A person browses them in Marketplace › Agents, on the phone and in the app on the computer. Install opens Create a bot, filled in from the template. The person changes what they like, the look too, and saves. Nothing is installed before that: the new bot is the only thing that is made.

Capability: `agent-templates-v1`, named by the computer's app (`backend.capabilities`). Without it the phone says "Update the app on your computer".

## Where templates come from

The computer reads them, as it reads plugins. A phone never fetches GitHub. The first-party catalog is `promptclickrun/botkins-marketplace`, the built-in marketplace "Botkins". Any marketplace the person added can offer templates too, in the same way.

A marketplace's catalog file (`.github/plugin/marketplace.json`, the file that lists its plugins) lists its templates under `agents`, beside `plugins`:

```json
"agents": [
  {
    "name": "inbox-triage",
    "source": "./agents/inbox-triage.json",
    "category": "productivity",
    "version": "1.0.0",
    "keywords": ["email", "inbox"],
    "author": { "name": "Botkins", "url": "https://botkins.app" }
  }
]
```

- `name`: one word in lowercase letters, digits and dashes, unique in the marketplace. The template's id is `name@marketplace`, as a plugin's is. Ids are opaque to a client.
- `source`: a path in the same repository or folder, ending in `.json`, that does not climb out with `..`. The file is a Botkins bot template, the file "Export template…" writes: `{ "format": "botkins.bot-template", "version": 1, "name", "role", "summary", "instructions", "look" }`. Its fields are checked the same way as an imported template (`templateFields` in the desktop app's `desktop/templates.mjs`). The template's `name` is the bot's name and the title shown. Its `summary` is the description shown.
- `category`: optional. One of `writing`, `research`, `productivity`, `work`, `dev`, `learning`, `health`, `finance`, `home`, `media`, `life`, `other`. Another word is shown as Other.
- `version`, `keywords` (at most 12) and `author` (`{ name, url? }` or a string) are optional, and are shown as they are given.

The computer reads the template files when someone browses templates, at most once an hour for each marketplace (with the catalog itself). A file it can't read, or that isn't a template, is left out. At most 200 templates are read from one marketplace, and a file is at most 256 KB.

## Botkins' own templates

The app on the computer also carries a set of its own (`desktop/agent-templates-first-party.mjs`), listed first under the marketplace `botkins-app` ("Botkins", built in). Each keeps one contract: one concrete job and a named deliverable that the summary says; useful on day one, with connected apps or from pasted text, files and screenshots; an explicit "Ask first" step before anything is sent, posted, filed or changed outside the chat; and, where watching over time helps, a suggested Routine or Proactive pairing that stays quiet when nothing is new. Their listings add `deliverable`, `dayOne`, `approval`, `group` ("everyday" or "builder"), `pairing` (`{kind: "routine" | "proactive", cadence?, note}`) and `apps` (ids in the direct apps catalog). A Home starter has `starter: true` and is listed before every other template.

## Calls

Both are reads. A team member needs `agents` › `create` (a template is only good for making a bot). A phone makes them through the link. The window makes them as `window.botkins["agents.browse"]` and `["agents.template"]`.

```ts
"agents.browse"(query?: { query?: string; category?: string; marketplace?: string }):
  Promise<{ agents: MarketAgent[]; categories: MarketAgentCategory[] }>
"agents.template"(id: string): Promise<MarketAgentTemplate>

type MarketAgent = {
  id: string;              // name@marketplace
  name: string;            // the bot's name, shown as the title
  role: string;
  summary: string;         // shown as the description
  look?: BotkinLook;       // the look the bot starts with
  category?: string;       // one of the words above
  categoryName?: string;   // the category's words, e.g. "Productivity"
  marketplace: string;     // the marketplace's id
  marketplaceName: string; // its name, e.g. "Botkins"
  builtIn: boolean;        // a marketplace that comes with Botkins
  version?: string;
  author?: string;
  keywords?: string[];
};
type MarketAgentCategory = { id: string; name: string; count: number };
type MarketAgentTemplate = MarketAgent & { instructions: string };
```

- `query` (at most 200 characters) matches the name, role, summary, category and keywords. `category` and `marketplace` narrow the list. `categories` counts the templates the other filters leave, so a client can show its chips with counts.
- The order is the catalog's own (the built-in Botkins marketplace first), so a catalog puts its best templates first.
- `agents.template` answers with the template's instructions, for Create a bot. It is refused with a sentence when the template is gone.

## What a client shows

- The list: each template's Botkin (`look`), its name, its summary, and its category and marketplace on one line. Search, and the categories as chips.
- A template's page: the Botkin, the name, the role, the summary, category · marketplace · version · author, the instructions as they will be given, and one main action, Install.
- Install opens Create a bot filled in from `agents.template`: name, role, about, instructions and look. When the marketplace is not built in, Create a bot says one line under the form's start: "From <marketplace>. Someone else wrote these instructions: read them first."
- The bot is made with `addBot` as any other. A template is not saved as one of the person's own templates.
