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
