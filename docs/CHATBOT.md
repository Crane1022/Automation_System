# AI Chatbot — moving “Willow 4.0” from n8n

> 20 Nov 2026 · update: AI Chatbot step, Limit step, API key connections, safe JSON body.

## What was missing before

The n8n “Willow 4.0” workflow could not be imported because the platform had no equivalent for:

| n8n node | Now becomes |
|---|---|
| AI Agent + Google Gemini Chat Model + Window Buffer Memory + 5 Google Sheets **tools** | **one AI Chatbot step** (model = your AI connection, memory = built in, tools = “Lists the bot may search”) |
| Limit | **Limit** step |
| HTTP Request with *Header Auth* credential | HTTP Request + **“Sign in with” an API key / token connection** |
| HTTP body parameters | **Body: Fields** (quotes and new lines in AI answers no longer break the JSON) |
| `{{ $now.format('yyyy-MM-dd') }}` | `{{ $today }}` |

Importing `willow.json` now gives **0 “Needs replacing” steps**:
Webhook → System Prompt (Sheets) → Limit → AI Chatbot → Reply to GHL.

## How the AI Chatbot works

1. It reads the **message** (e.g. `{{ $json.body.message.body }}`) and the **instructions** (system prompt).
2. It loads the last *N* messages of this conversation (“Remember the conversation per”, e.g. the GHL contact id).
   Memory is kept per workflow in Firestore `workflowChatMemory` (ids are hashed; deleted after 90 days without use).
3. When it needs facts, the AI asks to search one of the lists. The server reads that Google Sheets tab,
   finds matching rows (all words must match; phone numbers match on digits) and sends **at most 10 rows** back.
   The whole sheet never goes to the AI. Max searches per answer is a setting (default 4).
4. The reply is saved as `{{ $json.output }}` (same name as n8n), with `lookups` listing what it searched.

Works with OpenAI, Claude and Gemini (it uses a small JSON protocol, not provider-specific tool calling).

## API key / token connections

Credentials → **API key / token**: name, websites it may be sent to (e.g. `services.leadconnectorhq.com`),
header name (default `Authorization`) and the key. The key is encrypted; only its last 4 characters are shown.
The HTTP Request step refuses to send it to any other website.

## Chat box on your website

1. Workflow: **Webhook Trigger** (Response: *Wait and send back the reply*, and your website under
   *Websites that may call it*, e.g. `https://www.widebed.com`) → **AI Chatbot** (Message `{{ $json.body.message }}`,
   Remember per `{{ $json.body.sessionId }}`) → **Respond to Webhook** (Fields: `reply` = `{{ $json.output }}`).
   The template **“AI: chat box on your website”** has all of this ready.
2. Publish + Active, copy the webhook URL.
3. Click the Webhook step → copy the chat box code, paste the webhook URL into `data-webhook`, put it on the website before `</body>`:
   ```html
   <script src="https://YOUR-APP/chat-widget.js" data-webhook="https://YOUR-APP/hooks/TOKEN"
           data-title="Widebed" data-welcome="Hi! How can we help with your stay?" data-color="#1f3a5f" defer></script>
   ```
   Optional: `data-subtitle`, `data-placeholder`, `data-position="left"`.

The chat box sends `{ message, sessionId, page, title }` and shows the `reply` field. Each visitor gets their own
`sessionId` (kept in the browser), so the bot remembers the conversation. Calls from websites that are not listed are
refused (403). The caller waits up to `WEBHOOK_REPLY_SECONDS` (default 30). n8n *Respond to Webhook* steps import too.

Note: the webhook URL is visible in the website's code, so anyone could call it. It is rate-limited per visitor
(`WEBHOOK_RATE_LIMIT_PER_MINUTE`); keep a spending limit on your AI account.

## On Vercel (no Redis)

Vercel pauses a function as soon as it has answered. A webhook run (the chatbot) would then stop halfway
and stay “Running”. So on Vercel without Redis, a webhook call now **stays open until its run has finished**
(max `WEBHOOK_WAIT_SECONDS`, default 25 s), then answers `202` as before. A normal reply takes 3–10 s.

## Go-live checklist (Willow)

1. `firebase deploy --only firestore` (new rule + TTL for `workflowChatMemory`).
2. Credentials: AI service (Gemini), Google account (can open the Willow sheet), API key / token for GoHighLevel.
3. Workflows → Import → `willow.json`. On the steps with a warning choose the connections:
   *System Prompt* (Google), *Talk to Your Data1* (AI + Google account for look-ups), *Reply to GHL* (Sign in with).
4. Test run with a sample body, check Executions → each step.
5. Publish, copy the new webhook URL, change the GoHighLevel workflow’s webhook to it. Switch n8n’s copy off.

## Customise any step (23 Nov 2026)

- **Formulas in every box** — type `{{ … }}` like in n8n: `{{ $json.message.trim() }}`, `{{ $('Webhook').item.json.body.contactId }}`, `{{ $now.format('yyyy-MM-dd') }}`, `{{ $json.rooms.map(r => r.name).join(', ') }}`. The **fx** button lists your earlier steps and common formulas, and shows the result using the last test run.
- **JSON tab** on every step — see and edit every setting at once, copy it, or **Paste from n8n** (select a node in n8n, Ctrl+C, paste).
- **Code steps** — IT Admins by default. An Admin can allow everyone who builds workflows in **Settings → Code steps**. Code always runs in a sandbox with no internet, a time limit and a memory limit.
- **Team steps** — on any step click **Save for team**, tick the boxes the team may change, and it appears under **My team's steps** in the step list. Fixing the saved step fixes every workflow that uses it. "Change all settings here instead" turns it back into a normal step.

## Website chat that knows the guest (23 Nov 2026)

Template **“AI: website chat that knows the guest”** (file `willow-website-guest-chat.widebed.json`) with the chat box block `docs/chat-box.html` (`askDetails: true`):

- **First visit:** the chat box asks Name, Phone (country code list, default +60) and Email. It sends `action: "start"` with `profile = { name, phone: "+60123456789", countryCode, phoneNumber, email }`.
- **Find guest by phone / by email** (Firebase Read, query + “Add to each incoming item as”) → **Returning guest?** → *Welcome back* or *Hi …, what are you looking for?*
- **Each question** (`action: "message"`): **Sort the question** (AI, category names = Google Sheets tab names: Property Units, Maintenance Data, Customer Service Team, FAQ) → **Find guest** (tenants/*/private by phoneKey) → **Their bookings** (offlineBookings where tenantId = the guest's TEN- id, max 10 → a list) → **System Prompt** → **Answer the question** (AI Chatbot; the bookings are written into its instructions, the matching tab is its look-up) → reply. Bookings come from Widebed PMS, not the Booking Details sheet (23 Nov 2026).
- **End chat** (`action: "end"`, shown after `idleMinutes` without a message): **AI Chatbot: End Chat** forgets the conversation; the box clears the visitor's details and starts like a first visit.
- Guests are the PMS tenants: `tenants/{id}/private/main` with `kind: "tenant"`, `name`, `phone`, `phoneKey` (digits with country code, e.g. 60123456789, made by the PMS `phoneKey()`), `email`. The steps search **tenants/*/private** (a new Firebase Read option: `*` = every document) by `phoneKey`, then by `email` only if the phone was not found. The PMS Firebase connection must allow `tenants/*/private` and `offlineBookings`. Firebase Read query + “Add to each incoming item as”: Max documents 1 → one document or null; more → a list.
- The email search needs a Firestore index in the PMS project (collection group `private`: `kind` ASC + `email` ASC); the phone search uses the index the PMS already has. A value in double quotes in a Firebase filter (`"{{ … }}"`) is compared as text, so digit-only phone keys are not turned into numbers.
