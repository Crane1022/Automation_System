# Widebed AI Staff — Phase 1: audit and plan

> 17 Nov 2026 · Upgrades the existing Widebed Assistant into a team of AI employees.
> Phase 1 (this audit and plan) was written before any code changes. **Phases 2–8 are done** — see §11.

---

## 1. Short answer: can it be done?

**Yes.** About 60% of the hard parts already exist and work. The rest is new code built on top of them:
- the AI connection for Gemini, OpenAI and Claude;
- tools for PMS read-only, workflows and browser logins;
- approvals, memory, the scheduler and job queue;
- audit logs, roles and departments.

Three things need **your decisions or accounts** (see §9). Some parts of the brief will be done slightly differently from how it's written, because the existing system is safer that way (see §8).

Size: **7 build phases**, each delivered and tested separately, like Phases 1–4 of the automation platform.

---

## 2. What exists today (audit)

| # | Area | What's there now | Where |
|---|---|---|---|
| 1 | Assistant page | Chat list, chats, memory, "It can use" chips, approval card, live progress | `apps/web/src/views/AssistantView.vue` |
| 2 | Chat brain | Step-by-step loop: the AI answers in JSON (`say/tool/input`, `answer`, `ask`), so all 3 providers behave the same. Max steps, stop button | `apps/api/src/assistant/agent.ts` |
| 3–6 | AI providers | One `aiComplete()` for Gemini, OpenAI and Claude. Keys stored encrypted as `ai_provider` connections. The model is typed in per connection, with no fixed list. **No streaming, no token counting** | `apps/api/src/services/ai-client.ts` |
| 7 | Memory | One list per person (`assistantMemories`). The AI saves facts itself, never secrets. The person can view and delete them | `assistant/service.ts`, `tools.ts` |
| 8 | Conversations | `assistantChats` + `messages` subcollection, owner-only | `repositories/firestore.ts` |
| 9–10 | Workflow engine | Full engine; run published workflows with permission checks | `packages/engine`, `services/execution-service.ts` |
| 11–12 | PMS | Separate read-only Firebase connection with a collection allow-list; date checks in Malaysia time (`dateFilter`) | `assistant/tools.ts`, `shared/dates.ts` |
| 13–15 | Browser | Playwright, locked to the saved website's domains; the server fills passwords and the AI never sees them; downloads | `assistant/browser.ts` |
| 16 | Approvals | Inside one chat only: risky tool → card → Approve/Deny. **Not central, no expiry, no edit, no levels** | `assistant/service.ts` (`pendingJson`) |
| 17 | Notifications | Only failure **emails** (Phase 4). **No in-app notifications** | `services/system-service.ts` |
| 18 | Sign-in | Firebase Auth; the server checks every request | `auth/` |
| 19 | Firestore | 15 collections, all accessed by the server only | §5 |
| 20 | Security rules | **Deny all browser access**: everything goes through the API | `firebase/firestore.rules` |
| 21 | APIs | `/api/assistant/*` and ~60 other routes | `routes/` |
| 22 | Background work | Redis + BullMQ queue, worker containers, durable cron schedules with one-run-per-occurrence keys. **But Assistant chats currently run inside the API process, not the worker** | `services/queue.ts`, `scheduler.ts`, `worker.ts` |

Roles today: `super_admin`, `admin`, `it_admin`, `department_manager`, `employee`. These already map to the brief's Admin, Department Manager and Employee roles.

There is also the **AI Agent workflow node** (`ai.agent`), which runs the assistant without a chat (`runHeadless`). Scheduled AI work can already be done with it today.

## 3. Reuse / extend / new

| Brief's service | Decision |
|---|---|
| AI Provider Service | **Extend** `ai-client.ts`: streaming, token usage, model list from each provider, price table for cost estimates |
| Tool Execution Engine | **Extend** `tools.ts` and `browser.ts`: each tool gets a **risk level (1–4)** and a **tool id**, and every call is logged. New tools: Sheets read/write, Gmail draft/send, web search, read uploaded file, read company knowledge, delegate |
| Persistent Task Queue / Worker | **Reuse** BullMQ + worker; add an `agent-tasks` queue. Chats move from the API process to the worker |
| Scheduler | **Reuse** the BullMQ job scheduler and schedule picker (`shared/schedule.ts`); add agent schedules |
| Audit Logger | **Reuse** `auditLogs` + Activity log page |
| Memory Service | **Extend**: memory gets an `agentId` (personal agent memory). New company knowledge and project memory |
| Agent Registry, Orchestrator (Main Manager), Task Planner, Approval Service, Notification Service, Analytics Service | **New** |

## 4. Architecture

```
 Browser (Vue)                     API (Express)                         Worker(s)
 ─────────────                     ─────────────                         ─────────
 AI Staff pages ── HTTPS ──▶ auth + role/department checks ──▶ Redis queue ──▶ Agent runner
       ▲                     agents / chats / tasks / approvals              │  load agent + memory + knowledge
       │                     knowledge / notifications                       │  AI provider (stream)
       └──── SSE stream ◀── live events (status, text, approvals) ◀── Redis ◀┤  tools (each checked + logged)
                                                                             │  ├ PMS (read-only)
                                     Scheduler (BullMQ cron) ──▶ queue ──▶   │  ├ workflows
                                                                             │  ├ browser (Playwright)
                                                                             │  ├ Sheets / Gmail / search
                                                                             │  └ delegate ▶ child task ▶ queue
                                                                             ▼
                                     Firestore (server only): agents, tasks, approvals, logs, usage…
```

How a chat message runs:
1. The API stores the message and creates a **task** with source *chat*.
2. The task is added to the queue and the API answers immediately.
3. A worker picks it up and streams events through Redis, then SSE, to the browser.

Schedules and the Main Manager create the same kind of task, so everything shows up in the Task Center.

## 5. Database plan (Firestore, automation project)

The new collections follow the existing camelCase naming. All are server-only, like the existing collections.

| Collection | Holds |
|---|---|
| `aiAgents` | Profile:
- name, avatar, title, department, instructions;
- provider connection and model, temperature, max tokens;
- tools and their levels;
- visibility (private / department / company), allowed users and roles;
- limits, budget, status. |
| `aiAgentChats` (+ `messages`) | Chats per agent per person |
| `aiTasks` (+ `logs`) | Every piece of work: source, status, parent task, project, priority, output, error, tokens. `logs` holds each step and tool call |
| `aiSchedules` | Agent, instructions, repeat rule, time zone (default Asia/Kuala_Lumpur), start/end, approval policy, budget, notify |
| `aiResponsibilities` | Long-term duties linked to schedules, with open issues |
| `aiApprovals` | Exact action + parameters + hash, level, requester, approver, expiry, single-use state, decision |
| `aiMemories` | Memory with `agentId` + `ownerId` (+ optional `projectId`) |
| `aiKnowledge` (+ `chunks`) | Company documents: who may read them, text split into searchable pieces |
| `aiProjects` | Shared context for agents working together |
| `aiNotifications` | In-app notices per person: read/unread |
| `aiUsage` | Tokens and estimated cost per agent per day |

**Migration (no data moved or deleted):**
- The existing Widebed Assistant becomes the built-in agent **`widebed-assistant`**.
- Old chats in `assistantChats` and old memories in `assistantMemories` stay where they are and keep working. They are shown as that agent's history.
- New chats with the Widebed Assistant go to the new collections.
- The AI Agent workflow node keeps working unchanged and can optionally point at an agent.

New Firestore indexes are needed for tasks, approvals and notifications. These are deployed with `firebase deploy --only firestore`, like before.

## 6. Security risks and how they're handled

| Risk | Protection |
|---|---|
| An agent gets more power by asking another agent | A delegated task runs with the **intersection** of: requesting person's rights ∩ parent agent's tools ∩ child agent's tools. Max depth 2, max 6 sub-tasks, a budget per request |
| Prompt injection (a web page or PMS text says "ignore your rules") | Tool results are wrapped as data and marked untrusted. Permissions are checked in code, not by the AI. Risky actions always go through the approval service |
| Approval replay or tampering | Approval stores a hash of tool + exact parameters. Single-use (atomic Firestore transaction). Expires (default 24 h). Rights are re-checked at execution. The approver can't be the requester's own agent. "Edit" creates a **new** approval, which must be confirmed |
| Private chats or instructions leaking | Every API checks owner, department and visibility on the server. Instructions are visible only to admins |
| Runaway costs | Max steps, max tokens and a daily budget per agent and per schedule. The agent pauses when the budget is reached and admins are notified |
| Duplicate scheduled runs | One job per occurrence (`schedule:<id>:<time>`) — same as workflow schedules today |
| Secrets in memory | Existing filter (passwords, IC, card numbers) also applied to knowledge and project memory |
| PMS writes | **No write tool exists.** The connection stays read-only |

## 7. Plan (each phase = one tested update zip)

| Phase | Delivers | Depends on you |
|---|---|---|
| **2 — Foundation** | AI Staff page (cards), create/edit/duplicate/disable/archive/delete agents. Agent workspace chat:
- multiple chats, search, markdown, code blocks;
- **real streaming**, stop, regenerate, copy;
- live tool steps.

Per-agent provider, model and tools. **Model list read from the provider.** Agent memory. Widebed Assistant migrated as an agent. Chats run on the worker | An AI key (Gemini is fine) |
| **3 — Access** | Private / department / company agents, allowed people and roles, department-manager rules, chat isolation tests | — |
| **4 — Daily work** | AI Staff Schedules page (reuses the time picker), responsibilities, Task Center (filters, pause/cancel/retry, details), in-app and browser notifications, retries and timeouts, follow-up tasks without duplicates | — |
| **5 — Approval Center** | Levels 1–4 on every tool, central Approval Center (Approve / Reject / Edit and resubmit), expiry, single-use, audit. Gmail draft → approve → send. Sheets write | Google connection (already have) |
| **6 — Main Manager** | Planner → sub-tasks → parallel or sequential agents → retry → combined report. Collaboration view (who asked whom, what came back) | — |
| **7 — Company Knowledge** | 7a ✅: Knowledge page (type or upload PDF/Word/Excel/text → text only), folders, who may read + which AI staff, keyword search tool, file attachments in chat. 7b ✅: photos in chat (vision) | — (no Firebase Storage: decided 17 Nov 2026) |
| **8 — Performance + going live** | Workforce Overview, AI Performance: success rate, time, tokens, cost per agent, model and department; daily/weekly/monthly reports. Security tests. Real-service test list (§23 of the brief) | Real accounts for testing |

All new pages use the existing Widebed look: light/dark, mobile, Guide button, and the motion system from update-7 (page transitions, skeletons, button spinners). New additions:
- a typing/streaming cursor;
- "working" pulses on agent cards;
- animated approval cards.

## 8. Where the build will differ from the brief (and why)

1. **Live updates come through the API (SSE), not Firestore listeners in the browser.** The platform denies all browser access to Firestore on purpose. Agent permissions are too detailed for security rules, so the API checks every record. It feels the same: real-time.
2. **Collection names** use the existing camelCase style (`aiAgents` instead of `agents/`).
3. **"Unlimited" agents** have no limit in the code. The real limit is AI cost, controlled with budgets.
4. **Browser notifications** work while the app is open in a tab. Notifications on a phone with the app closed need Firebase Cloud Messaging, so that's an extra later.
5. **"Test with real APIs"**: I can't reach your accounts from here. Each phase ships with automated tests using simulated services, plus a click-by-click test list for you with the real ones. Nothing in the app ever fakes a result: if a service isn't connected, it shows *Not connected*.

## 9. Decisions and accounts needed

1. **Where is the data for the Finance and HR agents?**
   - Attendance: in the PMS Firebase (the attendance app)? Which collection?
   - Utility bills: only on myTNB/websites, or also stored somewhere?
   - Expenses: PMS, Google Sheets, or accounting software?
2. **Web search:** needs a search service key. Options are Google Programmable Search (free tier), Brave Search or Tavily.
3. **File uploads** (knowledge docs, chat attachments): ~~Firebase Storage~~ not used (decided 17 Nov 2026). Only the text of files is kept, in Firestore.
4. **AI cost:** which model for the Main Manager, and roughly what monthly budget? Budgets and alerts will be set from this.

## 10. New environment variables (expected)

| Variable | For |
|---|---|
| `AI_TASK_CONCURRENCY` | How many agent tasks a worker runs at once (default 3) |
| `AI_TASK_TIMEOUT_MS` | Max time for one agent task (default 10 min) |
| `AI_MAX_DELEGATION_DEPTH` | Main Manager depth limit (default 2) |
| `WEB_SEARCH_PROVIDER`, `WEB_SEARCH_API_KEY` | Web search tool (optional) |
| ~~`FIREBASE_STORAGE_BUCKET`~~ | Not needed: no Firebase Storage (files are read, only text kept) |

Infrastructure: same as now, i.e. API + worker + Redis. Redis becomes **required** in production for AI Staff, because chats run on the worker. On a single PC it still works without Redis.

---

## 11. Progress

### Phase 2 — Foundation ✅ (17 Nov 2026, update-9)

**Features done**

AI Staff page (`/ai-staff`):
- employee cards: available / working / switched off, AI model, tools, chat count;
- search, archived view;
- **New AI employee** with 7 templates (Main Manager, PMS, Finance, HR, Operations, Marketing, Automation) or from scratch.

Agent editor (`/ai-staff/new`, `/ai-staff/:id/edit`):
- profile: avatar, colour, title, department, description;
- responsibilities, expertise, personality, writing style;
- admin-only instructions;
- AI service and **model list read live from the provider**, temperature (optional), max length, max steps;
- tools: memory, PMS, workflows, websites (all or chosen);
- visibility: company / department / private, roles, named people;
- switch on/off. Live preview.

Actions:
- duplicate, switch off/on, archive, delete (archived only);
- the built-in Widebed Assistant can't be archived or deleted.

Workspace chat (`/ai-staff/:agentId/chat/:chatId?`):
- **answers type out live** (provider streaming → SSE);
- markdown with tables and code blocks (with Copy);
- live tool steps, approval card, files, browser view;
- Stop, Copy, **Answer again** (regenerate);
- chat list with search, per-agent memory panel;
- right panel (job, tools it can use, expertise, memory).

Other:
- **Per-agent memory**: an AI employee only reads and saves its own memories.
- The **AI Agent** workflow step can now work as a named AI employee (new optional field).

**Database changes:**
- new collection `aiAgents` (server-only rule added in `firebase/firestore.rules`);
- `assistantChats` and `assistantMemories` get an optional `agentId`. Old documents have none and are treated as the Widebed Assistant's. **No data moved or deleted.**
- No new indexes.

**Changed from the plan:**
- Chats and memories stay in `assistantChats` and `assistantMemories` with an `agentId` field, instead of new `aiAgentChats` and `aiMemories` collections. It's less duplication, and old data needs no migration.
- AI employee chats still run in the **API process**, as before, and stream to the browser from there. Moving them to the worker queue belongs with background work, so it's in **Phase 4**: scheduled runs need the worker anyway, and then live events go through Redis.

**New permission:** `agent.manage` (Super Admin and Admin) to create and change AI employees.

**Tests:** `apps/api/test/aistaff.test.ts` has 12 tests:
- registry and access rules (department, private, roles, named people);
- identity, model and temperature reach the AI;
- streaming events;
- separate memory, regenerate, switch off / archive / delete, audit;
- model lists for 3 providers, the streaming parsers for 3 providers, the partial-JSON reader.

**Known limitations**
- Department managers can't yet manage "their" department's agents (Phase 3).
- No file or image attachments in chat yet (added later: files in Phase 7a, photos in Phase 7b).
- Token usage is counted per call but not stored or shown yet (Phase 8).
- Old `AssistantView.vue` was removed; `/assistant` links redirect to the Widebed Assistant's chat.

**Next:** Phase 3 — Access.

### Phase 3 — Access ✅ (17 Nov 2026, update-10)

**Features done**

**Managers of an AI employee** (`managerIds`, set by an Admin):
- e.g. the Finance head can change its avatar, colour, title, description, personality, writing style, responsibilities, expertise and **instructions**;
- they **can't** change its name, department, AI service or model, tools, visibility or allowed people, nor switch it off, duplicate or delete it;
- the server keeps only the allowed fields, whatever is sent.

**Who can chat with it now:**
- each person who has access, with the reason (Admin / department / added by name / manager / everyone);
- shown on the edit page to Admins and its managers.

**Chats are private to their owner**, also for Admins:
- read, follow (stream), send, regenerate, approve, stop and delete are all blocked for anyone else (404);
- losing access to an AI employee keeps your old chats readable but stops new messages.

**Instructions and access lists** are only returned to Admins and the AI employee's managers.

**Admin memory review** (edit page → "Show memory"):
- what an AI employee remembers about each person: correct or delete;
- viewing, editing and deleting are recorded (`memory.review`, `memory.edit`, `memory.delete`).

**People can correct their own memory** (pencil in the Memory window).

**Secret filter** on memory (`memorySecretProblem`), for both the AI's `remember` tool and manual adds and edits:
- refuses passwords, PINs/OTPs, Malaysian IC numbers, and card numbers (Luhn check);
- normal account numbers (e.g. 12-digit TNB) are allowed.

**Other:**
- Activity log: new "AI Staff" filter and plain-English labels for AI actions.
- Guides updated.

**Changes:**
- `aiAgents` documents get `managerIds` (older ones are read as `[]`, no migration);
- new APIs: `GET /api/agents/:id/access`, `GET /api/agents/:id/memories`, `PATCH /api/assistant/memories/:id`;
- no new collections, indexes or env vars.

**Tests:** `apps/api/test/aistaff-access.test.ts`, 11 tests:
- isolation for 3 other people (including an Admin) on every chat endpoint;
- disabled account; access removed; instructions hidden;
- department agent without a department;
- delegated-manager field limits and forbidden actions; access list;
- secret filter (also through the AI tool); own-memory edit; Admin review with audit.

**Known limitations**
- Department managers don't automatically manage their department's agents; an Admin names them. This is on purpose: it's explicit delegation, as the brief says.
- "Approve actions when granted permission" comes with the Approval Center (Phase 5). "View departmental tasks" comes with the Task Center (Phase 4).

**Next:** Phase 4 — Daily autonomous work:
- AI Staff Schedules;
- responsibilities;
- Task Center;
- chats and schedules running on the worker queue;
- in-app notifications.

### Phase 4a — Background tasks and schedules ✅ (17 Nov 2026, update-11)

**Features done**

**AI Tasks** (`/ai-tasks`), the Task Center:
- **Give a task** to any AI employee you may chat with. It runs in the background with *your* permissions, so you can close the app.
- List with filters: AI employee, Working/Done/Failed, given or scheduled, today only. Auto-refreshes while something runs.
- Detail panel: the task, every step, the result (markdown, Copy), files, error, time taken, tokens, whose permissions it used.
- **Stop** a waiting or running task; **Run again** a failed or cancelled one.

**AI Schedules** (`/ai-schedules`):
- Admins and the AI employee's managers can set it to repeat daily, weekly, monthly, once, or every N minutes/hours, in a chosen time zone (default Malaysia).
- Optional from/until dates, priority, on/off switch, **Run now**.
- Ideas per job (e.g. PMS Assistant 7:00 "Today's arrivals"). Shows the next run and how the last run went.

**Background engine:**
- Tasks go on their own queue (`wb-agent-tasks` in Redis, or in-process without Redis) and run on the worker.
- Schedules use the same durable scheduler as workflows (key prefix `ai-`), so they survive restarts and need no browser.
- **One task per occurrence**: the task id is a hash of schedule + occurrence, so a second firing is ignored.
- Automatic **retry once** for scheduled tasks when the AI service is busy or unreachable.
- **Timeout** (`AI_TASK_TIMEOUT_MS`, default 10 min).
- Tasks interrupted by a restart are marked failed with a clear message.
- **A task never reports success unless the AI really finished.** Errors are stored as they happened.
- Background runs **refuse risky actions** (workflows, risky clicks) because nobody can approve. The Approval Center (Phase 5) will hold them for a decision instead.

**Other:**
- The AI employee chat page links to its tasks and schedules.
- Activity log entries for tasks and schedules. Guides for both pages.

**Database:**
- new collections `aiTasks` (TTL on `expireAt`, the same retention as executions) and `aiSchedules`, both server-only;
- no composite indexes needed (lists are filtered in the server);
- **deploy with `firebase deploy --only firestore`** (rules + TTL + index exemptions).

**Env (optional):** `AI_TASK_CONCURRENCY` (3), `AI_TASK_TIMEOUT_MS` (600000).

**Tests:** `apps/api/test/aistaff-tasks.test.ts`, 12 tests:
- task run with steps and tokens; access to give; who sees which tasks;
- stop and run again; AI failure stored honestly; inactive account;
- schedule permissions and validation; registered with the scheduler;
- one task per occurrence; automatic retry; start/end dates; run now;
- disabled AI employee; delete; resync after restart.

**Still in Phase 4b:**
- in-app notifications (bell), plus browser notifications;
- long-term responsibilities with follow-up tasks, without duplicates;
- moving **chats** to the worker queue (tasks already run there).

### Phase 4b — Notifications and responsibilities ✅ (17 Nov 2026, update-12)

**Features done**

**Notifications (the bell)** at the top of the menu (and in the mobile header):
- unread count, list, mark read / mark all read; clicking opens the task or responsibility;
- refreshed every 30 s and when the tab comes back.

Who is told what (only people who can already see the task):
- **One-time task:** done or failed → the person who gave it.
- **Schedule:** per schedule, "Tell me": only on failures (default), every run, or never. Goes to the schedule's owner and the AI employee's managers.
- **New problem found by a responsibility:** the same people.

**Preferences** (Settings → Notifications, per person):
- done / failed / new problems;
- **browser pop-up notifications** while the app is open (asks the browser for permission).

**Long-term responsibilities** (AI Schedules → Responsibilities tab):
- e.g. "Monitor outstanding utility bills", linked to one or more schedules of the same AI employee;
- pause / resume (its schedules then wait), edit, delete (schedules stay).

**How problem tracking works:**
- each linked run is asked to end with an `issues` block (`stable-id | problem`); it's taken off the shown result and stored on the task;
- **new problems** are added, notified, and (if switched on) get **one follow-up task** each;
- the same problem in later runs only counts up ("seen in 3 runs"), so **no duplicate follow-ups**;
- at most 3 follow-ups per run, and follow-ups never create more follow-ups;
- problems no longer reported move to "recently solved", and a person can also press **Sorted**.

**Task Center:**
- shows "Problems it reported", follow-up tasks and their parent;
- new filter "Follow-ups of problems".

**Database:**
- new `aiNotifications` (TTL 60 days via `expireAt`) and `aiResponsibilities`, both server-only;
- `aiSchedules` get `notify` and `responsibilityId`; `aiTasks` get `responsibilityId`, `parentTaskId` and `issues`;
- no composite indexes. **Deploy with `firebase deploy --only firestore`.**

**Tests:** `apps/api/test/aistaff-4b.test.ts`, 7 tests:
- reading the issues block;
- notification to the giver with link; read isolation; preferences; failure-only schedule notices to owner and managers;
- responsibility permissions and schedule linking;
- open / seen-again / solved tracking with one follow-up per new problem;
- manual "Sorted", pause, delete.

**Decision: chats stay in the API process.**
- Background work (tasks, schedules, follow-ups) runs on the worker queue.
- Chats need a person watching (live typing, approvals), and run fine in the single API server.
- Moving them to the worker only matters with several API servers. It is moved to **Phase 8 (production hardening)** instead of adding risk now.

**Next:** Phase 5 — Approval Center:
- risk levels 1–4 on every action;
- approvals that can wait for a person (also for background tasks): approve / reject / edit, expiry, single-use.

### Phase 5 — Approval Center ✅ (17 Nov 2026, update-13)

**Features done**

**Risk levels on every action:**

| Level | What it covers | How it's handled |
|---|---|---|
| 1 · Read only | Look-ups | Never asks |
| 2 · Low risk | Typing into a website form | Follows the Admin policy (default: automatic in chats, ask in background) |
| 3 · Sensitive | Running a workflow; website clicks like Submit / Send / Confirm / Save | Always asks |
| 4 · Critical | Pay, Delete, Cancel, Transfer | See "Level 4 rules" below |

**Level 4 rules:**
- only Admins or the AI employee's **named approvers** can approve;
- the approver must type **APPROVE**;
- the request expires within 2 hours;
- Admins get a bell notice.

**Approvals page** (`/ai-approvals`):
- **Waiting** and **History** tabs;
- each card shows the AI employee, risk level, chat or task, what it will do, the **exact parameters**, why it asked, and the time left;
- **Approve**, **Reject** (optional note), and **Edit**: change the parameters, which makes a *new* request that must be confirmed, and closes the old one as "Edited";
- Admin rules box: the low-risk policy and the expiry time (1 h – 3 days).

**Chats:**
- the approval card shows the risk level and expiry, with a link to the Approval Center;
- level 4 asks for the APPROVE word;
- a decision made in the Approval Center continues the chat;
- sending another message instead withdraws the request.

**Background tasks:**
- a task now **waits** (status "Needs approval") instead of refusing;
- when approved it **continues where it stopped** with exactly the approved parameters; when rejected it continues without the action;
- when the request expires the task fails with "Nothing was done";
- stopping a waiting task withdraws its request.

**Agent editor:** "Approvers" list (Admin only).

**Notifications:** "needs approval" goes to the person it runs for (in background tasks), the named approvers, and Admins (critical). "Approved / Not approved" goes to the requester. Both can be switched off in Settings.

**Security** (all on the server):
- **Bound to the exact action:** each approval stores sha256(tool + canonical parameters). The gate only lets that action run, in that chat or task.
- **Single use:** pending → decided is an atomic transaction (two people can't both decide), and the action can run once (`usedAt`, also atomic).
- **Expiry** is checked on every decision and every minute by the worker. An expired request is never executed.
- **Who decides:**
  - the person it runs for, up to level 3, and they can always reject their own request;
  - named approvers and Admins, at any level;
  - AI employees can never decide.
- **Edits** create a new request and must be confirmed. The waiting chat or task switches to the new one.
- **Permissions checked again:** when work continues, the tools are rebuilt for the person it runs for, so e.g. running a workflow checks their access again.
- **Every decision, edit and policy change is in the Activity log** (`approval.approve`, `approval.reject`, `approval.edit`, `approval.policy`), including the parameter hash.

**Database:**
- new `aiApprovals` (server-only);
- `aiTasks` get `approvalId`, `transcriptJson`, `resume`, and the status `waiting_approval`;
- `settings/system` gets `ai.lowRiskPolicy` and `ai.approvalHours`.

**Tests:** `apps/api/test/aistaff-approvals.test.ts`, 10 tests:
- chat request recorded with hash; visibility; decided by a named approver in the center continues the chat; single use;
- withdrawn by a new message;
- background task waits and continues (workflow ran once); reject continues without it;
- edit and confirm uses the new parameters; expiry does nothing; stop withdraws;
- level 4 rules; the exact-action, one-time gate; the low-risk policy, which survives saving the alert settings.

**Known limits:**
- When a background task waited for a **website** click, its browser session closed meanwhile. On approval it opens the site again and repeats the steps; the approval still covers only that exact click.
- Workflow AI Agent steps keep their own "May act without approval" switch and don't wait.

**Next:** Phase 6 — Main Manager: plan → delegate to several AI staff (in parallel or in order) → combine.

### Phase 6 — Main Manager ✅ (17 Nov 2026, update-14)

**Features done**

**Manager AI employees.** The Main Manager template (or the "Manager" switch in the editor, Admin only) gets two tools:
- `list_team`: the colleagues this person may use, with their job, skills, and what they can use under this manager.
- `delegate`: hands parts to colleagues and waits for the results.
  - Independent parts run **at the same time** (max 3).
  - `after` makes a part **wait** for earlier parts and gives it their results ("Results from your colleagues…": hand-off and shared project context).
  - The manager then checks the results against each other and writes **one combined answer**.

This works in chats (live steps like "Fixer finished (2/3)") and as a background task or schedule.

**Collaboration page** (`/ai-collaboration`):
- each request shown as a plan, left to right (start now → waits for…);
- statuses; click a part to see exactly what it was asked and what it found;
- links to AI Tasks and Approvals.

**Task Center:** parts show as "part of team work", with their own filter.

**Safety** (all enforced by the server, not the AI):
- **Who can be a helper:** AI staff the *person* may use, switched on, and not managers themselves. The manager can't pick itself.
- **No added permissions:** a helper works with the person's permissions **and** only the tools the manager has (e.g. the manager has no website tool → helpers can't use websites). This also limits websites.
- **No loops:** helpers can't delegate (depth 1). `after` may only point to earlier parts.
- **Budgets:**
  - at most 6 parts per hand-off and 2 valid hand-offs per request (the second one is for retrying failures);
  - 3 working at once;
  - the normal step and token limits of each helper.
- **Stop** the manager and its helpers stop too.
- **Failed input:** a part whose input failed is skipped with a clear reason, and the manager is told.
- **Approvals:** risky steps by helpers still go to the Approval Center. The manager is told a part is waiting.
- **Notifications:** helpers don't send their own notices; the manager's result is announced as usual.

**Database:**
- new `aiProjects` (server-only);
- `aiTasks` get `projectId`, `dependsOn`, `toolLimit` and source `delegation`;
- `aiAgents` get `canDelegate`.

**Tests:** `apps/api/test/aistaff-manager.test.ts`, 7 tests:
- team selection (not itself, not other managers, not unavailable staff);
- parallel + dependent parts with hand-off and combined report; project record and visibility;
- tool intersection (no workflow tools via a manager without them) and no further delegation;
- refusals (unavailable colleague, more than 6 parts, bad `after`, another manager, the third hand-off);
- failed input skips the dependent part; stopping the manager stops helpers;
- the manager as a background task (helpers linked to it, no duplicate notices).

**Also fixed:** background runs now respect an AI employee's chosen website list (by id or name).

**Next:** Phase 7 — Company Knowledge:
- a Knowledge page with documents and uploads, and per-document access;
- permission-aware search for AI staff;
- project memory;
- file attachments in chat.

~~Needs Firebase Storage~~ — decided: **no Firebase Storage**. Only extracted text is kept.

### Phase 7a — Company Knowledge ✅ (17 Nov 2026, update-15)

**Decision:** no Firebase Storage. Uploaded files are read on the server, their **text** is kept in Firestore, and the file is thrown away. Keep originals in your own drive.

**Features done**
- **Company Knowledge page** (`/knowledge`, nav "Company Knowledge"):
  - folders, document cards (who reads it, which AI uses it, size, source file name);
  - open to read the full text; Admins add / edit / remove;
  - add by typing/pasting or **from a file** (PDF, Word .docx, Excel .xlsx, txt/md/csv/json/html, max 10 MB): the text is shown for checking before saving;
  - **"Try a search"** (optionally "as" one AI employee) shows exactly what the AI would find.
- **Access per document:** readers = everyone, or departments and/or roles; AI staff = all, or a chosen list.
- **AI tools** `search_knowledge` and `read_knowledge` (risk level 1, read only). Only offered when there is at least one document for this person and this AI. The AI is told to search before answering company questions and never invent a policy.
- **AI employee switch** "Company Knowledge" (on by default, also for existing AI staff). Manager helpers only get it if the manager has it.
- **Chat attachments (📎):** up to 3 files per message; their text (max 40k characters in total) goes to the AI for that conversation; the chat shows file chips; the message keeps only the name and size. Old attachment text is dropped first when a chat gets very long (Firestore 1 MB limit).
- **Document reader without extra packages** (`apps/api/src/services/text-extract.ts`): docx/xlsx (zip + XML), PDF (objects, object streams, Flate/ASCII85/ASCIIHex, fonts with ToUnicode maps, hex strings, letter-by-letter layouts). Tested on PDFs from reportlab, LibreOffice and Chrome "Save as PDF". Scanned PDFs get a clear message.

**Security**
- Every list / open / search checks the reader rules on the server. An AI only finds documents that it may use **and** the person it works for may read (same for background tasks: the task's owner).
- Only Admins (`knowledge.manage`: Super Admin, Admin) add, change, remove or upload. All changes are in the Activity log.
- Firestore rules deny all client access to `aiKnowledge` and its `knowledgeChunks`.

**Database**
- `aiKnowledge/{docId}`: title, folder, audience, agentIds, size, preview, source file name (no file).
- `aiKnowledge/{docId}/knowledgeChunks/{nnnn}`: ~1500-character text pieces + their search words (`terms`).
- Index: `knowledgeChunks.terms` array-contains (collection group); `text` excluded from indexing. In `firestore.indexes.json`.
- Search: Firestore finds pieces sharing words with the question (`array-contains-any`), then the server ranks them (BM25: rare words count more, short focused pieces win, title words get a bonus).

**Tests:** `apps/api/test/knowledge.test.ts`, 16 tests: PDF reading (font maps), clear errors, chunking, upload endpoint (text only, Admin only), Admin-only changes, department-only documents hidden in list/open/search, ranking, edit rebuilds pieces / delete removes them, AI search in chat, per-AI documents, person-based filtering, switch off, chat attachments (AI gets text, chat stores only the name), file-only messages, transcript trimming. **206 tests pass.**

**Limits**
- Search is by **words**, not meaning: "check-in" finds "check-in", not "arrival time". Use clear titles and the words staff use. (Meaning search needs an embeddings service; possible later.)
- Scanned PDFs, images, old .doc/.xls and PowerPoint are not read.
- Very unusual PDF fonts (no ToUnicode map) may give unreadable text — the reader then says so and asks to paste the text.
- Project team notes for manager helpers were not added (helpers already receive earlier results through `after`).

**Next:** Phase 7b — images in chat (photos of damage, receipts) for AI services that can see images; then Phase 8.

### Phase 7b — Photos in chat ✅ (17 Nov 2026, update-16)

**Features done**
- 📎 in every chat now also takes **photos** (JPG, PNG, WebP, GIF; iPhone HEIC where the browser can open it), and **pasting a screenshot** works too. Up to 3 photos per message.
- The browser **shrinks** each photo first (longest side 1600 px, JPEG, under 700 KB) — a 6 MB phone photo becomes ~300 KB.
- Photos show in the chat as thumbnails; click for full size.
- The AI **sees** the photos: OpenAI (`image_url`), Claude (`image` blocks) and Gemini (`inline_data`). It looks at the **4 newest photos** of the chat on every answer, so follow-up questions ("is it urgent?") still work. It is told to describe only what is really visible.
- If the chosen model can't see pictures, the chat says so in plain words and names models that can.

**No Firebase Storage:** photos are kept compressed inside the chat in Firestore: `assistantChats/{chatId}/images/{imageId}` (base64, each < 1 MB). Deleted together with the chat.

**Security**
- Only the chat's owner can upload to it or open its photos (others get 404).
- The file type is checked from the bytes (JPEG/PNG/WebP/GIF signatures), not the name — SVG and other files are refused. Served with `nosniff`.
- A photo can only be sent with one message, and only in the chat it was uploaded to.
- Limits: 700 KB per photo, 3 per message, 40 per chat.
- Firestore rules deny client access; `images.data` is excluded from indexing.

**Tests:** `apps/api/test/photos.test.ts`, 7 tests: type/size recognition, the three AI formats, "can't see pictures" message, owner-only upload and viewing, AI receives the photo with the message and on follow-ups, one message per photo, other chat refused, photo-only messages, non-photos and oversize refused, newest-4 limit, delete with the chat. **213 tests pass.**

**Limits**
- Photos are for **chats**. Background tasks and schedules don't take photos.
- Each photo is sent to the AI service again with every answer in that chat (up to 4) — this costs tokens. Start a new chat for a new topic.
- Manager helpers (delegation) don't see the photos; the manager describes what matters in the task it hands out.

**Next:** Phase 8 — performance dashboard (success rate, time, tokens and cost per AI employee), chats on the worker, security review and the real-service test list.

### Phase 8 — AI Performance and the go-live test list ✅ (17 Nov 2026, update-17)

**Features done**
- **Every AI call is counted** (chats, tasks, schedules, team-work parts) per day (Malaysia time) × AI employee × model: calls, tokens in, tokens out. Counting never slows or breaks an answer.
- **AI Performance page** (`/ai-performance`): today / 7 / 30 / 90 days.
  - Tiles: tasks done, success rate (done ÷ done + failed), average time, AI calls and tokens, estimated cost.
  - Chart: AI tasks per day (done / failed striped / other), with "Show numbers".
  - Tables: by AI employee (tasks, success bar, average time, calls, tokens bar, cost), by department, by model.
- **Model prices (Admins):** USD per 1 million tokens, entered from the provider's price page. A name also covers dated versions. **No prices are built in** (they change often), so cost shows "—" until a price is set, and "≥" when only part of the usage has a price. Models used without a price are listed for one-click adding.
- **Who sees it:** Admins (and Activity-log viewers) everything; department managers their own department's AI staff; employees not at all (menu item hidden, API refuses).
- **Full system test checklist** (Claude Docs "Widebed AI Staff — Full System Test Checklist"): 12 parts, ~90 steps, 5 test accounts, results log.

**Database:** new `aiUsage/{day}_{agentId}_{model}` (server-only; counters added with Firestore increments). Prices in `systemSettings/aiPrices`. No new indexes.

**Tests:** `apps/api/test/performance.test.ts`, 4 tests: price matching and cost, real chat + task counts (success rate, tokens, per-model, per-day), cost after setting prices, department-manager scope and employee refusal. **217 tests pass.**

**Decisions and limits**
- **Chats stay in the API process** (not moved to the worker). With one API server this is safe and simpler; moving them only matters when running several API servers. Background work already runs on the worker.
- Usage counting starts with this update; earlier chats are not in the numbers. AI calls from plain workflow AI steps (not AI staff) are not counted here.
- Cost is an estimate; the provider's bill is the real amount.

**Security review (summary)**
- Every new endpoint checks the signed-in person on the server: knowledge reader rules, chat ownership for photos, Admin-only prices and uploads to Company Knowledge, scope for performance.
- Firestore rules deny all browser access to every AI collection (`aiAgents`, `aiTasks`, `aiSchedules`, `aiResponsibilities`, `aiNotifications`, `aiApprovals`, `aiProjects`, `aiKnowledge` + chunks, `aiUsage`, chat `images`).
- Uploaded files are checked by content (photos by their byte signature; documents parsed as text), size-limited, and never stored as files.
- PMS has no write tool; passwords never reach the AI; risky actions go through the Approval Center.
- Still to verify with real services: the checklist above (AI providers' vision formats, real PMS data, real websites, phones).
