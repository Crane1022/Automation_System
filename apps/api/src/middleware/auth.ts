import type { NextFunction, Request, Response } from 'express';
import type { AppUser, Permission } from '@widebed/shared';
import { hasPermission } from '@widebed/shared';
import type { TokenVerifier } from '../auth/verifier.js';
import type { UsersRepo } from '../repositories/types.js';
import { forbidden, unauthorized } from '../lib/http-error.js';
import { nowIso } from '../lib/ids.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AppUser;
    }
  }
}

interface AuthDeps {
  verifier: TokenVerifier;
  users: UsersRepo;
  superAdminEmails: string[];
}

/**
 * Verifies the Firebase ID token on every request and loads the user's role
 * from Firestore. The role in Firestore is the only source of truth.
 *
 * First login: a users/{uid} record is created. Emails listed in
 * SUPER_ADMIN_EMAILS become active super admins; everyone else is "pending"
 * until an administrator activates them.
 */
export function createAuth(deps: AuthDeps) {
  const admins = new Set(deps.superAdminEmails.map((e) => e.toLowerCase()));
  // Small cache so each request does not re-read the user doc (role changes apply within 30 s).
  const cache = new Map<string, { user: AppUser; at: number }>();

  const authenticate = async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) throw unauthorized();
      let verified;
      try {
        verified = await deps.verifier.verify(token);
      } catch {
        throw unauthorized('Invalid or expired session. Please sign in again.');
      }

      const cached = cache.get(verified.uid);
      let user = cached && Date.now() - cached.at < 30_000 ? cached.user : await deps.users.get(verified.uid);
      if (!user) {
        // Accounts are created by an admin in the Firebase console (public sign-up should be
        // disabled), and console-created users are not email-verified, so we only match the email.
        const isAdmin = !!verified.email && admins.has(verified.email.toLowerCase());
        const fresh: AppUser = {
          uid: verified.uid,
          name: verified.name ?? verified.email?.split('@')[0] ?? 'User',
          email: verified.email ?? '',
          role: isAdmin ? 'super_admin' : 'employee',
          department: null,
          status: isAdmin ? 'active' : 'pending',
          createdAt: nowIso(),
          lastLoginAt: nowIso(),
        };
        try {
          await deps.users.create(fresh);
          user = fresh;
        } catch (err) {
          // The page sends several requests at once on first sign-in; another request may
          // have created the record a moment ago. Use that one instead of failing.
          user = await deps.users.get(verified.uid);
          if (!user) throw err;
        }
      }
      cache.set(user.uid, { user, at: Date.now() });

      if (user.status !== 'active') {
        throw forbidden(user.status === 'pending' ? 'Your account is waiting for administrator approval.' : 'Your account is disabled.');
      }
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
  const invalidate = (uid: string) => cache.delete(uid);
  return { authenticate, invalidate };
}

export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!hasPermission(req.user, permission)) return next(forbidden());
    next();
  };
}
