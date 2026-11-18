# Widebed Automation — Handover

> Give this file (together with the project folder) to whoever continues the work —
> a teammate or another AI assistant session. It explains what exists, how to run it,
> what is verified, what is not, and what to do next.
>
> Last updated: 14 Nov 2026 · Status: **Phase 1–4 built.** Phase 4 = sharing, activity log, version compare,
> runs-per-day chart, failure alert emails, backup/restore, deployment checklist. What's left is mostly
> **trying it against the real services and going live** — see §11.

---

## 1. What this is

**Widebed Automation** is Widebed's own self-hosted workflow automation platform (like n8n /
Make / Zapier), built from scratch. Staff build workflows on a visual canvas; the platform runs
them on triggers (manual, webhook, schedule, events from PMS/TMS) and shows every run step by step.

It is **independent of Widebed PMS and TMS**: its own Firebase project (`widebed-automation`), its
own server. It talks to PMS/TMS only through Firebase connections (allow-listed collections) and events.

Why it exists: replace the n8n workflows Widebed runs today (e.g. *Tenant Reminder*: daily
emails to tenants and owners from the "Willow 4.0 (N8N)" Google Sheet) with an in-house platform.

## 2. About the owner (how to work with them)

- Owner: **Crane** (IT, Widebed). Develops on **Windows, PowerShell**, folder `C:\dev\Widebed\widebedAutomation`.
- Prefers **beginner-friendly, step-by-step** explanations and **simple, clean code**. Happy to iterate.
- Always give **PowerShell** commands (not bash). Env vars: `$env:NAME="value"`; Python is `python`, not `python3`.
- When something fails, ask for the **check number** and the **terminal output** (Terminal 1 = API, 2 = worker).

## 3. Tech stack (fixed by the original brief — do not change)

| Layer | Choice |
|---|---|
| Frontend | Vue 3, TypeScript, Vite, Pinia, Vue Router, Tailwind CSS 4, Vue Flow, Lucide (`@lucide/vue`) |
| Backend | Node.js 22, Express, TypeScript, REST + Server-Sent Events |
| Database / auth | **Cloud Firestore only** (no Postgres/Mongo), Firebase Auth, Admin SDK |
| Queue | Redis + BullMQ (Redis is never the database) |
| Execution | Own engine + worker processes (**not** Cloud Functions) |
| Deploy | Docker Compose, Caddy (HTTPS), self-hosted Linux |

## 4. Project map

```
packages/shared   types, permissions (RBAC matrix), credentials types, redaction helpers
packages/nodes    every node type (one file per family) + node registry + SSRF-safe HTTP client
packages/engine   graph validation, {{ expression }} resolver (paths only, no eval), executor
apps/api          Express API + worker entry (src/worker.ts)
  src/routes        workflows (incl. import/export), executions (+SSE), credentials, misc, public webhooks/events
  src/services      execution-service (start/run/cancel/retry), queue (in-process | BullMQ),
                    scheduler (timers | BullMQ job schedulers), event-bus (local | Redis pub/sub),
                    credential-service (encryption, Firebase guard, Google OAuth), code-sandbox,
                    webhook-service, workflow-transfer (export/import + n8n converter), audit
  src/repositories  Firestore implementation + in-memory one (tests); same interface
  test/             API + phase2 + transfer + redis + repository-contract tests, e2e harness
apps/web          Vue app (views/, components/editor/ = canvas, palette, settings panel)
firebase/         firestore.rules (deny all client access), firestore.indexes.json (+ TTL)
docker/           api.Dockerfile (API + worker), web.Dockerfile, Caddyfile
e2e/              Playwright browser scripts (run.py = Phase 1, phase2.py = Phase 2)
docs/             ARCHITECTURE.md (design, schema, API, security), screenshots/
```

Read **docs/ARCHITECTURE.md** next — it has the Firestore schema, every API endpoint, the
workflow JSON format, the node contract and the security design.

## 5. How it works (short version)

- **Workflow** = `draftDefinition` (editable) + immutable **versions** created on *Publish*.
  Published runs always use their version snapshot; editing the draft never changes a running/old run.
- **Run** = `workflowExecutions/{id}` + one `steps/{id}` doc per node. The execution doc holds
  everything a worker needs (trigger data, and for test runs a frozen copy of the draft), so the API
  only queues and any worker can run it.
- **Without `REDIS_URL`** the API runs everything itself (in-memory queue + timers). **With Redis**
  the API queues, `worker.ts` processes run jobs and schedules, and live events / cancels go via Redis.
- **Nodes** are pure: they only use `ctx.services` (http, firestore, googleToken, runCode, wait).
  Security lives in those services (SSRF guard, collection allow-lists, sandbox, token handling).
- **Roles**: super_admin, admin, it_admin, department_manager, employee — matrix in
  `packages/shared/src/permissions.ts`; always enforced on the backend.
- **Users** are created by admins only (Users & Permissions → *Invite user*). Public sign-up is
  disabled in Firebase. `SUPER_ADMIN_EMAILS` bootstraps the first admin.

## 6. Nodes available now

| Category | Nodes |
|---|---|
| Triggers | Manual, Webhook (URL token + optional HMAC), Schedule (once on a date, every day / week / month with time pickers, every N minutes, or cron for IT; time zone), HTTP Event (named events from PMS/TMS with event-source keys) |
| Logic | IF, Switch (dynamic outputs), Filter, Merge (append / by position / wait both / **match by fields**), Loop (list → items, or N times), Wait (≤ `WAIT_MAX_MS`), **Combine into One**. IF/Filter have **date checks** (today, tomorrow, N days ago…) and expressions have `{{ $today }}` |
| Data | HTTP Request, Code Execution (sandboxed; IT Admin only), Firebase Read / Create / Update / Delete (other projects, allow-listed collections, optional read-only) |
| Communication | Gmail Send / Read, Google Sheets Read Rows / Add Row / Update Row (one Google OAuth connection) |
| AI | AI Write / Answer, AI Sort into Categories, AI Pull Out Details, **AI Agent** (runs the Assistant on a schedule) |
| Import helper | "Needs replacing" placeholder for imported nodes with no equivalent (blocks Publish) |

Nothing is greyed out any more. Trello is **not used** by Widebed (dropped 14 Nov 2026).

## 7. Running it on Crane's PC (Windows)

```powershell
cd C:\dev\Widebed\widebedAutomation
npm install
npm test                 # expect 71 passed, 4 skipped (the 4 need Redis)
npm run dev:api          # Terminal 1
npm run dev:web          # Terminal 2 → open the URL Vite prints
```

`apps/api/.env` (never commit; values are examples):
```
FIREBASE_PROJECT_ID=widebed-automation
GOOGLE_APPLICATION_CREDENTIALS=C:/dev/Widebed/widebedAutomation/secret/<service-account>.json
ENCRYPTION_KEY=<32 random bytes base64 — keep forever, never share>
SUPER_ADMIN_EMAILS=<owner email>
CORS_ORIGINS=http://localhost:5174
PUBLIC_BASE_URL=http://localhost:5174          # must equal the browser URL
HTTP_ALLOW_PRIVATE_NETWORKS=false
# optional:
# REDIS_URL=redis://localhost:6379             # only when Redis is really running
# PROCESS_JOBS=false                           # only with Redis + a separate `npm run dev:worker`
# GOOGLE_OAUTH_CLIENT_ID= / GOOGLE_OAUTH_CLIENT_SECRET=   # for Gmail
```
`apps/web/.env`: the four `VITE_FIREBASE_*` values from Firebase → Project settings → Web app.

Firestore rules / indexes / TTL: `npx firebase-tools deploy --only firestore --project widebed-automation`
(if it asks to delete an index that is not in the file, answer **N**).

**Redis** (optional locally): Docker Desktop must show *Engine running*, then
`docker run -d --name widebed-redis -p 6379:6379 --restart unless-stopped redis:7-alpine`.
Alternative without Docker: Memurai (Redis-compatible Windows service).

## 8. Verification status — be honest about this

**Verified (automated, 190 tests; earlier runs also with real Redis):** engine, all node logic, RBAC, invites,
publish/versions, webhooks (+HMAC, idempotency), SSE, cancel/retry, credential encryption,
Firebase allow-list / read-only / department rules (against an in-memory fake Firestore), Google
OAuth flow (against a simulated Google), code sandbox escapes, schedules, events, import/export
(incl. the real *Tenant Reminder* n8n file converting 26/34 nodes), Redis mode with API and worker
as separate processes. Browser flows for Phase 1, Phase 2 and import/export run with zero console errors.

**Verified by Crane on his PC:** tests pass; sign-in, invites, dashboard, workflow editing against
the real `widebed-automation` Firebase project; **Gmail send with the real support@widebed.com account**
(14 Nov 2026; OAuth app is External/Testing → the connection expires every 7 days until verified).

**NOT yet verified against the real services:**
- Gmail read, and Google Sheets nodes, with the real Google account.
- Firebase nodes against the real PMS/TMS projects (start read-only on a test collection).
- Redis on Crane's PC (Docker Desktop was not running yet).
- Docker images (`docker compose build`, incl. `docker/api-browser.Dockerfile`) and a production deployment.
- AI steps and the Widebed Assistant with a real AI key; the assistant's real browser (Playwright) and myTNB.
- The PMS templates against real PMS data.
- The web app in a browser after the 14 Nov updates (type-checked only; Crane to click through) — incl. the Phase 4 screens.
- Failure alert emails with the real support@widebed.com account (tested with a simulated Gmail).

## 9. Known limitations / decisions

- **Expressions are paths only** (`{{ $json.a["b c"][0] }}`, `$node["Name"].json`, `$trigger`…). No JS
  in expressions (security). Anything complex goes in a Code node. n8n expressions like
  `.toDateTime().toFormat()` are flagged on import.
- `$node["X"]` gives the **first** item of X (n8n's `.item` pairing is not implemented).
- Code node: isolated child process (permission model, no code-from-strings, no fetch/require,
  memory/time limits, `CODE_TIMEZONE` default Asia/Kuala_Lumpur). Not a VM boundary → only IT
  Admin/Super Admin may add/change code (enforced on save, publish and import).
- Wait node pauses inside the worker (max 1 h default). Long "resume tomorrow" waits → use a Schedule.
- A worker crash marks the run **failed** (never auto re-run — emails may already be sent).
- Workflow search filters up to 500 workflows server-side (no full-text index).
- Gmail "sender name" option from n8n is not supported (mail is sent as the connected account).
- Sharing gives **view + run** only (never edit). Editing stays with the owner, the department manager and admins.
- Failure alerts: cooldown is remembered per process — with several workers you can get one email per worker per cooldown.
- Backup = workflows only (drafts, tags, department). Connections, run history, users and templates are not in it; restore adds switched-off copies.
- Assistant runs inside the API process (not the worker); with several API servers, a chat's browser tab and
  screenshot live on the server that ran it. Fine for one server; revisit when scaling.

### Motion and loading (14 Nov 2026)
All animation lives in `apps/web/src/style.css` (section “Motion”: `animate-in` + `--i` for staggered lists, `animate-pop`,
`skeleton`, `dots`, `card-hover`, page / modal transitions) and switches off for `prefers-reduced-motion`.
Loading feedback is automatic (`lib/loading.ts`): `api()` drives the top progress bar, and a button that starts requests
shows a spinner and blocks double clicks until they finish. Background polling must pass `{ quiet: true }`; buttons with
their own spinner get `data-no-loading`. Use `<Skeleton kind="list|table|cards|tiles">` instead of “Loading…” text.

### Beginner-friendly principle (from Crane, 14 Nov 2026)
The whole app must be usable by **non-technical staff** building their own workflows. Prefer pickers,
buttons and plain-English summaries over codes (cron, JSON, expressions). Keep advanced options
available but labelled "Advanced". Reusable beginner field types exist: `date`, `time`,
`multiSelect`, `timezone` (see `FieldInput.vue`).
Every page has a **Guide** button in the top-right corner of its header (via `PageHeader.vue`; editor: top-right of
the canvas) that opens a pop-up. New pages must use `<PageHeader>` so they get it too. The text lives in
`apps/web/src/lib/guides.ts` — when you add or change a page or feature, update its guide there.

## 10. Problems already solved (don't re-investigate)

| Symptom | Cause / fix |
|---|---|
| "waiting for administrator approval" on first login | Firebase-console users are not email-verified; bootstrap now matches email only. Fix existing doc: Firestore `users/{uid}` → role `super_admin`, status `active`. |
| 500 on first dashboard load | Parallel first requests raced to create the user doc → now tolerant. |
| `FAILED_PRECONDITION … requires an index` | Firestore indexes not deployed → run the deploy command. |
| PowerShell: `VAR=value` / `source` / `python3` errors | Use `$env:VAR=...`; the API auto-loads `apps/api/.env`; use `python`. |
| 503 on Run + "Waiting for the first node…" | `REDIS_URL` set but Redis not running. Start Redis or remove `REDIS_URL`. The editor now shows this message in the execution panel. |
| `docker` "dockerDesktopLinuxEngine" error | Docker Desktop app not running. |
| Assistant: “Your chats will appear here” although a chat exists; reply stuck on “Thinking” | Chat list needed a Firestore index → now sorted in memory (no index). “Thinking” AI models used up the length budget → budgets raised and a clear “ran out of length” error. |

## 11. Phase status

| Phase | What | Status |
|---|---|---|
| 1 | Sign-in, roles, workflow editor, manual/webhook runs, executions, dashboard | ✅ Built, tested, used by Crane |
| 2 | Redis queue + worker, schedules, events, Firebase/Gmail/HTTP/Code nodes, import/export (n8n) | ✅ Built & tested · Gmail send verified for real |
| 3 | Google Sheets, AI nodes + AI Agent, Integrations, Templates (16), PMS templates, Widebed Assistant | ✅ Built & tested with fakes |
| 4 | Sharing, Activity log, version compare, runs-per-day chart, failure alerts, backup/restore, deployment checklist | ✅ Built & tested (14 Nov 2026) |
| AI Staff P1 | Audit + plan for the multi-agent “AI Staff” upgrade — `docs/AI-STAFF-PLAN.md` | ✅ 17 Nov |
| AI Staff P2 | AI Staff page, agent editor (7 templates, live model list), per-agent chats with live typing + markdown, per-agent memory | ✅ Built & tested (update-9) |
| AI Staff P3 | Access: delegated managers, who-can-chat list, private chats (tested), Admin memory review, secret filter | ✅ Built & tested (update-10) |
| AI Staff P4a | AI Tasks (Task Center, give a task, stop/retry) + AI Schedules on the server queue/scheduler | ✅ Built & tested (update-11) |
| AI Staff P4b | Notification bell (+ browser pop-ups, preferences), long-term responsibilities with problem tracking and one follow-up per new problem | ✅ Built & tested (update-12) |
| AI Staff P5 | Approval Center: risk levels 1–4, exact-action single-use approvals with expiry, edit + confirm, tasks wait for approval | ✅ Built & tested (update-13) |
| AI Staff P6 | Main Manager: list_team + delegate (parallel / after), Collaboration page, permission intersection, loop/budget limits | ✅ Built & tested (update-14) |
| AI Staff P7a | Company Knowledge (text only, no Firebase Storage): Knowledge page, uploads → text, reader + AI access rules, search_knowledge/read_knowledge, chat file attachments | ✅ Built & tested (update-15) |
| AI Staff P7b | Photos in chat: browser shrinks, kept in the chat (Firestore, no Storage), AI sees the 4 newest (OpenAI/Claude/Gemini) | ✅ Built & tested (update-16) |
| AI Staff P8 | AI Performance page (tasks, success, time, tokens, cost from Admin prices), usage counting, security review, full test checklist | ✅ Built & tested (update-17) |
| UI | Menu grouped into AI Team / Automation / Connections / Admin (foldable, remembered per browser) | ✅ update-18 |
| Workflows | Tenant Reminder rebuilt on the PMS Firebase (docs/workflows); Firebase Read “Add to each incoming item as” lookups; Gmail sender name + pass-through | ✅ update-23 |
| — | **Try with the real services** (list in §8 “NOT yet verified”) | ⏳ Crane |
| — | **Go live** on a server — follow `docs/DEPLOYMENT.md` | ⏳ Not started |

### Phase 4 (14 Nov 2026) — where things are
- **Sharing**: Workflows → ⋯ → *Share…* (`ShareWorkflowModal.vue`). `GET /api/people` is a small directory
  (name/email/department of active users) for anyone who can create workflows; the full user list stays admin-only.
  `PATCH /workflows/:id {sharedWith}` now checks every person is active, drops the owner, and writes a `workflow.share` audit entry.
- **Activity log** page `/activity` (`ActivityView.vue`, permission `audit.view` = Super Admin + Admin): plain-English rows,
  filters, search, details, paging. The API adds `actorName`/`actorEmail`.
- **Version compare**: editor → Versions → *What changed?* (vs the previous version) and *Compare my draft with the live version*.
  Logic in `packages/shared/src/diff.ts` (`diffDefinitions`), UI `components/editor/VersionCompare.vue`.
- **Runs per day** chart on Overview (`DailyRunsChart.vue`, `GET /api/dashboard/daily?days=14&tz=…`). Failed parts are
  hatched so they don't rely on red vs green alone; hover for numbers, *Show numbers* for a table.
- **Failure alerts** + **system settings** (Settings page, Super Admin): `SystemService` (`services/system-service.ts`),
  `GET/PUT /api/system/settings`, `POST /api/system/alerts/test`. Emails go through a Google connection with Gmail
  (`CredentialService.sendSystemEmail`). Only published runs alert; one email per workflow per cooldown.
- **Backup / restore**: `GET /api/system/backup` (all workflows, no secrets). Restore runs in the browser: each workflow
  goes through the normal import, so the same safety checks apply.
- **Deployment checklist**: `docs/DEPLOYMENT.md`.

Ideas for later (not started): per-workflow alert recipients, Slack/LINE/WhatsApp alerts, scheduled automatic backups
to Google Drive, edit-sharing (share as “can edit”), PMS bell notifications, instant PMS events.

### Phase 3 notes (done)

1. ✅ **Google Sheets nodes** — done 14 Nov 2026 (`packages/nodes/src/nodes/sheets.ts`). Same `google_oauth`
   connection with the extra `spreadsheets` scope; **Reconnect** on the Credentials page refreshes a
   connection in place (same id, must be the same Google account). n8n `googleSheets` read / append /
   update / appendOrUpdate are converted. Next for Tenant Reminder: **re-import** the n8n file so the
   Sheets nodes convert, pick the Google connection on all Sheets + Gmail nodes, and rewrite the 3
   `toDateTime()` expressions in "Password Update" (the Code node already computes `currentExpiryDisplay`).
   Not yet verified against the real Google Sheets API (tested with a fake Sheets server).
2. ~~Trello~~ — dropped: Widebed does not use Trello.
3. ✅ **AI** connections + AI Write / Sort / Pull Out Details nodes (`packages/nodes/src/nodes/ai.ts`,
   `apps/api/src/services/ai-client.ts`). Default models (editable, checked by Test): OpenAI `gpt-5.4-mini`,
   Claude `claude-haiku-5-5`, Gemini `gemini-flash-latest`. Not yet verified with a real AI key.
6. ✅ **Widebed Assistant** (14 Nov 2026) — `apps/api/src/assistant/` (agent.ts loop, tools.ts, browser.ts, service.ts),
   `routes/assistant.ts`, `AssistantView.vue`. Chat + memory, tools: memory, workflows (always asks approval),
   read-only PMS queries (managers/IT/admins only; PMS connection must be read-only), browser with saved
   **Website login** connections (domain-locked, passwords never reach the AI, risky clicks ask, OTP asked in chat,
   downloads kept 7 days). Plus the **AI Agent** node for scheduled jobs. Tested with a fake AI and a fake browser
   only. The real browser needs Playwright + Chromium (README → Widebed Assistant); not yet tried on myTNB.
7. ✅ **PMS automations**: date checks, `{{ $today }}`, Combine into One, and 5 “Widebed PMS” templates
   (arrivals tomorrow, bookings not in eZee, stale issues, lead follow-up, unclear payments). Field names were taken
   from the PMS code (`widebed-pmsdashboard`); check them against real data with a Test run.
4. ✅ **Integration Hub** page (`IntegrationsView.vue`) and **AI** page (`AiView.vue`).
5. ✅ **Templates** (`TemplatesView.vue`, `packages/shared/src/templates.ts`, `routes/templates.ts`):
   11 built-in templates + “Save as template”. Deploy Firestore rules again (new `workflowTemplates`).

For each new node: one file in `packages/nodes/src/nodes/`, register in `registry.ts`, remove it
from `PLANNED_NODES`, add tests in `packages/engine/test/nodes.test.ts`, add an n8n mapping if useful.

Ideas noted for later: PMS bell notifications from workflows (Firebase Create needs a real timestamp value),
instant PMS events (PMS server → `/events/…`), per-person reminders (look up the assignee's email).


## 12. Ground rules from the original brief (keep following them)

- Build real working features, no fake buttons or hard-coded results. Unbuilt features are shown
  honestly as "Phase N".
- Never store secrets in plain text (AES-256-GCM via `SecretBox`; hashes for tokens/keys).
- Never commit service-account JSON or `.env` files.
- Do not claim something is done until it is implemented **and tested**; say clearly what was not
  verified against real services.
- Keep the platform independent of PMS/TMS; do not modify their Firebase projects' rules.
