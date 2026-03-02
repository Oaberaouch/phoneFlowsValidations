// run.js
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const SITE = process.env.PF_SITE || "https://www.lm.phoneflows.ma/";
const ARTIFACTS_DIR = process.env.PF_ARTIFACTS_DIR || "artifacts";
const HEADLESS = process.env.PF_HEADLESS !== "0";
const TRACE = process.env.PF_TRACE === "1";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function safeScreenshot(page, name) {
  try {
    ensureDir(ARTIFACTS_DIR);
    const file = path.join(ARTIFACTS_DIR, `${ts()}_${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`Saved screenshot: ${file}`);
  } catch (e) {
    console.log("Screenshot failed:", e?.message || e);
  }
}

async function safeHtmlDump(page, name) {
  try {
    ensureDir(ARTIFACTS_DIR);
    const file = path.join(ARTIFACTS_DIR, `${ts()}_${name}.html`);
    const html = await page.content();
    fs.writeFileSync(file, html, "utf-8");
    console.log(`Saved HTML dump: ${file}`);
  } catch (e) {
    console.log("HTML dump failed:", e?.message || e);
  }
}

async function fillIfPresent(page, locator, value, label) {
  if (!value) return false;
  try {
    const el = page.locator(locator).first();
    if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
      await el.fill(value, { timeout: 5000 });
      console.log(`Filled ${label} using selector: ${locator}`);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

async function clickSubmit(page) {
  // Try common French labels first, then generic submit buttons.
  const candidates = [
    page.getByRole("button", { name: /se connecter/i }),
    page.getByRole("button", { name: /connexion/i }),
    page.getByRole("button", { name: /login/i }),
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
  ];

  for (const c of candidates) {
    try {
      if ((await c.count()) > 0 && (await c.first().isVisible().catch(() => false))) {
        await c.first().click({ timeout: 8000 });
        return true;
      }
    } catch {
      // try next
    }
  }

  // Fallback: press Enter in password field if exists
  try {
    const pwd = page.locator('input[type="password"]').first();
    if ((await pwd.count()) > 0) {
      await pwd.press("Enter");
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

async function waitForPostLogin(page) {
  // “Logged in” heuristics: any of these becoming true is enough.
  const conditions = [
    page.locator('input[type="hidden"][id^="idpl"]').first(), // your planning hidden inputs
    page.locator('input[type="hidden"][id^="idp"]').first(),  // broader
    page.locator("text=/déconnexion|logout/i").first(),
    page.locator("nav").first(),
  ];

  const startUrl = page.url();

  // Give the app time to redirect/load.
  await page.waitForLoadState("domcontentloaded").catch(() => null);

  const deadlineMs = 30000;
  const start = Date.now();

  while (Date.now() - start < deadlineMs) {
    // URL change can be a sign of login success
    const urlChanged = page.url() !== startUrl;

    for (const cond of conditions) {
      const visible = await cond.isVisible().catch(() => false);
      const exists = (await cond.count().catch(() => 0)) > 0;
      if (visible || exists || urlChanged) {
        return true;
      }
    }

    // If app loads data async, wait a bit.
    await page.waitForTimeout(500);
  }

  return false;
}

async function extractPlanningIds(page) {
  // Extract idple\d+ / idpls\d+ hidden inputs
  const items = await page.$$eval('input[type="hidden"]', (els) => {
    const out = [];
    for (const el of els) {
      const id = el.getAttribute("id") || "";
      const value = el.value || el.getAttribute("value") || "";
      if (/^idp(le|ls)\d+$/.test(id) && value) {
        out.push({
          inputId: id,
          id: value,
          type: id.includes("le") ? "entry" : "exit",
          day: id.replace("idple", "").replace("idpls", ""),
        });
      }
    }
    return out;
  });

  // De-duplicate by planning id
  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    if (!seen.has(it.id)) {
      seen.add(it.id);
      deduped.push(it);
    }
  }
  return deduped;
}

async function getCsrfToken(page) {
  // Support common CSRF patterns (ASP.NET MVC, etc.)
  const token = await page
    .locator('input[name="__RequestVerificationToken"]')
    .first()
    .inputValue()
    .catch(() => "");
  if (token) return { name: "__RequestVerificationToken", value: token };

  const meta = await page
    .locator('meta[name="csrf-token"], meta[name="xsrf-token"], meta[name="request-verification-token"]')
    .first()
    .getAttribute("content")
    .catch(() => "");
  if (meta) return { name: "csrf-meta", value: meta };

  return null;
}

(async () => {
  const CODE = process.env.PF_CODE || "";
  const LOGIN = process.env.PF_LOGIN || "";
  const PASSWORD = mustGetEnv("PF_PASSWORD");

  ensureDir(ARTIFACTS_DIR);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    viewport: { width: 1365, height: 768 },
  });
  const page = await context.newPage();

  if (TRACE) {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }

  try {
    console.log("Opening:", SITE);
    await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Best-effort fill for code / login / password (site may show only password, per your screenshot).
    // Try multiple selectors for each field.
    await fillIfPresent(page, ".code", CODE, "CODE (.code)");
    await fillIfPresent(page, 'input[name="code"]', CODE, "CODE (name=code)");
    await fillIfPresent(page, 'input[id*="code" i]', CODE, "CODE (id contains code)");
    await fillIfPresent(page, 'input[placeholder*="code" i]', CODE, "CODE (placeholder contains code)");

    await fillIfPresent(page, "#login", LOGIN, "LOGIN (#login)");
    await fillIfPresent(page, 'input[name="login"]', LOGIN, "LOGIN (name=login)");
    await fillIfPresent(page, 'input[name="username"]', LOGIN, "LOGIN (name=username)");
    await fillIfPresent(page, 'input[id*="login" i]', LOGIN, "LOGIN (id contains login)");
    await fillIfPresent(page, 'input[placeholder*="login" i]', LOGIN, "LOGIN (placeholder contains login)");
    await fillIfPresent(page, 'input[placeholder*="utilisateur" i]', LOGIN, "LOGIN (placeholder utilisateur)");

    // Password
    const pwdLoc = page.locator('input[type="password"]').first();
    await pwdLoc.waitFor({ state: "visible", timeout: 20000 });
    await pwdLoc.fill(PASSWORD);
    console.log("Filled PASSWORD");

    // Submit
    const submitted = await clickSubmit(page);
    if (!submitted) {
      await safeScreenshot(page, "no_submit_found");
      throw new Error("Could not find a submit action (button or Enter on password).");
    }

    // Wait for navigation / async post-login load
    await page.waitForLoadState("domcontentloaded").catch(() => null);
    const loggedIn = await waitForPostLogin(page);
    if (!loggedIn) {
      await safeScreenshot(page, "login_not_confirmed");
      await safeHtmlDump(page, "login_not_confirmed");
      throw new Error("Login could not be confirmed (no expected post-login elements found).");
    }

    console.log("Login seems successful. Current URL:", page.url());

    // If planning inputs load after XHR, give a short grace period.
    await page.waitForTimeout(1500);

    const planning = await extractPlanningIds(page);
    console.log(`Found planning IDs: ${planning.length}`);

    if (planning.length === 0) {
      await safeScreenshot(page, "no_planning_ids");
      await safeHtmlDump(page, "no_planning_ids");
      throw new Error("No planning hidden inputs found. The selector logic may not match the page you reach after login.");
    }

    const csrf = await getCsrfToken(page);
    if (csrf) console.log("CSRF token detected (will be sent if applicable).");

    let success = 0;
    let failed = 0;

    for (const item of planning) {
      const url = new URL("/adh/Adherents/etspln", page.url()).toString();

      // Form payload; include CSRF token if it’s an ASP.NET hidden field pattern.
      const form = { id: item.id, etat: "1" };
      if (csrf?.name === "__RequestVerificationToken") {
        form.__RequestVerificationToken = csrf.value;
      }

      try {
        const resp = await context.request.post(url, {
          form,
          headers: {
            "x-requested-with": "XMLHttpRequest",
            "referer": page.url(),
            // If your app uses meta-token CSRF, it’s often expected in a header:
            ...(csrf?.name === "csrf-meta" ? { "x-csrf-token": csrf.value } : {}),
          },
          timeout: 30000,
        });

        const status = resp.status();
        const ok = resp.ok();

        if (ok) {
          success++;
        } else {
          failed++;
          const body = await resp.text().catch(() => "");
          console.log(
            `FAILED validate id=${item.id} (${item.type}/${item.day}) status=${status} body_snippet=${body.slice(0, 200)}`
          );
        }
      } catch (e) {
        failed++;
        console.log(`ERROR validate id=${item.id} (${item.type}/${item.day}):`, e?.message || e);
      }

      // Avoid hammering the endpoint
      await page.waitForTimeout(250);
    }

    const result = { ok: failed === 0, total: planning.length, success, failed };
    console.log("RESULT:", result);

    if (TRACE) {
      const tracePath = path.join(ARTIFACTS_DIR, `${ts()}_trace.zip`);
      await context.tracing.stop({ path: tracePath });
      console.log(`Saved trace: ${tracePath}`);
    }

    await browser.close();
    process.exit(result.ok ? 0 : 2);
  } catch (e) {
    console.error("ERROR:", e?.stack || e);

    await safeScreenshot(page, "fatal");
    await safeHtmlDump(page, "fatal");

    if (TRACE) {
      try {
        const tracePath = path.join(ARTIFACTS_DIR, `${ts()}_trace_failed.zip`);
        await context.tracing.stop({ path: tracePath });
        console.log(`Saved trace: ${tracePath}`);
      } catch {}
    }

    await browser.close().catch(() => null);
    process.exit(1);
  }
})();