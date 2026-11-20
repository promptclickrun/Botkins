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
  /** Tests only: replaces both Apple hosts, and adds an `x-botkins-apns-env` header. Unset in wrangler.jsonc. */
  APNS_HOST?: string;
}
