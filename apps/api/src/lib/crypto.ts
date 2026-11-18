import crypto from 'node:crypto';

/**
 * Secret handling helpers.
 *  - encryptSecret / decryptSecret: AES-256-GCM with a key from ENCRYPTION_KEY.
 *  - hashToken: SHA-256 for values we only need to compare (webhook URL tokens).
 *  - verifyHmac: constant-time check of webhook signatures.
 */

export class SecretBox {
  private key: Buffer;
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('Encryption key must be 32 bytes');
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
  }

  decrypt(payload: string): string {
    const [v, iv, tag, data] = payload.split(':');
    if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported secret format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function hmacSha256Hex(secret: string, body: Buffer | string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function verifyHmac(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const given = header.startsWith('sha256=') ? header.slice(7) : header;
  const expected = hmacSha256Hex(secret, body);
  const a = Buffer.from(given, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
