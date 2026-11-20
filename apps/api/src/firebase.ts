import { readFileSync } from 'node:fs';
import { cert, getApps, initializeApp, applicationDefault, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { Config } from './config.js';

/**
 * Initializes the Firebase Admin SDK on the server only.
 * Credentials come from (in order):
 *   1. FIREBASE_SERVICE_ACCOUNT_BASE64
 *   2. GOOGLE_APPLICATION_CREDENTIALS (path to a mounted secret file)
 *   3. Emulators (FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST) for local dev
 */
export function initFirebase(config: Config) {
  let app: App;
  if (getApps().length) {
    app = getApps()[0];
  } else if (config.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const json = JSON.parse(Buffer.from(config.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
    app = initializeApp({ credential: cert(json), projectId: config.FIREBASE_PROJECT_ID });
  } else if (config.GOOGLE_APPLICATION_CREDENTIALS) {
    const json = JSON.parse(readFileSync(config.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
    app = initializeApp({ credential: cert(json), projectId: config.FIREBASE_PROJECT_ID });
  } else if (process.env.FIRESTORE_EMULATOR_HOST) {
    app = initializeApp({ projectId: config.FIREBASE_PROJECT_ID });
  } else {
    app = initializeApp({ credential: applicationDefault(), projectId: config.FIREBASE_PROJECT_ID });
  }
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true, preferRest: true });
  return { app, db, auth: getAuth(app) };
}
