/**
 * In-app guides: one per page, opened with the "Guide" button next to the page title.
 * Written for non-technical staff: short steps, plain words, and a real example for
 * each situation. Edit the text here — no code changes are needed elsewhere.
 */

export interface GuideExample {
  title: string;
  /** Shown as a list of steps or lines. */
  lines: string[];
}

export interface GuideSection {
  title: string;
  text?: string;
  steps?: string[];
  example?: GuideExample;
  tip?: string;
}

export interface Guide {
  title: string;
  summary: string;
  sections: GuideSection[];
}

export type GuideKey =
  | 'overview'
  | 'workflows'
  | 'editor'
  | 'executions'
  | 'executionDetail'
  | 'credentials'
  | 'schedules'
  | 'users'
  | 'settings'
  | 'integrations'
  | 'aiAgents'
  | 'templates'
  | 'assistant'
  | 'aiStaff'
  | 'aiTasks'
  | 'aiSchedules'
  | 'aiApprovals'
  | 'aiCollaboration'
  | 'knowledge'
  | 'aiPerformance'
  | 'activity';

export const GUIDES: Record<GuideKey, Guide> = {
  overview: {
    title: 'Overview',
    summary: 'A quick health check of all your automations.',
    sections: [
      {
        title: 'What you see here',
        steps: [
          'Runs per day: green bars worked, red striped parts failed. Point at a bar for the exact numbers, or press “Show numbers” for a table.',
          'Success rate: how many finished runs worked. 100% means nothing failed.',
          'Running jobs: workflows working right now, and how many are waiting in line.',
          'Recent activity: the latest runs. Click one to see every step.',
          'System health: shows whether the server and database are working.',
        ],
      },
      {
        title: 'When something is red',
        text: 'A red “Failed” badge means a run stopped with an error.',
        steps: ['Click the run in Recent activity.', 'Open the red step to read the error.', 'Fix the workflow (or the connection), then press Retry.'],
        example: {
          title: 'Example',
          lines: ['“Tenant Reminder” failed at “Send email”.', 'Error: “choose a connection”.', 'Fix: open the workflow → click the email node → pick the Gmail connection → Publish → Retry the run.'],
        },
        tip: 'Don’t want to keep checking? A Super Admin can turn on failure alert emails in Settings.',
      },
    ],
  },

  workflows: {
    title: 'Workflows',
    summary: 'A workflow is a list of steps that run by themselves: “when THIS happens, do THAT”.',
    sections: [
      {
        title: 'Create your first workflow',
        steps: [
          'Click “New workflow”, type a name (e.g. “Check-in reminder”) and click “Create and open editor”.',
          'In the editor, drag a trigger (what starts it) and an action (what it does) onto the canvas.',
          'Connect them, fill in the settings, click “Test run”, then “Publish” and switch it to Active.',
        ],
        example: {
          title: 'Example: email the team every Monday',
          lines: ['Trigger: Schedule Trigger → Every week → Mon → 9:00 AM', 'Action: Gmail Send Email → To: team@widebed.com → Subject: “Weekly check”', 'Publish → Active. Done!'],
        },
      },
      {
        title: 'Not sure where to start?',
        text: 'Open Templates (left menu): pick a ready-made workflow like “Monthly rent reminder”, fill in your details and publish.',
      },
      {
        title: 'Statuses',
        steps: [
          'Draft only: never published. It does not run by itself.',
          'v1, v2…: the published version that runs.',
          'Active: it runs automatically. Inactive: it waits until you switch it on.',
        ],
      },
      {
        title: 'Import and export',
        steps: [
          'Export: click ⋯ on a workflow → “Export (.json)”. Use it as a backup or to copy it to another system.',
          'Import: click “Import” (top right) and choose a .json file from Widebed or from n8n. It becomes a NEW workflow.',
          'After importing, open it and choose the connections (Gmail, Firebase) again — passwords are never inside the file.',
        ],
        tip: 'Steps that cannot be converted from n8n show in red as “Needs replacing”. Replace or delete them before publishing.',
      },
      {
        title: 'Folders, tags and search',
        steps: ['“New folder” groups related workflows (e.g. “Tenants”, “Owners”).', 'Use ⋯ → “Move to folder” to file a workflow.', 'Search finds names, descriptions and tags.'],
      },
      {
        title: 'Share a workflow with someone',
        steps: [
          'Click ⋯ on the workflow → “Share…”.',
          'Type the person’s name or email and click “Add”, then “Save sharing”.',
          'They can now open it, press Run and see its history — but they can’t change it.',
        ],
        example: {
          title: 'Example',
          lines: ['You built “Owner monthly statement”.', 'Share it with Amy from Accounts so she can run it at month end.', 'The row then shows a 👥 1 badge; Amy sees “shared with you”.'],
        },
        tip: 'Admins and your department manager can already see your workflows — you only need to share with people outside that.',
      },
    ],
  },

  editor: {
    title: 'Workflow editor',
    summary: 'Build a workflow by dragging boxes (called nodes) and joining them with lines.',
    sections: [
      {
        title: 'The 4 basic moves',
        steps: [
          'Add: drag a node from the left panel onto the canvas.',
          'Connect: drag from the small dot on the right of one node to the left of the next.',
          'Set up: click a node — its settings open on the right.',
          'Delete: click a node and press Delete (or use the Delete button in its panel).',
        ],
      },
      {
        title: 'Every workflow starts with a trigger',
        steps: [
          'Manual Trigger: runs only when you press “Test run”. Good for trying things.',
          'Schedule Trigger: runs on a date, every day, week, month or every few minutes.',
          'Webhook Trigger: another system calls a secret web address to start it.',
          'HTTP Event: Widebed PMS/TMS sends a named event, e.g. “booking.created”.',
        ],
      },
      {
        title: 'Use data from an earlier step',
        text: 'Type {{ }} in a field to insert data that came from earlier in the workflow.',
        example: {
          title: 'Examples',
          lines: [
            '{{ $json.email }} → the “email” of the current item',
            'Hello {{ $json.tenantName }}, your rent is due on {{ $json.dueDate }}',
            '{{ $node["Read bookings"].json.guestName }} → a value from the node called “Read bookings”',
            '{{ $trigger.body.bookingId }} → data sent to the webhook / event',
          ],
        },
        tip: 'Not sure what the field is called? Run a test first, then click the earlier node and open “Last run” to see its data.',
      },
      {
        title: 'Work with Google Sheets',
        steps: [
          'Read Rows: each row becomes one item, e.g. one per tenant. Row 1 must contain the column names.',
          'Add Row: adds a new row at the bottom. Columns are found by their name.',
          'Update Row: finds a row (e.g. where “Booking ID” equals {{ $json.bookingId }}) and changes some cells.',
          'Paste the sheet’s link from your browser — the tab in the link is used automatically.',
        ],
        example: {
          title: 'Example: remind unpaid tenants',
          lines: ['Schedule Trigger → Every month → 25th → 10:00 AM', 'Google Sheets Read Rows → Only rows where Status = Unpaid', 'Gmail Send Email → To: {{ $json.Email }} → “Hi {{ $json.Name }}, your rent is due”'],
        },
        tip: 'Share the sheet with the Google account of the node, or Google will say it cannot open it.',
      },
      {
        title: 'Dates without code',
        steps: [
          'In IF or Filter, pick a date check: “is tomorrow”, “is more than … days ago”, “is within the next … days”…',
          'Works with dates like 2026-12-01, 01/12/2026 and PMS/Firebase dates, in Malaysia time.',
          'Use today’s date in text: {{ $today }} (2026-11-14), {{ $today.tomorrow }}, {{ $today.display }} (14 Nov 2026).',
        ],
        example: { title: 'Example', lines: ['Filter: {{ $json.updatedAt }} is more than 3 days ago', 'Firebase Read: arrival == {{ $today.tomorrow }}'] },
      },
      {
        title: 'One email instead of many',
        text: 'Put “Combine into One” before a Gmail step: all items become one list, {{ $json.list }}, and {{ $json.count }} tells how many.',
        tip: 'When there is nothing in the list, the steps after it do not run — no empty emails.',
      },
      {
        title: 'Make decisions',
        steps: ['IF: two paths — true or false. e.g. “nights is greater than 7”.', 'Switch: many paths, one per value. e.g. one path per property.', 'Filter: keep only the items that match.', 'Loop: repeat steps for each item in a list.'],
        example: { title: 'Example', lines: ['IF “days until check-in” is equal to 1 → Send reminder email', 'otherwise → do nothing'] },
      },
      {
        title: 'Test, publish, switch on',
        steps: [
          'Save (Ctrl+S) keeps your changes as a draft. The running version does not change.',
          'Test run runs the draft now so you can check each step. Green = worked, red = error.',
          'Publish makes the draft the official version. It is blocked while there are problems (orange warnings).',
          'Switch Active on so schedules, webhooks and events start it automatically.',
        ],
        tip: 'Made a mistake? Use Undo (Ctrl+Z), or “Versions” to load an older published version back into the draft.',
      },
    ],
  },

  executions: {
    title: 'Executions',
    summary: 'Every time a workflow runs, it is listed here with its result.',
    sections: [
      {
        title: 'Read the list',
        steps: [
          'Status: Success (worked), Failed (stopped with an error), Running, Waiting, Cancelled.',
          'Trigger: what started it — Manual, Schedule, Webhook or Event.',
          '“test” means it was a Test run of a draft.',
        ],
      },
      {
        title: 'Find a run',
        steps: ['Use the filters for workflow, status and trigger.', 'Example: Workflow = “Tenant Reminder”, Status = Failed shows only the failures of that workflow.', 'Click a row to see every step.'],
      },
    ],
  },

  executionDetail: {
    title: 'Run details',
    summary: 'Shows exactly what happened in one run, step by step.',
    sections: [
      {
        title: 'Check each step',
        steps: ['Click a step on the left to see what went in (Input) and what came out (Output).', 'A red step shows the error message in plain text.'],
      },
      {
        title: 'Retry or cancel',
        steps: [
          'Retry: runs it again with the same starting data — useful after fixing a connection.',
          'Cancel: stops a run that is still running or waiting.',
        ],
        example: {
          title: 'Example',
          lines: ['Error: “Google connection expired”.', 'Fix: Credentials → reconnect the Google account.', 'Then come back here and press Retry.'],
        },
        tip: 'Be careful retrying runs that already sent emails — the emails will be sent again.',
      },
    ],
  },

  credentials: {
    title: 'Credentials (connections)',
    summary: 'Connections let workflows log in to other systems. Passwords and keys are encrypted and never shown again.',
    sections: [
      {
        title: 'Google account (for Gmail and Google Sheets nodes)',
        text: 'Lets workflows send and read email, and read and write Google Sheets, as one Google account.',
        steps: [
          'Click “Google account”, give it a name (e.g. “Support inbox”) and click “Continue to Google”.',
          'Sign in with the mailbox that should send the emails, then click Allow.',
          'You come back here and it shows as Connected.',
        ],
        tip: 'If the box says “Google sign-in is not configured”, an IT Admin must set it up on the server first (see the README → Gmail).',
      },
      {
        title: 'Reconnect a Google account',
        text: 'Use Reconnect when a connection shows an error, or when it says it needs Google Sheets access. It keeps the same connection, so workflows that use it keep working.',
        steps: ['Click “Reconnect” on the Google connection.', 'On Google’s page choose the SAME account (e.g. support@widebed.com) and click Allow.', 'The sheet must also be shared with that account: in Google Sheets click Share and add it (Editor to add or change rows).'],
      },
      {
        title: 'Firebase project (for Firebase nodes)',
        text: 'Lets workflows read or change data in another Firebase project, like Widebed PMS.',
        steps: [
          'In that project’s Firebase console: Project settings → Service accounts → Generate new private key. A .json file downloads.',
          'Here: click “Firebase project”, choose that .json file.',
          'List the collections workflows may use, one per line. Everything else stays blocked.',
          'Tick “Read-only” if workflows should only read. Click “Connect and test”, then delete the downloaded file.',
        ],
        example: { title: 'Example', lines: ['Name: Widebed PMS (read-only)', 'Collections: bookings, properties', 'Read-only: ticked'] },
        tip: 'Start read-only on a test collection. Add write access only when the workflow is proven.',
      },
      {
        title: 'AI service (for AI steps)',
        text: 'Lets workflows use OpenAI (ChatGPT), Anthropic (Claude) or Google Gemini.',
        steps: [
          'Create an API key on the AI company’s website (the form has a link) and set a monthly spending limit there.',
          'Click “AI service”, choose the company, paste the key. Keep the suggested model unless you know you need another.',
          'Click “Test and connect” — a tiny test message checks the key before it is saved.',
        ],
        tip: 'Change the model or replace the key later with the “Edit” button. The key is never shown again.',
      },
      {
        title: 'Website login (for the Assistant’s browser)',
        text: 'Lets the Assistant sign in to a website for you, e.g. myTNB to collect bills.',
        steps: ['Click “Website login”, give it a name (e.g. myTNB) and paste the website’s sign-in page address.', 'Enter the username and password. They are encrypted; the AI never sees them.', 'Add other website addresses it may open, if the site uses more than one. It can never open any other site.'],
        tip: 'If the login fails, an IT Admin can fill in “Advanced: login page fields”.',
      },
      {
        title: 'Event source (for HTTP Event triggers)',
        text: 'Gives another app (like Widebed PMS) a key so it can start workflows by sending events.',
        steps: ['Click “Event source”, type the app name, click “Create key”.', 'Copy the key immediately — it is shown only once — and give it to the developer of that app.'],
        example: { title: 'Example', lines: ['PMS sends: POST /events/booking.created', 'Every Active workflow with an HTTP Event trigger named “booking.created” starts.'] },
      },
      {
        title: 'Test, update and remove',
        steps: ['Test: checks the connection still works.', 'Access (Firebase): change the allowed collections or read-only.', 'New key (event source): replaces a lost or leaked key.', 'Department: leave empty so every department can use it, or limit it to one.'],
      },
    ],
  },

  schedules: {
    title: 'Schedules',
    summary: 'All workflows that run by themselves on a timetable, and when each runs next.',
    sections: [
      {
        title: 'Add a schedule',
        steps: ['Open a workflow and add a Schedule Trigger.', 'Choose when: Once, Every day, Every week, Every month or Every few minutes.', 'Publish, then switch the workflow to Active. It appears here.'],
        example: {
          title: 'Examples',
          lines: [
            'Rent reminder: Every month → 25th → 10:00 AM',
            'Daily report: Every day → 8:00 AM',
            'Cleaning check: Every week → Mon, Thu → 2:00 PM',
            'One-off announcement: Once → 1 Dec 2026 → 9:00 AM',
          ],
        },
      },
      {
        title: 'Not in the list?',
        steps: ['Is the workflow Published? Draft changes do not count until you publish.', 'Is it switched to Active?', 'A “Once” schedule shows “Finished” after it has run.'],
        tip: 'Times use the time zone chosen in the Schedule node (Malaysia by default).',
      },
    ],
  },

  users: {
    title: 'Users & Permissions',
    summary: 'Invite staff and choose what each person may do.',
    sections: [
      {
        title: 'Invite someone',
        steps: ['Click “Invite user”, enter their name, email, role and department.', 'They receive an email to set their password.', 'Nobody can sign up by themselves — only invited people get in.'],
      },
      {
        title: 'Which role to choose',
        steps: [
          'Employee: runs workflows shared with them. Cannot build.',
          'Department Manager: builds and publishes workflows for their department.',
          'IT Admin: everything technical — connections, code steps, all workflows.',
          'Admin: all workflows and runs, no connections or users.',
          'Super Admin: everything, including users and settings.',
        ],
        example: { title: 'Example', lines: ['Housekeeping lead → Department Manager, department “Housekeeping”', 'Front desk staff → Employee'] },
        tip: 'Someone leaving? Click Disable — they can no longer sign in.',
      },
    ],
  },

  settings: {
    title: 'Settings',
    summary: 'Your profile and how the app looks. Super Admins also set up failure alerts and backups here.',
    sections: [
      {
        title: 'What you can change',
        steps: ['Appearance: light or dark mode (also the moon icon at the bottom left).', 'Password: sign out, then “Forgot password?” on the sign-in page.', 'Role and department: ask a Super Admin.'],
      },
      {
        title: 'Failure alerts (Super Admin)',
        text: 'Get an email when a live workflow fails, so nobody has to keep checking the Executions page.',
        steps: [
          'Connect a Google account on the Credentials page first (tick Gmail).',
          'In “Failure alerts”, pick that account and type who should get the emails.',
          'Press “Send test email” and check the inbox.',
          'Turn alerts on and press Save.',
        ],
        example: {
          title: 'Example',
          lines: [
            'Send from: Support inbox (support@widebed.com)',
            'Send to: ivan@widebed.com, it@widebed.com',
            'At most one email per workflow every: 60 minutes',
            '→ If “Rent reminder” fails at 9:00 and again at 9:20, you get one email at 9:00.',
          ],
        },
        tip: 'Test runs from the editor never send alerts — only real (published) runs do.',
      },
      {
        title: 'Backup and restore (Super Admin)',
        steps: [
          '“Download backup” saves every workflow into one file. Keep it somewhere safe (e.g. Google Drive).',
          'Passwords and keys are never in the file — connections must be picked again after a restore.',
          '“Restore from backup” adds the workflows back as new, switched-off copies. Nothing existing is overwritten.',
        ],
        tip: 'Download a backup before big changes, and once a month.',
      },
    ],
  },

  activity: {
    title: 'Activity log',
    summary: 'A record of who changed what and when — useful when something stopped working and you want to know why.',
    sections: [
      {
        title: 'Find something',
        steps: ['Use the buttons at the top to show only Workflows, People, Connections, Settings or Sign-ins.', 'Type a name in the search box, e.g. “Amy”.', 'Click a row to see the details and a link to the workflow or run.'],
        example: {
          title: 'Example: “Why did the rent reminder stop?”',
          lines: ['Click “Workflows” and search “rent”.', 'You see: “Amy switched a workflow off · Yesterday 4:12 PM”.', 'Now you know who to ask, and you can switch it back on from the Workflows page.'],
        },
      },
      {
        title: 'Good to know',
        steps: ['Entries can’t be edited or deleted, not even by admins.', 'Passwords and keys are never written to the log.', 'Older entries load when you press “Show older entries” at the bottom.'],
      },
    ],
  },

  integrations: {
    title: 'Integrations',
    summary: 'All the outside services your workflows can use, and whether each one is connected.',
    sections: [
      {
        title: 'Connect a service',
        steps: ['Find the service card (Gmail, Google Sheets, PMS data, AI…).', 'Click “Connect” — the right form opens on the Credentials page.', 'Follow the form. When it says Connected, the service is ready to use in workflows.'],
        tip: 'Gmail and Google Sheets share one Google connection: connect once, use both.',
      },
      {
        title: 'Read the cards',
        steps: ['“Not connected”: nobody has connected it yet.', '“1 connected”: ready. The list shows which account and whether it works.', 'A red badge means the connection needs attention — click Manage and press Test or Reconnect.'],
      },
      {
        title: 'Not an IT Admin?',
        text: 'Only IT Admins and Super Admins can connect services. You can still see what is connected and use it in your workflows.',
      },
    ],
  },
  aiAgents: {
    title: 'AI Settings',
    summary: 'Connect AI services, switch AI staff on, and let AI write, sort and read text inside your workflows.',
    sections: [
      {
        title: 'Get started in 3 steps',
        steps: ['Connect an AI service (OpenAI, Claude or Gemini) — an IT Admin does this once.', 'In a workflow, drag an AI step from the “AI” group on the left.', 'Choose the AI connection on the step and describe the job in plain words.'],
      },
      {
        title: 'Which AI step?',
        steps: [
          'AI Write / Answer: writes, summarises or translates. The answer is saved as {{ $json.answer }}.',
          'AI Sort into Categories: sends each item to the output of the best category (e.g. Complaint).',
          'AI Pull Out Details: fills in fields like guestName or checkIn from a text.',
        ],
        example: {
          title: 'Example: booking emails → sheet',
          lines: ['Gmail Read Email → “is:unread from:agoda.com”', 'AI Pull Out Details → guestName, checkIn, checkOut, property', 'Google Sheets Add Row → Guest = {{ $json.guestName }}'],
        },
      },
      {
        title: 'The Widebed Assistant',
        steps: [
          'IT Admin: in “Widebed Assistant” choose the AI service, a READ-ONLY PMS connection and (optional) the browser, tick “Switch on” and Save. This switches on all AI staff.',
          'Everyone: open AI Staff in the left menu and click an AI employee to chat.',
          'For jobs on a schedule, add the “AI Agent” step to a workflow, e.g. every 1st of the month: “list unpaid TNB bills” → Gmail.',
        ],
      },
      {
        title: 'Use AI safely',
        steps: ['AI can be wrong: let it draft emails for your team rather than sending to guests directly.', 'Each item is one paid request — set a spending limit in your AI account.', 'Do not send passport or card numbers to AI.'],
      },
    ],
  },
  templates: {
    title: 'Templates',
    summary: 'Ready-made workflows you copy and adjust — the quickest way to start.',
    sections: [
      {
        title: 'Use a template',
        steps: [
          'Click a template to see how it works and what you need first.',
          'Type a name and click “Use this template”. A new workflow opens in the editor.',
          'Fill in the steps marked with a warning (sheet link, connection, email addresses).',
          'Click “Test run”, then “Publish” and switch it to Active.',
        ],
        tip: 'If you have only one Google account or AI connection, it is chosen for you automatically.',
      },
      {
        title: 'Share your own workflow as a template',
        steps: ['Go to Workflows, click ⋯ on your workflow → “Save as template”.', 'Describe what it does and what people need first.', 'Your team now sees it here. Connections are never included.'],
      },
    ],
  },
  assistant: {
    title: 'Chatting with AI staff',
    summary: 'Chat with an AI employee. It answers live, shows each step it takes, remembers what you tell it, and asks you first before anything risky.',
    sections: [
      {
        title: 'Ask it anything',
        steps: [
          'Type your question and press Enter (Shift+Enter for a new line). The answer types out as it is written.',
          'You see each step it takes, e.g. “Reading PMS: bookings”.',
          'Press Stop if it goes the wrong way. Point at an answer for Copy and “Answer again”.',
          'Your chats with this AI employee are on the left — search them with the box at the top.',
        ],
        example: { title: 'Try', lines: ['Which issues are still open for more than 3 days?', 'Who arrives tomorrow at Sunrise Suites? Show a table.', 'What workflows can I run?'] },
      },
      {
        title: 'Photos and files (📎)',
        steps: [
          'Press 📎 (or paste a screenshot) to add up to 3 photos and 3 files to a message.',
          'Photos: damage, meter readings, receipts, screenshots. They are made smaller automatically and kept inside this chat. The AI can look at the latest 4 photos of the chat.',
          'Files (PDF, Word, Excel, text): only their text is read for this conversation; the file itself is not kept.',
          'The AI service must be able to see pictures (e.g. gpt-4o-mini, Claude Sonnet/Haiku, gemini-2.5-flash). If not, the chat says so — change the model in AI Staff → Edit.',
        ],
        example: { title: 'Try', lines: ['[photo of a ceiling stain] Is this a leak? What should housekeeping do?', '[photo of a TNB meter] What is the reading?'] },
      },
      {
        title: 'It remembers',
        steps: ['Say “remember …” and it saves it, e.g. “Remember: unit A-12’s TNB account is 2200-1111”.', 'Click “Memory” to see, add or delete what it knows. Only you can see your memory.', 'Each AI employee has its own memory: what you tell Finance, the PMS Assistant doesn’t know.'],
        tip: 'It reads your memory list at the start of every chat — it doesn’t read your old chats.',
      },
      {
        title: 'It asks before acting',
        steps: ['Running a workflow, or clicking things like “Pay” or “Submit” on a website, shows a “needs your OK” box.', 'Click Approve to go ahead, or “Don’t do it”.', 'Reading data and websites needs no approval.'],
      },
      {
        title: 'Websites (e.g. myTNB bills)',
        steps: [
          'An IT Admin saves the website login once (Credentials → Website login).',
          'Ask: “Open myTNB and list my unpaid bills”. It signs in by itself — the AI never sees the password.',
          'If the website sends a code to your phone, it asks you for it: type it in the chat.',
          'Downloaded bills appear as files in its reply (kept for 7 days).',
        ],
      },
    ],
  },
  aiStaff: {
    title: 'AI Staff',
    summary: 'Your team of AI employees. Each has its own job, instructions, AI model, tools and memory.',
    sections: [
      {
        title: 'Chat with one',
        steps: ['Click an AI employee’s card.', 'A green dot means it’s available; “Working…” means it’s busy on your request.', 'You only see the AI staff you’re allowed to use (company-wide, your department, or shared with you).'],
      },
      {
        title: 'Add an AI employee (Admins)',
        steps: [
          'Click “New AI employee” and pick a ready-made job (PMS, Finance, HR, Operations, Marketing, Automation, Main Manager) or start from scratch.',
          'Check its job, write any extra instructions, and choose what it may use (PMS data, workflows, websites, memory).',
          'Pick who may chat with it, then Save. It opens straight into a chat so you can try it.',
        ],
        example: {
          title: 'Example: Finance Assistant',
          lines: [
            'Job: check outstanding utility bills, prepare summaries',
            'Instructions: “Show amounts as RM. Overdue bills first.”',
            'May use: PMS data, saved websites (myTNB), memory',
            'Who: Finance department',
          ],
        },
        tip: 'Give each one only the tools its job needs. The person chatting must also be allowed to use them.',
      },
      {
        title: 'AI brain',
        steps: [
          'Each AI employee can use a different AI service and model — e.g. a strong model for the Main Manager, a cheaper one for simple look-ups.',
          'The model list comes straight from the AI service, so new models appear by themselves (press “Refresh list”).',
          'Leave “creativity” off unless you need it.',
        ],
      },
      {
        title: 'Who may use and change it',
        steps: [
          '“Who may chat with them”: Everyone, their department, or only you — plus named people and role limits.',
          'Managers of this AI employee (e.g. the Finance head) may change its job, behaviour and instructions, but not its AI, tools or access.',
          'Open “Who can chat with it now” at the bottom of the edit page to check the result.',
          'Chats are always private: nobody else can read them — not even Admins.',
        ],
      },
      {
        title: 'Check its memory (Admins)',
        steps: [
          'On the edit page, press “Show memory” to see what it remembers about each person.',
          'Correct (pencil) or delete anything wrong. Opening the list is recorded in the Activity log.',
          'Passwords, IC numbers and card numbers are refused automatically — they are never saved.',
        ],
      },
      {
        title: 'Switch off, archive, delete',
        steps: ['Switch off: nobody can chat with it for now; everything is kept.', 'Archive: removes it from the team (you can bring it back).', 'Delete: only for archived ones. People keep their old chats.'],
        tip: 'The built-in Widebed Assistant can be changed and switched off, but not deleted.',
      },
    ],
  },
  aiTasks: {
    title: 'AI Tasks',
    summary: 'Everything your AI staff do in the background. They keep working when you close the app.',
    sections: [
      {
        title: 'Give a task',
        steps: ['Press “Give a task”, choose the AI employee and describe the job.', 'Close the app if you like — it works on the server.', 'Come back to AI Tasks and click the task to read the result.'],
        example: { title: 'Example', lines: ['Who: Operations Assistant', 'Task: “List all unresolved issues older than 3 days, grouped by property, with who has each one.”', 'Result: a table you can copy into an email.'] },
      },
      {
        title: 'Read a task',
        steps: ['“What it did” shows every step (e.g. “Reading PMS: issues”).', '“Result” is its answer. Use Copy to paste it anywhere.', 'Failed? The red box says why. Fix the cause (e.g. the AI key) and press “Run again”.', 'Stop a task that is taking too long with Stop.'],
        tip: 'If a task needs to run a workflow or click something risky, it waits for approval (status “Needs approval”). You get a bell notice; decide on the Approvals page.',
      },
      {
        title: 'Who sees which tasks',
        steps: ['You see the tasks you gave.', 'Managers of an AI employee and department managers see its tasks.', 'Admins see all tasks.'],
      },
    ],
  },
  aiSchedules: {
    title: 'AI Schedules',
    summary: 'Give an AI employee regular work — every day, week or month — and it does it by itself on the server.',
    sections: [
      {
        title: 'Make a schedule',
        steps: [
          'Press “New schedule” and choose the AI employee.',
          'Pick an idea (e.g. “7:00 · Today’s arrivals”) or write what it should do each time.',
          'Choose how often and the time — the blue box says it back in words, e.g. “Every day at 7:00 AM”.',
          'Press “Create schedule”. The result of each run appears in AI Tasks.',
        ],
        example: {
          title: 'A daily routine for the PMS Assistant',
          lines: ['7:00 AM — Today’s arrivals', '8:00 AM — Today’s departures', '6:00 PM — Occupancy summary'],
        },
      },
      {
        title: 'Good to know',
        steps: [
          'It runs with the permissions of the person who made (or last changed) the schedule.',
          'Use the switch to pause it, ▶ to run it now, and “Until” to stop it after a date.',
          'If the AI service is busy it tries once more by itself. Each run is done only once, even with several servers.',
          'Only Admins and the managers of an AI employee can give it schedules.',
          '“Tell me”: only when it fails (default), after every run, or never. The notice appears under the bell.',
        ],
      },
      {
        title: 'Responsibilities (tab)',
        text: 'A permanent duty, e.g. “Monitor outstanding utility bills”, carried out by one or more schedules.',
        steps: [
          'Open the Responsibilities tab → “New responsibility”. Pick the AI employee and its schedules.',
          'Each run lists the problems it finds. They stay on the card until a later run no longer finds them (or you press “Sorted”).',
          'With follow-up tasks on, each NEW problem gets one investigation task — never a second one for the same problem.',
          'Pause it to make its schedules wait (e.g. during a holiday).',
        ],
        example: {
          title: 'Example',
          lines: ['Finance Assistant · Monitor outstanding utility bills · daily 8:00 AM', 'Mon: finds “A-12 TNB bill 14 days overdue” → follow-up task + bell notice', 'Tue: still overdue → seen in 2 runs, no new follow-up', 'Wed: paid → moves to “recently solved”'],
        },
      },
    ],
  },
  aiApprovals: {
    title: 'Approvals',
    summary: 'AI staff ask before doing anything that sends, runs, changes or pays. Decide here — each OK covers exactly one action, once.',
    sections: [
      {
        title: 'The four risk levels',
        steps: [
          'Level 1 · Read only — looking things up. Never asks.',
          'Level 2 · Low risk — e.g. typing into a website form. Follows the Admin rule (default: automatic in chats, ask in background tasks).',
          'Level 3 · Sensitive — running a workflow, clicking Submit/Send/Confirm. Always asks.',
          'Level 4 · Critical — Pay, Delete, Cancel. Only an Admin or a named approver can approve, and must type APPROVE. Expires within 2 hours.',
        ],
      },
      {
        title: 'Decide',
        steps: [
          'Read what it wants to do and the exact parameters (e.g. which workflow, with which data).',
          'Approve: it does exactly that, once, then carries on. Reject: it is told not to and carries on without it.',
          'Edit: change a parameter (e.g. the amount or the name), save — this makes a new request that must be approved.',
          'If nobody decides in time, the request expires and nothing is done.',
        ],
        example: {
          title: 'Example',
          lines: ['Finance Assistant · L3 Sensitive · “Running workflow Send rent reminder”', 'Parameters: unit = A-12, amount = 1500', 'You edit amount to 1450 → Save as new request → Approve', 'The workflow runs once with 1450.'],
        },
      },
      {
        title: 'Who can approve',
        steps: ['The person the AI employee is working for — up to level 3.', 'Approvers named on the AI employee’s edit page (Access section) — any level.', 'Admins — any level. Every decision is in the Activity log.'],
        tip: 'Background tasks now wait here instead of giving up. You get a bell notice when something needs you.',
      },
    ],
  },
  aiCollaboration: {
    title: 'Collaboration',
    summary: 'A manager AI (e.g. Main Manager) can split a big request between AI colleagues and combine their answers. This page shows how it did it.',
    sections: [
      {
        title: 'How to use the Main Manager',
        steps: [
          'Admins: AI Staff → New AI employee → Main Manager (or tick “Manager: hand work to other AI staff” on any AI employee).',
          'Tick the tools its helpers may use (e.g. PMS data). Helpers never get more than the manager has.',
          'Chat with it, or give it a task: “Prepare a report about tomorrow’s arrivals and any open issues in those units”.',
          'It shows “Handing work to PMS Assistant, Operations Assistant…”, waits for their results, checks them against each other and writes one report.',
        ],
        example: {
          title: 'What happens behind the scenes',
          lines: ['PMS Assistant: tomorrow’s arrivals   ┐  at the same time', 'Operations Assistant: open issues   ┘', '→ PMS Assistant: match arrivals with issues (waits for both)', '→ Main Manager: one combined report'],
        },
      },
      {
        title: 'Reading this page',
        steps: ['Each card is one request. Left to right: parts that started straight away, then parts that waited for them.', 'Click a part to see exactly what it was asked and what it found.', 'If a part fails, the parts that needed it are skipped, and the manager says so in its answer.'],
      },
      {
        title: 'Safety limits',
        steps: ['Only colleagues the person may use. Helpers work with that person’s permissions.', 'Helpers can’t hand work on (no endless loops). At most 6 parts and 2 hand-offs per request, 3 working at a time.', 'Stopping the manager stops its helpers. Risky steps still wait in Approvals.'],
      },
    ],
  },
  knowledge: {
    title: 'Company Knowledge',
    summary: 'Your SOPs, house rules, price lists and policies — written once, used by every AI employee when it answers.',
    sections: [
      {
        title: 'Add a document (Admins)',
        steps: [
          'Press “Add document”.',
          'Either type / paste the text, or choose a file (PDF, Word .docx, Excel .xlsx, or a text file). The text is read out of the file and shown so you can check it.',
          'Only the TEXT is saved. The file itself is not kept anywhere — keep your original in your own folder.',
          'Give it a folder (e.g. “Housekeeping”) so it is easy to find.',
          'Choose who may read it: everyone, or only some departments or roles.',
          'Choose which AI staff may use it: all of them, or only some (e.g. only the Housekeeping Assistant).',
        ],
      },
      {
        title: 'How AI staff use it',
        steps: [
          'When someone asks a question about how Widebed does things, the AI searches Company Knowledge first and quotes the document.',
          'An AI only finds documents that BOTH it may use AND the person it works for may read.',
          'Use “Try a search” on this page to see what the AI would find for a question.',
          'If the AI finds nothing, it says so instead of inventing a rule.',
        ],
        example: { title: 'Example', lines: ['Staff: “How much is late checkout?”', 'AI: looks in Company Knowledge → House rules', 'AI: “Late checkout is RM 50 per hour (House rules).”'] },
      },
      {
        title: 'Good to know',
        steps: [
          'Scanned PDFs are pictures, so no text can be read. Paste the text instead, or save the file as Word.',
          'Keep one topic per document with a clear title — it makes searching better.',
          'To turn it off for one AI employee: AI Staff → Edit → untick “Company Knowledge”.',
          'In any chat you can also attach a file or photo with 📎 for that conversation only.',
        ],
      },
    ],
  },
  aiPerformance: {
    title: 'AI Performance',
    summary: 'How much each AI employee works, how often it succeeds, how long it takes, and how many AI tokens (and roughly how much money) it uses.',
    sections: [
      {
        title: 'Reading the page',
        steps: [
          'Pick a period at the top: today, 7, 30 or 90 days (Malaysia time).',
          'Tasks done / success rate / average time come from AI Tasks (given, scheduled and team-work parts).',
          'AI calls and tokens count every answer the AI service gave, in chats and in tasks.',
          'The chart shows tasks per day: done, failed (striped) and other. Hover a day, or press “Show numbers”.',
          'Point at a number in the table for details (e.g. done / failed / stopped).',
        ],
      },
      {
        title: 'Cost (Admins)',
        steps: [
          'Open “Model prices” and enter the price of each model you use, in US dollars per 1 million tokens, from your AI provider’s price page.',
          'Models used without a price are listed — click one to add it.',
          'Cost is an estimate. Your provider’s bill is the real amount.',
        ],
        tip: 'A “≥” in front of a cost means some of its tokens are on a model without a price.',
      },
      {
        title: 'Who sees it',
        steps: ['Admins see everything.', 'Department managers see the AI staff of their own department.', 'Employees don’t see this page.'],
      },
    ],
  },
};

/** Which guide belongs to which page (by route path). */
export function guideForPath(path: string): GuideKey | null {
  if (path === '/') return 'overview';
  if (/^\/workflows\/[^/]+\/edit/.test(path)) return 'editor';
  if (path.startsWith('/workflows')) return 'workflows';
  if (/^\/executions\/[^/]+/.test(path)) return 'executionDetail';
  if (path.startsWith('/executions')) return 'executions';
  if (path.startsWith('/credentials')) return 'credentials';
  if (path.startsWith('/schedules')) return 'schedules';
  if (path.startsWith('/users')) return 'users';
  if (path.startsWith('/settings')) return 'settings';
  if (path.startsWith('/integrations')) return 'integrations';
  if (path.startsWith('/ai-agents')) return 'aiAgents';
  if (path.startsWith('/templates')) return 'templates';
  if (path.startsWith('/assistant') || /^\/ai-staff\/[^/]+\/chat/.test(path)) return 'assistant';
  if (path.startsWith('/ai-staff')) return 'aiStaff';
  if (path.startsWith('/ai-tasks')) return 'aiTasks';
  if (path.startsWith('/ai-schedules')) return 'aiSchedules';
  if (path.startsWith('/ai-approvals')) return 'aiApprovals';
  if (path.startsWith('/ai-collaboration')) return 'aiCollaboration';
  if (path.startsWith('/knowledge')) return 'knowledge';
  if (path.startsWith('/ai-performance')) return 'aiPerformance';
  if (path.startsWith('/activity')) return 'activity';
  return null;
}
