import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { initFirebase } from './firebase.js';
import { createFirestoreRepositories } from './repositories/firestore.js';
import { createFirebaseVerifier } from './auth/verifier.js';
import { buildContext, startProcessing } from './bootstrap.js';

/**
 * Background worker: runs executions and scheduled triggers from the Redis queue.
 * Run as many copies as you need (docker compose up --scale worker=3).
 * It has no HTTP port; the API only enqueues jobs.
 */
if (existsSync('.env')) process.loadEnvFile('.env');

async function main() {
  const config = loadConfig();
  if (!config.REDIS_URL) throw new Error('The worker needs REDIS_URL. Without Redis, the API runs jobs itself.');
  const { db, auth } = initFirebase(config);
  const repos = createFirestoreRepositories(db, { retentionDays: config.EXECUTION_RETENTION_DAYS });
  const ctx = buildContext(config, repos, createFirebaseVerifier(auth));
  startProcessing(ctx);
  console.log(`[worker] processing executions (concurrency ${config.EXECUTION_CONCURRENCY})`);

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal}: finishing running executions…`);
    await Promise.race([ctx.shutdown(), new Promise((r) => setTimeout(r, 30_000))]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[worker] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
