# Going live — deployment checklist

Tick these off in order when moving Widebed Automation from Crane's PC to a real server.
Each step says **how to check it worked**. Don't skip the checks.

## A. Before you start

- [ ] A small Linux server (2 vCPU, 4 GB RAM is plenty to start), Docker + Docker Compose installed.
- [ ] A domain name, e.g. `automation.widebed.com`, with its DNS **A record** pointing to the server's IP.
  *Check:* `ping automation.widebed.com` answers from the server's IP.
- [ ] Ports 80 and 443 open in the server firewall (nothing else needs to be open).
- [ ] A **backup** of the workflows from the PC: Settings → Backup and restore → *Download backup*.

## B. Firebase (project `widebed-automation`)

- [ ] Authentication → Settings → **Authorized domains**: add `automation.widebed.com`.
- [ ] Deploy rules, indexes and TTL policies from the project folder:
  `npx firebase-tools deploy --only firestore --project widebed-automation`
  *Check:* Firestore → Indexes shows all indexes as **Enabled** (can take a few minutes).
- [ ] Service-account key (`secret/…json`) copied to the server **outside the git folder**, `chmod 600`.

## C. Google sign-in for Gmail / Sheets

- [ ] Google Cloud console → APIs & Services → Credentials → your OAuth client →
  *Authorised redirect URIs*: add `https://automation.widebed.com/oauth/google/callback`.
- [ ] OAuth consent screen: while it is **Testing**, connections stop working after 7 days.
  Publish the app (or use an Internal app on Google Workspace) before relying on scheduled emails.

## D. Configure and start

```bash
git clone … widebed-automation && cd widebed-automation
cp .env.example .env            # fill in EVERY value (see below)
mkdir -p secrets && cp /secure/place/sa.json secrets/firebase-service-account.json
chmod 600 secrets/firebase-service-account.json
docker compose up -d --build
```

Values in `.env` that are easy to get wrong:

| Setting | Must be |
|---|---|
| `DOMAIN`, `PUBLIC_BASE_URL`, `CORS_ORIGINS` | your real address, `https://…`, no trailing `/` |
| `ENCRYPTION_KEY` | **the same key as on the PC** if you copy connections; otherwise a new one (`openssl rand -base64 32`). Keep a copy in a password manager — without it, saved connections can't be read. |
| `REDIS_PASSWORD` | a long random password |
| `SUPER_ADMIN_EMAILS` | `neokahoong.widebed@gmail.com` |
| `VITE_FIREBASE_*` | from Firebase console → Project settings → Your apps |

- [ ] *Check:* `docker compose ps` shows `api`, `web`, `worker`, `redis` as **running**.
- [ ] *Check:* `https://automation.widebed.com/healthz` shows `{"status":"ok"}` with a padlock (HTTPS).
- [ ] *Check:* sign in, Overview → **System health** says *Operational*, queue mode **bullmq**.

## E. After the first sign-in

- [ ] Credentials: reconnect Google (support@widebed.com) and press **Test**.
- [ ] Credentials: add the PMS Firebase connection **read-only**, only the collections you need.
- [ ] Settings → Backup and restore → **Restore from backup** (the file from step A). Open each restored
  workflow, pick its connections, press **Test run**, then **Publish** and switch it on.
- [ ] Settings → **Failure alerts**: pick the Google account, add your email, **Send test email**, switch on, Save.
- [ ] Run one real workflow end to end and check it on the Executions page.
- [ ] Schedules page lists every scheduled workflow with the right *next run* time (Malaysia time).

## F. Keep it healthy

- [ ] Download a backup once a month and before big changes (Settings → Backup).
- [ ] Update: `git pull && docker compose up -d --build` (running jobs get 30 s to finish).
- [ ] More capacity: `docker compose up -d --scale worker=3`.
  Note: each worker has its own alert cooldown, so with 3 workers you may get up to 3 alert emails for the same workflow per cooldown period.
- [ ] Assistant browser (optional): build the API with `docker/api-browser.Dockerfile` and set `ASSISTANT_BROWSER=true`.
- [ ] Look at the **Activity log** page now and then — it shows who changed what.

## G. Schedules on Vercel (free timer)

Vercel pauses the API when nobody uses the app, so Schedule Triggers don't fire by themselves.
An outside timer wakes it up and starts whatever is due.

1. Make a secret (at least 24 characters), e.g. `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.
2. Vercel → project → Settings → Environment Variables → add `CRON_SECRET` = that secret (Production). Redeploy.
3. Check it: open `https://<your-domain>/cron/run-schedules?key=<secret>` → you see `{"ok":true,...}`.
4. [cron-job.org](https://cron-job.org) (free) → Create cronjob:
   - URL: `https://<your-domain>/cron/run-schedules?key=<secret>`
   - Schedule: every 5 minutes
   - Time zone: Asia/Kuala_Lumpur (only matters for the history view)
   - Turn on "notify on failure".
5. Leave `REDIS_URL` empty on Vercel (without a worker, Redis would only queue the runs).

How it behaves:
- Each call starts the latest occurrence of every active schedule if it was due in the last
  `CRON_CATCHUP_MINUTES` (default 180) and has not run yet. A daily 9:00 AM workflow runs at 9:00–9:05.
- Each occurrence runs **once**, however often the link is called.
- Occurrences from before the workflow was (re)published are skipped.
- The call waits up to `CRON_WAIT_SECONDS` (default 240) for the runs to finish, so Vercel keeps
  the function alive. cron-job.org may show a "timeout" for long runs; the run still finishes.
- AI Staff schedules are not covered (they need the always-on worker).

## If something goes wrong

| What you see | What to do |
|---|---|
| Browser says "not secure" / certificate error | DNS doesn't point to the server yet, or ports 80/443 are closed. Fix, then `docker compose restart web`. |
| Sign-in pop-up closes with an error | Domain missing from Firebase **Authorized domains** (step B). |
| "requires an index" / 503 on a page | Indexes not deployed or still building (step B). |
| Gmail: "access was revoked or expired" | Credentials → Reconnect. If it happens every 7 days, publish the OAuth app (step C). |
| Runs stay "Queued" | `docker compose logs worker` — usually Redis password mismatch. |
