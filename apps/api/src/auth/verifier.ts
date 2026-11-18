import type { Auth } from 'firebase-admin/auth';

export interface VerifiedToken {
  uid: string;
  email: string | null;
  name: string | null;
  emailVerified: boolean;
}

/** Verifies a Firebase ID token. Abstracted so tests can use a fake. */
export interface TokenVerifier {
  verify(idToken: string): Promise<VerifiedToken>;
}

export function createFirebaseVerifier(auth: Auth): TokenVerifier {
  return {
    async verify(idToken) {
      // checkRevoked=true: logout / disabled users are rejected immediately.
      const t = await auth.verifyIdToken(idToken, true);
      return { uid: t.uid, email: t.email ?? null, name: (t.name as string | undefined) ?? null, emailVerified: !!t.email_verified };
    },
  };
}
