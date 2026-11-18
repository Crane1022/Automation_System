import crypto from 'node:crypto';
import type { Auth } from 'firebase-admin/auth';

/**
 * Creates sign-in accounts in Firebase Authentication on behalf of an admin.
 * Used by "Invite user": only administrators can add people — there is no self sign-up.
 */
export interface UserDirectory {
  /** Creates the account (or finds an existing one with this email) and returns its uid. */
  ensureAccount(email: string, displayName: string): Promise<{ uid: string; existed: boolean }>;
  /** Blocks or unblocks sign-in at the Firebase level. */
  setDisabled(uid: string, disabled: boolean): Promise<void>;
}

export function createFirebaseDirectory(auth: Auth): UserDirectory {
  return {
    async ensureAccount(email, displayName) {
      try {
        const existing = await auth.getUserByEmail(email);
        return { uid: existing.uid, existed: true };
      } catch (err: any) {
        if (err?.code !== 'auth/user-not-found') throw err;
      }
      // Random password nobody knows; the person sets their own via the emailed reset link.
      const created = await auth.createUser({
        email,
        displayName,
        password: crypto.randomBytes(24).toString('base64url'),
        emailVerified: false,
      });
      return { uid: created.uid, existed: false };
    },
    async setDisabled(uid, disabled) {
      await auth.updateUser(uid, { disabled });
    },
  };
}
