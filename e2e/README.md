# Browser end-to-end check (dev only)

Drives the real UI in Chrome against the real API (in-memory storage). Firebase sign-in
endpoints are stubbed in the browser, so no Firebase project is needed.

```bash
pip install playwright && playwright install chromium
npm run build:packages
npx tsx apps/api/test/e2e-harness.ts &                 # API on :4000
VITE_FIREBASE_API_KEY=test-key VITE_FIREBASE_AUTH_DOMAIN=localhost \
VITE_FIREBASE_PROJECT_ID=demo-widebed VITE_FIREBASE_APP_ID=1:1:web:1 \
  npm run build -w apps/web && npx vite preview apps/web --port 4173 &
python3 e2e/run.py                                     # screenshots in e2e/shots/
```

Covers: sign-in, create workflow, drag/connect nodes, configure HTTP + IF, undo/redo,
save, test run with live status, publish, activate, webhook URL issuance, external webhook
call with idempotency, executions list/detail, dark mode.

`python e2e/phase2.py` (same setup) covers Phase 2: event-source key, Firebase connection with
collection allow-list, a workflow using Code → Switch → Firebase Create / Wait / Loop, workflow
settings, the Schedules page and the Executions list.
