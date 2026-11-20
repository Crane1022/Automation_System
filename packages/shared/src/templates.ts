/**
 * Workflow templates: ready-made workflows people copy and adjust.
 *
 * Built-in templates live here (in code, reviewed like any other change). Teams can also
 * save their own workflows as templates (stored in Firestore `workflowTemplates`).
 * Templates never contain connections or secrets: nodes that need a connection have
 * `credentialId: null`, and the user picks one after creating the workflow.
 */
import type { WorkflowDefinition, WorkflowNode } from './workflow.js';

export const TEMPLATE_CATEGORIES = ['Widebed PMS', 'Guests', 'Bookings', 'Tenants & owners', 'Team', 'Email', 'AI', 'Custom'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export interface WorkflowTemplate {
  templateId: string;
  name: string;
  /** One or two sentences: what it does, in plain words. */
  description: string;
  category: TemplateCategory;
  /** What has to exist before it works, e.g. "A Google Sheet with the columns …". */
  needs: string[];
  /** What to do after creating the workflow. */
  setup: string[];
  definition: WorkflowDefinition;
  builtIn: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

/* ------------------------------------------------------------------ helpers */

let x = 0;
const n = (id: string, type: string, name: string, config: Record<string, unknown>, needsConnection = false): WorkflowNode => {
  const node: WorkflowNode = { id, type, name, position: { x: (x++ % 10) * 320, y: 0 }, config };
  if (needsConnection) node.credentialId = null;
  return node;
};
const chain = (...nodes: WorkflowNode[]): WorkflowDefinition => {
  nodes.forEach((node, i) => (node.position = { x: i * 320, y: 0 }));
  return {
    schemaVersion: 1,
    nodes,
    connections: nodes.slice(1).map((t, i) => ({ id: `c${i + 1}`, source: nodes[i]!.id, sourceHandle: 'main', target: t.id, targetHandle: 'main' })),
    settings: {},
  };
};
const SHEET = { spreadsheet: '', sheet: '', headerRow: 1 };
const GOOGLE = 'Connect a Google account on the Credentials page (it sends the emails and opens the sheet).';
const SHARE = 'Share the Google Sheet with that Google account (Editor if the workflow adds or changes rows).';
const PASTE = 'Paste the link of your Google Sheet into every Google Sheets step.';
const CONNECT = 'Click each step with a warning and choose the Google account under “Credentials”.';
const GO = 'Click “Test run” to try it, then “Publish” and switch it to Active.';
const PMS_NEED = 'A Firebase project connection to Widebed PMS (widebed-pmsdashboard), read-only, allowing the collection used here.';
const PMS_CONNECT = 'Click each step with a warning and choose the PMS connection (Firebase steps) and the Google account (email step).';
const pmsRead = (id: string, name: string, collection: string, where: { field: string; op: string; value: unknown }[], limit = 200) =>
  n(id, 'data.firebaseRead', name, { mode: 'query', collection, where, orderBy: '', direction: 'asc', limit }, true);
const AI_NEED = 'Connect an AI service (OpenAI, Claude or Gemini) on the Credentials page. AI is paid per use.';
const T = '2026-11-14T00:00:00.000Z';
const builtIn = (t: Omit<WorkflowTemplate, 'builtIn' | 'createdBy' | 'createdByName' | 'createdAt'>): WorkflowTemplate => ({ ...t, builtIn: true, createdBy: null, createdByName: 'Widebed', createdAt: T });

/* ---------------------------------------------------------------- templates */

export const BUILT_IN_TEMPLATES: WorkflowTemplate[] = [
  builtIn({
    templateId: 'tpl_rent_reminder',
    name: 'Monthly rent reminder',
    description: 'On the 25th of every month, emails every tenant whose rent is still unpaid.',
    category: 'Tenants & owners',
    needs: [GOOGLE, 'A Google Sheet with the columns: Name, Email, Unit, Amount, Status (write “Unpaid” or “Paid”).'],
    setup: [PASTE, CONNECT, 'Change the day and time in “Every 25th” if you like.', GO],
    definition: chain(
      n('s1', 'trigger.schedule', 'Every 25th, 10:00 AM', { mode: 'monthly', dayOfMonth: '25', time: '10:00', timezone: 'Asia/Kuala_Lumpur' }),
      n('s2', 'comm.sheetsRead', 'Unpaid tenants', { ...SHEET, filters: [{ key: 'Status', value: 'Unpaid' }], returnMode: 'all', valueMode: 'formatted' }, true),
      n('s3', 'comm.gmailSend', 'Email the tenant', {
        to: '{{ $json.Email }}',
        subject: 'Rent reminder – {{ $json.Unit }}',
        format: 'text',
        body: 'Hi {{ $json.Name }},\n\nThis is a friendly reminder that the rent of {{ $json.Amount }} for {{ $json.Unit }} is due.\nIf you have already paid, please ignore this email.\n\nThank you,\nWidebed',
      }, true),
    ),
  }),
  builtIn({
    templateId: 'tpl_checkin_reminder',
    name: 'Check-in reminder to guests',
    description: 'Every morning, emails the guests who check in tomorrow with their check-in details.',
    category: 'Guests',
    needs: [
      GOOGLE,
      'A Google Sheet with the columns: Guest, Email, Property, Check-in, Days to check-in.',
      'In “Days to check-in” put a formula that counts the days, e.g. =D2-TODAY() (D = the Check-in column), and copy it down.',
    ],
    setup: [PASTE, CONNECT, 'Edit the email text: add your check-in instructions, Wi-Fi, parking…', GO],
    definition: chain(
      n('s1', 'trigger.schedule', 'Every day, 10:00 AM', { mode: 'daily', time: '10:00', timezone: 'Asia/Kuala_Lumpur' }),
      n('s2', 'comm.sheetsRead', 'Guests arriving tomorrow', { ...SHEET, filters: [{ key: 'Days to check-in', value: '1' }], returnMode: 'all', valueMode: 'formatted' }, true),
      n('s3', 'comm.gmailSend', 'Email the guest', {
        to: '{{ $json.Email }}',
        subject: 'See you tomorrow at {{ $json.Property }}!',
        format: 'text',
        body: 'Hi {{ $json.Guest }},\n\nWe look forward to welcoming you tomorrow ({{ $json["Check-in"] }}) at {{ $json.Property }}.\n\nCheck-in is from 3:00 PM. Reply to this email if you need anything.\n\nSee you soon,\nWidebed',
      }, true),
    ),
  }),
  builtIn({
    templateId: 'tpl_booking_to_sheet',
    name: 'Log new bookings in a sheet',
    description: 'When Widebed PMS reports a new booking, adds it as a row in a Google Sheet.',
    category: 'Bookings',
    needs: [
      GOOGLE,
      'A Google Sheet with the columns: Booking ID, Guest, Property, Check-in, Check-out, Nights.',
      'An Event source on the Credentials page, and the PMS sending the “booking.created” event.',
    ],
    setup: [PASTE, CONNECT, SHARE, 'Check the field names in “Add the booking” match what the PMS sends (open the trigger → Test data).', GO],
    definition: chain(
      n('s1', 'trigger.event', 'New booking (from PMS)', {
        eventName: 'booking.created',
        testData: '{ "bookingId": "B-102", "guestName": "Ana Lee", "propertyName": "Sunrise Suite A-12", "checkIn": "2026-12-01", "checkOut": "2026-12-04", "nights": 3 }',
      }),
      n('s2', 'comm.sheetsCreateRow', 'Add the booking', {
        ...SHEET,
        mode: 'fields',
        allowFormulas: false,
        columns: [
          { key: 'Booking ID', value: '{{ $json.data.bookingId }}' },
          { key: 'Guest', value: '{{ $json.data.guestName }}' },
          { key: 'Property', value: '{{ $json.data.propertyName }}' },
          { key: 'Check-in', value: '{{ $json.data.checkIn }}' },
          { key: 'Check-out', value: '{{ $json.data.checkOut }}' },
          { key: 'Nights', value: '{{ $json.data.nights }}' },
        ],
      }, true),
    ),
  }),
  builtIn({
    templateId: 'tpl_booking_housekeeping',
    name: 'Tell housekeeping about a new booking',
    description: 'When Widebed PMS reports a new booking, emails the housekeeping team the dates and property.',
    category: 'Team',
    needs: [GOOGLE, 'An Event source on the Credentials page, and the PMS sending the “booking.created” event.'],
    setup: ['Change the “To” address in “Email housekeeping” to your team’s email.', CONNECT, GO],
    definition: chain(
      n('s1', 'trigger.event', 'New booking (from PMS)', {
        eventName: 'booking.created',
        testData: '{ "bookingId": "B-102", "guestName": "Ana Lee", "propertyName": "Sunrise Suite A-12", "checkIn": "2026-12-01", "checkOut": "2026-12-04", "nights": 3 }',
      }),
      n('s2', 'comm.gmailSend', 'Email housekeeping', {
        to: 'housekeeping@widebed.com',
        subject: 'New booking: {{ $json.data.propertyName }} ({{ $json.data.checkIn }})',
        format: 'text',
        body: 'New booking {{ $json.data.bookingId }}\n\nProperty: {{ $json.data.propertyName }}\nGuest: {{ $json.data.guestName }}\nCheck-in: {{ $json.data.checkIn }}\nCheck-out: {{ $json.data.checkOut }}\nNights: {{ $json.data.nights }}\n\nPlease plan the cleaning before check-in.',
      }, true),
    ),
  }),
  builtIn({
    templateId: 'tpl_payment_received',
    name: 'Mark a booking as paid',
    description: 'When a payment system calls this workflow’s web address, finds the booking in a sheet and sets it to “Paid”.',
    category: 'Bookings',
    needs: [GOOGLE, 'A Google Sheet with the columns: Booking ID, Status, Paid on.', 'A system that can call a web address (webhook) with { "bookingId": "…", "paidAt": "…" }.'],
    setup: [PASTE, CONNECT, SHARE, 'Publish, then copy the web address from the Webhook step and give it to the payment system.', GO],
    definition: chain(
      n('s1', 'trigger.webhook', 'Payment received', { method: 'POST', requireSignature: false, responseMode: 'accepted' }),
      n('s2', 'comm.sheetsUpdateRow', 'Set booking to Paid', {
        ...SHEET,
        matchColumn: 'Booking ID',
        matchValue: '{{ $json.body.bookingId }}',
        mode: 'fields',
        columns: [
          { key: 'Status', value: 'Paid' },
          { key: 'Paid on', value: '{{ $json.body.paidAt }}' },
        ],
        ifNotFound: 'error',
        multiple: 'first',
        allowFormulas: false,
      }, true),
    ),
  }),
  builtIn({
    templateId: 'tpl_website_enquiry',
    name: 'Website enquiry → sheet + email',
    description: 'When your website form sends an enquiry, saves it in a Google Sheet and emails the sales team.',
    category: 'Email',
    needs: [GOOGLE, 'A Google Sheet with the columns: Name, Email, Phone, Message.', 'A website form that can send to a web address (webhook).'],
    setup: [PASTE, CONNECT, SHARE, 'Change the “To” address in “Email sales”.', 'Publish, then copy the web address from the Webhook step into your website form.', GO],
    definition: chain(
      n('s1', 'trigger.webhook', 'Website form', { method: 'POST', requireSignature: false, responseMode: 'accepted' }),
      n('s2', 'comm.sheetsCreateRow', 'Save the enquiry', {
        ...SHEET,
        mode: 'fields',
        allowFormulas: false,
        columns: [
          { key: 'Name', value: '{{ $json.body.name }}' },
          { key: 'Email', value: '{{ $json.body.email }}' },
          { key: 'Phone', value: '{{ $json.body.phone }}' },
          { key: 'Message', value: '{{ $json.body.message }}' },
        ],
      }, true),
      n('s3', 'comm.gmailSend', 'Email sales', {
        to: 'sales@widebed.com',
        subject: 'New enquiry from {{ $json.Name }}',
        format: 'text',
        replyTo: '{{ $json.Email }}',
        body: 'Name: {{ $json.Name }}\nEmail: {{ $json.Email }}\nPhone: {{ $json.Phone }}\n\n{{ $json.Message }}\n\n(Saved in row {{ $json.row_number }} of the enquiries sheet.)',
      }, true),
    ),
  }),
  builtIn({
    templateId: 'tpl_inbox_to_sheet',
    name: 'Save OTA booking emails to a sheet',
    description: 'Every 15 minutes, finds new booking emails (e.g. from Agoda) and saves the sender, subject and date in a Google Sheet.',
    category: 'Email',
    needs: [GOOGLE, 'A Google Sheet with the columns: Received, From, Subject, Preview.'],
    setup: ['Change the search in “New booking emails” (e.g. from:booking.com) — same as the Gmail search box.', PASTE, CONNECT, GO],
    definition: chain(
      n('s1', 'trigger.schedule', 'Every 15 minutes', { mode: 'interval', every: 15, unit: 'minutes', timezone: 'Asia/Kuala_Lumpur' }),
      n('s2', 'comm.gmailRead', 'New booking emails', { query: 'is:unread from:agoda.com subject:booking', maxResults: 20, includeBody: false, markAsRead: true }, true),
      n('s3', 'comm.sheetsCreateRow', 'Save to sheet', {
        ...SHEET,
        mode: 'fields',
        allowFormulas: false,
        columns: [
          { key: 'Received', value: '{{ $json.date }}' },
          { key: 'From', value: '{{ $json.from }}' },
          { key: 'Subject', value: '{{ $json.subject }}' },
          { key: 'Preview', value: '{{ $json.snippet }}' },
        ],
      }, true),
    ),
  }),
  builtIn({
    templateId: 'tpl_cleaning_check',
    name: 'Weekly cleaning check reminder',
    description: 'Every Monday and Thursday at 2 PM, reminds the housekeeping team to do the property checks.',
    category: 'Team',
    needs: [GOOGLE],
    setup: ['Change the “To” address and the checklist in the email.', 'Change the days or time in the first step if you like.', CONNECT, GO],
    definition: chain(
      n('s1', 'trigger.schedule', 'Mon & Thu, 2:00 PM', { mode: 'weekly', weekdays: ['1', '4'], time: '14:00', timezone: 'Asia/Kuala_Lumpur' }),
      n('s2', 'comm.gmailSend', 'Remind housekeeping', {
        to: 'housekeeping@widebed.com',
        subject: 'Reminder: property checks today',
        format: 'text',
        body: 'Hi team,\n\nPlease complete today’s property checks:\n- Linen and towels stocked\n- Toiletries refilled\n- Air-con and lights working\n- Photos of any damage sent to the ops chat\n\nThank you!',
      }, true),
    ),
  }),
  builtIn({
    templateId: 'tpl_owner_statement',
    name: 'Monthly note to property owners',
    description: 'On the last day of every month, emails each owner that their monthly statement is on the way.',
    category: 'Tenants & owners',
    needs: [GOOGLE, 'A Google Sheet with the columns: Owner, Email, Property.'],
    setup: [PASTE, CONNECT, 'Edit the email text to match how you send statements.', GO],
    definition: chain(
      n('s1', 'trigger.schedule', 'Last day of the month, 6 PM', { mode: 'monthly', dayOfMonth: 'L', time: '18:00', timezone: 'Asia/Kuala_Lumpur' }),
      n('s2', 'comm.sheetsRead', 'All owners', { ...SHEET, filters: [], returnMode: 'all', valueMode: 'formatted' }, true),
      n('s3', 'comm.gmailSend', 'Email the owner', {
        to: '{{ $json.Email }}',
        subject: 'Your monthly statement for {{ $json.Property }}',
        format: 'text',
        body: 'Dear {{ $json.Owner }},\n\nThe month has closed for {{ $json.Property }}. Your statement will be sent within 5 working days.\n\nBest regards,\nWidebed',
      }, true),
    ),
  }),
  builtIn({
    templateId: 'tpl_ai_website_chat',
    name: 'AI: chat box on your website',
    description: 'A chat bubble on your website. Visitors type a question, the AI answers right away in the chat box, remembers the conversation and can look things up in your Google Sheets.',
    category: 'AI',
    needs: [
      AI_NEED,
      'Optional: a Google account and Google Sheets with your FAQ or unit details, if the bot should look things up.',
      'Access to your website’s HTML (or a “custom code” box in your website builder).',
    ],
    setup: [
      'On “Website visitor message”, list your website address under “Websites that may call it” (e.g. https://www.widebed.com).',
      'On “AI Chatbot”, choose the AI connection and write the instructions. To let it search sheets, choose the Google account and add the sheet links (or delete the example list).',
      'Publish and switch to Active, and copy the webhook URL shown once.',
      'Click the “Website visitor message” step, copy the chat box code, paste your webhook URL into it, and put it on your website before </body>.',
      'Open your website and send a test message. Each message appears under Executions.',
    ],
    definition: chain(
      n('s1', 'trigger.webhook', 'Website visitor message', { method: 'POST', requireSignature: false, responseMode: 'reply', allowedOrigins: '', testData: JSON.stringify({ message: 'Hi, is parking free?', sessionId: 'test-visitor-1', page: 'https://www.widebed.com/' }, null, 2) }),
      n('s2', 'ai.chatbot', 'AI Chatbot', {
        message: '{{ $json.body.message }}',
        instructions: 'You are the friendly website assistant of Widebed, a short-term rental company in Malaysia. Answer in the visitor’s language, in 1–3 short sentences. Help with questions about our properties, booking and check-in. Never invent prices or availability: if you do not know, ask for their email or phone number so the team can reply.\n\nToday: {{ $today }}\nPage the visitor is on: {{ $json.body.page }}',
        conversationId: '{{ $json.body.sessionId }}',
        memoryMessages: 20,
        googleConnection: '',
        lookups: [{ name: 'FAQ', spreadsheet: '', sheet: 'FAQ', description: 'Common questions and answers: check-in time, parking, Wi-Fi, house rules, cancellations.' }],
        maxLookups: 3,
        saveAs: 'output',
      }, true),
      n('s3', 'comm.respondWebhook', 'Send the reply to the chat box', { bodyType: 'fields', bodyFields: [{ key: 'reply', value: '{{ $json.output }}' }], text: '', statusCode: 200 }),
    ),
  }),
  builtIn({
    templateId: 'tpl_ai_live_chat',
    name: 'AI: live chat guest assistant (GoHighLevel)',
    description: 'Answers every new GoHighLevel live-chat or WhatsApp message with AI, remembers each guest’s conversation and looks up bookings and units in Google Sheets — like the “Willow” n8n bot.',
    category: 'AI',
    needs: [
      AI_NEED,
      GOOGLE,
      'A GoHighLevel private integration token, saved on the Credentials page as an “API key / token” for services.leadconnectorhq.com.',
      'Google Sheets with your bookings and unit details (row 1 = column names).',
    ],
    setup: [
      'On “AI Chatbot”: choose the AI connection and the Google account, write the bot’s instructions, and paste the sheet links under “Lists the bot may search”.',
      'On “Reply in GoHighLevel”: choose your GoHighLevel key in “Sign in with”.',
      'Publish the workflow, copy the webhook address, and in GoHighLevel add a workflow “Customer replied → Webhook (POST)” to that address.',
      'Send a test message from GoHighLevel and open Executions to see each step.',
    ],
    definition: chain(
      n('s1', 'trigger.webhook', 'New chat message', { method: 'POST', requireSignature: false, testData: JSON.stringify({ contact_id: 'test-contact-1', full_name: 'Test Guest', phone: '+60123456789', message: { body: 'Hi, my booking number is WB-1029. What time is check-in?' } }, null, 2) }),
      n('s2', 'ai.chatbot', 'AI Chatbot', {
        message: '{{ $json.body.message.body }}',
        instructions: 'You are Willow, the friendly guest assistant of Widebed, a short-term rental company in Malaysia. Answer in the guest’s language, briefly and politely. Before sharing any booking or unit details, check the guest in “Booking Details” using their phone number or booking number. Never share door codes or Wi-Fi passwords unless the booking is confirmed and check-in is today. If you cannot help, say a team member will reply soon.\n\nGuest name: {{ $json.body.full_name }}\nGuest phone: {{ $json.body.phone }}\nToday: {{ $today }}',
        conversationId: '{{ $json.body.contact_id }}',
        memoryMessages: 20,
        googleConnection: '',
        lookups: [
          { name: 'Booking Details', spreadsheet: '', sheet: 'Booking Details', description: 'Bookings: guest name, phone, booking number, unit number, check-in and check-out dates. Use it first to check who the guest is.' },
          { name: 'Property Units', spreadsheet: '', sheet: 'Property Units', description: 'Unit details: address, parking, Wi-Fi, check-in steps. Only after the guest is verified in Booking Details, and search by their unit number.' },
        ],
        maxLookups: 4,
        saveAs: 'output',
      }, true),
      n('s3', 'data.httpRequest', 'Reply in GoHighLevel', {
        method: 'POST',
        url: 'https://services.leadconnectorhq.com/conversations/messages',
        auth: '',
        query: [],
        headers: [{ key: 'Version', value: '2021-07-28' }, { key: 'Accept', value: 'application/json' }],
        bodyType: 'fields',
        bodyFields: [
          { key: 'type', value: 'Live_Chat' },
          { key: 'contactId', value: '{{ $node["New chat message"].json.body.contact_id }}' },
          { key: 'message', value: '{{ $json.output }}' },
        ],
        body: '',
        timeoutMs: 15000,
        failOnHttpError: true,
      }),
    ),
  }),
  builtIn({
    templateId: 'tpl_ai_booking_emails',
    name: 'AI: booking emails → sheet',
    description: 'Every 15 minutes, AI reads new booking emails (e.g. from Agoda) and saves the guest, dates and property as a row in a Google Sheet.',
    category: 'AI',
    needs: [
      GOOGLE,
      AI_NEED,
      'A Google Sheet with the columns: Booking ID, Guest, Check-in, Check-out, Property, Amount.',
    ],
    setup: ['Change the search in “New booking emails” to match your booking emails.', PASTE, 'Choose the Google account and the AI connection on the steps with a warning.', 'Click “Test run” and check the new row is right before publishing.', GO],
    definition: chain(
      n('s1', 'trigger.schedule', 'Every 15 minutes', { mode: 'interval', every: 15, unit: 'minutes', timezone: 'Asia/Kuala_Lumpur' }),
      n('s2', 'comm.gmailRead', 'New booking emails', { query: 'is:unread from:agoda.com subject:booking', maxResults: 20, includeBody: true, markAsRead: true }, true),
      n('s3', 'ai.extract', 'AI reads the booking', {
        text: 'Subject: {{ $json.subject }}\n\n{{ $json.body }}',
        fields: [
          { key: 'bookingId', value: 'Booking or reservation number' },
          { key: 'guestName', value: 'Full name of the guest' },
          { key: 'checkIn', value: 'Check-in date as YYYY-MM-DD' },
          { key: 'checkOut', value: 'Check-out date as YYYY-MM-DD' },
          { key: 'property', value: 'Name of the property, hotel or room' },
          { key: 'amount', value: 'Total price with currency, e.g. MYR 450.00' },
        ],
      }, true),
      n('s4', 'comm.sheetsCreateRow', 'Save to sheet', {
        ...SHEET,
        mode: 'fields',
        allowFormulas: false,
        columns: [
          { key: 'Booking ID', value: '{{ $json.bookingId }}' },
          { key: 'Guest', value: '{{ $json.guestName }}' },
          { key: 'Check-in', value: '{{ $json.checkIn }}' },
          { key: 'Check-out', value: '{{ $json.checkOut }}' },
          { key: 'Property', value: '{{ $json.property }}' },
          { key: 'Amount', value: '{{ $json.amount }}' },
        ],
      }, true),
    ),
  }),
  builtIn({
    templateId: 'tpl_ai_sort_guest_emails',
    name: 'AI: sort guest emails and draft replies',
    description: 'Every 15 minutes, AI sorts new guest emails. Complaints go to operations, cancellations to reservations, and for questions AI drafts a reply for your team to check.',
    category: 'AI',
    needs: [GOOGLE, AI_NEED],
    setup: [
      'Change the search in “New guest emails” (e.g. to:support@widebed.com).',
      'Change the “To” addresses of the three email steps to your teams.',
      'Choose the Google account and the AI connection on the steps with a warning.',
      'Edit the categories in “AI sorts the email” if you like — each one gets its own output.',
      GO,
    ],
    definition: {
      schemaVersion: 1,
      nodes: [
        { ...n('s1', 'trigger.schedule', 'Every 15 minutes', { mode: 'interval', every: 15, unit: 'minutes', timezone: 'Asia/Kuala_Lumpur' }), position: { x: 0, y: 160 } },
        { ...n('s2', 'comm.gmailRead', 'New guest emails', { query: 'is:unread to:support@widebed.com', maxResults: 20, includeBody: true, markAsRead: true }, true), position: { x: 320, y: 160 } },
        {
          ...n('s3', 'ai.classify', 'AI sorts the email', {
            text: 'Subject: {{ $json.subject }}\n\n{{ $json.body }}',
            categories: [
              { id: 'c_question', label: 'Question', value: 'Questions about the stay: availability, prices, check-in, parking, Wi-Fi' },
              { id: 'c_complaint', label: 'Complaint', value: 'Something is broken or dirty, noise, or the guest is unhappy' },
              { id: 'c_cancel', label: 'Cancellation', value: 'The guest wants to cancel, change dates or asks for a refund' },
            ],
            instructions: '',
          }, true),
          position: { x: 640, y: 160 },
        },
        {
          ...n('s4', 'ai.chat', 'AI drafts a reply', {
            prompt: 'Write a short, friendly reply to this guest email. Use the same language as the guest. If you are not sure about a fact, say a team member will confirm.\n\nFrom: {{ $json.from }}\nSubject: {{ $json.subject }}\n\n{{ $json.body }}',
            rules: 'You write for Widebed, a short-term rental company in Malaysia. Be warm and brief. Never promise refunds or discounts.',
            length: 'short',
            saveAs: 'draft',
          }, true),
          position: { x: 960, y: 0 },
        },
        {
          ...n('s5', 'comm.gmailSend', 'Send draft to the team', {
            to: 'support@widebed.com',
            subject: 'Suggested reply: {{ $json.subject }}',
            format: 'text',
            body: 'Guest: {{ $json.from }}\n\n--- Suggested reply (check before sending) ---\n{{ $json.draft }}\n\n--- Original email ---\n{{ $json.body }}',
          }, true),
          position: { x: 1280, y: 0 },
        },
        {
          ...n('s6', 'comm.gmailSend', 'Alert operations', {
            to: 'operations@widebed.com',
            subject: 'Guest complaint: {{ $json.subject }}',
            format: 'text',
            body: 'From: {{ $json.from }}\nWhy AI flagged it: {{ $json.reason }}\n\n{{ $json.body }}',
          }, true),
          position: { x: 960, y: 160 },
        },
        {
          ...n('s7', 'comm.gmailSend', 'Tell reservations', {
            to: 'reservations@widebed.com',
            subject: 'Cancellation / change request: {{ $json.subject }}',
            format: 'text',
            body: 'From: {{ $json.from }}\nWhy AI flagged it: {{ $json.reason }}\n\n{{ $json.body }}',
          }, true),
          position: { x: 960, y: 320 },
        },
      ],
      connections: [
        { id: 'c1', source: 's1', sourceHandle: 'main', target: 's2', targetHandle: 'main' },
        { id: 'c2', source: 's2', sourceHandle: 'main', target: 's3', targetHandle: 'main' },
        { id: 'c3', source: 's3', sourceHandle: 'c_question', target: 's4', targetHandle: 'main' },
        { id: 'c4', source: 's4', sourceHandle: 'main', target: 's5', targetHandle: 'main' },
        { id: 'c5', source: 's3', sourceHandle: 'c_complaint', target: 's6', targetHandle: 'main' },
        { id: 'c6', source: 's3', sourceHandle: 'c_cancel', target: 's7', targetHandle: 'main' },
      ],
      settings: {},
    },
  }),
  builtIn({
    templateId: 'tpl_pms_arrivals_tomorrow',
    name: 'PMS: tomorrow’s arrivals to housekeeping',
    description: 'Every evening at 6 PM, lists the offline bookings arriving tomorrow and emails the list to housekeeping in one email.',
    category: 'Widebed PMS',
    needs: [PMS_NEED.replace('the collection used here', 'offlineBookings'), GOOGLE],
    setup: [PMS_CONNECT, 'Change the “To” address in “Email housekeeping”.', GO],
    definition: chain(
      n('s1', 'trigger.schedule', 'Every day, 6:00 PM', { mode: 'daily', time: '18:00', timezone: 'Asia/Kuala_Lumpur' }),
      pmsRead('s2', 'Bookings arriving tomorrow', 'offlineBookings', [{ field: 'arrival', op: '==', value: '{{ $today.tomorrow }}' }]),
      n('s3', 'logic.filter', 'Not cancelled', { conditions: [{ left: '{{ $json.status }}', operator: 'notEquals', right: 'cancelled' }], combine: 'and' }),
      n('s4', 'logic.combine', 'One list', { line: '• {{ $json.unitCode }} · {{ $json.propertyName }} · {{ $json.nights }} nights (until {{ $json.departure }})', saveAs: 'list', sortBy: 'propertyName' }),
      n('s5', 'comm.gmailSend', 'Email housekeeping', {
        to: 'housekeeping@widebed.com',
        subject: '{{ $json.count }} arrival(s) tomorrow, {{ $today.tomorrow }}',
        format: 'text',
        body: 'Hi team,\n\nThese units have guests arriving tomorrow ({{ $today.tomorrow }}). Please make sure they are cleaned and ready:\n\n{{ $json.list }}\n\nSent automatically from Widebed PMS data.',
      }, true),
    ),
  }),
  builtIn({
    templateId: 'tpl_pms_not_in_ezee',
    name: 'PMS: bookings not entered in eZee',
    description: 'Every morning, finds offline bookings that still have no eZee reservation number and reminds Operations.',
    category: 'Widebed PMS',
    needs: [PMS_NEED.replace('the collection used here', 'offlineBookings'), GOOGLE],
    setup: [PMS_CONNECT, 'Change the “To” address.', GO],
    definition: chain(
      n('s1', 'trigger.schedule', 'Every day, 10:00 AM', { mode: 'daily', time: '10:00', timezone: 'Asia/Kuala_Lumpur' }),
      pmsRead('s2', 'Bookings without eZee no.', 'offlineBookings', [{ field: 'ezeeReservationNo', op: '==', value: '' }]),
      n('s3', 'logic.filter', 'Not cancelled', { conditions: [{ left: '{{ $json.status }}', operator: 'notEquals', right: 'cancelled' }], combine: 'and' }),
      n('s4', 'logic.combine', 'One list', { line: '• {{ $json.id }} · {{ $json.unitCode }} · {{ $json.propertyName }} · arrives {{ $json.arrival }}', saveAs: 'list', sortBy: 'arrival' }),
      n('s5', 'comm.gmailSend', 'Remind Operations', {
        to: 'operations@widebed.com',
        subject: '{{ $json.count }} booking(s) still missing an eZee reservation number',
        format: 'text',
        body: 'Hi Operations,\n\nPlease enter these bookings in eZee and add the reservation number in the PMS (Tenant Leads → booking):\n\n{{ $json.list }}\n\nThank you!',
      }, true),
    ),
  }),
  builtIn({
    templateId: 'tpl_pms_stale_issues',
    name: 'PMS: issues with no update for 3 days',
    description: 'Every morning, finds open issues nobody has updated for more than 3 days and sends one reminder list.',
    category: 'Widebed PMS',
    needs: [PMS_NEED.replace('the collection used here', 'issues'), GOOGLE],
    setup: [PMS_CONNECT, 'Change the number of days in “Not updated for 3+ days” if you like.', 'Change the “To” address.', GO],
    definition: chain(
      n('s1', 'trigger.schedule', 'Every day, 9:00 AM', { mode: 'daily', time: '09:00', timezone: 'Asia/Kuala_Lumpur' }),
      pmsRead('s2', 'Open issues', 'issues', [{ field: 'status', op: '==', value: 'open' }], 300),
      n('s3', 'logic.filter', 'Not updated for 3+ days', { conditions: [{ left: '{{ $json.updatedAt }}', operator: 'moreThanDaysAgo', right: 3 }], combine: 'and' }),
      n('s4', 'logic.combine', 'One list', { line: '• {{ $json.id }} · {{ $json.unit }} ({{ $json.property }}) · {{ $json.title }} — last by {{ $json.lastBy }}', saveAs: 'list', sortBy: 'updatedAt' }),
      n('s5', 'comm.gmailSend', 'Remind the team', {
        to: 'operations@widebed.com',
        subject: '{{ $json.count }} open issue(s) with no update for 3+ days',
        format: 'text',
        body: 'Good morning,\n\nThese issues have had no update for more than 3 days (oldest first). Please update or close them in the PMS (Issues):\n\n{{ $json.list }}',
      }, true),
    ),
  }),
  builtIn({
    templateId: 'tpl_pms_lead_followup',
    name: 'PMS: tenant leads waiting for follow-up',
    description: 'Every morning, lists tenant leads still “New” after 2 days so someone calls them back.',
    category: 'Widebed PMS',
    needs: [PMS_NEED.replace('the collection used here', 'offlineInquiries'), GOOGLE],
    setup: [PMS_CONNECT, 'Change the “To” address (e.g. the sales team).', GO],
    definition: chain(
      n('s1', 'trigger.schedule', 'Every day, 9:30 AM', { mode: 'daily', time: '09:30', timezone: 'Asia/Kuala_Lumpur' }),
      pmsRead('s2', 'New tenant leads', 'offlineInquiries', [{ field: 'status', op: '==', value: 'new' }]),
      n('s3', 'logic.filter', 'Waiting 2+ days', { conditions: [{ left: '{{ $json.updatedAt }}', operator: 'moreThanDaysAgo', right: 2 }], combine: 'and' }),
      n('s4', 'logic.combine', 'One list', { line: '• {{ $json.id }} · looking for {{ $json.lookingFor }} · budget {{ $json.budget }} · follow-up: {{ $json.assignedTo }}', saveAs: 'list', sortBy: 'updatedAt' }),
      n('s5', 'comm.gmailSend', 'Remind sales', {
        to: 'sales@widebed.com',
        subject: '{{ $json.count }} tenant lead(s) waiting for a call back',
        format: 'text',
        body: 'Hi team,\n\nThese tenant leads are still “New” after 2 days. Please contact them and update the status in the PMS (Tenant Leads):\n\n{{ $json.list }}',
      }, true),
    ),
  }),
  builtIn({
    templateId: 'tpl_pms_unclear_payments',
    name: 'PMS: offline payments to check',
    description: 'Every day at 11 AM, lists offline payments still marked Unknown or Pending and emails Finance.',
    category: 'Widebed PMS',
    needs: [PMS_NEED.replace('the collection used here', 'offlinePayments'), GOOGLE],
    setup: [PMS_CONNECT, 'Change the “To” address.', GO],
    definition: chain(
      n('s1', 'trigger.schedule', 'Every day, 11:00 AM', { mode: 'daily', time: '11:00', timezone: 'Asia/Kuala_Lumpur' }),
      pmsRead('s2', 'Unknown or Pending payments', 'offlinePayments', [{ field: 'status', op: 'in', value: ['Unknown', 'Pending'] }]),
      n('s3', 'logic.combine', 'One list', { line: '• {{ $json.date }} · {{ $json.unitCode }} ({{ $json.propertyName }}) · RM {{ $json.amount }} · {{ $json.status }}', saveAs: 'list', sortBy: 'date' }),
      n('s4', 'comm.gmailSend', 'Email Finance', {
        to: 'finance@widebed.com',
        subject: '{{ $json.count }} offline payment(s) to check',
        format: 'text',
        body: 'Hi Finance,\n\nThese offline payments are still Unknown or Pending (oldest first):\n\n{{ $json.list }}\n\nPlease check them in the PMS (Offline Payments).',
      }, true),
    ),
  }),
];

/** Copy of a definition that is safe to store as a template: no chosen connections, no run data. */
export function templateSafeDefinition(def: WorkflowDefinition): WorkflowDefinition {
  const copy: WorkflowDefinition = JSON.parse(JSON.stringify(def));
  for (const node of copy.nodes) {
    if ('credentialId' in node) node.credentialId = null;
  }
  return copy;
}
