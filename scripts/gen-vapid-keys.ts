// Generate a VAPID (P-256) keypair for Web Push.
//
//   npx tsx scripts/gen-vapid-keys.ts [subject]
//
// `subject` defaults to mailto:ops@rallypt.app. Store all three values in the
// app's CF_WORKER_SECRETS slice: `VAPID_PRIVATE_KEY` (secret — signs the VAPID
// JWT), `VAPID_SUBJECT`, and `VAPID_PUBLIC_KEY`. The public key is served to
// browsers at runtime via GET /api/v1/push/public-key (it is the
// applicationServerKey — safe to ship to clients; no build-time variable).
import { generateVapidKeys } from '@rallypoint/web-push'

const subject = process.argv[2] ?? 'mailto:ops@rallypt.app'
const keys = await generateVapidKeys(subject)

// console.warn (stderr) — the repo's ESLint config only permits warn/error.
console.warn(JSON.stringify(keys, null, 2))
