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

async function saveFailureArtifacts(page, label) {
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

async function fillFirstVisible(page, candidates, value, label) {
  if (!value) return false;

  for (const c of candidates) {
    const loc =
      typeof c === "string" ? page.locator(c).first() : c.first();

    try {
      if ((await loc.count()) === 0) continue;

      // must be visible + editable
      const visible = await loc.isVisible().catch(() => false);
      if (!visible) continue;

      await loc.fill(value, { timeout: 5000 });
      console.log(`Filled ${label} using: ${typeof c === "string" ? c : "locator"}`);
      return true;
    } catch {
      // try next
    }
  }
  console.log(`Did not fill ${label} (no visible editable input found).`);
  return false;
}

async function clickSubmit(page) {
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
    } catch {}
  }

  // fallback: press Enter on password
  try {
    const pwd = page.locator('input[type="password"]').first();
    if ((await pwd.count()) > 0) {
      await pwd.press("Enter");
      return true;
    }
  } catch {}

  return false;
}

async function waitForPostLogin(page) {
  const startUrl = page.url();

  const deadlineMs = 30000;
  const start = Date.now();

  while (Date.now() - start < deadlineMs) {
    const url = page.url();
    const urlChanged = url !== startUrl;

    const hasPlanningInputs =
      (await page.locator('input[type="hidden"]').filter({ has: page.locator('[id^="idpl"]') }).count().catch(() => 0)) > 0 ||
      (await page.locator('input[type="hidden"][id^="idpl"]').count().catch(() => 0)) > 0 ||
      (await page.locator('input[type="hidden"][id^="idp"]').count().catch(() => 0)) > 0;

    const hasLogout =
      (await page.locator("text=/déconnexion|logout/i").count().catch(() => 0)) > 0;

    if (urlChanged || hasPlanningInputs || hasLogout) return true;

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
  const token = await page
    .locator('input[name="__RequestVerificationToken"]')
    .first()
    .inputValue()
    .catch(() => "");
  if (token) return { kind: "aspnet", value: token };

  const meta = await page
    .locator('meta[name="csrf-token"], meta[name="xsrf-token"], meta[name="request-verification-token"]')
    .first()
    .getAttribute("content")
    .catch(() => "");
  if (meta) return { kind: "meta", value: meta };

  return null;
}

(async () => {
  const PASSWORD = mustGetEnv("PF_PASSWORD");
  const CODE = process.env.PF_CODE || "";
  const LOGIN = process.env.PF_LOGIN || "";

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

    // Wait for the ONLY thing we know is visible from your screenshot: password input
    const pwd = page.locator('input[type="password"]').first();
    await pwd.waitFor({ state: "visible", timeout: 30000 });

    // Fill optional fields ONLY if a visible input exists (do not wait for .code; it can be hidden)
    await fillFirstVisible(
      page,
      [
        page.getByPlaceholder(/matricule/i),
        "input#code",
        'input[name="code"]',
        'input.form-control.code',
        'input[placeholder*="Matricule" i]',
      ],
      CODE,
      "CODE"
    );

    await fillFirstVisible(
      page,
      [
        "input#login",
        'input[name="login"]',
        'input[name="username"]',
        page.getByPlaceholder(/login|utilisateur|username/i),
      ],
      LOGIN,
      "LOGIN"
    );

    await pwd.fill(PASSWORD);

    const submitted = await clickSubmit(page);
    if (!submitted) {
      await saveFailureArtifacts(page, "no_submit");
      throw new Error("Could not submit login form (no button, Enter failed).");
    }

    await page.waitForLoadState("domcontentloaded").catch(() => null);

    const loggedIn = await waitForPostLogin(page);
    if (!loggedIn) {
      await saveFailureArtifacts(page, "login_not_confirmed");
      throw new Error("Login not confirmed (no redirect/post-login markers).");
    }

    console.log("Login seems OK. URL:", page.url());

    // Give async content a moment to render
    await page.waitForTimeout(1500);

    const planning = await extractPlanningIds(page);
    console.log(`Found planning IDs: ${planning.length}`);

    if (planning.length === 0) {
      await saveFailureArtifacts(page, "no_planning_ids");
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
    await saveFailureArtifacts(page, "fatal");

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