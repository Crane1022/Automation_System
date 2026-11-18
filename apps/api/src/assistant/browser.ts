import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hostAllowed, type AppUser, type Credential } from '@widebed/shared';
import type { AgentTool } from './agent.js';
import type { CredentialService } from '../services/credential-service.js';
import { newId } from '../lib/ids.js';

/**
 * The assistant's web browser (Stage 3).
 *
 * Safety:
 *  - It may only open the websites of saved “Website login” connections (their allowed domains).
 *    Navigating anywhere else is blocked inside the browser itself.
 *  - Passwords go from the encrypted store straight into the page; the AI never sees them.
 *  - Clicking buttons that look like paying, submitting, deleting or changing things needs the person’s approval.
 *  - Page text is handed to the AI as data, never as instructions.
 *
 * The real browser is Playwright + Chromium. It is optional: if it is not installed on the server,
 * the tools say so plainly. Tests use a fake driver.
 */

export interface BrowserLink {
  text: string;
  href: string;
}

export interface BrowserPage {
  goto(url: string): Promise<void>;
  url(): string;
  title(): Promise<string>;
  /** Visible text of the page. */
  text(): Promise<string>;
  links(): Promise<BrowserLink[]>;
  /** Fill a field found by its label / placeholder / name, or by a CSS selector. */
  fill(field: string, value: string, opts?: { selector?: boolean; enter?: boolean }): Promise<void>;
  /** Click a button or link by its visible text, or a CSS selector. */
  click(target: string, opts?: { selector?: boolean }): Promise<void>;
  /** Find the login form and sign in. */
  login(username: string, password: string, selectors?: { username?: string; password?: string; submit?: string }): Promise<void>;
  /** Click something that downloads a file and return the file. */
  download(target: string): Promise<{ name: string; data: Buffer }>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

export interface BrowserLauncher {
  /** A fresh, isolated browser tab that refuses to navigate outside `allowedDomains`. */
  open(allowedDomains: string[]): Promise<BrowserPage>;
}

/* --------------------------------------------------------- Playwright driver */

export class BrowserNotInstalled extends Error {
  constructor() {
    super('The web browser is not installed on this server yet. IT: in the project folder run “npm install playwright -w apps/api” and “npx playwright install chromium” (Docker: see README).');
  }
}

/**
 * Does a saved field setting look like CSS (#email, input[name=user], .login input) rather than
 * words on the page (Email, Username)? Words are matched by label, placeholder, name or id.
 */
export function looksLikeCss(v: string): boolean {
  const t = v.trim();
  return /^[#.[]/.test(t) || /[#[\]>=:]/.test(t) || /^(input|button|a|select|textarea|form)([.#[:\s]|$)/i.test(t);
}

/** Playwright errors carry colour codes and a long call log: keep the first plain sentence. */
export function friendlyBrowserError(err: unknown): Error {
  const raw = String((err as Error)?.message ?? err)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\[\d+m/g, '');
  const first = raw.split(/Call log:|\n/)[0]!.trim();
  if (/Timeout \d+ms exceeded/i.test(first)) return new Error('The page didn’t respond in time (it may be slow, or covered by a pop-up). Read the page and try again.');
  return new Error(first.replace(/^locator\.\w+:\s*/, ''));
}

export function playwrightLauncher(): BrowserLauncher {
  let browserPromise: Promise<any> | null = null;
  const getBrowser = async () => {
    if (!browserPromise) {
      browserPromise = (async () => {
        const name = 'playwright';
        let pw: any;
        try {
          pw = await import(name);
        } catch {
          throw new BrowserNotInstalled();
        }
        try {
          return await pw.chromium.launch({ headless: true });
        } catch (err) {
          throw new Error(`The browser could not start: ${(err as Error).message.split('\n')[0]}. IT: run “npx playwright install --with-deps chromium”.`);
        }
      })().catch((err) => {
        browserPromise = null;
        throw err;
      });
    }
    return browserPromise;
  };

  return {
    async open(allowedDomains) {
      const browser = await getBrowser();
      const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 }, locale: 'en-MY', timezoneId: 'Asia/Kuala_Lumpur' });
      // Block any page navigation to a website that is not allowed (images/scripts from other hosts still load).
      await context.route('**/*', (route: any) => {
        const req = route.request();
        if (req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame()) {
          let host = '';
          try {
            host = new URL(req.url()).hostname;
          } catch {
            /* about:blank etc. */
          }
          if (host && !hostAllowed(host, allowedDomains)) return route.abort('blockedbyclient');
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      const settle = () => page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
      const locate = (target: string, selector?: boolean) => {
        if (selector && looksLikeCss(target)) return page.locator(target);
        const name = new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        return page.getByRole('button', { name }).or(page.getByRole('link', { name })).or(page.getByText(name));
      };
      /** A field by its label, placeholder, name or id — or a CSS selector when it looks like one. */
      const byWords = (w: string) => {
        const safe = w.replace(/["\\]/g, '');
        return page
          .getByLabel(w, { exact: false })
          .or(page.getByPlaceholder(w, { exact: false }))
          .or(page.locator(`input[name*="${safe}" i], input[id*="${safe}" i], input[aria-label*="${safe}" i]`));
      };
      const field = (label: string, selector?: boolean) => (selector && looksLikeCss(label) ? page.locator(label) : byWords(label));

      /** The first matching element that is really visible (pages often hide copies for mobile). */
      const visibleOne = async (loc: any, ms: number): Promise<any | null> => {
        const end = Date.now() + ms;
        do {
          for (const el of (await loc.all().catch(() => [])).slice(0, 12)) if (await el.isVisible().catch(() => false)) return el;
          await page.waitForTimeout(300);
        } while (Date.now() < end);
        return null;
      };

      /** Closes cookie banners and announcement pop-ups that cover the page. */
      const clearPopups = async () => {
        await page.keyboard.press('Escape').catch(() => undefined);
        const name = /^(close|×|✕|x|ok|okay|got it|i understand|understood|accept( all)?|agree|i agree|dismiss|skip|later|no,? thanks|tutup|setuju)$/i;
        const candidates = page.getByRole('button', { name }).or(page.locator('[aria-label*="close" i], .btn-close, .modal .close, button.close'));
        for (let i = 0; i < 3; i++) {
          const el = await visibleOne(candidates, 300);
          if (!el) return;
          await el.click({ timeout: 2_000 }).catch(() => undefined);
          await page.waitForTimeout(400);
        }
      };

      /** Click that survives pop-ups covering the button. */
      const clickSafely = async (loc: any, what: string) => {
        const el = await visibleOne(loc, 15_000);
        if (!el) throw new Error(`Couldn’t find a visible “${what}” on the page. Read the page to see what is there.`);
        await clickElement(el, what);
      };
      const clickElement = async (el: any, what: string) => {
        try {
          await el.click({ timeout: 6_000 });
          return;
        } catch {
          /* probably covered by a pop-up */
        }
        await clearPopups();
        try {
          await el.click({ timeout: 6_000 });
          return;
        } catch {
          /* still covered */
        }
        try {
          // Something keeps covering it: press it directly.
          await el.evaluate((n: any) => n.click());
        } catch {
          throw new Error(`Couldn’t click “${what}”: something on the page covers it.`);
        }
      };

      return {
        async goto(url) {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          await settle();
        },
        url: () => page.url(),
        title: () => page.title(),
        text: async () => (await page.locator('body').innerText().catch(() => '')).replace(/\n{3,}/g, '\n\n').trim(),
        links: () =>
          page.$$eval('a[href]', (as: any[]) =>
            as.map((a) => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80), href: a.href })).filter((l) => l.text && /^https?:/.test(l.href)).slice(0, 80),
          ),
        async fill(target, value, opts) {
          const f = await visibleOne(field(target, opts?.selector), 15_000);
          if (!f) throw new Error(`Couldn’t find a visible field “${target}”. Read the page to see the field names.`);
          await f.fill(value);
          if (opts?.enter) {
            await f.press('Enter');
            await settle();
          }
        },
        async click(target, opts) {
          await clickSafely(locate(target, opts?.selector), target);
          await settle();
        },
        async login(username, password, sel) {
          await clearPopups();
          const saved = (v?: string) => (v?.trim() ? (looksLikeCss(v) ? page.locator(v.trim()) : byWords(v.trim())) : null);
          const USER = 'input[type="email"], input[autocomplete="username"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[id*="email" i], input[name*="login" i], input[type="text"], input[type="tel"], input:not([type])';
          // 1) Password box (if this page has one) → the username box in the same form.
          let pass = await visibleOne(saved(sel?.password) ?? page.locator('input[type="password"]'), 4_000);
          let user = await visibleOne(saved(sel?.username) ?? (pass ? pass.locator('xpath=ancestor::form[1]').locator(USER) : page.locator(USER)), 6_000);
          if (!user && sel?.username) user = await visibleOne(pass ? pass.locator('xpath=ancestor::form[1]').locator(USER) : page.locator(USER), 4_000);
          if (!user && pass) user = await visibleOne(page.locator(USER), 2_000);
          if (!user) {
            throw new Error(
              'Couldn’t find the username / email box on this page. If the form only appears after pressing a button (e.g. “Login”), click it first. Otherwise IT can set the field names in Credentials → Website login → Advanced.',
            );
          }
          await user.fill(username);
          if (!pass) {
            // Two-step logins: username first, then the password page.
            await user.press('Enter');
            await settle();
            pass = await visibleOne(saved(sel?.password) ?? page.locator('input[type="password"]'), 10_000);
          }
          if (!pass) throw new Error('Typed the username, but no password box appeared. Read the page to see what it asks for (maybe a code).');
          await pass.fill(password);
          // The sign-in button: the saved setting is only a hint — if it isn't found, find the form's own button.
          const hint = sel?.submit?.trim();
          let btn = hint ? await visibleOne(looksLikeCss(hint) ? page.locator(hint) : locate(hint), 3_000) : null;
          if (!btn) btn = await visibleOne(pass.locator('xpath=ancestor::form[1]').locator('button[type="submit"], input[type="submit"], button:not([type])'), 1_500);
          if (!btn) btn = await visibleOne(page.getByRole('button', { name: /^\s*(log ?in|sign ?in|log masuk|masuk|submit|continue|next|login now)\s*$/i }), 1_500);
          if (btn) await clickElement(btn, 'Login');
          else await pass.press('Enter');
          await settle();
        },
        async download(target) {
          const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), clickSafely(locate(target), target)]);
          const file = await dl.path();
          return { name: dl.suggestedFilename(), data: await fs.readFile(file) };
        },
        screenshot: () => page.screenshot({ type: 'jpeg', quality: 55 }),
        async close() {
          await context.close().catch(() => undefined);
        },
      };
    },
  };
}

/* ------------------------------------------------------------ sessions + files */

interface Session {
  page: BrowserPage;
  credentialId: string;
  allowedDomains: string[];
  ownerId: string;
  lastUsed: number;
}

export interface SavedFile {
  fileId: string;
  ownerId: string;
  name: string;
  size: number;
  createdAt: string;
}

const IDLE_MS = 10 * 60_000;
const FILE_DAYS = 7;

/** One browser tab per chat, closed after 10 idle minutes; latest screenshot per chat; downloaded files on disk. */
export class BrowserSessions {
  private sessions = new Map<string, Session>();
  private screens = new Map<string, { image: Buffer; at: string; url: string }>();
  readonly filesDir: string;
  private timer: NodeJS.Timeout;

  constructor(
    private launcher: BrowserLauncher,
    filesDir?: string,
    private maxSessions = 3,
  ) {
    this.filesDir = filesDir ?? path.join(os.tmpdir(), 'widebed-assistant-files');
    this.timer = setInterval(() => void this.sweep(), 60_000);
    this.timer.unref?.();
  }

  get(chatId: string) {
    const s = this.sessions.get(chatId);
    if (s) s.lastUsed = Date.now();
    return s;
  }

  async open(chatId: string, ownerId: string, credentialId: string, allowedDomains: string[]) {
    await this.close(chatId);
    if (this.sessions.size >= this.maxSessions) throw new Error('Too many browsers are open right now. Try again in a few minutes.');
    const page = await this.launcher.open(allowedDomains);
    const s = { page, credentialId, allowedDomains, ownerId, lastUsed: Date.now() };
    this.sessions.set(chatId, s);
    return s;
  }

  async close(chatId: string) {
    const s = this.sessions.get(chatId);
    this.sessions.delete(chatId);
    if (s) await s.page.close().catch(() => undefined);
  }

  async snap(chatId: string) {
    const s = this.sessions.get(chatId);
    if (!s) return;
    try {
      this.screens.set(chatId, { image: await s.page.screenshot(), at: new Date().toISOString(), url: s.page.url() });
    } catch {
      /* page may be navigating */
    }
  }

  screen(chatId: string) {
    return this.screens.get(chatId) ?? null;
  }

  async saveFile(ownerId: string, name: string, data: Buffer): Promise<SavedFile> {
    await fs.mkdir(this.filesDir, { recursive: true });
    const meta: SavedFile = { fileId: newId('file'), ownerId, name: name.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'download', size: data.length, createdAt: new Date().toISOString() };
    await fs.writeFile(path.join(this.filesDir, `${meta.fileId}.bin`), data);
    await fs.writeFile(path.join(this.filesDir, `${meta.fileId}.json`), JSON.stringify(meta));
    return meta;
  }

  async readFile(fileId: string): Promise<{ meta: SavedFile; data: Buffer } | null> {
    if (!/^file_[A-Za-z0-9_-]+$/.test(fileId)) return null;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(this.filesDir, `${fileId}.json`), 'utf8')) as SavedFile;
      return { meta, data: await fs.readFile(path.join(this.filesDir, `${fileId}.bin`)) };
    } catch {
      return null;
    }
  }

  private async sweep() {
    for (const [chatId, s] of this.sessions) if (Date.now() - s.lastUsed > IDLE_MS) await this.close(chatId);
    try {
      for (const f of await fs.readdir(this.filesDir)) {
        const p = path.join(this.filesDir, f);
        const st = await fs.stat(p);
        if (Date.now() - st.mtimeMs > FILE_DAYS * 86_400_000) await fs.unlink(p).catch(() => undefined);
      }
    } catch {
      /* folder not made yet */
    }
  }

  async shutdown() {
    clearInterval(this.timer);
    for (const id of [...this.sessions.keys()]) await this.close(id);
  }
}

/* ---------------------------------------------------------------------- tools */

/** Payments, deleting, cancelling: critical (level 4). */
const CRITICAL = /\b(pay|bayar|payment|checkout|purchase|buy|transfer|delete|remove|cancel|unsubscribe|close account|terminate)\b/i;
const RISKY = /\b(pay|bayar|payment|checkout|purchase|buy|transfer|submit|confirm|delete|remove|cancel|update|save|change|edit|apply|sign out|log ?out|unsubscribe|send)\b/i;
const PASSWORDISH = /pass(word)?|kata laluan|pin\b|cvv|card number/i;

export function browserTools(o: {
  sessions: BrowserSessions;
  credentials: CredentialService;
  user: AppUser;
  chatId: string;
  /** Website logins this person may use (already filtered by department). */
  websites: Credential[];
  onFile?: (f: SavedFile) => void | Promise<void>;
}): AgentTool[] {
  const { sessions, user, chatId } = o;
  const byName = (site: string) =>
    o.websites.find((w) => w.credentialId === site) ?? o.websites.find((w) => w.name.toLowerCase() === String(site ?? '').toLowerCase()) ?? (o.websites.length === 1 && !site ? o.websites[0] : undefined);
  const need = () => {
    const s = sessions.get(chatId);
    if (!s) throw new Error('No website is open. Use browser_open first.');
    return s;
  };
  const after = async (s: { page: BrowserPage }) => {
    await sessions.snap(chatId);
    return { url: s.page.url(), title: await s.page.title().catch(() => '') };
  };
  const sites = o.websites.map((w) => `"${w.name}"`).join(', ') || '(none saved)';

  const tools: AgentTool[] = [
    {
      name: 'browser_open',
      description: `Open a saved website in the browser (its login page). Saved websites: ${sites}. Only these websites can be opened.`,
      input: '{ "site": "website name" }',
      label: (i) => `Opening ${i?.site ?? 'website'}`,
      async run(input, ctx) {
        const site = byName(input?.site);
        if (!site) throw new Error(`No saved website called "${input?.site}". Saved websites: ${sites}`);
        ctx.progress('Starting the browser…');
        const s = await sessions.open(chatId, user.uid, site.credentialId, site.details.allowedDomains ?? []);
        await s.page.goto(site.details.loginUrl!);
        return { ...(await after(s)), note: 'Opened. Use browser_login to sign in, or browser_read to see the page.' };
      },
    },
    {
      name: 'browser_login',
      description: 'Sign in on the open website with its saved username and password (you never see them). Pop-ups are closed for you. If the login form only appears after pressing a button (e.g. “Login” on the home page), click that first, then call this. If a code is then sent to the person’s phone or email, ask them for it and type it with browser_type.',
      input: '{}',
      label: () => 'Signing in',
      async run(_input, ctx) {
        let s = o.sessions.get(chatId);
        if (!s) {
          // Not opened yet: open it straight away when there is only one saved website.
          if (o.websites.length !== 1) throw new Error(`No website is open. Use browser_open first with one of: ${sites}.`);
          const site = o.websites[0]!;
          ctx.progress('Opening the website first…');
          s = await o.sessions.open(chatId, user.uid, site.credentialId, site.details.allowedDomains ?? []);
          await s.page.goto(site.details.loginUrl!);
        }
        const { username, password, credential } = await o.credentials.websiteLogin(s.credentialId, user.department);
        ctx.progress(`Signing in as ${credential.details.usernameHint ?? 'the saved user'}…`);
        await s.page.login(username, password, credential.details.selectors);
        const text = (await s.page.text()).slice(0, 1500);
        return { ...(await after(s)), pageStart: text, note: 'Check the page text: if it still shows a login form or an error, the login failed.' };
      },
    },
    {
      name: 'browser_read',
      description: 'Read the open page: its address, title, visible text and links.',
      input: '{}',
      label: () => 'Reading the page',
      async run() {
        const s = need();
        const text = await s.page.text();
        return { ...(await after(s)), text: text.slice(0, 7000), links: (await s.page.links()).slice(0, 60) };
      },
    },
    {
      name: 'browser_goto',
      description: 'Go to another address on the same website (only the saved website’s domains are allowed).',
      input: '{ "url": "https://…" }',
      label: (i) => `Going to ${String(i?.url ?? '').replace(/^https?:\/\//, '').slice(0, 60)}`,
      async run(input) {
        const s = need();
        const url = new URL(String(input?.url ?? ''));
        if (url.protocol !== 'https:' || !hostAllowed(url.hostname, s.allowedDomains)) throw new Error(`Not allowed: the assistant may only open ${s.allowedDomains.join(', ')}`);
        await s.page.goto(url.toString());
        return after(s);
      },
    },
    {
      name: 'browser_click',
      description: 'Click a link, tab or button on the open page by its visible text (e.g. "Bills", "View bill", "Next").',
      input: '{ "text": "visible text of the link or button" }',
      label: (i) => `Clicking “${String(i?.text ?? '').slice(0, 40)}”`,
      approval: (i) => (RISKY.test(String(i?.text ?? '')) ? `Click “${i?.text}” on the website. This might change something on the account.` : null),
      risk: (i) => (CRITICAL.test(String(i?.text ?? '')) ? 4 : RISKY.test(String(i?.text ?? '')) ? 3 : 1),
      target: 'Saved website',
      async run(input) {
        const s = need();
        await s.page.click(String(input?.text ?? ''));
        return after(s);
      },
    },
    {
      name: 'browser_type',
      description: 'Type into a field on the open page, found by its label or placeholder — for codes the person gave you (OTP) or searches. Never for passwords.',
      input: '{ "field": "label of the field, e.g. OTP", "text": "what to type", "pressEnter": true }',
      label: (i) => `Typing into “${String(i?.field ?? '').slice(0, 30)}”`,
      risk: () => 2,
      target: 'Saved website',
      approval: (i) => `Type “${String(i?.text ?? '').slice(0, 80)}” into “${String(i?.field ?? '').slice(0, 40)}” on the website${i?.pressEnter ? ' and press Enter' : ''}.`,
      async run(input) {
        const s = need();
        const fieldName = String(input?.field ?? '');
        if (PASSWORDISH.test(fieldName)) throw new Error('Passwords and card details are never typed by the assistant. Use browser_login.');
        await s.page.fill(fieldName, String(input?.text ?? ''), { enter: !!input?.pressEnter });
        return after(s);
      },
    },
    {
      name: 'browser_download',
      description: 'Download a file (e.g. a bill PDF) by clicking its link or button. The file is given to the person in the chat.',
      input: '{ "text": "visible text of the download link, e.g. Download PDF" }',
      label: (i) => `Downloading “${String(i?.text ?? '').slice(0, 40)}”`,
      async run(input, ctx) {
        const s = need();
        ctx.progress('Waiting for the file…');
        const file = await s.page.download(String(input?.text ?? ''));
        if (file.data.length > 25 * 1024 * 1024) throw new Error('The file is larger than 25 MB');
        const saved = await sessions.saveFile(user.uid, file.name, file.data);
        await o.onFile?.(saved);
        await after(s);
        return { saved: saved.name, size: saved.size, note: 'The file is attached to your reply automatically.' };
      },
    },
    {
      name: 'browser_close',
      description: 'Close the browser when you are finished with the website.',
      input: '{}',
      label: () => 'Closing the browser',
      async run() {
        await sessions.close(chatId);
        return 'Closed.';
      },
    },
  ];
  // Plain-words errors for people and the AI (no colour codes or Playwright call logs).
  return tools.map((t) => ({
    ...t,
    async run(input: any, ctx: any) {
      try {
        return await t.run(input, ctx);
      } catch (err) {
        throw friendlyBrowserError(err);
      }
    },
  }));
}
