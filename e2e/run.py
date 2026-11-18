"""Drives the real Widebed Automation UI in Chrome with Firebase sign-in stubbed."""
import base64, json, time, sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4173"
import os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
os.makedirs(OUT, exist_ok=True)

def b64(d):
    return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")

def jwt(uid, email, name):
    now = int(time.time())
    payload = {"iss": "https://securetoken.google.com/demo-widebed", "aud": "demo-widebed", "auth_time": now,
               "user_id": uid, "sub": uid, "iat": now, "exp": now + 3600, "email": email, "name": name,
               "email_verified": True, "firebase": {"sign_in_provider": "password", "identities": {"email": [email]}}}
    return f"{b64({'alg':'RS256','typ':'JWT'})}.{b64(payload)}.sig"

USER = {"uid": "u_admin", "email": "admin@widebed.test", "name": "Crane Admin"}
TOKEN = jwt(USER["uid"], USER["email"], USER["name"])

def stub_firebase(route):
    url = route.request.url
    if "signInWithPassword" in url:
        body = {"kind": "identitytoolkit#VerifyPasswordResponse", "localId": USER["uid"], "email": USER["email"],
                "displayName": USER["name"], "idToken": TOKEN, "registered": True, "refreshToken": "refresh", "expiresIn": "3600"}
    elif "accounts:lookup" in url:
        body = {"users": [{"localId": USER["uid"], "email": USER["email"], "displayName": USER["name"], "emailVerified": True,
                           "providerUserInfo": [{"providerId": "password", "email": USER["email"], "rawId": USER["email"]}],
                           "lastLoginAt": str(int(time.time()*1000)), "createdAt": str(int(time.time()*1000))}]}
    elif "securetoken" in url:
        body = {"access_token": TOKEN, "id_token": TOKEN, "refresh_token": "refresh", "expires_in": "3600", "user_id": USER["uid"], "token_type": "Bearer"}
    else:
        body = {}
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/identitytoolkit.googleapis.com/**", stub_firebase)
    page.route("**/securetoken.googleapis.com/**", stub_firebase)

    page.goto(BASE + "/login")
    page.wait_for_selector("text=Sign in")
    page.screenshot(path=f"{OUT}/01-login.png")
    page.fill("#email", USER["email"])
    page.fill("#password", "secret123")
    page.click("button:has-text('Sign in')")
    page.wait_for_selector("text=Good to see you")
    page.wait_for_timeout(600)
    page.screenshot(path=f"{OUT}/02-overview-empty.png")

    # Create a workflow
    page.click("a:has-text('Workflows')")
    page.click("button:has-text('New workflow')")
    page.fill("input[placeholder='e.g. Check-in reminder']", "Booking confirmation check")
    page.fill("textarea", "Look up a booking in the PMS and branch on its status")
    page.fill("input[placeholder='pms, tenants']", "pms, bookings")
    page.click("button:has-text('Create and open editor')")
    page.wait_for_selector(".vue-flow")
    page.wait_for_timeout(500)

    # Add nodes by clicking the palette
    for name in ["Manual Trigger", "HTTP Request", "IF Condition"]:
        page.click(f"aside button:has-text('{name}')")
        page.wait_for_timeout(250)

    nodes = page.locator(".vue-flow__node")
    assert nodes.count() == 3, nodes.count()

    # Lay them out by dragging
    def drag_node(idx, x, y):
        box = nodes.nth(idx).bounding_box()
        page.mouse.move(box["x"] + 60, box["y"] + 20)
        page.mouse.down()
        page.mouse.move(x, y, steps=8)
        page.mouse.up()
    # Newly added nodes overlap; drag the top-most (last) one first.
    drag_node(2, 880, 400)
    drag_node(1, 600, 400)
    drag_node(0, 320, 400)
    page.wait_for_timeout(300)

    def connect(src_idx, tgt_idx, handle_id="main"):
        src = nodes.nth(src_idx).locator(f".vue-flow__handle.source[data-handleid='{handle_id}']")
        tgt = nodes.nth(tgt_idx).locator(".vue-flow__handle.target").first
        sb, tb = src.bounding_box(), tgt.bounding_box()
        page.mouse.move(sb["x"] + sb["width"]/2, sb["y"] + sb["height"]/2)
        page.mouse.down()
        page.mouse.move(tb["x"] + tb["width"]/2, tb["y"] + tb["height"]/2, steps=12)
        page.mouse.up()
        page.wait_for_timeout(200)
    connect(0, 1)
    connect(1, 2)
    edges = page.locator(".vue-flow__edge").count()
    print("edges after connect:", edges)

    # Configure HTTP Request
    nodes.nth(1).click()
    page.wait_for_selector("text=Parameters")
    url_input = page.locator("aside input[placeholder^='https://api.example.com']")
    url_input.fill("http://127.0.0.1:4000/demo/booking/{{ $json.bookingId }}")
    # Configure IF
    nodes.nth(2).click()
    page.wait_for_timeout(200)
    page.locator("aside input[placeholder='{{ $json.status }}']").fill("{{ $json.body.status }}")
    page.locator("aside input[placeholder='value or {{ expression }}']").fill("confirmed")
    # Manual trigger test data
    nodes.nth(0).click()
    page.wait_for_timeout(200)
    page.locator("aside textarea").first.fill('{"bookingId": "B-1001"}')
    page.wait_for_timeout(900)
    page.screenshot(path=f"{OUT}/03-editor-configured.png")

    # Undo / redo sanity
    page.click("button[title='Undo (Ctrl+Z)']")
    page.wait_for_timeout(150)
    page.click("button[title='Redo (Ctrl+Shift+Z)']")
    page.wait_for_timeout(150)

    page.click("button:has-text('Save')")
    page.wait_for_selector("text=Draft saved")
    page.click("button:has-text('Test run')")
    try:
        page.wait_for_selector("text=Execution finished successfully", timeout=15000)
    except Exception:
        page.screenshot(path=f"{OUT}/debug-run.png"); print("RUN FAILED", errors); raise
    page.wait_for_timeout(500)
    nodes.nth(2).click()
    page.wait_for_timeout(400)
    page.screenshot(path=f"{OUT}/04-editor-run-success.png")

    # Publish & activate
    page.click("button:has-text('Publish')")
    page.wait_for_selector("text=Published version 1")
    page.click("button[role='switch']")
    page.wait_for_selector("text=Workflow is active")
    page.wait_for_timeout(300)
    page.screenshot(path=f"{OUT}/05-editor-published.png")

    # Add a webhook-triggered workflow to show the one-time URL modal
    page.click("button[aria-label='Back to workflows']")
    page.wait_for_selector("text=Booking confirmation check")
    page.click("button:has-text('New workflow')")
    page.fill("input[placeholder='e.g. Check-in reminder']", "Tenant enquiry webhook")
    page.click("button:has-text('Create and open editor')")
    page.wait_for_selector(".vue-flow")
    page.click("aside button:has-text('Webhook Trigger')")
    page.wait_for_timeout(300)
    page.click("button:has-text('Publish')")
    page.wait_for_selector("text=Webhook endpoint ready")
    page.wait_for_timeout(300)
    page.screenshot(path=f"{OUT}/06-webhook-issued.png")
    hook_url = page.locator("input[readonly]").first.input_value()
    print("webhook url:", hook_url)
    page.click("button:has-text('Done')")
    page.click("button[role='switch']")
    page.wait_for_timeout(500)

    # Call the webhook from outside
    resp = page.request.post(hook_url, data=json.dumps({"tenant": "Unit 12A", "question": "Wi-Fi password?"}), headers={"content-type": "application/json", "Idempotency-Key": "enq-1"})
    print("webhook call:", resp.status, resp.text())
    resp2 = page.request.post(hook_url, data=json.dumps({"tenant": "Unit 12A"}), headers={"content-type": "application/json", "Idempotency-Key": "enq-1"})
    print("webhook dup:", resp2.status, resp2.text())
    page.wait_for_timeout(500)

    page.click("button[aria-label='Back to workflows']")
    page.wait_for_selector("text=Tenant enquiry webhook")
    page.screenshot(path=f"{OUT}/07-workflows-list.png")

    page.click("a:has-text('Executions')")
    page.wait_for_selector("text=Execution ID")
    page.wait_for_timeout(400)
    page.screenshot(path=f"{OUT}/08-executions.png")
    page.locator("tbody tr").last.click()
    page.wait_for_selector("text=Nodes (")
    page.wait_for_timeout(400)
    page.screenshot(path=f"{OUT}/09-execution-detail.png")

    page.click("a:has-text('Overview')")
    page.wait_for_selector("text=Recent activity")
    page.wait_for_timeout(600)
    page.screenshot(path=f"{OUT}/10-overview.png")

    page.click("button[title='Dark mode']")
    page.wait_for_timeout(300)
    page.screenshot(path=f"{OUT}/11-overview-dark.png")
    page.click("a:has-text('Workflows')")
    page.locator("text=Booking confirmation check").first.click()
    page.wait_for_selector(".vue-flow__node")
    page.wait_for_timeout(800)
    page.screenshot(path=f"{OUT}/12-editor-dark.png")

    browser.close()

print("console errors:", errors)
