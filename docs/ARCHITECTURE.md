# Widebed Automation — Architecture

Self-hosted visual workflow automation for Widebed. Built from scratch: own engine, own node
registry, own UI. Firestore is the only database. Execution happens in our own Node.js
processes (never Cloud Functions).

---

## 1. Project structure

```
widebed-automation/
├── packages/
│   ├── shared/     Types used by every part: workflow JSON, executions, roles/permissions,
│   │               node descriptors, secret redaction. No runtime dependencies.
│   ├── nodes/      Node registry + node implementations + SSRF-safe HTTP client.
│   │               (This is where IT admins add custom nodes and integrations.)
│   └── engine/     Graph validation, expression resolver, workflow executor.
│                   Knows nothing about Firestore, Express or queues.
├── apps/
│   ├── api/        Express REST API + SSE + webhook receiver + execution service.
│   │   ├── src/repositories/   Firestore implementation (+ in-memory one for tests)
│   │   ├── src/services/       execution queue/runner, webhooks, audit, event bus
│   │   ├── src/routes/         HTTP endpoints, request validation (zod)
│   │   └── test/               API, RBAC, webhook and repository contract tests
│   └── web/        Vue 3 + Vite + Pinia + Vue Router + Tailwind + Vue Flow
├── firebase/       Firestore security rules and indexes (+ TTL policies)
├── docker/         Dockerfiles and Caddyfile
└── docs/
```

The worker is a second entry point of the same code (`apps/api/src/worker.ts`), shipped in the
same Docker image with a different command. API and workers share nothing in memory: a run
is fully described by its execution document, and they talk through Redis.

```
Browser ─HTTPS─▶ Caddy ─/api /hooks /events /oauth─▶ API (Express) ──enqueue──▶ Redis (BullMQ)
                   └ static SPA                        │  token + RBAC        │  executions queue
                                                        │                      │  schedules (job schedulers)
                                                        │ SSE ◀─ pub/sub ──────┤  live events + cancel
                                                        ▼                      ▼
                                                  Firestore ◀──────── Worker ×N ─▶ engine ─▶ nodes
                                                                         │ Code node → sandbox child process
                                                                         │ Firebase nodes → other projects (allow-listed)
                                                                         └ Gmail → Google APIs (OAuth tokens)
```
Without `REDIS_URL` everything runs in one process (in-memory queue, timers, local events) — handy
for development and tests, not for production.

---

## 2. Firestore schema

All timestamps are ISO-8601 strings (sortable, readable in the console) except `expireAt`,
which is a Firestore `Timestamp` because TTL policies require it.

| Collection | Doc id | Key fields | Notes |
|---|---|---|---|
| `users` | Firebase uid | name, email, role, department, status, createdAt, lastLoginAt | Role here is the only source of truth. New users are `pending`. |
| `workflows` | `wf_…` | name, description, folderId, ownerId, department, status, tags, sharedWith[], draftDefinition, publishedVersion, publishedVersionId, eventTriggers[], createdAt, updatedAt, publishedAt | `draftDefinition` is exempt from indexing. `eventTriggers` = event names of the published version (fast lookup for `/events`). |
| `workflowVersions` | `{workflowId}_v{n}` | versionId, workflowId, versionNumber, nodes, connections, settings, publishedBy, publishedAt | **Immutable.** Created in a transaction with `create()`, so version numbers can't collide. |
| `workflowExecutions` | `exe_…` | workflowId, workflowName, department, workflowVersion, workflowVersionId, isTestRun, status, triggerType, initiatedBy, idempotencyKey, retryOf, createdAt, startedAt, completedAt, duration, errorSummary, stepCount, triggerNodeId, triggerItemsJson, definitionJson, untilNodeId, expireAt | Summary + everything a worker needs to run it. `triggerItemsJson` / `definitionJson` (draft test runs only) are server-only. |
| `workflowExecutions/{id}/steps` | `step_…` | nodeId, nodeName, nodeType, status, attempt, inputJson, outputJson, error, startedAt, completedAt, duration, expireAt | One doc per node run (subcollection). Payloads are redacted, size-limited JSON strings (arbitrary data can contain nested arrays, which Firestore can't store natively). |
| `workflowFolders` | `fld_…` | name, ownerId, department, createdAt | |
| `assistantChats` | `chat_…` | ownerId, title, status (idle/running/waiting), createdAt, updatedAt, transcriptJson, pendingJson | Server-only transcript (last 80 entries) and the action waiting for approval. |
| `assistantChats/{id}/messages` | `msg_…` | role, text, status, steps[], pending, files[], createdAt | What the chat page shows, including live steps. |
| `assistantMemories` | `mem_…` | ownerId, text, createdAt | What the assistant remembers about a person (max 100). |
| `workflowTemplates` | `tpl_…` | name, description, category, needs[], setup[], definitionJson, builtIn (false), createdBy, createdByName, createdAt | Templates saved by users. Connections are removed before saving. Built-in templates live in code (`packages/shared/src/templates.ts`). |
| `webhookEndpoints` | `wh_…` | workflowId, nodeId, endpointTokenHash, signingSecretEncrypted, status, createdAt | Only the SHA-256 of the URL token is stored. |
| `credentials` | `cred_…` | name, provider (`firebase_service_account`, `google_oauth`, `event_source`, `ai_provider`), ownerId, department, status, details (project id, allowed collections, read-only, account email, scopes, key prefix, AI service + model + last 4 of key), encryptedSecretReference, lastTestedAt, lastTestResult | Metadata only — safe to list in the UI. `department: null` = usable by all departments. |
| `credentialSecrets` | same id | encrypted (AES-256-GCM) JSON: service-account key / OAuth refresh token / event-key hash / AI API key | Separate collection so metadata reads never touch secrets. Only API/worker decrypt. |
| `auditLogs` | `log_…` | actorId, action, resourceType, resourceId, timestamp, metadata | Top-level (not a subcollection) so admins can query across all resources by time. Metadata is redacted. |
| `systemSettings` | setting id | settingValue, updatedAt | Phase 4 UI; `_health` doc used for pings. |

**Idempotency** — when a caller sends `Idempotency-Key`, the execution id is
`sha256(workflowId + key)` and is written with `create()`. A duplicate request hits
`ALREADY_EXISTS` and gets the original execution id back. No read-then-write race.

**Retention** — `expireAt = createdAt + EXECUTION_RETENTION_DAYS`. TTL policies on
`workflowExecutions.expireAt` and the `steps` collection group delete old history
automatically (declared in `firebase/firestore.indexes.json`).

**Pagination** — cursor = last document id, applied with `startAfter(snapshot)`.
**Indexes** — composite indexes for every list filter + `createdAt desc` are in
`firebase/firestore.indexes.json`.

---

## 3. Workflow JSON format (schemaVersion 1)

```json
{
  "schemaVersion": 1,
  "nodes": [
    { "id": "node_trg", "type": "trigger.webhook", "name": "New booking",
      "position": { "x": 0, "y": 0 }, "config": { "method": "POST", "requireSignature": true } },
    { "id": "node_get", "type": "data.httpRequest", "name": "Get booking",
      "position": { "x": 280, "y": 0 },
      "config": { "method": "GET", "url": "https://pms.widebed.com/api/bookings/{{ $json.body.bookingId }}" },
      "retry": { "maxAttempts": 3, "backoffMs": 1000 } },
    { "id": "node_if", "type": "logic.if", "name": "Confirmed?",
      "position": { "x": 560, "y": 0 },
      "config": { "conditions": [{ "left": "{{ $json.body.status }}", "operator": "equals", "right": "confirmed" }], "combine": "and" } }
  ],
  "connections": [
    { "id": "c1", "source": "node_trg", "sourceHandle": "main", "target": "node_get", "targetHandle": "main" },
    { "id": "c2", "source": "node_get", "sourceHandle": "main", "target": "node_if", "targetHandle": "main" }
  ],
  "settings": { "timeoutMs": 120000 }
}
```

Rules enforced by `validateWorkflow`: known node types, valid config (zod), unique node
names and ids, handles that exist, no edges into triggers, no cycles, at least one trigger,
max 200 nodes. Unreachable nodes are a warning.

### Data between nodes
Data flows as a list of **items** (`{ json: {...} }`). A node runs once with all items it
received; most nodes process them item by item. An output handle that emits no items
causes the downstream nodes to be **skipped** — this is how IF branching works.

### Expressions
`{{ … }}` inside any string field. Only property paths are allowed — **not JavaScript** —
so there's nothing to sandbox:
`$json.a.b`, `$json["key with space"][0]`, `$node["Node name"].json.x`, `$trigger.body.x`,
`$execution.id`, `$workflow.id`, `$now`, `$itemIndex`. `__proto__`/`constructor` are blocked.
A field that is exactly one expression keeps its raw type (number, object).

---

## 4. Node execution contract

```ts
interface NodeImplementation {
  descriptor: NodeDescriptor;      // type, version, category, icon, inputs, outputs,
                                   // UI fields, input/output schema, docs, retryable
  configSchema: ZodSchema;         // validated on save, publish and before running
  execute(ctx: NodeExecutionContext): Promise<{ outputs: Record<handleId, Item[]> }>;
}

ctx = { executionId, workflowId, node, config, items, inputs,
        resolve(value, item, index),   // expression resolution
        signal,                        // AbortSignal: cancel + timeout
        services: { http, getCredential? } }
```

Nodes never import Firestore, Express or `fetch`. Everything risky goes through
`ctx.services`, where the platform enforces security. Errors are thrown as
`NodeError(message, { code, retryable })`; the engine retries only when the node type is
retryable **and** the error says `retryable: true`, with exponential backoff.

**Adding a node:** create `packages/nodes/src/nodes/my-node.ts` with `defineNode({...})`,
register it in `createDefaultRegistry()`. The palette, settings form, docs tab and
validation update automatically because the UI renders from `GET /api/node-types`.

---

## 5. API endpoints

All `/api/*` routes require `Authorization: Bearer <Firebase ID token>`.

| Method | Path | Permission |
|---|---|---|
| GET | `/api/me` | any active user |
| POST | `/api/me/session` | records login |
| GET / PATCH | `/api/users`, `/api/users/:uid` | `user.manage` |
| GET / POST | `/api/workflows` | list = visible ones; create = `workflow.create` |
| GET / PATCH / DELETE | `/api/workflows/:id` | view / edit |
| PUT | `/api/workflows/:id/draft` | edit — saves draft only |
| POST | `/api/workflows/:id/validate` | view |
| POST | `/api/workflows/:id/duplicate` | `workflow.create` |
| POST | `/api/workflows/:id/publish` | publish — creates immutable version |
| POST | `/api/workflows/:id/activate` · `/deactivate` | publish |
| GET | `/api/workflows/:id/versions` · `/versions/:n` | view |
| POST | `/api/workflows/:id/versions/:n/restore` | edit — loads into draft |
| POST | `/api/workflows/:id/run` `{mode: draft\|published, payload?}` | draft = edit, published = run |
| POST | `/api/workflows/:id/nodes/:nodeId/test` | edit — runs up to that node |
| GET | `/api/workflows/:id/webhooks` | edit — never returns tokens |
| POST | `/api/workflows/:id/webhooks/:nodeId/rotate` | publish |
| GET / POST / PATCH / DELETE | `/api/folders` | |
| GET | `/api/executions?workflowId&status&triggerType&department&from&to&cursor&limit` | scoped by role |
| GET | `/api/executions/:id` | includes steps |
| GET | `/api/executions/:id/stream` | Server-Sent Events |
| POST | `/api/executions/:id/cancel` · `/retry` | |
| GET | `/api/node-types` | |
| GET | `/api/dashboard/stats?from&to` | scoped by role |
| GET | `/api/system/health`, `/api/system/audit-logs` | audit = `audit.view` |
| GET | `/api/credentials` | metadata of connections visible to the user |
| POST | `/api/credentials/firebase` · `/event-source` · `/ai` · `/google/start` (`reconnectId` to refresh an existing Google connection) | `credential.manage` |
| POST | `/api/credentials/:id/test` · `/rotate` · PATCH · DELETE | `credential.manage` |
| GET | `/api/schedules` | active schedules + next run |
| GET | `/api/workflows/:id/export` | view — portable JSON of the draft (no secrets) |
| POST | `/api/workflows/import` `{ file, name?, autoConnect? }` | `workflow.create` — Widebed export or n8n workflow → new inactive workflow + report. `autoConnect` picks the connection when exactly one fits (used by templates). |
| GET | `/api/assistant/status` · PUT `/api/assistant/settings` (`credential.manage`) | |
| GET / POST / DELETE | `/api/assistant/chats[/:id]`, POST `/:id/messages` · `/:id/decision` · `/:id/stop`, GET `/:id/screen` | own chats only |
| GET / POST / DELETE | `/api/assistant/memories[/:id]`, GET `/api/assistant/files/:id` | own only |
| GET / POST | `/api/templates` | list = everyone; save a workflow as template = `workflow.create` |
| DELETE | `/api/templates/:id` | its creator or `workflow.manageAll` |
| ANY | `/hooks/:token` | public; token (+ optional HMAC) |
| POST | `/events/:eventName` | public; `Authorization: Bearer <event source key>` |
| GET | `/oauth/google/callback` | public; signed state |
| GET | `/healthz` | public liveness |

---

## 6. Security architecture

| Concern | Implementation |
|---|---|
| Authentication | Firebase Auth (email/password, reset). Every API request: `verifyIdToken(token, checkRevoked=true)` with the Admin SDK. |
| Authorization | Role + department loaded from `users/{uid}` on the server (30 s cache, invalidated on change). Permission matrix in `packages/shared/src/permissions.ts`; checked in every route. Browser role info is display-only. |
| Firestore access | Security rules deny **all** client reads/writes. Only the API (Admin SDK) touches data. |
| Onboarding | First sign-in creates a `pending` user. Only `SUPER_ADMIN_EMAILS` are auto-activated. |
| Secrets at rest | AES-256-GCM (`SecretBox`, key from `ENCRYPTION_KEY`). Webhook URL tokens are stored as SHA-256 hashes only. |
| Webhooks | Unguessable 192-bit token in URL; optional HMAC-SHA256 over the raw body (`X-Widebed-Signature`), constant-time compare; same 404 for every failure; per-IP rate limit; body size limit; `Authorization`/`Cookie` headers stripped before data enters the workflow. |
| SSRF | HTTP Request node uses `createSafeHttpClient`: http/https only, no credentials in URL, every DNS answer checked in the socket `lookup` hook (blocks loopback, RFC1918, link-local/metadata, CGNAT, IPv6 ULA/link-local, IPv4-mapped), redirects re-validated, auth headers dropped on cross-host redirect. Internal hosts can be allow-listed explicitly. |
| Sensitive fields | HTTP node rejects `Authorization`/API-key headers in plain fields — these must come from credentials. |
| Log hygiene | Step input/output pass through `redactSecrets` (password/token/secret/api key/authorization/cookie keys) and `limitSize` (64 KB) before storage. Audit metadata is redacted too. |
| Code execution | Code node runs in a **separate short-lived process**: Node permission model (no fs, child processes, workers, addons), `--disallow-code-generation-from-strings` + vm context with code generation off (blocks `constructor.constructor` escapes), host `fetch`/`require`/module loaders removed, empty environment (no secrets), memory cap, CPU timeout + hard kill, JSON-only I/O. Only `node.createCustom` roles (IT Admin, Super Admin) may add or change Code nodes — enforced on save and publish. Residual risk: not a VM boundary; run workers with restricted outbound network. Expressions elsewhere remain path lookups, not `eval`. |
| Outside data (Firebase nodes) | Each connection lists the collections nodes may use (`*` = one path segment); everything else is refused before any request. Optional read-only. The platform's own collections are always refused. Department-scoped connections can only be used by workflows of that department (checked on save **and** at run time). |
| Gmail | OAuth 2.0 with a signed, expiring `state`; refresh token stored encrypted; access tokens only in worker memory; revoked access marks the connection “needs attention”. Header-injection check on To/Cc/Bcc/Subject. Sending is never retried automatically. |
| Events | Event-source keys are random 192-bit values; only their SHA-256 is stored; compared in constant time; rotatable per app. |
| Abuse limits | Rate limits (API and webhooks), JSON body 2 MB, webhook body 1 MB, max 200 nodes, max 5 000 items per node, response size cap, execution timeout, queue length cap, concurrency limit. |
| Transport & browser | Caddy: automatic HTTPS, HSTS, strict CSP (no inline scripts), `X-Frame-Options: DENY`. CORS limited to `CORS_ORIGINS`. |
| Containers | Non-root user, read-only filesystem, `no-new-privileges`, service account mounted as a Docker secret. |

---

## 7. Execution engine

1. `POST /run` or a webhook → `ExecutionService.start()`
2. Load the definition: published → immutable `workflowVersions` snapshot; draft test run → a copy of the draft taken now.
3. Validate the graph (graph-level errors block; node errors block only if that node would run).
4. Create the execution record (`pending`), atomically if an idempotency key is present.
5. Enqueue (`queued`). The in-process queue enforces `EXECUTION_CONCURRENCY` and `MAX_QUEUE_LENGTH`.
6. Runner sets `running`, starts the timeout timer, calls `runWorkflow()`.
7. Engine executes reachable nodes in topological order, passes items along connections, evaluates IF branches, skips empty branches, retries eligible failures.
8. Each step is written to `steps/` and pushed over SSE (`step.started`, `step.finished`).
9. Final status `success | failed | cancelled` with duration, error summary and step count.

Cancellation: queued jobs are removed; running jobs get `AbortController.abort()`, which
also aborts in-flight HTTP requests. Timeout uses the same signal and is reported as failed.
Retry: allowed for failed/cancelled published runs; pinned to the same version and replays
the stored trigger data.

**Durability (Phase 2).** With Redis, queued executions survive restarts. A worker that dies
mid-run is detected by BullMQ (lock expiry) and the execution is marked failed — it is **not**
re-run automatically, because nodes may already have sent emails or written data. Users can
retry it from the Executions page (pinned to the same version and trigger data).

**Wait** pauses inside the worker (status `waiting`, cancellable, max `WAIT_MAX_MS`). Long
“resume tomorrow” waits are out of scope; use a Schedule Trigger for those.

**Schedules** are BullMQ job schedulers keyed `wf:{workflowId}:{nodeId}`, created on activate /
publish-while-active and removed on deactivate / delete. Each occurrence uses its job id as the
idempotency key, so one occurrence never starts two runs.

**Schedule options.** The Schedule Trigger offers beginner modes — *once* (date + time), *daily*,
*weekly* (days + time), *monthly* (day 1–31 or last day + time) — next to *interval* and *cron*
(advanced). `scheduleCron()` in `packages/shared/src/schedule.ts` turns every simple mode into a cron
pattern, so the scheduler only handles cron or interval. A *once* schedule is registered with
`limit: 1` and an `endDate`, and is not registered at all once its time has passed.

---

## 8. Phased plan and status

### Phase 1 — done
Authentication (login, reset, logout, sessions, invites), Dashboard, Workflow management, Visual
builder, Manual + Webhook triggers, HTTP Request, IF, execution engine (retries, timeout,
cancellation, idempotency, concurrency limits), execution history and live monitoring,
Users & Permissions, audit logging of key actions.

### Phase 2 — done
- Redis + BullMQ queue, separate worker containers, Redis pub/sub for live events and cancel.
- Retry handling: per-node and workflow-default retry policies, safe manual retry, crash handling.
- Schedule Trigger (once / daily / weekly / monthly pickers, interval, or cron; time zones) and HTTP Event Trigger (named events from PMS/TMS).
- Switch, Filter, Merge, Loop, Wait / Delay.
- Code Execution in an isolated process.
- Firebase Read / Create / Update / Delete against other projects, with collection allow-lists.
- Gmail Send / Read via Google OAuth.
- Credentials page (Firebase projects, Google accounts, event sources), Schedules page, workflow settings.

### Phase 3 — mostly done (14 Nov 2026)
- Google Sheets Read Rows / Add Row / Update Row (shared Google connection, Reconnect in place).
- AI connections (OpenAI, Anthropic Claude, Google Gemini; key checked before saving) and the
  AI Write / Answer, AI Sort into Categories (dynamic outputs) and AI Pull Out Details nodes.
  The key stays in the API/worker (`services.ai`); nodes never see it.
- Integration Hub page (status per service, Connect opens the right form on Credentials).
- Templates: 11 built-in Widebed templates + “Save as template”; using one goes through import.
- **Widebed Assistant** (`apps/api/src/assistant/`): chat + memory, agent loop with a JSON tool protocol
  (works on all three AI services), tools = memory, published workflows (always approved by the person),
  read-only PMS queries (builders only), and a Playwright browser restricted to the domains of saved
  “Website login” connections (passwords filled server-side, risky clicks need approval, OTP via chat).
  Runs in the API process; progress is written to the message doc and polled by the page.
  The **AI Agent** node runs the same loop without a person (approval-needing tools refused unless allowed).
- Date conditions (today / tomorrow / N days) and `{{ $today }}`; **Combine into One** node.

### Phase 4
Department permissions and sharing UI, advanced monitoring (per-day charts, alerts), audit log
screen, version compare, system settings screen, backups, production hardening.
