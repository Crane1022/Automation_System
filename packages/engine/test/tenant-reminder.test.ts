import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@widebed/shared';
import { createDefaultRegistry, type NodeServices } from './helpers.js';
import { runWorkflow, validateWorkflow } from '../src/index.js';

/**
 * The "Tenant Reminder (PMS)" workflow file (docs/workflows) end to end, with a fake PMS
 * (Firestore) and a fake Gmail: which emails go out today and what is written back to the PMS.
 */

// Found from the repository root (tests run there)
function findFile(rel: string) {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++, dir = path.dirname(dir)) if (fs.existsSync(path.join(dir, rel))) return path.join(dir, rel);
  throw new Error(`${rel} not found`);
}
const file = JSON.parse(fs.readFileSync(findFile('docs/workflows/Tenant_Reminder_PMS.widebed.json'), 'utf8'));
const def = file.workflow.definition as WorkflowDefinition;
const registry = createDefaultRegistry();

// Days relative to today in Malaysia (the workflow's own clock)
const day = (n: number) => new Date(Date.now() + 8 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);

function pms() {
  const docs: Record<string, Record<string, unknown>> = {
    // B1: arrives tomorrow
    'offlineBookings/offline_A': { status: 'active', bookingNo: 'DM-001', tenantId: 'TEN-0001', propertyId: 'P1', propertyName: 'D Majestic', unitId: 'U1', unitCode: 'A-12-03', arrival: day(1), departure: day(5), moveInStatus: 'Ready_to_Send', moveOutStatus: 'Ready_to_Send', rentalStatus: 'Paid' },
    'offlineBookings/offline_A/private/main': { mainDoorPasscode: '123456', currentExpiryDate: day(5) },
    'tenants/TEN-0001/private/main': { name: 'Tan Wei Ming', email: 'tan@example.com' },
    // B2: arrives today → welcome + owner move-in (owner from the unit)
    'offlineBookings/offline_B': { status: 'active', tenantId: 'TEN-0002', propertyId: 'P1', propertyName: 'D Majestic', unitId: 'U1', unitCode: 'B-07-01', arrival: day(0), departure: day(30), moveInStatus: 'Ready_to_Send', moveOutStatus: 'Ready_to_Send', rentalStatus: 'Paid' },
    'tenants/TEN-0002/private/main': { name: 'Nurul Huda', email: 'nurul@example.com' },
    // B3: long-term, rent unpaid due in 3 days, leaves in 7 days, passcode expires tomorrow (new code ready), utility bill ready
    'offlineBookings/offline_C': { status: 'active', tenantId: 'TEN-0003', propertyId: 'P1', propertyName: 'D Majestic', unitId: 'U2', unitCode: 'C-03-09', arrival: day(-60), departure: day(7), longTerm: true, monthlyRent: 1800, renewalDate: day(3), rentalStatus: 'Unpaid', passwordStatus: 'Ready_to_Send', moveInStatus: 'Sent', moveOutStatus: 'Ready_to_Send' },
    'offlineBookings/offline_C/private/main': { mainDoorPasscode: '111111', currentExpiryDate: day(1), nextDoorPasscode: '222222', nextExpiryDate: day(31) },
    'tenants/TEN-0003/private/main': { name: 'James Lee', email: 'james@example.com' },
    'utilityBills/offline_C': { electricity: 120.5, water: 30, sewerage: 8, total: 158.5, periodFrom: day(-40), periodTo: day(-10), invoiceLink: 'https://drive.example/inv', utilityStatus: 'Ready_to_Send' },
    // B4: leaves today, imported booking with its own Owner Email
    'offlineBookings/offline_DM-014': { status: 'active', source: 'import', tenantId: null, propertyId: 'P1', propertyName: 'D Majestic', unitId: 'U9', unitCode: 'D-01-01', arrival: day(-3), departure: day(0), ownerEmail: 'owner.d@example.com, second@example.com', moveInStatus: 'Sent', moveOutStatus: 'Ready_to_Send' },
    'offlineBookings/offline_DM-014/private/main': { name: 'Siti Aminah', email: 'siti@example.com', mainDoorPasscode: '999999' },
    // B5: left yesterday → thank you
    'offlineBookings/offline_E': { status: 'active', tenantId: 'TEN-0005', propertyId: 'P1', unitId: 'U1', unitCode: 'E-02-02', arrival: day(-10), departure: day(-1), moveInStatus: 'Sent', moveOutStatus: 'Sent' },
    'tenants/TEN-0005/private/main': { name: 'Kumar Raj', email: 'kumar@example.com' },
    // B6: arrives tomorrow but no email → nothing for the guest
    'offlineBookings/offline_F': { status: 'active', tenantId: 'TEN-0006', propertyId: 'P1', unitId: 'U1', unitCode: 'F-01-01', arrival: day(1), departure: day(3) },
    'tenants/TEN-0006/private/main': { name: 'No Email' },
    // Units, property, owners
    'units/U1': { unitCode: 'A-12-03', ownerId: 'OWN-1' },
    'units/U2': { unitCode: 'C-03-09', ownerId: 'OWN-2', info: { wifi: 'TM-123' } },
    'properties/P1': { name: 'D Majestic', info: { address: 'Jalan Pudu' } },
    'owners/OWN-1/private/contact': { fullName: 'Owner One', email: 'owner1@example.com', coOwners: [{ name: 'Co', email: 'co1@example.com' }] },
  };
  const writes: { path: string; data: Record<string, unknown> }[] = [];
  const access = {
    get: async (p: string) => (docs[p] ? { id: p.split('/').pop()!, path: p, data: structuredClone(docs[p]) } : null),
    query: async (col: string, opts: any) =>
      Object.entries(docs)
        .filter(([p, d]) => p.split('/').length === 2 && p.startsWith(col + '/') && opts.where.every((w: any) => d[w.field] === w.value))
        .map(([p, d]) => ({ id: p.split('/')[1]!, path: p, data: structuredClone(d) })),
    update: async (p: string, data: Record<string, unknown>) => {
      writes.push({ path: p, data });
      docs[p] = { ...(docs[p] ?? {}), ...data };
    },
    create: async () => { throw new Error('not used'); },
    delete: async () => { throw new Error('not used'); },
  };
  return { access, writes, docs };
}

describe('Tenant Reminder (PMS) workflow file', () => {
  it('is a valid workflow for this platform', () => {
    expect(file.format).toBe('widebed-automation/workflow');
    expect(validateWorkflow(def, registry)).toEqual([]);
  });

  it('sends exactly the emails due today and marks them in the PMS', async () => {
    const { access, writes } = pms();
    const sent: { to: string; cc: string; subject: string; from: string; body: string }[] = [];
    const http = {
      request: async (req: any) => {
        const raw = Buffer.from(JSON.parse(req.body).raw, 'base64url').toString();
        const header = (n: string) => (raw.match(new RegExp(`^${n}: (.*)$`, 'm')) ?? [])[1] ?? '';
        const subj = header('Subject');
        const enc = subj.match(/^=\?UTF-8\?B\?(.*)\?=$/);
        const body = Buffer.from(raw.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString('utf8');
        sent.push({ to: header('To'), cc: header('Cc'), from: header('From'), subject: enc ? Buffer.from(enc[1]!, 'base64').toString() : subj, body });
        return { status: 200, statusText: 'OK', headers: {}, url: req.url, body: JSON.stringify({ id: `m${sent.length}`, threadId: 't' }) };
      },
    };
    const services = {
      http,
      firestore: async () => access,
      googleToken: async () => ({ accessToken: 'tok', email: 'noreply@widebed.com' }),
      runCode: async (code: string, input: unknown) => new Function('items', `return (async () => {\n${code}\n})()`)(structuredClone(input)),
    } as unknown as NodeServices;
    const r = await runWorkflow({ executionId: 'e', workflowId: 'w', definition: def, registry, services, triggerItems: [{ json: {} }] });
    expect(r.error ?? null).toBe(null);
    expect(r.status).toBe('success');

    const by = (s: string) => sent.filter((m) => m.subject.includes(s)).map((m) => m.to).sort();
    expect(by('starts tomorrow')).toEqual(['tan@example.com']);                         // Rule 1 (no email for F)
    expect(by('Welcome to')).toEqual(['nurul@example.com']);                             // Rule 2
    expect(by('extend your stay')).toEqual(['james@example.com']);                       // Rule 3
    expect(by('Payment Reminder')).toEqual(['james@example.com']);                       // Rule 4
    expect(by('New Door Passcode')).toEqual(['james@example.com']);                      // Rule 5
    expect(by('Checkout Reminder')).toEqual(['siti@example.com']);                       // Rule 6 (guest from the imported booking)
    expect(by('Thank You')).toEqual(['kumar@example.com']);                              // Rule 7
    expect(by('Utility Bills')).toEqual(['james@example.com']);                          // Rule 8
    expect(by('Tenant Moved In')).toEqual(['owner1@example.com, co1@example.com']);       // Rule 9 (owner + co-owner from the unit)
    expect(by('Tenant Moved Out')).toEqual(['owner.d@example.com, second@example.com']); // Rule 10 (the booking's own Owner Email)
    expect(sent).toHaveLength(10);

    const pay = sent.find((m) => m.subject.includes('Payment Reminder'))!;
    expect(pay.body).toContain('RM 1,800.00');
    const code = sent.find((m) => m.subject.includes('New Door Passcode'))!;
    expect(code.body).toContain('222222');
    expect(code.from).toBe('"Widebed" <noreply@widebed.com>');
    expect(sent.find((m) => m.subject.includes('Welcome'))!.cc).toContain('admin@widebed.com');

    expect(writes.map((w) => w.path).sort()).toEqual([
      'offlineBookings/offline_B',              // move-in Sent
      'offlineBookings/offline_C',              // password Active
      'offlineBookings/offline_C/private/main', // new passcode is now the current one
      'offlineBookings/offline_DM-014',         // move-out Sent
      'utilityBills/offline_C',                 // utility Sent
    ]);
    expect(writes.find((w) => w.path === 'offlineBookings/offline_C/private/main')!.data).toEqual({ mainDoorPasscode: '222222', currentExpiryDate: day(31), nextDoorPasscode: '', nextExpiryDate: '' });
  });

  it('sends nothing twice: a second run the same day only repeats the day-based emails, not the "Sent" ones', async () => {
    const { access, writes } = pms();
    const subjects: string[] = [];
    const services = {
      http: { request: async (req: any) => { const raw = Buffer.from(JSON.parse(req.body).raw, 'base64url').toString(); subjects.push((raw.match(/^To: (.*)$/m) ?? [])[1] + ' ' + (raw.match(/^Subject: (.*)$/m) ?? [])[1]); return { status: 200, statusText: 'OK', headers: {}, url: '', body: '{"id":"m","threadId":"t"}' }; } },
      firestore: async () => access,
      googleToken: async () => ({ accessToken: 'tok', email: 'noreply@widebed.com' }),
      runCode: async (code: string, input: unknown) => new Function('items', `return (async () => {\n${code}\n})()`)(structuredClone(input)),
    } as unknown as NodeServices;
    await runWorkflow({ executionId: 'e1', workflowId: 'w', definition: def, registry, services, triggerItems: [{ json: {} }] });
    const first = writes.length;
    subjects.length = 0;
    await runWorkflow({ executionId: 'e2', workflowId: 'w', definition: def, registry, services, triggerItems: [{ json: {} }] });
    expect(writes.length).toBe(first); // nothing new written
    expect(subjects.join('\n')).not.toMatch(/Moved In|Moved Out|Utility Bills|New Door Passcode/);
  });
});
