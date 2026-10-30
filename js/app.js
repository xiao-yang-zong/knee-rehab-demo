// 入口：读取配置、页面路由与转场、把摄像头 → 关键点 → 膝角 → 计数 → 语音 串起来。
// 动作标准、安全规则、文案都在 config/ 里，这里只放流程和界面。
//
// v0.8 界面流程（2026-10-28 改版，按 iOS 的导航习惯）：
//   第一次：欢迎（确认免责声明 + 医生允许）→ 我的情况（一题一屏）→ 你的计划
//   每次：  今天 →（底部弹出）训练前确认 →（右滑进入）动作准备 →（全屏）训练中 → 这组怎么样 → 下一个 / 今天完成
//   底部标签：今天、课程、康复师、记录（v1.0 加了课程和康复师）。训练流程里隐藏标签栏。
//   地址栏 hash 就是路由：#welcome #setup/1..4 #plan #today #check #prep/<动作id> #session #after #done #records #tips #about
//                        #courses #course/<课程id> #therapists
//   课程里的动作走和“今天”完全相同的流程（训练前确认 → 动作准备 → 训练中 → 这组怎么样），只是“下一个”按课程顺序。

import { angleDeg } from './angle.js';
import { createCounter, createSmoother } from './counter.js';
import { startCamera, stopCamera, startVideoFile, stopVideo, createPoseTracker, pickLeg, prefetchModel } from './pose.js';
import { drawFrame } from './draw.js';
import * as voice from './voice.js';
import * as store from './storage.js';
import { createAngleRange, bestValue, summarize, progressMessage } from './progress.js';
import { weekSummary, summaryText, buildReport } from './summary.js';
import { buildPlan, normalizeProfile, splitPart, partOf, jointOf } from './plan.js';
import { demoSVG, pauseIfReducedMotion } from './demo.js';
import { createBoneCheck } from './bones.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const MODEL_TIMEOUT_MS = 25000;
const CAMERA_TIMEOUT_MS = 10000;
const LOW_FPS = 10;           // 每秒处理不到 10 帧时，计数和角度可能不准
const LOW_FPS_GRACE_SEC = 5;  // 模型刚启动时帧率不稳，前 5 秒不提示
const RED_NOTICE_HOURS = 48;
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// 转场：往前走从右滑入（push），后退或回到标签页向右滑出（pop），标签之间、进出训练全屏用淡入淡出
const SCREENS = {
  welcome: {},
  today: { tab: true },
  courses: { tab: true },
  therapists: { tab: true },
  records: { tab: true },
  course: {},
  setup: {},
  plan: {},
  tips: {},
  about: {},
  prep: {},
  session: { full: true },
  after: {},
  done: {},
};

const app = {
  exercises: [],
  safety: null,
  copy: null,
  planRules: null,
  profile: null,        // 我的情况（没填为 null）
  skipSetup: false,     // 本次打开页面选了“先用通用计划”
  passedSafety: false,  // 本次打开页面是否完成了训练前确认
  painBefore: null,
  pendingPrep: null,    // 确认完要进入的动作
  side: null,           // 拍哪条腿（null = 跟随我的情况）
  facing: 'user',       // 用哪个摄像头：user 前置 / environment 后置
  session: null,        // 正在进行的训练
  lastResult: null,     // 刚结束的一组（“这组怎么样”页用）
  draft: null,          // 我的情况：填写中的答案
  screen: null,         // 当前显示的页面
  stack: [],            // 本次打开页面后的浏览记录（用于返回按钮和判断后退）
  replacing: false,     // 下一次 hashchange 来自 location.replace
  prepError: '',        // 摄像头出错时留给“动作准备”页显示的提示
  course: null,         // 从课程进入训练时：{ id }；从“今天”进入时为 null
  courses: null,        // config/courses.json
  therapists: null,     // config/therapists.json
  courseFilter: null,   // 课程页的关节筛选：null 全部 / 'knee' / 'ankle'
  therapistFilter: null,
};

// 角度函数是否可用（防止 js/angle.js 被改坏时页面静默失效）
const angleReady = Number.isFinite(angleDeg({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 0, y: 200 }));

async function loadJSON(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`读取 ${path} 失败（${res.status}）`);
  return res.json();
}

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = '') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;

// ---------------- 计划 ----------------

function hasPlan() {
  return !!app.profile || app.skipSetup;
}

const currentJoint = () => app.profile?.joint || 'knee';
const JOINT_WORD = { knee: '膝盖', ankle: '脚踝' };
const JOINT_NAME = { knee: '膝关节', ankle: '踝关节' };
const jointWord = (j = currentJoint()) => JOINT_WORD[j] || '膝盖';
const partLabel = (p) => app.planRules.copy.parts.find((x) => x.value === partOf(p))?.label || '';

function currentPlan() {
  return buildPlan({
    exercises: app.exercises,
    profile: app.profile,
    rules: app.planRules,
    painToday: app.passedSafety ? app.painBefore : null,
    records: store.getRecords(),
  });
}

function planItems(plan = currentPlan()) {
  return plan.items.map((i) => i.exercise);
}

function uniqueReasons(plan) {
  return [...new Set([...plan.items.flatMap((i) => i.reasons), ...plan.excluded.map((e) => e.reason)])];
}

// 下一个今天还没做的动作；afterId 给定时从它后面开始找
function nextUndone(afterId = null) {
  const items = planItems();
  const done = store.doneTodayIds();
  const i = afterId ? items.findIndex((ex) => ex.id === afterId) : -1;
  const order = [...items.slice(i + 1), ...items.slice(0, i + 1)];
  return order.find((ex) => !done.has(ex.id)) || null;
}

function exMeta(ex) {
  return ex.holdSec > 0 ? `${ex.reps} 次 · 每次保持 ${ex.holdSec} 秒` : `${ex.reps} 次`;
}

// 粗略时长：每次动作约 4 秒 + 保持时间，每个动作另加 30 秒准备
function planMinutes(items) {
  const sec = items.reduce((s, ex) => s + ex.reps * (4 + (ex.holdSec || 0)) + 30, 0);
  return Math.max(1, Math.round(sec / 60));
}

// ---------------- 路由与转场 ----------------

function parseHash() {
  const [name = 'today', arg = null] = (location.hash || '#today').slice(1).split('/');
  return { name, arg };
}

function go(hash, { replace = false } = {}) {
  if (location.hash === hash) { route(); return; }
  if (replace) { app.replacing = true; location.replace(hash); } else location.hash = hash;
}

function goBack(fallback) {
  if (app.stack.length > 1) history.back();
  else go(fallback, { replace: true });
}

// 返回 true 表示这次是后退
function trackStack() {
  const h = location.hash || '#today';
  const s = app.stack;
  if (app.replacing) {
    app.replacing = false;
    if (s.length) s[s.length - 1] = h; else s.push(h);
    return false;
  }
  if (s.length > 1 && s[s.length - 2] === h) { s.pop(); return true; }
  if (s[s.length - 1] !== h) s.push(h);
  return false;
}

function guard({ name, arg }) {
  const onboarded = store.isOnboarded();
  if (!onboarded && name !== 'welcome' && name !== 'about') return '#welcome';
  if (onboarded && name === 'welcome') return '#today';
  if (name === 'check' && !store.isOnboarded()) return '#welcome';
  if (name === 'setup' && !['1', '2', '3', '4'].includes(arg)) return '#setup/1';
  if (name === 'plan' && !hasPlan()) return '#setup/1';
  if (name === 'prep' && !app.passedSafety) { app.pendingPrep = arg; return '#check'; }
  if (name === 'session' && !app.session) return app.lastResult ? '#after' : '#today';
  if (name === 'after' && !app.lastResult) return '#today';
  if (name === 'course' && !app.courses?.courses.some((c) => c.id === arg)) return '#courses';
  if (name !== 'check' && !SCREENS[name]) return '#today';
  return null;
}

function route() {
  const target = parseHash();
  const redirect = guard(target);
  if (redirect) { go(redirect, { replace: true }); return; }
  const isBack = trackStack();

  const { name, arg } = target;
  if (name !== 'session') endSession({ save: false });

  const isSheet = name === 'check';
  // 确认页从底部弹出，盖在当前页面上（今天或计划页）；直接打开 #check 时盖在“今天”上
  const under = ['today', 'plan'].includes(app.screen) ? app.screen : 'today';
  const screen = isSheet ? under : name;
  const prev = app.screen;
  const changed = prev !== screen;

  closeSheets({ except: isSheet ? 'check-layer' : null });

  const render = () => {
    if (changed) showScreen(screen);
    renderScreen(screen, arg);
    if (changed) window.scrollTo(0, 0);
    updateNavbars();
  };

  if (changed && prev) withTransition(transitionFor(prev, screen, isBack), render);
  else render();

  if (isSheet) openCheck();
}

function transitionFor(from, to, isBack) {
  const a = SCREENS[from];
  const b = SCREENS[to];
  if (!a || !b) return null;
  if (a.full || b.full) return 'fade';
  if (a.tab && b.tab) return 'fade';
  if (isBack || b.tab) return 'pop';
  return 'push';
}

function withTransition(dir, fn) {
  if (!dir || !document.startViewTransition || reduceMotion()) { fn(); return; }
  const root = document.documentElement;
  root.dataset.nav = dir;
  const t = document.startViewTransition(fn);
  t.finished.finally(() => { delete root.dataset.nav; });
}

function showScreen(name) {
  app.screen = name;
  $$('[data-screen]').forEach((el) => { el.hidden = el.dataset.screen !== name; });
  const tab = SCREENS[name]?.tab;
  $('#tabbar').hidden = !tab;
  $$('[data-tab]').forEach((a) => {
    const on = a.dataset.tab === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.documentElement.classList.toggle('in-session', name === 'session');
}

function renderScreen(name, arg) {
  switch (name) {
    case 'welcome': return renderWelcome();
    case 'setup': return renderSetup(Number(arg));
    case 'plan': return renderPlanResult();
    case 'today': return renderToday();
    case 'prep': return renderPrep(arg);
    case 'session': return undefined;
    case 'after': return renderAfter();
    case 'done': return renderDone();
    case 'records': return renderRecords();
    case 'courses': return renderCourses();
    case 'course': return renderCourse(arg);
    case 'therapists': return renderTherapists();
    case 'tips': return renderTips();
    case 'about': return renderAbout();
    default: return undefined;
  }
}

// 大标题滚出屏幕后，顶部导航栏显示小标题和分隔线（iOS 的做法）
function updateNavbars() {
  const scrolled = window.scrollY > 36;
  $$('.screen:not([hidden]) .navbar').forEach((n) => n.classList.toggle('scrolled', scrolled));
}

// ---------------- 底部弹出页 ----------------

function openLayer(id) {
  const layer = document.getElementById(id);
  if (!layer.hidden && layer.classList.contains('open')) return;
  layer.hidden = false;
  document.documentElement.classList.add('sheet-open');
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('open')));
}

function closeLayer(layer) {
  if (layer.hidden) return;
  layer.classList.remove('open');
  const done = () => {
    if (layer.classList.contains('open')) return;
    layer.hidden = true;
    if (!$$('.sheet-layer').some((l) => !l.hidden)) document.documentElement.classList.remove('sheet-open');
  };
  if (reduceMotion()) done(); else setTimeout(done, 380);
}

function closeSheets({ except = null } = {}) {
  $$('.sheet-layer').forEach((l) => { if (l.id !== except) closeLayer(l); });
}

function onSheetClose(layer) {
  if (layer.id === 'check-layer' && parseHash().name === 'check') goBack('#today');
  else closeLayer(layer);
}

let toastTimer = null;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 300); }, 2200);
}

// ---------------- 欢迎（第一次） ----------------

function renderWelcome() {
  const ui = app.copy.ui;
  $('#consent-tool-label').textContent = ui.consentTool;
  $('#consent-doctor-label').textContent = app.copy.doctorConfirmLabel;
  syncWelcome();
}

function syncWelcome() {
  $('#welcome-go').disabled = !($('#consent-tool').checked && $('#consent-doctor').checked);
}

function onWelcomeGo() {
  store.setOnboarded(true);
  store.setDoctorConfirmed(true);
  app.draft = null;
  go('#setup/1', { replace: true });
}

// ---------------- 我的情况：一题一屏 ----------------

function setupQuestions() {
  const c = app.planRules.copy;
  return [
    { key: 'part', q: c.partLabel, hint: '只安排这个关节的训练动作，训练时拍这一侧。', options: c.parts },
    { key: 'stage', q: c.stageLabel, hint: '不同阶段的目标角度和次数不一样。说不清就选“说不清”，我们按最保守的早期标准安排。', options: app.planRules.stages.map((s) => ({ value: s.id, label: s.label })) },
    { key: 'stand', q: c.standLabel, hint: '也就是站着时患腿能不能踩地用力。不确定就选“不确定”，我们先不安排站立动作。', options: c.stands },
    { key: 'reps', q: '康复师有没有交代每个动作做几次？', hint: '' },
  ];
}

function renderSetup(n) {
  if (!app.draft) {
    const p = app.profile || {};
    app.draft = { part: partOf(app.profile), stage: p.stage, stand: p.stand, clinicianReps: p.clinicianReps || null, maxFlexion: p.maxFlexion || null };
  }
  const qs = setupQuestions();
  const q = qs[n - 1];
  $('#setup-count').textContent = `第 ${n} 题，共 4 题`;
  $('#setup-question').textContent = q.q;
  $('#setup-hint').textContent = q.hint;
  $('#setup-hint').hidden = !q.hint;
  $$('#setup-steps i').forEach((el, i) => el.classList.toggle('on', i < n));
  $('#setup-skip').textContent = app.profile ? '取消' : '跳过';

  const box = $('#setup-choices');
  const isReps = q.key === 'reps';
  box.hidden = isReps;
  $('#setup-reps').hidden = !isReps;
  $('#setup-bar').hidden = !isReps;
  if (isReps) {
    const on = !!app.draft.clinicianReps;
    $('#reps-toggle').checked = on;
    $('#reps-value').textContent = app.draft.clinicianReps || 10;
    $('#reps-stepper-row').hidden = !on;
    // 医嘱护栏：只对膝关节
    const isKnee = splitPart(app.draft.part)?.joint !== 'ankle';
    $('#guard-group').hidden = !isKnee;
    $('#guard-note').hidden = !isKnee;
    const g = app.planRules.guard;
    const gOn = isKnee && !!app.draft.maxFlexion;
    $('#guard-toggle').checked = gOn;
    $('#guard-value').textContent = app.draft.maxFlexion || g.default;
    $('#guard-stepper-row').hidden = !gOn;
    return;
  }
  box.innerHTML = q.options.map((o) => `
    <button type="button" class="row choice${app.draft[q.key] === o.value ? ' selected' : ''}" role="radio"
      aria-checked="${app.draft[q.key] === o.value}" data-value="${esc(o.value)}">
      <span class="row-text">${esc(o.label)}</span>${icon('check', 'tickmark')}
    </button>`).join('');
  box.querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => {
    app.draft[q.key] = b.dataset.value;
    box.querySelectorAll('.choice').forEach((x) => {
      const on = x === b;
      x.classList.toggle('selected', on);
      x.setAttribute('aria-checked', String(on));
    });
    // 点选后稍停一下再自动进入下一题，让用户看到勾选反馈
    setTimeout(() => { if (parseHash().name === 'setup' && parseHash().arg === String(n)) go(`#setup/${n + 1}`); }, 260);
  }));
}

function setRepsValue(delta) {
  const v = Math.min(Math.max(Number($('#reps-value').textContent) + delta, app.planRules.repsMin), app.planRules.repsMax);
  $('#reps-value').textContent = v;
  if ($('#reps-toggle').checked) app.draft.clinicianReps = v;
}

function setGuardValue(delta) {
  const g = app.planRules.guard;
  const v = Math.min(Math.max(Number($('#guard-value').textContent) + delta * g.step, g.min), g.max);
  $('#guard-value').textContent = v;
  if ($('#guard-toggle').checked) app.draft.maxFlexion = v;
}

function onSetupFinish() {
  const d = app.draft;
  const part = splitPart(d.part);
  const profile = normalizeProfile({
    ...d, ...(part || {}),
    clinicianReps: $('#reps-toggle').checked ? Number($('#reps-value').textContent) : null,
    maxFlexion: $('#guard-toggle').checked && part?.joint === 'knee' ? Number($('#guard-value').textContent) : null,
  }, app.planRules);
  if (!profile) { go('#setup/1', { replace: true }); return; }
  app.profile = profile;
  app.side = null;
  app.draft = null;
  store.setProfile(profile);
  go('#plan');
}

function onSetupSkip() {
  app.draft = null;
  if (!app.profile) app.skipSetup = true;
  go('#today');
}

// ---------------- 计划结果 ----------------

function planRow(ex, i, done) {
  return `<div class="row plan-row${done ? ' done' : ''}">
      <span class="num">${done ? icon('check') : i + 1}</span>
      <span class="row-text"><strong>${esc(ex.name)}</strong><small>${esc(exMeta(ex))}</small></span>
    </div>`;
}

function excludedRow(e) {
  const why = e.reason === app.planRules.copy.reasons.standExcluded ? '今天不做 · 医生允许站立承重后再加' : '今天不做 · 超出医生给的角度上限';
  return `<div class="row plan-row skipped"><span class="num">–</span>
      <span class="row-text"><strong>${esc(e.exercise.name)}</strong><small>${esc(why)}</small></span></div>`;
}

function renderPlanResult() {
  const plan = currentPlan();
  const items = planItems(plan);
  $('#plan-sub').textContent = `${items.length} 个动作 · 约 ${planMinutes(items)} 分钟`;
  $('#plan-list').innerHTML = items.map((ex, i) => planRow(ex, i, false)).join('') + plan.excluded.map((e) => excludedRow(e)).join('');
  const reasons = uniqueReasons(plan);
  $('#plan-reasons').innerHTML = reasons.map((r) => `<li>${esc(r)}</li>`).join('');
  $('#plan-why').hidden = !reasons.length;
  $('#plan-why').open = false;
  $('#plan-note').textContent = plan.personalized ? app.planRules.copy.planNote : app.planRules.copy.defaultNote;
}

// ---------------- 今天 ----------------

function weekdayLabel(d) {
  return `${d.getMonth() + 1}月${d.getDate()}日 星期${'日一二三四五六'[d.getDay()]}`;
}

function recentRed(records) {
  const last = [...records].reverse().find((r) => r.painAfter);
  return last && last.painAfter === 'red' && Date.now() - new Date(last.date).getTime() < RED_NOTICE_HOURS * 3600 * 1000;
}

function renderToday() {
  const records = store.getRecords();
  $('#today-date').textContent = weekdayLabel(new Date());
  $('#today-red').hidden = !recentRed(records);
  $('#today-red-text').textContent = app.copy.redYesterdayNotice;

  const showSetup = !hasPlan();
  $('#today-setup').hidden = !showSetup;
  $('#today-plan').hidden = showSetup;
  $('#today-bar').hidden = showSetup;
  if (showSetup) {
    $('#today-setup-art').innerHTML = demoSVG('seated_knee_extension', '坐姿伸膝示意');
    pauseIfReducedMotion($('#today-setup-art'));
  } else {
    const plan = currentPlan();
    const items = planItems(plan);
    const done = store.doneTodayIds(records);
    const doneCount = items.filter((ex) => done.has(ex.id)).length;
    const all = items.length > 0 && doneCount === items.length;
    $('#today-ring').style.setProperty('--p', items.length ? (doneCount / items.length) * 100 : 0);
    $('#today-ring').classList.toggle('complete', all);
    $('#today-ring').classList.toggle('zero', doneCount === 0);
    $('#today-plan-title').textContent = all ? '今天的训练完成了' : '今天的训练';
    $('#today-plan-sub').textContent = all ? `${items.length} 个动作都做完了，做得很好` : `已完成 ${doneCount} / ${items.length} · 约 ${planMinutes(items.filter((ex) => !done.has(ex.id)))} 分钟`;
    $('#today-list').innerHTML = items.map((ex, i) => `
      <button type="button" class="row link-row plan-row${done.has(ex.id) ? ' done' : ''}" data-ex="${ex.id}">
        <span class="num">${done.has(ex.id) ? icon('check') : i + 1}</span>
        <span class="row-text"><strong>${esc(ex.name)}</strong><small>${esc(exMeta(ex))}</small></span>
        ${icon('chev', 'chev')}
      </button>`).join('') + plan.excluded.map((e) => excludedRow(e)).join('');
    $('#today-list').querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('click', () => startFlow(b.dataset.ex)));
    if (!items.length) $('#today-list').innerHTML = '<div class="row"><span class="row-text">这个关节今天没有可以安排的动作，请按医生或康复师的要求训练。</span></div>';
    $('#today-note').innerHTML = plan.personalized
      ? esc(app.planRules.copy.planNote)
      : `这是通用计划。<a class="link" href="#setup/1">按我的情况生成</a>`;
    const next = nextUndone();
    $('#today-start').textContent = all ? '再练一组' : doneCount ? `继续：${next.name}` : '开始训练';
    $('#today-start').dataset.ex = (next || items[0])?.id || '';
  }

  const stats = $('#today-stats');
  if (records.length) {
    const streak = store.streakDays(records);
    const ws = weekSummary(records);
    stats.innerHTML = `<span class="r-icon orange">${icon('flame')}</span>
      <span class="row-text">${streak ? `已连续训练 ${streak} 天` : '最近 7 天'} · 本周完成 ${ws.sets} 组</span>${icon('chev', 'chev')}`;
    stats.hidden = false;
  } else stats.hidden = true;
}

// 从“今天”进入某个动作：还没做训练前确认就先弹出确认
// course：从课程进入时传 { id }，“下一个”按课程顺序；从“今天”进入时不传
function startFlow(id, course = null) {
  if (!id) return;
  app.course = course;
  app.pendingPrep = id;
  if (app.passedSafety) go(`#prep/${id}`);
  else go('#check');
}

// ---------------- 训练前确认（底部弹出） ----------------

function painWord(v) {
  const w = app.copy.ui.painWords;
  if (v === 0) return w[0];
  if (v <= 3) return w[1];
  if (v <= 4) return w[2];
  if (v <= 6) return w[3];
  return w[4];
}

function setPain(v) {
  $('#pain').value = v;
  $('#pain-value').textContent = v;
  $('#pain-word').textContent = painWord(v);
  const level = v >= app.safety.painStopThreshold ? 'red' : v >= 3 ? 'yellow' : 'green';
  $('.pain-card').dataset.level = level;
  $('#pain').style.setProperty('--fill', `${v * 10}%`);
}

function openCheck() {
  const { safety, copy } = app;
  const needDoctor = safety.requireDoctorConfirmation && !store.isDoctorConfirmed();
  $('#check-doctor').hidden = !needDoctor;
  $('#check-doctor-label').textContent = copy.doctorConfirmLabel;
  $('#doctor-confirm').checked = false;
  const jw = jointWord(app.pendingPrep ? jointOf(app.exercises.find((e) => e.id === app.pendingPrep)) : currentJoint());
  $('#pain-head-text').textContent = `现在${jw}疼吗？`;
  $('#symptoms').innerHTML = safety.symptoms.map((s, i) => `
    <label class="row"><span class="row-text">${esc(s.replaceAll('膝盖', jw))}</span><input type="checkbox" class="switch" name="symptom" value="${i}" /></label>`).join('');
  setPain(Number.isFinite(app.painBefore) ? app.painBefore : 0);
  $('#check-foot').textContent = fill(copy.ui.checkFoot, { n: safety.painStopThreshold });
  $('#check-error').hidden = true;
  $('#check-form-wrap').hidden = false;
  $('#check-stop').hidden = true;
  openLayer('check-layer');
}

function onCheckGo() {
  const { safety } = app;
  if (!$('#check-doctor').hidden && !$('#doctor-confirm').checked) {
    $('#check-error').textContent = '需要先确认医生允许你在家训练，才能开始。';
    $('#check-error').hidden = false;
    return;
  }
  if (!$('#check-doctor').hidden) store.setDoctorConfirmed(true);
  const pain = Number($('#pain').value);
  const symptoms = $$('input[name="symptom"]:checked');
  if (pain >= safety.painStopThreshold || symptoms.length > 0) {
    $('#seek-care-text').textContent = safety.seekCareMessage;
    $('#check-form-wrap').hidden = true;
    $('#check-stop').hidden = false;
    return;
  }
  app.passedSafety = true;
  app.painBefore = pain;
  const id = app.pendingPrep || nextUndone()?.id || planItems()[0]?.id;
  app.pendingPrep = null;
  go(`#prep/${id}`, { replace: true });
}

// ---------------- 动作准备 ----------------

// 今天计划里的动作；不在计划里（从课程进入别的关节的动作）时，按同样的规则单独算一份
function findPlanExercise(id) {
  const inPlan = planItems().find((ex) => ex.id === id);
  if (inPlan) return inPlan;
  const all = buildPlan({
    exercises: app.exercises, profile: app.profile, rules: app.planRules,
    painToday: app.passedSafety ? app.painBefore : null, records: store.getRecords(), anyJoint: true,
  });
  return all.items.find((i) => i.exercise.id === id)?.exercise || null;
}

// 课程里某个动作今天能不能做：返回 null 表示可以，否则是原因（例如医生还没允许站立承重）
function blockedReason(id) {
  if (!app.profile) return null;
  const all = buildPlan({ exercises: app.exercises, profile: app.profile, rules: app.planRules, anyJoint: true });
  return all.excluded.find((e) => e.exercise.id === id)?.reason || null;
}

// “第几个，共几个”：从课程进入按课程算，否则按今天的计划
function positionText(id) {
  const c = app.course && app.courses?.courses.find((x) => x.id === app.course.id);
  const ids = c ? courseExerciseIds(c) : planItems().map((x) => x.id);
  const i = ids.indexOf(id);
  const where = c ? `${c.short || c.title} · ` : '';
  return i >= 0 ? `${where}第 ${i + 1} 个，共 ${ids.length} 个` : '单独练习';
}

function renderPrep(id) {
  const items = planItems();
  const ex = findPlanExercise(id);
  if (!ex) { go(items[0] ? `#prep/${items[0].id}` : '#today', { replace: true }); return; }
  app.prepId = ex.id;
  prefetchModel(); // 用户看说明时后台下载模型，点“开始”少等十几秒
  $('#prep-count').textContent = positionText(ex.id);
  $$('[data-screen="prep"] [data-back] span').forEach((sp) => { sp.textContent = app.course ? '课程' : '今天'; });
  // 透明分级：告诉用户系统能判断什么、不能判断什么
  $('#prep-judge').textContent = '摄像头自动计数 · 角度仅供参考';
  $('#prep-guard').hidden = !ex.guardNote;
  $('#prep-guard-text').textContent = ex.guardNote || '';
  $('#prep-name').textContent = ex.name;
  $('#prep-nav-title').textContent = ex.name;
  $('#prep-meta').textContent = exMeta(ex);
  $('#angle-banner').hidden = angleReady;
  $('#angle-banner').textContent = 'js/angle.js 的角度函数不可用，角度和计数暂时无法工作。请运行 npm run test:angle 检查。';

  const demo = $('#prep-demo');
  if (ex.video) {
    demo.innerHTML = `<video src="${esc(ex.video)}" playsinline muted loop autoplay controls></video>`;
  } else {
    demo.innerHTML = demoSVG(ex.id, `${ex.name}示意`) + '<p class="demo-cap">示意动画，跟着做大致动作即可</p>';
    pauseIfReducedMotion(demo);
  }
  demo.hidden = !demo.innerHTML;

  $('#prep-steps').innerHTML = `<li class="row prep-posture"><span class="num ghost">${icon('person')}</span><span class="row-text">${esc(ex.posture)}</span></li>`
    + ex.steps.map((s, k) => `<li class="row"><span class="num">${k + 1}</span><span class="row-text">${esc(s)}</span></li>`).join('');
  $('#prep-camera').textContent = ex.camera;
  $('#prep-caution').textContent = ex.caution || '';
  $('#prep-angle-note').textContent = app.copy.angleNote || '';
  const side = app.side || app.profile?.side || 'auto';
  renderSegmented($('#prep-side'), [
    { value: 'left', label: '左侧' }, { value: 'right', label: '右侧' }, { value: 'auto', label: '自动' },
  ], side, (v) => { app.side = v; });
  renderSegmented($('#prep-cam'), [
    { value: 'user', label: '前置' }, { value: 'environment', label: '后置' },
  ], app.facing, (v) => { app.facing = v; $('#prep-cam-note').hidden = v !== 'environment'; });
  $('#prep-cam-note').hidden = app.facing !== 'environment';
  $('#start-btn').disabled = false;
  $('#start-btn').textContent = app.prepError ? '重试' : '开始';
  $('#status').textContent = app.prepError;
  $('#status').classList.toggle('error', !!app.prepError);
  app.prepError = '';
}

function renderSegmented(box, options, value, onChange) {
  box.innerHTML = options.map((o) => `<button type="button" role="radio" aria-checked="${o.value === value}" data-value="${o.value}">${esc(o.label)}</button>`).join('');
  const idx = Math.max(options.findIndex((o) => o.value === value), 0);
  box.style.setProperty('--n', options.length);
  box.style.setProperty('--i', idx);
  box.querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => {
    box.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    box.style.setProperty('--i', i);
    onChange(b.dataset.value);
  }));
}

// ---------------- 训练中 ----------------

// file：演示模式下选的视频文件；不传就用摄像头
async function startSession(file = null) {
  const ex = findPlanExercise(app.prepId);
  if (!ex) return;
  const status = $('#status');
  $('#start-btn').disabled = true;
  if (!file) voice.unlock(ex.prompts.start); // 必须在点击事件里，iPhone 才会出声（演示模式在点按钮时已解锁）

  const video = $('#video');
  const canvas = $('#overlay');
  const isFile = !!file;
  try {
    status.classList.remove('error');
    if (isFile) {
      status.textContent = '正在读取视频…';
      await startVideoFile(video, file);
    } else {
      status.textContent = '正在打开摄像头…浏览器会询问是否允许使用摄像头';
      await openCameraWithTimeout(video, app.facing);
    }
    // 前置摄像头像照镜子一样镜像显示；后置摄像头和视频文件按原样显示
    const mirror = !isFile && app.facing === 'user';
    $('#stage').classList.toggle('no-mirror', !mirror);
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    $('#stage').style.setProperty('--ar', `${w} / ${h}`);

    const session = {
      ex,
      side: app.side || app.profile?.side || 'auto',
      counter: createCounter(ex),
      smoother: createSmoother(),
      bones: createBoneCheck(),
      rejected: 0,       // 被判为“认错”而丢掉的帧数（椅子腿、跳点）
      rejectSince: NaN,  // 连续被丢帧的开始时间
      mirror,
      source: isFile ? 'video' : 'camera',
      broken: 0,
      range: createAngleRange(),
      t0: performance.now(),
      tracker: null,
      finished: false,
    };
    app.session = session;
    app.lastResult = null;

    $('#hud-name').textContent = ex.name;
    $('#hud-sub').textContent = `${isFile ? '演示视频 · ' : ''}${positionText(ex.id)}`;
    $('#hud-angle-label').textContent = jointOf(ex) === 'ankle' ? '踝角' : '膝角';
    $('#hud-target').textContent = ex.reps;
    $('#hud-reps').textContent = '0';
    $('#hud-angle').textContent = '--';
    setHold(0);
    $('#prompt').textContent = '准备中…';
    $('#perf-note').hidden = true;
    $('#session-loading').hidden = false;
    $('#loading-text').textContent = '正在加载姿态模型…';
    status.textContent = '';
    go('#session');

    session.tracker = createPoseTracker(video, (frame) => onFrame(session, frame, canvas));
    session.tracker.start();

    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('姿态模型加载超时。请确认是通过 http 或 https 链接打开的（不是直接双击文件），或者换一台性能更好的手机再试。')), MODEL_TIMEOUT_MS));
    await Promise.race([session.tracker.ready, timeout]);
    if (app.session === session) {
      $('#session-loading').hidden = true;
      $('#prompt').textContent = ex.prompts.start;
      voice.speak(ex.prompts.start, { key: 'start' });
      if (isFile) {
        // 模型准备好再从头播放，播完自动结束这一组
        video.onended = () => { if (app.session === session) finishSession(); };
        video.currentTime = 0;
        await video.play();
      }
    }
  } catch (err) {
    console.error(err);
    endSession({ save: false });
    stopVideo(video);
    app.prepError = cameraErrorText(err);
    if (parseHash().name === 'session') go(`#prep/${ex.id}`, { replace: true });
    else renderPrep(ex.id);
  }
}

// 给 getUserMedia 加超时：用户在权限弹窗上不点、或点了关闭，页面不再一直卡在“正在打开摄像头”
async function openCameraWithTimeout(video, facing) {
  let timedOut = false;
  const opening = startCamera(video, facing);
  const timer = new Promise((_, rej) => setTimeout(() => {
    timedOut = true;
    const e = new Error('camera timeout');
    e.name = 'CameraTimeout';
    rej(e);
  }, CAMERA_TIMEOUT_MS));
  // 超时之后摄像头才打开的话，立刻关掉，避免指示灯一直亮着
  opening.then(() => { if (timedOut) stopCamera(video); }, () => {});
  return Promise.race([opening, timer]);
}

function cameraErrorText(err) {
  switch (err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '没有拿到摄像头权限。请点浏览器地址栏旁边的图标，允许使用摄像头，然后点“重试”。';
    case 'CameraTimeout':
      return '摄像头一直没有打开。请在浏览器弹窗里点“允许”，或检查地址栏的摄像头权限，然后点“重试”。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '没有找到可用的摄像头。请换一台带摄像头的手机或电脑再试。';
    case 'VideoFileError':
      return '这个视频打不开。换一个 mp4 格式的视频再试（手机自带相机录的一般都可以）。';
    case 'NotReadableError':
      return '摄像头正被其他应用占用。请关掉其他使用摄像头的应用，然后点“重试”。';
    default:
      return `出错了：${err.message}`;
  }
}

function setHold(p) {
  const ring = $('#hold-ring');
  ring.style.strokeDashoffset = String(100 - Math.round(p * 100));
  ring.style.opacity = p > 0 ? '1' : '0'; // 进度为 0 时圆头线帽会留一个小圆点，直接隐藏
}

function onFrame(session, frame, canvas) {
  if (app.session !== session || session.finished) return;
  const { ex } = session;
  const t = (performance.now() - session.t0) / 1000;

  let leg = null;
  let angle = NaN;
  let lost = true;
  let rejected = null; // 识别结果不合理（例如把椅子腿认成小腿）：这一帧不用

  if (frame.landmarks) {
    leg = pickLeg(frame.landmarks, session.side, jointOf(ex));
    lost = leg.visibility < app.safety.minVisibility;
    if (!lost && angleReady) {
      const raw = angleDeg(leg.hip, leg.knee, leg.ankle);
      const bc = session.bones.check(leg, raw, t);
      if (bc.ok) angle = session.smoother.push(raw);
      else rejected = bc;
    }
  }

  drawFrame(canvas, frame, lost || rejected ? null : leg, angle, session.mirror);
  checkFrameRate(session, t);

  if (rejected) {
    // 认错的帧当作“这一帧看不到腿”：不更新角度，正在保持的那一次有 graceSec 容错；平滑器不清零
    session.rejected += 1;
    if (!Number.isFinite(session.rejectSince)) session.rejectSince = t;
    const snap = session.counter.lose(t);
    setHold(snap.holdProgress);
    if (snap.event === 'hold_broken') {
      session.broken += 1;
      showPrompt(ex.prompts.hold_broken, 'broken', 0);
    } else if (rejected.noisy) {
      showPrompt(app.copy.interference, 'interference', 8000);
    }
    return;
  }
  session.rejectSince = NaN;

  if (lost) {
    // 看不到腿：平滑器清零；正在保持的那一次，短暂看不到不作废（见 counter.js 的 graceSec）
    session.smoother.reset();
    const snap = session.counter.lose(t);
    setHold(snap.holdProgress);
    if (snap.event === 'hold_broken') {
      session.broken += 1;
      showPrompt(app.copy.lostDuringHold, 'broken', 0);
    } else if (!snap.paused) {
      showPrompt(jointOf(ex) === 'ankle' ? app.copy.lostMessageAnkle : app.copy.lostMessage, 'lost', 5000);
    }
    return;
  }

  $('#hud-angle').textContent = Number.isFinite(angle) ? `${Math.round(angle)}°` : '--';
  session.range.push(angle);
  const snap = session.counter.update(angle, t);
  if ($('#hud-reps').textContent !== String(snap.reps)) {
    $('#hud-reps').textContent = snap.reps;
    const num = $('.count-num');
    num.classList.remove('bump');
    void num.offsetWidth; // 重新触发动画
    num.classList.add('bump');
  }
  setHold(snap.holdProgress);

  if (snap.warn && ex.prompts.warn) showPrompt(ex.prompts.warn, 'warn', 3000);
  else if (snap.tooFast && ex.prompts.too_fast) showPrompt(ex.prompts.too_fast, 'too_fast', 4000);

  switch (snap.event) {
    case 'ready': showPrompt(ex.prompts.ready, 'ready', 0); break;
    case 'enter_target': showPrompt(ex.prompts.enter_target, 'enter', 0); break;
    case 'hold_broken':
      session.broken += 1;
      showPrompt(ex.prompts.hold_broken, 'broken', 0);
      break;
    case 'held': showPrompt(ex.prompts.held, 'held', 0); break;
    case 'rep': showPrompt(ex.prompts.rep.replace('{n}', snap.reps), 'rep', 0); break;
    case 'done':
      showPrompt(ex.prompts.done, 'done', 0);
      finishSession();
      break;
    default: break;
  }
}

// 帧率门控：手机太卡时提示一句（只显示文字，不打断语音），恢复后自动隐藏
function checkFrameRate(session, t) {
  if (t < LOW_FPS_GRACE_SEC || !session.tracker) return;
  const fps = session.tracker.fps;
  const slow = fps > 0 && fps < LOW_FPS;
  const note = $('#perf-note');
  if (slow) note.textContent = `画面处理有点慢（每秒约 ${Math.round(fps)} 帧），计数可能不准`;
  note.hidden = !slow;
}

function showPrompt(text, key, minGapMs) {
  if (!text) return;
  $('#prompt').textContent = text;
  voice.speak(text, { key, minGapMs });
}

// 只有要求“保持几秒”的动作才有达标比例；不要求保持的动作（扶椅微蹲）返回 null，不显示
function hitRateOf(s) {
  if (!(s.ex.holdSec > 0)) return null;
  const attempts = s.counter.reps + s.broken;
  return attempts ? s.counter.reps / attempts : 0;
}

function sessionBest(s) {
  return bestValue(s.ex.progress?.metric, s.range);
}

function finishSession() {
  const s = app.session;
  if (!s || s.finished) return;
  app.lastResult = { ex: s.ex, reps: s.counter.reps, target: s.ex.reps, best: sessionBest(s), rate: hitRateOf(s), stopped: false, feeling: null };
  endSession({ save: true, stopped: false });
  go('#after', { replace: true });
}

function stopForDiscomfort() {
  const s = app.session;
  if (!s) return;
  app.lastResult = { ex: s.ex, reps: s.counter.reps, target: s.ex.reps, best: sessionBest(s), rate: hitRateOf(s), stopped: true, feeling: 'red' };
  endSession({ save: true, stopped: true });
  store.updateLastRecord({ painAfter: 'red' });
  voice.speak(app.copy.stopMessage, { force: true });
  go('#after', { replace: true });
}

// save: 是否写入记录；stopped: 是否因不适中止
function endSession({ save, stopped = false }) {
  const s = app.session;
  if (!s) return;
  s.finished = true;
  app.session = null;
  if (s.tracker) s.tracker.close();
  stopVideo($('#video'));
  if (!save) { voice.stopSpeaking(); return; }

  store.addRecord({
    date: new Date().toISOString(),
    exerciseId: s.ex.id,
    exerciseName: s.ex.name,
    reps: s.counter.reps,
    target: s.ex.reps,
    hitRate: hitRateOf(s),
    painBefore: app.painBefore,
    best: sessionBest(s),
    stopped,
    demo: s.source === 'video' || undefined, // 演示视频产生的记录，历史里标出来
  });
}

// ---------------- 这一组做完 ----------------

const FACES = {
  green: '<path d="M14 26c2.4 3.4 5.6 5 10 5s7.6-1.6 10-5"/>',
  yellow: '<path d="M15 29h18"/>',
  red: '<path d="M14 32c2.4-3.4 5.6-5 10-5s7.6 1.6 10 5"/>',
};

function faceSVG(level) {
  return `<svg viewBox="0 0 48 48" class="face ${level}" aria-hidden="true"><circle cx="24" cy="24" r="21"/><circle class="eye" cx="17" cy="19" r="2.4"/><circle class="eye" cx="31" cy="19" r="2.4"/>${FACES[level]}</svg>`;
}

function renderAfter() {
  const r = app.lastResult;
  const icon = $('#after-icon');
  icon.classList.toggle('warn', r.stopped);
  icon.innerHTML = r.stopped
    ? '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30"/><path d="M32 17v19"/><path d="M32 46v.5"/></svg>'
    : '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30"/><path d="m19 33 9 9 17-19"/></svg>';
  icon.classList.remove('play');
  void icon.offsetWidth;
  icon.classList.add('play');

  if (r.stopped) {
    $('#after-title').textContent = '已停止';
    $('#after-summary').textContent = `${r.ex.name}：完成 ${r.reps} / ${r.target} 次`;
    $('#after-ask').hidden = true;
    showAdvice('red', app.copy.stopMessage);
    $('#after-next').textContent = '回到今天';
    $('#after-next').onclick = () => go('#today');
    $('#after-stop').hidden = true;
    $('#after-bar').hidden = false;
    return;
  }

  $('#after-ask-text').textContent = `${jointWord(jointOf(r.ex))}现在感觉怎么样？`;
  $('#after-title').textContent = r.reps >= r.target ? '做完了' : '这一组结束了';
  const parts = [`${r.ex.name} ${r.reps} / ${r.target} 次`];
  if (r.rate !== null && r.reps) parts.push(`保持达标 ${Math.round(r.rate * 100)}%`);
  if (r.best !== null) parts.push(`${r.ex.progress.label} ${r.best}°`);
  $('#after-summary').textContent = parts.join(' · ');
  $('#after-ask').hidden = false;

  const box = $('#faces');
  box.innerHTML = app.copy.painAfterOptions.map((o) => `
    <button type="button" class="face-btn${r.feeling === o.level ? ' selected' : ''}" data-level="${o.level}" aria-pressed="${r.feeling === o.level}">
      ${faceSVG(o.level)}<span>${esc(o.label)}</span>
    </button>`).join('');
  box.querySelectorAll('.face-btn').forEach((b) => b.addEventListener('click', () => onFeeling(b.dataset.level)));

  if (r.feeling) applyFeeling(r.feeling);
  else { $('#after-advice').hidden = true; $('#after-bar').hidden = true; }
}

function showAdvice(level, text) {
  const box = $('#after-advice');
  box.className = `advice ${level}`;
  $('#after-advice-text').textContent = text;
  box.hidden = false;
}

function onFeeling(level) {
  const r = app.lastResult;
  if (!r || r.stopped) return;
  r.feeling = level;
  store.updateLastRecord({ painAfter: level });
  $$('#faces .face-btn').forEach((b) => {
    const on = b.dataset.level === level;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const opt = app.copy.painAfterOptions.find((o) => o.level === level);
  if (level === 'red') voice.speak(opt.advice, { force: true });
  applyFeeling(level);
}

function applyFeeling(level) {
  const r = app.lastResult;
  const opt = app.copy.painAfterOptions.find((o) => o.level === level);
  showAdvice(level, opt.advice);
  const next = level === 'red' ? null : (app.course ? nextInCourse(r.ex.id) : nextUndone(r.ex.id));
  const bar = $('#after-bar');
  const btn = $('#after-next');
  const stopBtn = $('#after-stop');
  if (level === 'red') {
    btn.textContent = '今天先到这';
    btn.onclick = () => go(store.doneTodayIds().size ? '#done' : '#today');
    stopBtn.hidden = true;
  } else if (next) {
    btn.textContent = `下一个：${next.name}`;
    btn.onclick = () => go(`#prep/${next.id}`);
    stopBtn.hidden = false;
  } else if (app.course) {
    btn.textContent = '这门课今天练完了';
    btn.onclick = () => go(`#course/${app.course.id}`);
    stopBtn.hidden = true;
  } else {
    btn.textContent = '查看今天的总结';
    btn.onclick = () => go('#done');
    stopBtn.hidden = true;
  }
  bar.hidden = false;
}

// ---------------- 今天完成 ----------------

function tile(value, label, tone = '') {
  return `<div class="tile ${tone}"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
}

function renderDone() {
  const records = store.getRecords();
  const items = planItems();
  const done = store.doneTodayIds(records);
  const doneCount = items.filter((ex) => done.has(ex.id)).length;
  const all = items.length > 0 && doneCount === items.length;
  const ring = $('.done-ring');
  ring.style.setProperty('--p', items.length ? (doneCount / items.length) * 100 : 0);
  ring.classList.remove('play');
  void ring.offsetWidth;
  ring.classList.add('play');
  $('#done-title').textContent = all ? '今天的训练完成了' : '今天先到这里';
  $('#done-sub').textContent = all ? '每一次都算数，明天继续。' : `完成了 ${doneCount} / ${items.length} 个动作，休息好再继续。`;

  const today = new Date().toDateString();
  const todays = records.filter((r) => new Date(r.date).toDateString() === today);
  const reps = todays.reduce((s, r) => s + (r.reps || 0), 0);
  $('#done-tiles').innerHTML = tile(`${store.streakDays(records)} 天`, '连续训练', 'orange')
    + tile(`${reps} 次`, '今天完成', 'tint')
    + tile(`${doneCount}/${items.length}`, '动作', 'green');

  const sums = app.exercises.map((ex) => ({ ex, s: summarize(records, ex) })).filter((x) => x.s && done.has(x.ex.id));
  $('#done-progress').innerHTML = sums.map(({ ex, s }) => progressRow(ex, s)).join('');
  $('#done-progress').hidden = !sums.length;
  $('#done-foot').textContent = sums.length ? app.copy.progressFootnote : '';
}

function progressRow(ex, s) {
  const delta = s.count > 1 ? `${s.delta > 0 ? '+' : ''}${s.delta}°` : `${s.latest}°`;
  const tone = s.trend === 'up' ? 'up' : '';
  return `<div class="row progress-row">
      <span class="row-text"><strong>${esc(ex.name)} · ${esc(s.label)}</strong>
        <small>${s.count > 1 ? `第一次 ${s.first}° → 最近 ${s.latest}°。` : ''}${esc(progressMessage(s))}</small></span>
      <span class="delta ${tone}">${esc(delta)}</span>
    </div>`;
}

// ---------------- 记录 ----------------

function renderRecords() {
  const records = store.getRecords();
  const has = records.length > 0;
  $('#records-empty').hidden = has;
  $('#records-body').hidden = !has;

  const p = app.profile;
  if (p) {
    const stage = app.planRules.stages.find((s) => s.id === p.stage);
    $('#rec-profile').textContent = `${partLabel(p)} · ${stage?.label || ''}`;
  } else $('#rec-profile').textContent = '未填写';
  $('#doctor-switch').checked = store.isDoctorConfirmed();
  $('#clear-status').textContent = '';

  if (!has) return;
  const ws = weekSummary(records);
  $('#rec-tiles').innerHTML = tile(`${store.streakDays(records)}`, '连续训练天数', 'orange')
    + tile(`${ws.sets}`, '最近 7 天组数', 'tint')
    + tile(ws.completion === null ? '–' : `${Math.round(ws.completion * 100)}%`, '完成度', 'green');
  renderWeekChart($('#week-chart'), ws);
  $('#week-text').textContent = summaryText(ws);

  const sums = app.exercises.map((ex) => ({ ex, s: summarize(records, ex) })).filter((x) => x.s);
  $('#rec-progress-wrap').hidden = !sums.length;
  $('#rec-progress').innerHTML = sums.map(({ ex, s }) => progressRow(ex, s)).join('');
  $('#rec-progress-foot').textContent = app.copy.progressFootnote;

  renderHistory(records, false);
}

const HISTORY_SHOWN = 8;

function renderHistory(records, all) {
  const list = [...records].reverse();
  const shown = all ? list : list.slice(0, HISTORY_SHOWN);
  const box = $('#rec-history');
  box.innerHTML = shown.map((r) => {
    const d = new Date(r.date);
    const when = `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const ex = app.exercises.find((e) => e.id === r.exerciseId);
    const meta = [when];
    if (Number.isFinite(r.best) && ex?.progress) meta.push(`${ex.progress.label} ${r.best}°`);
    if (Number.isFinite(r.painBefore)) meta.push(`训练前疼痛 ${r.painBefore}`);
    const opt = app.copy.painAfterOptions.find((o) => o.level === r.painAfter);
    const badge = (r.demo ? '<span class="badge gray">演示视频</span>' : '')
      + (r.stopped ? '<span class="badge red">因不适停止</span>'
        : opt ? `<span class="badge ${opt.level}">${esc(opt.label)}</span>` : '');
    return `<div class="row history-row">
        <span class="row-text"><strong>${esc(r.exerciseName)}</strong><small>${esc(meta.join(' · '))}</small></span>
        <span class="h-right"><b>${r.reps}/${r.target}</b>${badge}</span>
      </div>`;
  }).join('');
  if (!all && list.length > HISTORY_SHOWN) {
    box.insertAdjacentHTML('beforeend', `<button type="button" class="row link-row more-row"><span class="row-text tint-text">显示全部 ${list.length} 条</span></button>`);
    box.querySelector('.more-row').addEventListener('click', () => renderHistory(records, true));
  }
}

// 7 天柱状图：每天完成的组数；当天如有训练后“很疼”，柱子下方标一个红点
function renderWeekChart(el, ws) {
  const max = Math.max(3, ...ws.days.map((d) => d.sets));
  el.innerHTML = ws.days.map((d) => `
    <div class="bar-col" title="${esc(`${d.date}：完成 ${d.sets} 组，共 ${d.reps} 次`)}">
      <span class="bar-val">${d.sets || ''}</span>
      <div class="bar-track"><div class="bar${d.sets ? '' : ' zero'}" style="height:${Math.round((d.sets / max) * 100)}%"></div></div>
      <span class="bar-label${d.label === '今天' ? ' today' : ''}">${esc(d.label)}</span>
      <span class="bar-dot ${d.worstPain || ''}"></span>
    </div>`).join('');
}

// ---------------- 课程（标签） ----------------
// 课程 = 把已有的动作按关节和阶段打包，再配上训练小贴士。内容在 config/courses.json。
// 课程里的动作和“今天”的动作是同一套：同样的训练前确认、同样的角度标准和摄像头计数。

function courseExerciseIds(c) {
  return c.lessons.filter((l) => l.type === 'exercise').map((l) => l.id);
}

function courseExercises(c) {
  return courseExerciseIds(c).map((id) => findPlanExercise(id)).filter(Boolean);
}

// 课程顺序里下一个今天还没做、也没被挡住的动作
function nextInCourse(afterId = null) {
  const c = app.courses?.courses.find((x) => x.id === app.course?.id);
  if (!c) return null;
  const done = store.doneTodayIds();
  const ids = courseExerciseIds(c).filter((id) => !blockedReason(id));
  const i = afterId ? ids.indexOf(afterId) : -1;
  const id = ids.slice(i + 1).find((x) => !done.has(x));
  return id ? findPlanExercise(id) : null;
}

function jointFilter(box, value, onChange) {
  renderSegmented(box, [
    { value: 'all', label: '全部' }, { value: 'knee', label: '膝关节' }, { value: 'ankle', label: '踝关节' },
  ], value, onChange);
}

function renderCourses() {
  const f = app.courseFilter || app.profile?.joint || 'all';
  jointFilter($('#course-filter'), f, (v) => { app.courseFilter = v; renderCourseList(v); });
  renderCourseList(f);
}

function renderCourseList(f) {
  const list = app.courses.courses.filter((c) => f === 'all' || c.joint === f);
  $('#course-list').innerHTML = list.map((c) => {
    const exs = courseExercises(c);
    const ids = courseExerciseIds(c);
    const first = ids[0];
    const blocked = ids.some((id) => blockedReason(id));
    const mine = app.profile && c.joint === app.profile.joint && !blocked;
    return `<a class="course-card" href="#course/${esc(c.id)}">
        <div class="course-art" aria-hidden="true">${demoSVG(first, '')}</div>
        <div class="course-body">
          <div class="course-tags"><span class="badge tint">${esc(JOINT_NAME[c.joint])}</span><span class="badge gray">${esc(c.level)}</span>${mine ? '<span class="badge green">适合你</span>' : ''}</div>
          <strong>${esc(c.title)}</strong>
          <small>${ids.length} 个动作 · 约 ${planMinutes(exs)} 分钟 · ${esc(c.stageText)}</small>
        </div>
      </a>`;
  }).join('') || '<p class="footnote">这个关节暂时还没有课程。</p>';
  pauseIfReducedMotion($('#course-list'));
}

function renderCourse(id) {
  const c = app.courses.courses.find((x) => x.id === id);
  const done = store.doneTodayIds();
  const exs = courseExercises(c);
  $('#course-nav-title').textContent = c.short || c.title;
  $('#course-eyebrow').textContent = `${JOINT_NAME[c.joint]} · ${c.level}`;
  $('#course-title').textContent = c.title;
  $('#course-sub').textContent = `${courseExerciseIds(c).length} 个动作 · 约 ${planMinutes(exs)} 分钟`;
  $('#course-summary').textContent = c.summary;
  $('#course-fits').innerHTML = c.fits.map((t) => `<li>${esc(t)}</li>`).join('');
  $('#course-avoid').innerHTML = c.avoid.map((t) => `<li>${esc(t)}</li>`).join('');
  let n = 0;
  $('#course-lessons').innerHTML = c.lessons.map((l) => {
    if (l.type === 'tip') {
      return `<details class="disclosure lesson-tip">
          <summary class="row"><span class="r-icon orange">${icon('bulb')}</span><span class="row-text"><strong>${esc(l.title)}</strong><small>小贴士</small></span>${icon('chev', 'chev')}</summary>
          <div class="disclosure-body"><p>${esc(l.text)}</p></div>
        </details>`;
    }
    n += 1;
    const ex = findPlanExercise(l.id);
    const base = app.exercises.find((e) => e.id === l.id);
    const why = blockedReason(l.id);
    if (why || !ex) {
      return `<div class="row plan-row skipped"><span class="num">${n}</span><span class="row-text"><strong>${esc(base?.name || l.id)}</strong><small>${esc(why ? '暂时不练 · 医生允许站立承重后再练' : '暂时不可用')}</small></span></div>`;
    }
    const isDone = done.has(ex.id);
    return `<button type="button" class="row link-row plan-row${isDone ? ' done' : ''}" data-course-ex="${esc(ex.id)}">
        <span class="num">${isDone ? icon('check') : n}</span>
        <span class="row-text"><strong>${esc(ex.name)}</strong><small>${esc(exMeta(ex))} · 摄像头计数</small></span>${icon('chev', 'chev')}
      </button>`;
  }).join('');
  $('#course-lessons').querySelectorAll('[data-course-ex]').forEach((b) => b.addEventListener('click', () => startFlow(b.dataset.courseEx, { id: c.id })));
  $('#course-source').textContent = `内容来源：${c.source}`;
  const prevCourse = app.course;
  app.course = { id: c.id };
  const next = nextInCourse();
  app.course = prevCourse;
  const btn = $('#course-start');
  btn.disabled = !next;
  btn.textContent = next ? (exs.some((e) => done.has(e.id)) ? `继续：${next.name}` : '开始第一个动作') : '今天这门课练完了';
  btn.dataset.ex = next?.id || '';
  btn.dataset.course = c.id;
}

// ---------------- 康复师（标签） ----------------
// 只做“信息展示 + 把训练记录带去复诊”，不做在线诊断、不收费。
// 演示版的康复师是示例数据（config/therapists.json），页面上明确标注；“发送训练摘要”是真的可用的。

function renderTherapists() {
  const t = app.therapists;
  const f = app.therapistFilter || app.profile?.joint || 'all';
  jointFilter($('#therapist-filter'), f, (v) => { app.therapistFilter = v; renderTherapistList(v); });
  $('#therapist-notice').textContent = t.notice;
  $('#therapist-plan').innerHTML = t.partnership.map((p, i) => `
    <div class="row"><span class="num">${i + 1}</span><span class="row-text"><strong>${esc(p.title)}</strong><small>${esc(p.text)}</small></span></div>`).join('');
  renderTherapistList(f);
}

function renderTherapistList(f) {
  const list = app.therapists.therapists.filter((t) => f === 'all' || t.joints.includes(f));
  $('#therapist-list').innerHTML = list.map((t) => `
    <div class="therapist-card">
      <div class="th-head">
        <span class="th-avatar" aria-hidden="true">${esc(t.name.slice(0, 1))}</span>
        <div class="row-text"><strong>${esc(t.name)} <span class="badge gray">示例</span></strong><small>${esc(t.title)} · ${esc(t.org)}</small></div>
      </div>
      <div class="th-tags">${t.skills.map((k) => `<span class="badge tint">${esc(k)}</span>`).join('')}</div>
      <p class="th-meta">${esc(t.mode)}</p>
      <p class="th-cred">${esc(t.credential)}</p>
      <div class="th-actions">
        <button type="button" class="btn small primary" data-action="report">发送我的训练摘要</button>
        <button type="button" class="btn small plain" data-book="${esc(t.name)}">预约咨询</button>
      </div>
    </div>`).join('') || '<p class="footnote">暂时没有这个关节方向的康复师。</p>';
  $('#therapist-list').querySelectorAll('[data-action="report"]').forEach((b) => b.addEventListener('click', openReport));
  $('#therapist-list').querySelectorAll('[data-book]').forEach((b) => b.addEventListener('click', () => toast(app.therapists.bookingToast)));
}

// ---------------- 小贴士、关于 ----------------

function renderTips() {
  $('#tips-list').innerHTML = app.copy.tips.map((t) => `<div class="row icon-row"><span class="r-icon orange">${icon('bulb')}</span><span class="row-text">${esc(t)}</span></div>`).join('');
}

function renderAbout() {
  $('#about-disclaimer').textContent = app.copy.disclaimer;
  $$('[data-screen="about"] [data-back] span').forEach((s) => { s.textContent = store.isOnboarded() ? '记录' : '返回'; });
}

// ---------------- 训练摘要与数据管理 ----------------

function profileLabels() {
  if (!app.profile) return null;
  const stage = app.planRules.stages.find((s) => s.id === app.profile.stage);
  const stand = app.planRules.copy.stands.find((s) => s.value === app.profile.stand);
  return {
    stageLabel: stage?.label || '未填', standLabel: stand?.label || '未填', partLabel: partLabel(app.profile),
    maxFlexion: app.profile.maxFlexion,
  };
}

function openReport() {
  $('#report-text').textContent = buildReport(store.getRecords(), app.exercises, new Date(), profileLabels());
  $('#report-status').textContent = '';
  $('#report-copy').textContent = '复制';
  openLayer('report-layer');
}

async function onCopyReport() {
  const pre = $('#report-text');
  const text = pre.textContent;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (_) {
    // 部分浏览器（非 HTTPS、或没有剪贴板权限）不允许直接写剪贴板，退回到选中文字让用户自己复制
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  }
  if (ok) {
    $('#report-copy').textContent = '已复制';
    $('#report-status').textContent = '可以直接粘贴到微信或短信里发给医生或康复师。';
  } else {
    $('#report-status').textContent = '没能自动复制，文字已经选中，请长按或按 Ctrl/⌘ + C 复制。';
  }
}

function onClearAll() {
  const ok = store.clearAll();
  closeSheets();
  app.passedSafety = false;
  app.painBefore = null;
  app.profile = null;
  app.skipSetup = false;
  app.side = null;
  app.draft = null;
  app.lastResult = null;
  if (ok) {
    toast('已清除这台设备上的全部数据');
    go('#welcome', { replace: true });
  } else {
    $('#clear-status').textContent = '清除失败：浏览器不允许修改存储（可能是无痕模式）。';
  }
}

// ---------------- 启动 ----------------

function bindEvents() {
  $('#consent-tool').addEventListener('change', syncWelcome);
  $('#consent-doctor').addEventListener('change', syncWelcome);
  $('#welcome-go').addEventListener('click', onWelcomeGo);

  $('#setup-skip').addEventListener('click', onSetupSkip);
  $('#reps-toggle').addEventListener('change', (e) => {
    $('#reps-stepper-row').hidden = !e.target.checked;
    app.draft.clinicianReps = e.target.checked ? Number($('#reps-value').textContent) : null;
  });
  $('#reps-minus').addEventListener('click', () => setRepsValue(-1));
  $('#reps-plus').addEventListener('click', () => setRepsValue(1));
  $('#setup-finish').addEventListener('click', onSetupFinish);
  $('#guard-toggle').addEventListener('change', (e) => {
    $('#guard-stepper-row').hidden = !e.target.checked;
    app.draft.maxFlexion = e.target.checked ? Number($('#guard-value').textContent) : null;
  });
  $('#guard-minus').addEventListener('click', () => setGuardValue(-1));
  $('#guard-plus').addEventListener('click', () => setGuardValue(1));
  $('#course-start').addEventListener('click', (e) => startFlow(e.currentTarget.dataset.ex, { id: e.currentTarget.dataset.course }));

  $$('[data-go="check"]').forEach((b) => b.addEventListener('click', () => startFlow(nextUndone()?.id || planItems()[0]?.id)));
  $('#today-skip').addEventListener('click', () => { app.skipSetup = true; renderToday(); });
  $('#today-start').addEventListener('click', (e) => startFlow(e.currentTarget.dataset.ex));

  $('#pain').addEventListener('input', (e) => setPain(Number(e.target.value)));
  $('#check-go').addEventListener('click', onCheckGo);
  $('#seek-care-back').addEventListener('click', () => { $('#check-stop').hidden = true; $('#check-form-wrap').hidden = false; });

  $('#start-btn').addEventListener('click', () => startSession());
  // 演示模式：先在点击里解锁语音（iPhone 要求），再选视频文件
  $('#demo-btn').addEventListener('click', () => {
    const ex = findPlanExercise(app.prepId);
    if (ex) voice.unlock(ex.prompts.start);
    $('#demo-file').value = '';
    $('#demo-file').click();
  });
  $('#demo-file').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) startSession(f); });
  $('#stop-btn').addEventListener('click', stopForDiscomfort);
  $('#finish-btn').addEventListener('click', finishSession);
  $('#after-stop').addEventListener('click', () => go(store.doneTodayIds().size ? '#done' : '#today'));

  $$('[data-action="report"]').forEach((b) => b.addEventListener('click', openReport));
  $('#report-copy').addEventListener('click', onCopyReport);
  $('#doctor-switch').addEventListener('change', (e) => store.setDoctorConfirmed(e.target.checked));
  $('#clear-btn').addEventListener('click', () => openLayer('clear-layer'));
  $('#clear-yes').addEventListener('click', onClearAll);

  $$('[data-sheet-close]').forEach((b) => b.addEventListener('click', () => onSheetClose(b.closest('.sheet-layer'))));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = $$('.sheet-layer').find((l) => !l.hidden);
    if (open) onSheetClose(open);
  });

  // 返回按钮：有站内历史就后退，否则去上一级
  const parents = { setup: () => { const n = Number(parseHash().arg); return n > 1 ? `#setup/${n - 1}` : '#today'; }, plan: () => '#setup/4', prep: () => (app.course ? `#course/${app.course.id}` : '#today'), course: () => '#courses', tips: () => '#records', about: () => (store.isOnboarded() ? '#records' : '#welcome') };
  $$('[data-back]').forEach((b) => b.addEventListener('click', () => {
    const f = parents[app.screen];
    goBack(f ? f() : '#today');
  }));

  // 标签之间切换不进浏览记录（和 iOS 一样，标签页没有“返回”）
  $$('[data-tab]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(a.getAttribute('href'), { replace: true }); }));

  window.addEventListener('scroll', updateNavbars, { passive: true });
  window.addEventListener('hashchange', route);
  window.addEventListener('pagehide', () => endSession({ save: false }));
}

async function init() {
  try {
    const [ex, safety, copy, planRules, courses, therapists] = await Promise.all([
      loadJSON('config/exercises.json'),
      loadJSON('config/safety.json'),
      loadJSON('config/copy.json'),
      loadJSON('config/plan.json'),
      loadJSON('config/courses.json'),
      loadJSON('config/therapists.json'),
    ]);
    app.courses = courses;
    app.therapists = therapists;
    app.planRules = planRules;
    app.profile = normalizeProfile(store.getProfile(), planRules);
    app.exercises = [...ex.exercises].sort((a, b) => a.priority - b.priority);
    app.safety = safety;
    app.copy = copy;
    $('#stop-btn').textContent = copy.stopButton;
  } catch (err) {
    document.querySelector('#app').innerHTML =
      `<div class="content"><div class="notice red"><p>配置读取失败：${esc(err.message)}。请通过本地服务器或 HTTPS 链接打开，不要直接双击 index.html。</p></div></div>`;
    return;
  }
  bindEvents();
  route();
}

init();
