# Tenant Reminder (PMS): setup

`Tenant_Reminder_PMS.widebed.json` is the n8n **Tenant Reminder** rebuilt for Widebed Automation.
It reads bookings from the **Widebed PMS** Firebase instead of the Willow Google Sheet.
It writes the "Sent" marks back to the PMS instead of to the sheet.

## What it does (every day, 9:00 AM Malaysia time)

| Rule | Email | Sent when | Writes to the PMS after sending |
| --- | --- | --- | --- |
| 1 | Check-in tomorrow (address, door passcode) | 1 day before check-in | — |
| 2 | Welcome + quick access + house rules | Check-in day | — |
| 3 | Extend your stay? | 7 days before check-out | — |
| 4 | Rent payment reminder | 7, 3 and 1 day before the rent date, Rental Status **Unpaid**, guest staying now | — |
| 5 | New door passcode | Current passcode expires today or tomorrow, and the **next passcode + its expiry** are filled in | Next passcode becomes the main one; Password Status = Active |
| 6 | Check-out instructions | Check-out day | — |
| 7 | Thank you + deposit | Day after check-out | — |
| 8 | Utility bill | The booking's utility bill has Utility Status **Ready_to_Send**, guest staying now | Utility Status = Sent |
| 9 | Owner: tenant moved in | On or after check-in, Move-in Status **Ready_to_Send** | Move-in Status = Sent |
| 10 | Owner: tenant moved out | On or after check-out, Move-out Status **Ready_to_Send** | Move-out Status = Sent |

- **Bookings used:** `offlineBookings` with status **active**. That covers Create booking, direct bookings and Willow imports. Awaiting-payment and cancelled bookings are skipped.
- **Guest name and email** come from the tenant (`tenants/{id}/private/main`), or, for imported bookings, from the booking's own private part.
- **Owner email** comes from the booking's own Owner Email (imported bookings). Otherwise it comes from the unit's owner (`owners/{id}/private/contact`, plus co-owners).
- **Rent date:** the booking's Renewal Date (imported bookings). For long-term bookings without one, it is the same day of every month as the check-in.

## Set up

1. **PMS connection.** Go to Credentials → New → Firebase project.
   - Upload a service account key of **widebed-pmsdashboard** (role *Cloud Datastore User*).
   - Name it exactly **`Widebed PMS - Tenant emails`**.
   - **Read-only: OFF**, because it writes the "Sent" marks.
   - Allowed collections, one per line:
     ```
     offlineBookings
     offlineBookings/*/private
     tenants/*/private
     units
     properties
     owners/*/private
     utilityBills
     ```
   - Keep your existing read-only PMS connection for everything else.
2. **Gmail.** Name the Google account that sends these emails exactly **`Gmail account`**, or choose it on each email step after importing.
3. **Import.** Go to Workflows → Import → choose `Tenant_Reminder_PMS.widebed.json`. Only IT Admins and Super Admins can import it, because it has a Code step. With the names above, all 22 connection steps link by themselves.
4. **Dry run, sends nothing.**
   - Switch off the 10 "Email…" steps and the 5 "PMS: …" steps (right-click → Disable).
   - Press **Test run**, open the run, and click each "Rule …" step. You see who would get that email today.
   - "Work out today's emails" shows every booking's dates and statuses under `_check`.
5. **Go live.**
   - Switch the steps back on and **Publish**.
   - **Turn off the n8n Tenant Reminder**, or guests get every email twice.

## Good to know

- **PMS security rules don't change.** The connection works on the server with the service account, which Firestore security rules don't apply to. Only the collections listed above can be reached.
- **Changes don't appear in the PMS audit log.** The "Sent" marks and the passcode change are written by the automation. Every run is in the automation's Executions page.
- **Some sheet columns don't exist in the PMS yet:** GMap Link, WiFi name and password, mailbox passcode, parking lot. Those lines are left out of the emails.
  - If the PMS later saves them on the booking or the unit's info as `gmapLink`, `wifiName`, `wifiPassword`, `mailboxPasscode` or `parkingLot`, they appear in the emails automatically.
  - The WhatsApp group link exists only on imported bookings.
- **To stop passcode emails for one booking,** set its Password Status to `Hold`.
- **The n8n "Webhook → Password Update" branch is not included.** Rule 5 does the passcode change automatically.
- **Wrong or missing emails:** guests with no valid email are skipped. Owner emails are skipped when no owner email is found.
