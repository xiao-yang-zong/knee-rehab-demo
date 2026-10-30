// 计数状态机测试：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCounter, createSmoother, inRange, effectiveZones, DEFAULT_COUNTING } from '../js/counter.js';

const config = JSON.parse(readFileSync(new URL('../config/exercises.json', import.meta.url), 'utf8'));
const ex = (id) => config.exercises.find((e) => e.id === id);

// 按 fps 把角度序列喂给计数器，返回所有事件
function run(counter, segments, fps = 30) {
  const events = [];
  let t = 0;
  let last;
  for (const [angle, seconds] of segments) {
    const n = Math.round(seconds * fps);
    for (let i = 0; i < n; i++) {
      last = angle === null ? counter.lose(t) : counter.update(angle, t); // null 表示这一帧看不到腿
      if (last.event) events.push(last.event);
      t += 1 / fps;
    }
  }
  return { events, last };
}

test('inRange 支持只写 min 或 max', () => {
  assert.equal(inRange(100, { max: 120 }), true);
  assert.equal(inRange(130, { max: 120 }), false);
  assert.equal(inRange(165, { min: 160 }), true);
  assert.equal(inRange(140, { min: 130, max: 155 }), true);
  assert.equal(inRange(NaN, { min: 0 }), false);
  assert.equal(inRange(100, null), false);
});

test('坐姿伸膝：保持够 5 秒再放下，算 1 次', () => {
  const c = createCounter(ex('seated_knee_extension'));
  const { events, last } = run(c, [[95, 1], [170, 5.5], [95, 1]]);
  assert.deepEqual(events, ['ready', 'enter_target', 'held', 'rep']);
  assert.equal(last.reps, 1);
});

test('坐姿伸膝：保持不够 5 秒就放下，不计数', () => {
  const c = createCounter(ex('seated_knee_extension'));
  const { events, last } = run(c, [[95, 1], [170, 3], [140, 0.5], [95, 1]]);
  assert.ok(events.includes('hold_broken'));
  assert.ok(!events.includes('rep'));
  assert.equal(last.reps, 0);
});

test('一开始就在目标区（没先回到起始姿势）不计数', () => {
  const c = createCounter(ex('seated_knee_extension'));
  const { last } = run(c, [[170, 6]]);
  assert.equal(last.state, 'WAIT_REST');
  assert.equal(last.reps, 0);
});

test('中间区域（介于起始和目标之间）不会误计数', () => {
  const c = createCounter(ex('seated_knee_extension'));
  const { last } = run(c, [[95, 1], [140, 6], [95, 1]]);
  assert.equal(last.reps, 0);
});

test('达到目标次数后发出 done，之后不再计数', () => {
  const e = { ...ex('seated_knee_extension'), reps: 2 };
  const c = createCounter(e);
  const rep = [[170, 5.5], [95, 1]];
  const { events, last } = run(c, [[95, 1], ...rep, ...rep, ...rep]);
  assert.equal(events.filter((x) => x === 'rep').length, 1);
  assert.equal(events.filter((x) => x === 'done').length, 1);
  assert.equal(last.reps, 2);
});

test('扶椅微蹲：holdSec 为 0 也需短暂停留防抖，蹲深会 warn', () => {
  const c = createCounter(ex('chair_mini_squat'));
  const quick = run(c, [[175, 1], [155, 0.1], [175, 1]]);
  assert.equal(quick.last.reps, 0, '只停留 0.1 秒不应计数');

  const { last } = run(c, [[155, 1], [175, 1]]);
  assert.equal(last.reps, 1);

  const deep = createCounter(ex('chair_mini_squat'));
  const r = run(deep, [[175, 1], [110, 0.2]]);
  assert.equal(r.last.warn, true);
});

test('NaN 角度（没检测到人）不改变状态', () => {
  const c = createCounter(ex('seated_knee_extension'));
  run(c, [[95, 1]]);
  const { last } = run(c, [[NaN, 3]]);
  assert.equal(last.state, 'READY');
});

test('平滑器忽略 NaN，并逐步逼近新值', () => {
  const s = createSmoother(0.5);
  assert.equal(s.push(100), 100);
  assert.equal(s.push(NaN), 100);
  assert.equal(s.push(200), 150);
});

test('配置文件里每个动作都有必需字段', () => {
  for (const e of config.exercises) {
    for (const k of ['id', 'name', 'rest', 'target', 'reps', 'prompts']) {
      assert.ok(e[k] !== undefined, `${e.id} 缺少 ${k}`);
    }
    assert.ok(!inRange(Object.values(e.rest)[0], e.target), `${e.id} 的起始区和目标区不应重叠`);
  }
});

test('保持期间离开画面：这一次作废，回来后不能直接算保持够（修复 D02）', () => {
  const c = createCounter(ex('seated_knee_extension'));
  // 保持 1 秒 → 离开画面 5 秒 → 回到目标区 0.5 秒 → 放下
  const { events, last } = run(c, [[95, 1], [170, 1], [null, 5], [170, 0.5], [95, 1]]);
  assert.deepEqual(events, ['ready', 'enter_target', 'hold_broken', 'enter_target', 'hold_broken']);
  assert.equal(last.reps, 0);
});

test('已经保持够再离开画面，回到起始姿势照常计数', () => {
  const c = createCounter(ex('seated_knee_extension'));
  const { events, last } = run(c, [[95, 1], [170, 5.5], [null, 2], [95, 1]]);
  assert.deepEqual(events, ['ready', 'enter_target', 'held', 'rep']);
  assert.equal(last.reps, 1);
});

// 按 fps 匀速把角度从 a 变到 b，用 seconds 秒
function ramp(counter, a, b, seconds, t0 = 0, fps = 30) {
  let tooFast = false;
  const n = Math.round(seconds * fps);
  for (let i = 0; i <= n; i++) {
    const s = counter.update(a + ((b - a) * i) / n, t0 + i / fps);
    if (s.tooFast) tooFast = true;
  }
  return tooFast;
}

test('动作过快：0.3 秒抬起 75° 提示慢一点；2 秒抬起不提示', () => {
  const e = ex('seated_knee_extension');
  assert.equal(ramp(createCounter(e), 95, 170, 0.3), true);
  assert.equal(ramp(createCounter(e), 95, 170, 2), false);
});

test('动作过快只是提醒，不影响计数', () => {
  const c = createCounter(ex('seated_knee_extension'));
  let t = 0;
  const hold = (angle, sec) => { let s; for (let i = 0; i < sec * 30; i++, t += 1 / 30) s = c.update(angle, t); return s; };
  hold(95, 1);
  assert.equal(ramp(c, 95, 170, 0.3, t), true);
  t += 0.3 + 1 / 30;
  hold(170, 5.5);
  const last = hold(95, 1);
  assert.equal(last.reps, 1);
});

test('每个阶段的参数：起始区和目标区不重叠；微蹲任何阶段都不超过 60°（膝角 ≥ 120°）', () => {
  for (const e of config.exercises) {
    for (const [stage, p] of Object.entries(e.stageParams || {})) {
      const merged = { ...e, ...p };
      assert.ok(!inRange(Object.values(merged.rest)[0], merged.target), `${e.id}/${stage} 起始区和目标区重叠`);
      if (e.id === 'chair_mini_squat') {
        assert.ok(merged.target.min >= 120, `${stage} 微蹲目标超过 60°`);
        assert.ok(merged.warn.max <= merged.target.min, `${stage} 微蹲报警线应在目标区之外`);
      }
    }
  }
});

// ---------- v0.7 判定放宽 ----------

const stagesOf = (e) => Object.entries(e.stageParams || { base: {} }).map(([k, p]) => [k, { ...e, ...p }]);

test('放宽后：每个动作每个阶段，起始区和目标区之间仍至少隔 minGapDeg', () => {
  for (const e of config.exercises) {
    for (const [stage, m] of stagesOf(e)) {
      const z = effectiveZones(m);
      const gap = z.dir === 'up' ? z.enter.min - z.rest.max : z.rest.min - z.enter.max;
      assert.ok(gap >= z.counting.minGapDeg - 1e-9, `${e.id}/${stage} 两区间隔 ${gap}`);
      assert.ok(!inRange(z.dir === 'up' ? z.rest.max : z.rest.min, z.stay), `${e.id}/${stage} 离开线越过了起始区`);
    }
  }
});

test('放宽只往“更容易达到”的方向，不会比康复标准更严', () => {
  for (const e of config.exercises) {
    for (const [stage, m] of stagesOf(e)) {
      const z = effectiveZones(m);
      if (z.dir === 'up') {
        assert.ok(z.enter.min <= m.target.min && z.rest.max >= m.rest.max, `${e.id}/${stage}`);
      } else {
        assert.ok(z.enter.max >= m.target.max && z.rest.min <= m.rest.min, `${e.id}/${stage}`);
      }
    }
  }
});

test('坐姿伸膝：摄像头读数只到 155°（旧标准 160° 刷不出来）现在能计数', () => {
  const c = createCounter(ex('seated_knee_extension'));
  const { last } = run(c, [[125, 1], [155, 5.5], [125, 1]]);
  assert.equal(last.reps, 1);
});

test('保持期间几次短暂抖出目标区（每次 0.2 秒），不作废，计时暂停', () => {
  const c = createCounter(ex('seated_knee_extension'));
  const shaky = [];
  for (let i = 0; i < 5; i++) shaky.push([165, 1.2], [140, 0.2]);
  const { events, last } = run(c, [[95, 1], ...shaky, [95, 1]]);
  assert.ok(!events.includes('hold_broken'));
  assert.equal(last.reps, 1);
});

test('抖动不算保持时间：出界的时间不累计', () => {
  const c = createCounter(ex('seated_knee_extension'));
  // 在目标区共 4 秒（不够 5 秒），中间夹着出界时间
  const seg = [];
  for (let i = 0; i < 8; i++) seg.push([165, 0.5], [140, 0.5]);
  const { last } = run(c, [[95, 1], ...seg.slice(0, -1)]);
  assert.equal(last.state, 'IN_TARGET');
  assert.ok(last.holdProgress < 1);
});

test('出界超过 graceSec 才作废', () => {
  const c = createCounter(ex('seated_knee_extension'));
  const { events, last } = run(c, [[95, 1], [165, 2], [140, DEFAULT_COUNTING.graceSec + 0.4]]);
  assert.ok(events.includes('hold_broken'));
  assert.equal(last.state, 'READY');
});

test('保持期间短暂看不到腿（0.5 秒）不作废', () => {
  const c = createCounter(ex('seated_knee_extension'));
  const { events, last } = run(c, [[95, 1], [165, 2], [null, 0.5], [165, 3.5], [95, 1]]);
  assert.ok(!events.includes('hold_broken'));
  assert.equal(last.reps, 1);
});

test('保持期间直接回到起始姿势 = 放弃，立即作废', () => {
  const c = createCounter(ex('seated_knee_extension'));
  const { events } = run(c, [[95, 1], [165, 2], [95, 0.1]]);
  assert.equal(events.at(-1), 'hold_broken');
});

test('足跟滑动：读数 95°（差 5°没到 90°）也能计数，保持 10 秒', () => {
  const c = createCounter(ex('seated_heel_slide'));
  const { last } = run(c, [[120, 1], [95, 10.5], [120, 1]]);
  assert.equal(last.reps, 1);
});

test('扶椅微蹲：摄像头把站直读成 166°，站直校准后照常计数', () => {
  const c = createCounter(ex('chair_mini_squat'));
  const cal = run(c, [[166, 1.5]]);
  assert.equal(cal.last.calibrated, true);
  assert.equal(cal.last.state, 'READY');
  assert.equal(cal.last.offset, 9);
  const { last } = run(c, [[150, 0.6], [166, 1], [150, 0.6], [166, 1]]);
  assert.equal(last.reps, 2);
});

test('扶椅微蹲：没站稳（一直在动）不会完成校准', () => {
  const c = createCounter(ex('chair_mini_squat'));
  const seq = [];
  for (let i = 0; i < 10; i++) seq.push([175, 0.1], [160, 0.1]);
  const { last } = run(c, seq);
  assert.equal(last.calibrated, false);
  assert.equal(last.state, 'WAIT_REST');
});

test('扶椅微蹲：校准时半蹲着，之后站直会自动把修正量调小', () => {
  const c = createCounter(ex('chair_mini_squat'));
  const a = run(c, [[158, 1.5]]);
  assert.equal(a.last.offset, 15);
  const b = run(c, [[172, 0.5]]);
  assert.equal(b.last.offset, 3);
});

test('安全侧不放宽：蹲太深按原始读数报警，校准修正不影响', () => {
  const c = createCounter(ex('chair_mini_squat'));
  run(c, [[163, 1.5]]); // 修正量 12
  const { last } = run(c, [[144, 0.2]]); // 校正后 156 在目标区，但原始 144 已过 145 的报警线
  assert.equal(last.warn, true);
});
