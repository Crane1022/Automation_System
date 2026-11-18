import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

/**
 * Firebase web SDK — used ONLY for sign-in. All data goes through our API,
 * which verifies the ID token with the Admin SDK. The web config values are
 * public identifiers, not secrets.
 */
const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseConfigured = Boolean(config.apiKey && config.projectId);

export const firebaseApp = initializeApp(firebaseConfigured ? config : { apiKey: 'missing', projectId: 'missing', appId: 'missing' });
export const auth = getAuth(firebaseApp);
