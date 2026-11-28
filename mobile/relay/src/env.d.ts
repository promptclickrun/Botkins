// Settings the Worker reads that wrangler.jsonc does not declare: the APNs secrets
// (`wrangler secret put`, never in a file) and a test-only host. All are optional: with the first
// key, its id or the team missing, the push route answers 503 push_off.
interface Env {
  /** The APNs auth key: PEM text of the PKCS#8 .p8 file. For production, and for the test service too unless that has its own key below. */
  APNS_KEY_P8?: string;
  /** The key's 10-character id. */
  APNS_KEY_ID?: string;
  /** A second key, for Apple's test service (sandbox) only: PEM text of its .p8 file. */
  APNS_SANDBOX_KEY_P8?: string;
  /** The second key's 10-character id. */
  APNS_SANDBOX_KEY_ID?: string;
  /** The Apple developer team id. */
  APNS_TEAM_ID?: string;
  /** Tests only: how much all copies of shared spaces may take together, in bytes, in place of 1 GiB. Unset in wrangler.jsonc. */
  SPACE_BYTES_MAX?: string;
  /** The "Botkins Intake" GitHub App, installed on FEEDBACK_REPO only with Issues: write. Feedback is off without all three. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  /** PEM text of the app's PKCS#8 private key. */
  GITHUB_APP_KEY?: string;
  /** Webhook secret for the "Botkins Agent" GitHub App (`POST /v1/github/events`). Route answers 503 github_off when unset. */
  GITHUB_WEBHOOK_SECRET?: string;
  /** The website form's Turnstile secret. Website reports are refused without it. */
  TURNSTILE_SECRET?: string;
  /** Tests only: replaces both Apple hosts, and adds an `x-botkins-apns-env` header. Unset in wrangler.jsonc. */
  APNS_HOST?: string;
  /** Tests only: replaces `https://api.github.com` when checking repo read authorization on subscribe. Unset in wrangler.jsonc. */
  GITHUB_API_BASE?: string;
}

// The shared-space page's scripts are plain files, bundled as text (wrangler's own rule for *.txt).
declare module "*.txt" {
  const text: string;
  export default text;
}
