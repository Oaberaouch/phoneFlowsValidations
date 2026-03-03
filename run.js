// run.js
// Playwright bot: login (including clicking ".user-change-button" when needed),
// extract planning IDs from hidden inputs idple\d+ / idpls\d+,
// validate each via authenticated POST to /adh/Adherents/etspln,
// save artifacts (screenshot + html + optional trace) on failure.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const SITE = process.env.PF_SITE || "https://www.lm.phoneflows.ma/Login";
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

async function saveArtifacts(page, label) {
  try {
    ensureDir(ARTIFACTS_DIR);
    const png = path.join(ARTIFACTS_DIR, `${ts()}_${label}.png`);
    const html = path.join(ARTIFACTS_DIR, `${ts()}_${label}.html`);
    await page.screenshot({ path: png, fullPage: true });
    fs.writeFileSync(html, await page.content(), "utf-8");
    console.log(`Saved: ${png}`);
    console.log(`Saved: ${html}`);
  } catch (e) {
    console.log("Failed to save artifacts:", e?.message || e);
  }
}

async function maybeClickUserChange(page) {
  const btn = page.locator(".user-change-button").first();
  if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
    console.log("Double-clicking .user-change-button to reveal full login form...");
    await btn.dblclick({ timeout: 10000 }).catch(() => null);
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

async function fillField(page, selector, value, label) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "attached", timeout: 20000 });
  // If it might be hidden, attached is enough; fill still works for most inputs.
  // If your site blocks filling hidden inputs, change to {state:"visible"}.
  await loc.fill(value);
  console.log(`Filled ${label} (${selector})`);
}

async function submitLogin(page) {
  const submitCandidates = [
    page.getByRole("button", { name: /se connecter/i }),
    page.getByRole("button", { name: /connexion/i }),
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
  ];

  for (const c of submitCandidates) {
    try {
      if ((await c.count()) > 0 && (await c.first().isVisible().catch(() => false))) {
        console.log("Submitting by clicking submit button...");
        await Promise.all([
          page.waitForLoadState("domcontentloaded").catch(() => null),
          c.first().click({ timeout: 10000 }),
        ]);
        return true;
      }
    } catch {
      // continue
    }
  }

  // Fallback: form.submit()
  try {
    console.log("Submitting via form.submit() fallback...");
    const form = page.locator("form").first();
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => null),
      form.evaluate((f) => f.submit()),
    ]);
    return true;
  } catch {
    // continue
  }

  // Last fallback: press Enter in password field
  try {
    console.log("Submitting by pressing Enter in password field...");
    await page.locator("#password, input[type='password']").first().press("Enter");
    await page.waitForLoadState("domcontentloaded").catch(() => null);
    return true;
  } catch {
    return false;
  }
}

async function waitForPostLogin(page) {
  // Adjust/add a marker if you know a reliable element after login.
  const deadlineMs = 30000;
  const start = Date.now();
  const startUrl = page.url();

  while (Date.now() - start < deadlineMs) {
    const urlChanged = page.url() !== startUrl;

    const hasPlanningInputs =
      (await page.locator('input[type="hidden"][id^="idpl"]').count().catch(() => 0)) > 0 ||
      (await page.locator('input[type="hidden"][id^="idp"]').count().catch(() => 0)) > 0;

    const hasLogout =
      (await page.locator("text=/déconnexion|logout/i").count().catch(() => 0)) > 0;

    // Sometimes you stay on the same URL but the app transitions to a logged-in state.
    if (urlChanged || hasPlanningInputs || hasLogout) return true;

    // Also detect visible login error messages to fail faster (French/English variants).
    const loginError =
      (await page.locator("text=/mot de passe|incorrect|erreur|invalid/i").count().catch(() => 0)) > 0;
    if (loginError) return false;

    await page.waitForTimeout(500);
  }

  return false;
}

async function extractPlanningIds(page) {
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

  const seen = new Set();
  return items.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

async function getCsrfToken(page) {
  // If the server requires CSRF, we support two common patterns:
  // 1) ASP.NET hidden input __RequestVerificationToken
  // 2) meta csrf token -> send in header
  const aspnet = await page
    .locator('input[name="__RequestVerificationToken"]')
    .first()
    .inputValue()
    .catch(() => "");
  if (aspnet) return { kind: "aspnet", value: aspnet };

  const meta = await page
    .locator('meta[name="csrf-token"], meta[name="xsrf-token"], meta[name="request-verification-token"]')
    .first()
    .getAttribute("content")
    .catch(() => "");
  if (meta) return { kind: "meta", value: meta };

  return null;
}

(async () => {
  const CODE = mustGetEnv("PF_CODE");
  const LOGIN = mustGetEnv("PF_LOGIN");
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

    // The CI behavior you saw suggests code/login might be hidden until this is clicked.
    await maybeClickUserChange(page);

    // Wait for password field (most stable)
    await page.locator("#password, input[type='password']").first().waitFor({ state: "attached", timeout: 30000 });

    // Fill exactly like your working console snippet
    await fillField(page, ".code", CODE, "CODE");
    await fillField(page, "#login", LOGIN, "LOGIN");
    await fillField(page, "#password", PASSWORD, "PASSWORD");

    const submitted = await submitLogin(page);
    if (!submitted) {
      await saveArtifacts(page, "submit_failed");
      throw new Error("Could not submit login form.");
    }

    const loggedIn = await waitForPostLogin(page);
    if (!loggedIn) {
      await saveArtifacts(page, "login_not_confirmed");
      throw new Error("Login not confirmed (no redirect/post-login markers).");
    }

    console.log("Login confirmed. URL:", page.url());

    // Allow any async render
    await page.waitForTimeout(1500);

    const planning = await extractPlanningIds(page);
    console.log(`Found planning IDs: ${planning.length}`);

    if (planning.length === 0) {
      await saveArtifacts(page, "no_planning_ids");
      throw new Error("No planning IDs found after login.");
    }

    const csrf = await getCsrfToken(page);
    if (csrf) console.log(`CSRF detected: ${csrf.kind}`);

    let success = 0;
    let failed = 0;

    for (const item of planning) {
      const url = new URL("/adh/Adherents/etspln", page.url()).toString();

      const form = { id: item.id, etat: "1" };
      const headers = {
        "x-requested-with": "XMLHttpRequest",
        "referer": page.url(),
      };

      if (csrf?.kind === "aspnet") {
        form.__RequestVerificationToken = csrf.value;
      } else if (csrf?.kind === "meta") {
        headers["x-csrf-token"] = csrf.value;
      }

      try {
        const resp = await context.request.post(url, {
          form,
          headers,
          timeout: 30000,
        });

        if (resp.ok()) {
          success++;
        } else {
          failed++;
          const body = await resp.text().catch(() => "");
          console.log(
            `FAIL id=${item.id} (${item.type}/${item.day}) status=${resp.status()} body=${body.slice(0, 200)}`
          );
        }
      } catch (e) {
        failed++;
        console.log(`ERROR id=${item.id}:`, e?.message || e);
      }

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
    await saveArtifacts(page, "fatal");

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