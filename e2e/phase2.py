"""Phase 2 browser check: credentials, Switch/Code/Firebase/Wait nodes, schedules."""
import json, os, time
from playwright.sync_api import sync_playwright

src = open(os.path.join(os.path.dirname(__file__), "run.py")).read().split("    # Create a workflow")[0]
src = src.replace("with sync_playwright() as p:", "p = sync_playwright().start()\nif True:")
exec(src)  # logs in; defines page, BASE, OUT, TOKEN, errors, browser

H = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
def api(method, path, body=None):
    r = page.request.fetch(BASE + "/api" + path, method=method, headers=H, data=json.dumps(body) if body is not None else None)
    assert r.ok, (path, r.status, r.text())
    return r.json() if r.status != 204 else None

# 1. Credentials page: event source + Firebase connection through the UI
page.click("a:has-text('Credentials')")
page.wait_for_selector("text=No connections yet")
page.click("button:has-text('Event source')")
page.fill("input[placeholder='Widebed PMS']", "Widebed PMS")
page.click("button:has-text('Create key')")
page.wait_for_selector("text=Example request from the app")
page.wait_for_timeout(300)
page.screenshot(path=f"{OUT}/30-event-key.png")
page.click("button:has-text('Done')")

sa = os.path.join(OUT, "sa.json")
json.dump({"type": "service_account", "project_id": "widebed-pms", "client_email": "bot@widebed-pms.iam.gserviceaccount.com", "private_key": "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n"}, open(sa, "w"))
page.click("button:has-text('Firebase project')")
page.locator("form#fb-form input").first.fill("Widebed PMS (Firestore)")
page.set_input_files("form#fb-form input[type=file]", sa)
page.fill("form#fb-form textarea", "bookings\ntenants/*/payments")
page.click("button:has-text('Connect and test')")
page.wait_for_selector("text=Connected to widebed-pms")
page.wait_for_timeout(400)
page.screenshot(path=f"{OUT}/31-credentials.png")
cred = [c for c in api("GET", "/credentials")["items"] if c["provider"] == "firebase_service_account"][0]

# 2. Build a workflow through the API, then use the real editor to run it
wf = api("POST", "/workflows", {"name": "Booking router", "description": "Phase 2 nodes", "tags": ["phase2"]})
N = lambda i, t, name, x, y, cfg, **kw: {"id": i, "type": t, "name": name, "position": {"x": x, "y": y}, "config": cfg, **kw}
E = lambda s, t, sh="main", th="main": {"id": f"{s}-{t}-{sh}", "source": s, "sourceHandle": sh, "target": t, "targetHandle": th}
definition = {
    "schemaVersion": 1,
    "nodes": [
        N("t", "trigger.manual", "Bookings", 0, 120, {"testData": json.dumps([{"id": "B-1", "status": "confirmed", "nights": 3}, {"id": "B-2", "status": "cancelled", "nights": 1}, {"id": "B-3", "status": "pending", "nights": 2}])}),
        N("c", "data.code", "Add total", 280, 120, {"code": "return items.map(b => ({ ...b, total: b.nights * 180 }))", "timeoutMs": 3000}),
        N("s", "logic.switch", "By status", 560, 120, {"value": "{{ $json.status }}", "cases": [{"id": "c_ok", "label": "Confirmed", "value": "confirmed"}, {"id": "c_x", "label": "Cancelled", "value": "cancelled"}]}),
        N("f", "data.firebaseCreate", "Save booking", 860, 20, {"collection": "bookings", "docId": "{{ $json.id }}", "data": "{{ $json }}"}, credentialId=cred["credentialId"]),
        N("w", "logic.wait", "Cool-off", 860, 140, {"amount": 1, "unit": "seconds"}),
        N("l", "logic.loop", "Each night", 860, 260, {"mode": "count", "count": "{{ $json.nights }}"}),
    ],
    "connections": [E("t", "c"), E("c", "s"), E("s", "f", "c_ok"), E("s", "w", "c_x"), E("s", "l", "otherwise")],
}
api("PUT", f"/workflows/{wf['workflowId']}/draft", {"definition": definition})
import random
definition["nodes"][0]["config"]["testData"] = definition["nodes"][0]["config"]["testData"].replace("B-", f"B{random.randint(100,999)}-")
api("PUT", f"/workflows/{wf['workflowId']}/draft", {"definition": definition})
page.goto(f"{BASE}/workflows/{wf['workflowId']}/edit")
page.wait_for_selector(".vue-flow__node")
page.wait_for_timeout(600)
page.click("button:has-text('Test run')")
page.wait_for_selector("text=Execution finished successfully", timeout=20000)
page.wait_for_timeout(500)
page.locator(".vue-flow__node", has_text="By status").click()
page.wait_for_timeout(300)
page.click("aside button:has-text('Parameters')")
page.wait_for_timeout(300)
page.screenshot(path=f"{OUT}/32-editor-switch.png")
page.locator("section td", has_text="Save booking").click()  # via the execution panel (node is under the side panel)
page.wait_for_timeout(300)
page.click("aside button:has-text('Parameters')")
page.wait_for_timeout(300)
page.screenshot(path=f"{OUT}/33-editor-firebase.png")
page.click("button[title='Workflow settings']")
page.wait_for_selector("text=Timeout (minutes)")
page.screenshot(path=f"{OUT}/34-workflow-settings.png")
page.click("button:has-text('Cancel')")

# 3. Schedule workflow → Schedules page
sw = api("POST", "/workflows", {"name": "Daily occupancy report"})
api("PUT", f"/workflows/{sw['workflowId']}/draft", {"definition": {"schemaVersion": 1, "nodes": [N("s", "trigger.schedule", "Every weekday 9:00", 0, 0, {"mode": "cron", "cron": "0 9 * * 1-5", "timezone": "Asia/Kuala_Lumpur"})], "connections": []}})
api("POST", f"/workflows/{sw['workflowId']}/publish")
api("POST", f"/workflows/{sw['workflowId']}/activate")
page.goto(f"{BASE}/schedules")
page.wait_for_selector("text=Daily occupancy report")
page.screenshot(path=f"{OUT}/35-schedules.png")

# 4. Event trigger end-to-end through /events
ew = api("POST", "/workflows", {"name": "New booking event"})
api("PUT", f"/workflows/{ew['workflowId']}/draft", {"definition": {"schemaVersion": 1, "nodes": [N("e", "trigger.event", "booking.created", 0, 0, {"eventName": "booking.created"})], "connections": []}})
api("POST", f"/workflows/{ew['workflowId']}/publish")
api("POST", f"/workflows/{ew['workflowId']}/activate")

page.goto(f"{BASE}/executions")
page.wait_for_selector("td:has-text('Booking router')")
page.screenshot(path=f"{OUT}/36-executions.png")
print("errors:", errors)
browser.close()
