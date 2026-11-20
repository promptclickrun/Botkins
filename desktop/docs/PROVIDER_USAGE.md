# Provider plans and limits

Each connected model provider's plan and what is left of its limits. The desktop app reads them (it holds the sign-ins), shows them on the Usage page and under each provider in the model picker, and answers a paired phone with the same data.

The code is `desktop/providerusage.mjs`. Each provider's adapter reads its own answer in `usage()` (`desktop/providers/<id>/index.mjs`). The types for the page are in `src/types.ts` (`ProviderUsage`, `ProviderLimit`).

## The call

`providerUsage(options?: { refresh?: boolean })` returns `ProviderUsage[]`.

- It is an ordinary app call, the same kind as `usage`: `window.botkins.providerUsage()` in the window, and the method `providerUsage` over the phone link.
- The app lists the capability `"provider-usage-v1"` when the call exists.
- There is one entry for each provider that is switched on and connected, in the app's provider order. A provider that is switched off or signed out has no entry.
- Without `refresh` the app answers from what it knows. A provider that was never asked is asked first (the call waits up to 25 seconds for it). An answer older than 2 minutes is returned as it is and read again in the background.
- With `refresh: true` every provider is read again before the call returns. One provider is not read more than once in 10 seconds.
- The window gets the event `provider-usage` (`window.botkins.onProviderUsage`) when a background read has come in. A phone asks again when it shows the screen.

## The shape

```ts
type ProviderUsage = {
  provider: string;                       // the provider's id, as in ProviderStatus.id: "copilot", "codex", "claude", "opencode", …
  name: string;                           // the provider's name as the app shows it: "GitHub Copilot", "ChatGPT", "Claude"
  plan?: string;                          // "Claude Max 20x", "ChatGPT Pro", "GitHub Copilot Pro+". Absent when the provider doesn't say.
  account?: "subscription" | "api-key";   // an API-key account is billed by use and has no plan limits
  limits: ProviderLimit[];                // [] when the provider gives none
  credits?: { label: string; amount: number; unit: string };   // a bought balance, where the provider has one
  note?: string;                          // one plain sentence when there is nothing to show and it is not an error
  source?: string;                        // whose tool said it: "Claude Code", "Codex", "GitHub Copilot"
  updatedAt?: number;                     // when these numbers were read from the provider
  error?: string;                         // one plain sentence when the last read failed; the limits are then the last known ones
};

type ProviderLimit = {
  id: string;                  // stable: "weekly", "session", "premium", "weekly-fable", "chat", …
  label: string;               // as shown: "Weekly", "5-hour session", "Premium requests", "Weekly, Fable"
  percentRemaining?: number;   // 0 to 100, one decimal at most. Absent when the provider doesn't say. Never a guess.
  percentUsed?: number;        // 100 - percentRemaining. Present exactly when percentRemaining is.
  resetAt?: number;            // when the limit starts again. Absent when the provider gives none, or when that time has passed.
  primary?: boolean;           // the one limit to show under the provider in the model picker
  window?: "session" | "week" | "month";
  model?: string;              // set when the limit counts one model only: "Fable". Such a limit is never primary.
  used?: number;               // the counts behind the percent, where the provider gives them
  limit?: number;
  unit?: "requests" | "credits";
  unlimited?: boolean;         // the provider says this allowance has no limit. No percent and no bar.
};
```

Times are milliseconds since 1970.

## Rules

- Every value was stated by the provider. A value it didn't state is left out. Nothing is estimated and nothing has a default.
- A limit without `percentRemaining` is shown with its label and "Not available" (or "Unlimited" when `unlimited` is set), and never with a bar.
- `primary` is set by the app on at most one limit per provider: of the limits that count every model and have a percent, the one with the least left. The weekly one wins a tie.
- `error` and `updatedAt` together mean the numbers are the last known ones. A screen shows the sentence and the age of the numbers.
- An entry holds no token, email, login, organization or account id. The file the app keeps the last answers in (`provider-usage.json` in the data folder) holds none either: it marks whose numbers they are with a digest.
- When the signed-in account changes, the kept numbers of that provider are dropped and it is read again.

## What each provider gives

Read from real sign-ins on 19 November 2026.

| Provider | Source | Plan | Limits |
| --- | --- | --- | --- |
| Claude | Claude Code's `get_usage` (the data behind `/usage`), through the Claude Agent SDK | `subscriptionType` and `planTier` of `claude auth status --json`: "Claude Max 20x" | `session` "5-hour session" and `weekly` "Weekly" (or "Weekly, all models" when a model is counted by itself), each with the percent used and a reset time, while Anthropic reports the window. One `weekly-<model>` for each model Anthropic counts by itself. `extra` "Extra usage" with a percent when paid extra usage is on. |
| ChatGPT | The Codex app server's `account/rateLimits/read` | `planType`: "ChatGPT Pro", "ChatGPT Plus" | Up to two windows, each with the percent used, its length and a reset time. A window of 10,080 minutes is `weekly`, one of 300 minutes is `session`. More limits by id where a model is counted by itself. `credits` when the account has a balance. |
| GitHub Copilot | The Copilot runtime's `account.getQuota`; the plan and the month's reset date from the signed-in account (`account.getCurrentAuth`) | `copilot_plan`: "GitHub Copilot Pro+", "GitHub Copilot Enterprise" | `premium` "Premium requests" with the percent remaining, the used and included counts, and the reset date. `chat` and `completions`, which are `unlimited` on paid plans and counted on the free plan. |
| OpenCode, ACP agents | Nothing | None | None. The entry has `limits: []` and a `note`. |

Notes:

- Claude: Anthropic reports the 5-hour window only at some times. When it is absent there is no `session` limit. An API key, Amazon Bedrock or Google Vertex sign-in gives `account: "api-key"` and no limits. Claude Code is started without a prompt for the read, so nothing is used from the plan, and its scan of local transcripts is skipped.
- ChatGPT: an OpenAI API key gives `account: "api-key"` and no limits.
- GitHub Copilot: a quota's own `resetDate` is the time of the call when GitHub gives no reset for it. The app takes the reset from the account's `quota_reset_date_utc` and uses the quota's own date only when it lies ahead. `unit` is `"credits"` when the account is billed by tokens and `"requests"` otherwise.

## Tests

`test/providerusage.test.mjs` covers each provider's parser, the common shape and the cache, with answers in the real shapes and with missing fields. The adapter tests (`test/providers-claude.test.mjs`, `test/providers-codex.test.mjs`, `test/providers.test.mjs`) cover each `usage()`.
