import { loadConfig } from './config.js';
import { initFirebase } from './firebase.js';
import { createFirestoreRepositories } from './repositories/firestore.js';
import { createFirebaseVerifier } from './auth/verifier.js';
import { createFirebaseDirectory } from './auth/user-directory.js';
import { buildContext, startProcessing } from './bootstrap.js';
import { createApp } from './create-app.js';

/**
 * Entry point for Vercel (see vercel.json → services.api).
 *
 * Vercel runs the API as functions: it imports this file and sends requests to the exported
 * Express app. There is no app.listen() and no long-lived process, so compared with main.ts:
 *   - Environment variables come from the Vercel project settings (no .env file).
 *   - Firebase credentials must be in FIREBASE_SERVICE_ACCOUNT_BASE64 (there is no secret file).
 *   - The "interrupted execution" clean-up on startup is skipped: Vercel starts new copies of the
 *     API all the time, and that clean-up would wrongly fail runs that another copy is still running.
 *   - With REDIS_URL set, the API only queues work and a separate worker (worker.ts) runs it.
 *     Without REDIS_URL, runs happen inside the function on a best-effort basis: short runs work,
 *     but schedules and long runs are not reliable, because Vercel pauses idle functions.
 */
const config = loadConfig();
const { db, auth } = initFirebase(config);
const repos = createFirestoreRepositories(db, { retentionDays: config.EXECUTION_RETENTION_DAYS });
const ctx = buildContext(config, repos, createFirebaseVerifier(auth), { directory: createFirebaseDirectory(auth) });

if (!config.REDIS_URL) {
  console.warn('[vercel] No REDIS_URL: workflow runs happen inside the API function (best effort). Schedules will not fire reliably.');
  startProcessing(ctx);
}

const app = createApp(ctx);
export default app;
