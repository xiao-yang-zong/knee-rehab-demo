const { chromium } = require('playwright');
const [,, BASE, OUT] = process.argv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch();
  const R = {};
  for (const [name, opts] of [['phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }], ['desktop', { viewport: { width: 1280, height: 800 } }], ['reduced', { viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }]]) {
    const ctx = await b.newContext(opts); const p = await ctx.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await p.goto(BASE + '/'); await p.waitForSelector('#welcome-go');
    await p.click('label:has(#consent-tool)'); await p.click('label:has(#consent-doctor)'); await p.click('#welcome-go');
    await p.waitForSelector('[data-screen="setup"]:not([hidden])');
    await p.click('#setup-skip'); await p.waitForSelector('[data-screen="today"]:not([hidden])'); await sleep(600);
    await p.screenshot({ path: `${OUT}/x-${name}-today-generic.png` });
    R[name + '_note'] = await p.textContent('#today-note');
    await p.reload(); await p.waitForSelector('#today-setup:not([hidden])'); await sleep(600);
    await p.screenshot({ path: `${OUT}/x-${name}-today-noplan.png` });
    R[name + '_todayButtons'] = await p.$$eval('#today-setup .btn', (bs) => bs.map((x) => x.textContent.trim()));
    // 直接打开 #prep 应先弹出确认
    await p.goto(BASE + '/#prep/seated_heel_slide'); await sleep(800);
    R[name + '_deeplinkPrep'] = await p.evaluate(() => [location.hash, !document.querySelector('#check-layer').hidden]);
    await p.click('#check-go'); await sleep(700);
    R[name + '_afterCheck'] = await p.evaluate(() => location.hash);
    await p.click('[data-screen="prep"] [data-back]'); await sleep(700);
    R[name + '_backFromPrep'] = await p.evaluate(() => location.hash);
    R[name + '_sw'] = await p.evaluate(() => document.documentElement.scrollWidth);
    R[name + '_errors'] = errs;
    await ctx.close();
  }
  console.log(JSON.stringify(R, null, 2)); await b.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
