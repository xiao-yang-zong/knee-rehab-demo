const { chromium } = require('playwright');
const fs = require('fs');
const [,, BASE, OUT, FAKE, SCHEME = 'light'] = process.argv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODE = { seated_knee_extension: 'ext', seated_heel_slide: 'heel', chair_mini_squat: 'squat' };
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: SCHEME, permissions: ['camera'] });
  const page = await ctx.newPage();
  const log = { errors: [], external: [] };
  page.on('console', (m) => { if (m.type() === 'error') log.errors.push(m.text()); });
  page.on('pageerror', (e) => log.errors.push(String(e)));
  page.on('request', (r) => { const u = r.url(); if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:')) log.external.push(u); });
  await page.route('**/vendor/mediapipe/pose/pose.js', (r) => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(FAKE, 'utf8') }));
  await page.route('**/config/exercises.json', async (r) => {
    const res = await r.fetch(); const d = await res.json();
    d.exercises.forEach((e) => { if (e.holdSec) e.holdSec = 1; });
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(d) });
  });
  const R = {};
  const shot = async (name, full = false) => { await sleep(650); await page.screenshot({ path: `${OUT}/${SCHEME}-${name}.png`, fullPage: full }); };

  await page.goto(BASE + '/');
  await page.waitForSelector('[data-screen="welcome"]:not([hidden])');
  R.firstHash = await page.evaluate(() => location.hash);
  await shot('01-welcome');
  R.welcomeDisabled = await page.$eval('#welcome-go', (b) => b.disabled);
  await page.click('label:has(#consent-tool)'); await page.click('label:has(#consent-doctor)');
  await page.click('#welcome-go');
  await page.waitForSelector('[data-screen="setup"]:not([hidden])');
  await shot('02-setup1');
  await page.click('#setup-choices .choice[data-value="right_knee"]');
  await page.waitForFunction(() => location.hash === '#setup/2');
  await shot('03-setup2');
  await page.click('#setup-choices .choice[data-value="2to6w"]');
  await page.waitForFunction(() => location.hash === '#setup/3');
  await page.click('#setup-choices .choice[data-value="yes"]');
  await page.waitForFunction(() => location.hash === '#setup/4');
  await page.click('label:has(#reps-toggle)');
  for (let i = 0; i < 7; i++) await page.click('#reps-minus');
  await shot('04-setup4');
  R.reps = await page.textContent('#reps-value');
  await page.click('#setup-finish');
  await page.waitForSelector('[data-screen="plan"]:not([hidden])');
  await shot('05-plan');
  R.plan = await page.$$eval('#plan-list .row', (rs) => rs.map((r) => r.innerText.replace(/\n/g, ' ')));

  // 训练前确认（从计划页弹出）
  await page.click('[data-screen="plan"] [data-go="check"]');
  await page.waitForSelector('#check-layer.open');
  await shot('06-check');
  await page.click('#check-go');
  await page.waitForSelector('[data-screen="prep"]:not([hidden])');
  await shot('07-prep');
  await page.screenshot({ path: `${OUT}/${SCHEME}-07b-prep-full.png`, fullPage: true });

  for (let k = 0; k < 3; k++) {
    const hash = await page.evaluate(() => location.hash);
    const id = hash.split('/')[1];
    await page.evaluate((m) => { window.__FAKE_MODE = m; }, MODE[id]);
    await page.click('#start-btn');
    await page.waitForSelector('[data-screen="session"]:not([hidden])');
    await sleep(2500);
    if (k === 0) await page.screenshot({ path: `${OUT}/${SCHEME}-08-session.png` });
    try { await page.waitForSelector('[data-screen="after"]:not([hidden])', { timeout: 40000 }); }
    catch (e) { console.log('STUCK', k, id, await page.evaluate(() => [location.hash, document.querySelector('#hud-reps').textContent, document.querySelector('#prompt').textContent, document.querySelector('#hud-angle').textContent])); await page.screenshot({ path: `${OUT}/stuck-${k}.png` }); throw e; }
    if (k === 0) await shot('09-after');
    R[`after${k}`] = await page.textContent('#after-summary');
    await page.click(`#faces .face-btn[data-level="${k === 1 ? 'yellow' : 'green'}"]`);
    if (k === 0) await shot('10-after-picked');
    R[`next${k}`] = await page.textContent('#after-next');
    await page.click('#after-next');
    await sleep(500);
  }
  await page.waitForSelector('[data-screen="done"]:not([hidden])');
  await sleep(1400);
  await shot('11-done');
  await page.click('[data-screen="done"] a.btn.primary');
  await page.waitForSelector('[data-screen="today"]:not([hidden])');
  await shot('12-today-complete');
  await page.click('[data-tab="records"]');
  await page.waitForSelector('[data-screen="records"]:not([hidden])');
  await shot('13-records');
  await page.screenshot({ path: `${OUT}/${SCHEME}-13b-records-full.png`, fullPage: true });
  await page.evaluate(() => window.scrollTo(0, 400)); await shot('13c-records-scrolled');
  await page.click('[data-screen="records"] [data-action="report"]');
  await page.waitForSelector('#report-layer.open'); await shot('14-report');
  R.report = (await page.textContent('#report-text')).slice(0, 200);
  await page.click('#report-layer .nav-action'); await sleep(500);
  await page.click('#clear-btn'); await page.waitForSelector('#clear-layer.open'); await shot('15-clear');
  await page.click('#clear-layer .as-btn.strong'); await sleep(500);

  // 很疼：确认页拦截
  await page.goto(BASE + '/#today'); await page.reload();
  await page.waitForSelector('[data-screen="today"]:not([hidden])');
  await shot('15b-today-reload');
  await page.click('#today-start');
  await page.waitForSelector('#check-layer.open');
  await page.$eval('#pain', (el) => { el.value = 6; el.dispatchEvent(new Event('input')); });
  await shot('16-check-pain6');
  await page.click('#check-go'); await shot('17-check-stop');
  await page.click('#check-stop [data-sheet-close]'); await sleep(500);
  R.afterStopHash = await page.evaluate(() => location.hash);

  // 后退键：从记录页进关于页再后退
  await page.click('[data-tab="records"]'); await sleep(400);
  await page.click('[data-screen="records"] a[href="#about"]'); await page.waitForSelector('[data-screen="about"]:not([hidden])'); await shot('18-about');
  await page.click('[data-screen="about"] [data-back]'); await sleep(500);
  R.backFromAbout = await page.evaluate(() => location.hash);

  // 清除全部数据 → 回到欢迎页
  await page.click('#clear-btn'); await page.waitForSelector('#clear-layer.open');
  await page.click('#clear-yes'); await sleep(800);
  R.afterClearHash = await page.evaluate(() => location.hash);
  R.sw = await page.evaluate(() => document.documentElement.scrollWidth);
  R.errors = log.errors; R.external = log.external;
  console.log(JSON.stringify(R, null, 2));
  await browser.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
