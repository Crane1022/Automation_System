import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import { isBlockedAddress } from './ip.js';

/**
 * HTTP client used by workflow nodes, with SSRF protection.
 *
 * - Only http/https URLs.
 * - Every DNS answer is checked inside the socket `lookup` hook, so the
 *   address we validate is the address we connect to (no DNS-rebinding gap).
 * - Redirects are followed manually and re-validated.
 * - Response bodies are capped at `maxResponseBytes`.
 */

export interface SafeHttpOptions {
  /** Allow private/loopback addresses (development only). */
  allowPrivateNetworks: boolean;
  /** Hostnames that may resolve to private addresses (e.g. internal PMS API). */
  allowedPrivateHosts: string[];
  maxResponseBytes: number;
  maxRedirects: number;
  defaultTimeoutMs: number;
}

export interface SafeHttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SafeHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface SafeHttpClient {
  request(req: SafeHttpRequest): Promise<SafeHttpResponse>;
}

export function createSafeHttpClient(opts: SafeHttpOptions): SafeHttpClient {
  const allowedHosts = new Set(opts.allowedPrivateHosts.map((h) => h.toLowerCase()));

  function makeLookup(hostname: string): LookupFunction {
    const privateOk = opts.allowPrivateNetworks || allowedHosts.has(hostname.toLowerCase());
    return (host, options, callback) => {
      dns.lookup(host, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, '', 0);
        const list = addresses as dns.LookupAddress[];
        if (!privateOk) {
          const bad = list.find((a) => isBlockedAddress(a.address));
          if (bad) {
            return callback(new SsrfError(`Blocked request to private or reserved address (${host})`), '', 0);
          }
        }
        if ((options as dns.LookupOptions).all) return (callback as any)(null, list);
        const first = list[0];
        callback(null, first.address, first.family);
      });
    };
  }

  function checkUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new SsrfError(`Invalid URL: ${raw}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SsrfError(`Only http and https URLs are allowed (got ${url.protocol})`);
    }
    if (url.username || url.password) {
      throw new SsrfError('Credentials in URLs are not allowed. Use a credential instead.');
    }
    // Literal IPs never go through DNS lookup, so check them here.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const privateOk = opts.allowPrivateNetworks || allowedHosts.has(host.toLowerCase());
    if (!privateOk && /^[\d.]+$|:/.test(host) && isBlockedAddress(host)) {
      throw new SsrfError(`Blocked request to private or reserved address (${host})`);
    }
    return url;
  }

  function once(req: SafeHttpRequest, url: URL): Promise<SafeHttpResponse> {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const timeoutMs = req.timeoutMs ?? opts.defaultTimeoutMs;
      const r = lib.request(
        url,
        {
          method: req.method,
          headers: req.headers,
          lookup: makeLookup(url.hostname),
          timeout: timeoutMs,
          signal: req.signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > opts.maxResponseBytes) {
              res.destroy(new Error(`Response exceeded ${opts.maxResponseBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
            }
            resolve({
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? '',
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
              url: url.toString(),
            });
          });
        },
      );
      r.on('timeout', () => r.destroy(new Error(`Request timed out after ${timeoutMs} ms`)));
      r.on('error', reject);
      if (req.body !== undefined) r.write(req.body);
      r.end();
    });
  }

  return {
    async request(req) {
      let url = checkUrl(req.url);
      let current = req;
      for (let i = 0; i <= opts.maxRedirects; i++) {
        const res = await once(current, url);
        const location = res.headers['location'];
        if (res.status >= 300 && res.status < 400 && location) {
          const next = checkUrl(new URL(location, url).toString());
          // Never forward auth headers to a different host.
          if (next.host !== url.host && current.headers) {
            const headers = Object.fromEntries(
              Object.entries(current.headers).filter(([k]) => !/^(authorization|cookie|proxy-authorization)$/i.test(k)),
            );
            current = { ...current, headers };
          }
          url = next;
          // 303 (and historically 301/302 for POST) switch to GET without a body.
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && current.method !== 'GET')) {
            current = { ...current, method: 'GET', body: undefined };
          }
          continue;
        }
        return res;
      }
      throw new Error(`Too many redirects (max ${opts.maxRedirects})`);
    },
  };
}
