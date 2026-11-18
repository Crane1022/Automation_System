# Widebed Automation

Widebed's own self-hosted workflow automation platform: a visual builder (similar in spirit
to n8n / Make / Zapier), a real execution engine, and live run monitoring. Firestore is the
database; all execution runs in our own Node.js services.

**Status: Phases 1 and 2 complete.** See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
design, the Firestore schema, the API, the workflow JSON format, the security model and
the phase plan.

| | |
|---|---|
| Frontend | Vue 3, TypeScript, Vite, Pinia, Vue Router, Tailwind CSS 4, Vue Flow, Lucide |
| Backend | Node.js 22, Express, TypeScript, Server-Sent Events |
| Data / auth | Cloud Firestore, Firebase Authentication, Firebase Admin SDK |
| Deploy | Docker Compose, Caddy (automatic HTTPS) |
| Queue | Redis + BullMQ, separate worker processes |

---

## Local development

Requirements: Node.js 20+ (22 recommended), a Firebase project (a separate one for
automation is recommended — see “Sharing a Firebase project” below).

```bash
npm install
cp .env.example apps/api/.env          # fill in (see below)
cp apps/web/.env.example apps/web/.env # Firebase web config
```

1. **Firebase console**
   - Authentication → Sign-in method → enable **Email/Password**.
   - Authentication → Settings → User actions → **untick “Enable create (sign-up)”**.
     Only administrators add people (Users & Permissions → *Invite user*).
   - Authentication → Users → add **your own** account once (the first super admin).
   - Project settings → Service accounts → *Generate new private key*. Save it **outside the
     repo** or in `secrets/` (git-ignored). Never commit it.
   - Project settings → General → add a Web app and copy its config into `apps/web/.env`.
2. **API env** (`apps/api/.env` or exported variables):
   ```bash
   FIREBASE_PROJECT_ID=your-project
   GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
   ENCRYPTION_KEY=$(openssl rand -base64 32)
   SUPER_ADMIN_EMAILS=you@widebed.com
   CORS_ORIGINS=http://localhost:5173
   PUBLIC_BASE_URL=http://localhost:5173
   HTTP_ALLOW_PRIVATE_NETWORKS=true   # dev only, lets workflows call localhost
   ```
3. **Deploy rules and indexes** (once): `npx firebase-tools deploy --only firestore --project your-project`
4. **Run**
   ```bash
   # terminal 1 — API on :4000 (loads env from your shell)
   set -a; source apps/api/.env; set +a
   npm run dev:api
   # terminal 2 — web on :5173 (proxies /api and /hooks to :4000)
   npm run dev:web
   ```
5. Sign in with the email listed in `SUPER_ADMIN_EMAILS`. Add everyone else from
   **Users & Permissions → Invite user**: their account is created with the role you pick and
   Firebase emails them a link to set a password. (Accounts added directly in the Firebase
   console show up as *pending* until you activate them.)

### Redis and the worker (Phase 2)

Without `REDIS_URL` the API runs everything itself (fine for trying things out). To develop the
real setup on Windows with Docker Desktop:

```powershell
docker run -d --name widebed-redis -p 6379:6379 --restart unless-stopped redis:7-alpine
```
Add `REDIS_URL=redis://localhost:6379` to `apps/api/.env`, then run the API and a worker:
```powershell
npm run dev:api      # terminal 1 — set PROCESS_JOBS=false in .env to make it queue-only
npm run dev:worker   # terminal 2 — runs executions and schedules
npm run dev:web      # terminal 3
```

### Gmail (Google OAuth)

1. Google Cloud console (same project as Firebase is fine) → **APIs & Services → Library** → enable **Gmail API** and **Google Sheets API**.
2. **OAuth consent screen** → User type **Internal** (Google Workspace) → add scopes `gmail.send`, `gmail.modify`, `spreadsheets`.
   (With **External** + test users, Google expires the connection after 7 days until the app is verified.)
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorised redirect URI: `<PUBLIC_BASE_URL>/oauth/google/callback` (e.g. `http://localhost:5174/oauth/google/callback`).
4. Put the client ID and secret in `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`, restart the API,
   then **Credentials → Google account**. Connections made before Google Sheets existed show a hint:
   click **Reconnect** (same account) to add the Sheets permission. Share each sheet with that account.

### AI services (optional)

Credentials → **AI service** (or Integrations → OpenAI / Claude / Gemini). Paste an API key from the AI
company; a tiny test message checks the key and model before anything is saved. Set a monthly spending
limit in the AI account — every item that passes an AI step is one paid request.

### Widebed Assistant (chat bot)

1. Connect an AI service (above) and, for PMS questions, a **read-only** Firebase connection to the PMS.
2. AI Agents page → **Widebed Assistant**: choose them, tick *Switch on*, Save. Everyone then has **Assistant** in the menu.
3. Optional **browser** (for websites like myTNB):
   - On your PC (PowerShell, in the project folder):
     ```powershell
     npm install playwright -w apps/api
     npx playwright install chromium
     ```
     then restart the API. Save the website on Credentials → **Website login** and tick *Let the assistant use a web browser*.
   - On the server: build the API/worker with `docker/api-browser.Dockerfile` (Debian + Chromium) instead of `api.Dockerfile`.
   - Without these steps the assistant still works; its browser tools just say the browser is not installed.

### Tests

```bash
npm test          # engine, nodes, API (auth, RBAC, publish, webhooks, credentials, code sandbox, schedules, events…)
npm run typecheck # backend + frontend
```

With Redis running, also test the production queue (API and worker as separate processes):
```powershell
$env:REDIS_URL="redis://localhost:6379/15"; npm test; Remove-Item Env:REDIS_URL
```

To also run the repository contract tests against Firestore, start the emulator:
`npx firebase-tools emulators:exec --only firestore "npm test"`.

---

## Production deployment (self-hosted Linux)

**Step-by-step checklist: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).** Short version:

```bash
git clone … && cd widebed-automation
cp .env.example .env                        # fill in every value
mkdir -p secrets && cp /secure/place/sa.json secrets/firebase-service-account.json
chmod 600 secrets/firebase-service-account.json
docker compose up -d --build
```

- Point DNS for `DOMAIN` to the server; Caddy obtains HTTPS certificates automatically.
- Deploy Firestore rules, indexes and TTL policies: `npx firebase-tools deploy --only firestore`.
- Health: `https://DOMAIN/healthz` (liveness) and the **System health** card on Overview.
- Upgrade: `git pull && docker compose up -d --build`. Running executions get up to 30 s to
  finish; in Phase 1 anything still queued is marked “Interrupted by a server restart”.

### Sharing a Firebase project with PMS/TMS
A dedicated Firebase project is simplest and keeps the platform independent. If you must
reuse the PMS/TMS project, do **not** deploy `firebase/firestore.rules` as-is (it would
replace their rules). Copy the `match` blocks for the automation collections into the
existing rules file instead. Collection names don't overlap with typical PMS/TMS names,
but check before deploying.

---

## Import / export

- **Export**: editor toolbar ⤓, or Workflows → ⋯ → *Export (.json)*. The file contains the draft, never secrets.
- **Import**: Workflows → *Import* → choose a `.json` exported from here **or from n8n**. A new inactive
  workflow is created and a report lists converted nodes, nodes that need replacing (e.g. Google Sheets
  until Phase 3), nodes that need a connection, and expressions to check.
- n8n conversion lives in `apps/api/src/services/workflow-transfer.ts` (one `case` per n8n node type).

## Adding a node

1. Create `packages/nodes/src/nodes/your-node.ts` using `defineNode({ descriptor, configSchema, execute })`.
2. Register it in `createDefaultRegistry()` in `packages/nodes/src/registry.ts`.
3. Add tests in `packages/engine/test/`.

The palette, settings form, validation and docs tab pick it up automatically.
