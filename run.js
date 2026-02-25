const { chromium } = require('playwright');

const SITE = 'https://www.lm.phoneflows.ma/';

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

(async () => {
  const CODE = mustGetEnv('PF_CODE');
  const LOGIN = mustGetEnv('PF_LOGIN');
  const PASSWORD = mustGetEnv('PF_PASSWORD');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(SITE, { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('.code', { timeout: 20000 });
  await page.fill('.code', CODE);
  await page.fill('#login', LOGIN);
  await page.fill('#password', PASSWORD);

  // submit
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => null),
    page.press('#password', 'Enter').catch(() => null)
  ]);

  // adjust selector if needed to confirm you're logged in
  await page.waitForSelector('input[type="hidden"][id^="idpl"]', { timeout: 30000 });

  const result = await page.evaluate(async () => {
    if (typeof window.$ !== 'function') {
      return { ok: false, error: 'jQuery not found; your script depends on $/$.ajax' };
    }

    return await new Promise((resolve) => {
      (function validateAllPlanning() {
        var planningIds = [];

        $('input[type="hidden"]').each(function() {
          var inputId = $(this).attr('id') || '';
          var value = $(this).val();

          if (inputId.match(/^idp(le|ls)\d+$/) && value) {
            planningIds.push({
              id: value,
              day: inputId.replace('idple', '').replace('idpls', ''),
              type: inputId.indexOf('le') > 0 ? 'entry' : 'exit'
            });
          }
        });

        var index = 0, success = 0, failed = 0;

        function validateNext() {
          if (index >= planningIds.length) {
            resolve({ ok: true, total: planningIds.length, success, failed });
            return;
          }

          var item = planningIds[index];

          $.ajax({
            url: '/adh/Adherents/etspln',
            type: 'POST',
            data: { id: item.id, etat: 1 },
            success: function() { success++; },
            error: function() { failed++; },
            complete: function() { index++; setTimeout(validateNext, 250); }
          });
        }

        validateNext();
      })();
    });
  });

  console.log('RESULT:', result);
  await browser.close();

  process.exit(result.ok ? 0 : 2);
})().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
