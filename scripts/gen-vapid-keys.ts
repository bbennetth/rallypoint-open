// Generate a VAPID (P-256) keypair for Web Push.
//
//   npx tsx scripts/gen-vapid-keys.ts [subject]
//
// `subject` defaults to mailto:ops@rallypt.app. Store the PRIVATE key as the
// planner-api `VAPID_PRIVATE_KEY` secret (CF_WORKER_SECRETS), the subject as
// `VAPID_SUBJECT`, and expose the PUBLIC key to planner-web at build time as
// the `VITE_VAPID_PUBLIC_KEY` repo variable (it is the browser's
// applicationServerKey — safe to ship to clients). The public key must also be
// set as the planner-api `VAPID_PUBLIC_KEY` secret so the JWT `k=` parameter
// matches.
import { generateVapidKeys } from '@rallypoint/web-push'

const subject = process.argv[2] ?? 'mailto:ops@rallypt.app'
const keys = await generateVapidKeys(subject)

// console.warn (stderr) — the repo's ESLint config only permits warn/error.
console.warn(JSON.stringify(keys, null, 2))
