import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { initFirebase } from './firebase.js';
import { createFirestoreRepositories } from './repositories/firestore.js';
import { createFirebaseVerifier } from './auth/verifier.js';
import { createFirebaseDirectory } from './auth/user-directory.js';
import { buildContext, resyncSchedules, startProcessing } from './bootstrap.js';
import { createApp } from './app.js';

// Local development: read apps/api/.env automatically (works on Windows, macOS and Linux).
// In Docker the variables come from docker-compose instead, so no file is needed.
if (existsSync('.env')) process.loadEnvFile('.env');

async function main() {
  const config = loadConfig();
  const { db, auth } = initFirebase(config);
  const repos = createFirestoreRepositories(db, { retentionDays: config.EXECUTION_RETENTION_DAYS });
  const ctx = buildContext(config, repos, createFirebaseVerifier(auth), { directory: createFirebaseDirectory(auth) });

  const app = createApp(ctx);
  const server = app.listen(config.PORT, () => {
    const mode = config.REDIS_URL ? 'Redis queue' : 'in-process queue';
    console.log(`[startup] Widebed Automation API listening on :${config.PORT} (${config.NODE_ENV}, ${mode}${config.PROCESS_JOBS || !config.REDIS_URL ? ', runs jobs' : ', queue only'})`);
  });

  // Without Redis nobody else can run jobs, so the API always does it.
  if (!config.PROCESS_JOBS && !config.REDIS_URL) console.warn('[startup] PROCESS_JOBS=false is ignored without REDIS_URL — the API runs jobs itself');
  if (config.PROCESS_JOBS || !config.REDIS_URL) startProcessing(ctx);

  // After listen() so a slow or unavailable Firestore never blocks startup.
  void (async () => {
    try {
      const n = await ctx.executions.recoverInterrupted();
      if (n) console.log(`[startup] marked ${n} interrupted execution(s) as failed`);
      const t = await ctx.agentTasks.recoverInterrupted();
      if (t) console.log(`[startup] marked ${t} interrupted AI task(s) as failed`);
      const s = await resyncSchedules(ctx);
      if (s) console.log(`[startup] schedules checked for ${s} active workflow(s)`);
    } catch (err) {
      console.error('[startup] background checks failed:', (err as Error).message);
    }
  })();

  // Graceful shutdown: stop accepting requests, let running executions finish (max 30 s).
  const shutdown = async (signal: string) => {
    console.log(`[shutdown] ${signal} received`);
    server.close();
    await Promise.race([ctx.shutdown(), new Promise((r) => setTimeout(r, 30_000))]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[startup] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
