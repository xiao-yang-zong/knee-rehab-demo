// 训练计划规则测试：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPlan, normalizeProfile } from '../js/plan.js';

const rules = JSON.parse(readFileSync(new URL('../config/plan.json', import.meta.url), 'utf8'));
const { exercises } = JSON.parse(readFileSync(new URL('../config/exercises.json', import.meta.url), 'utf8'));
const now = new Date('2026-10-28T12:00:00');
const base = { side: 'left', stage: '2to6w', stand: 'yes', clinicianReps: null };
const repsOf = (plan) => plan.items.map((i) => i.exercise.reps);
const ago = (h) => new Date(now.getTime() - h * 3600000).toISOString();

test('没填情况：用配置里的通用计划，次数不变', () => {
  const p = buildPlan({ exercises, profile: null, rules, now });
  assert.equal(p.personalized, false);
  // v1.0：没填情况的通用计划只放膝关节动作（踝泵要选了踝关节才安排）
  assert.deepEqual(repsOf(p), exercises.filter((e) => (e.joint || 'knee') === 'knee').map((e) => e.reps));
});

test('按术后/伤后时间给次数', () => {
  assert.deepEqual(repsOf(buildPlan({ exercises, profile: { ...base, stage: 'lt2w' }, rules, now })), [5, 5, 5]);
  assert.deepEqual(repsOf(buildPlan({ exercises, profile: { ...base, stage: 'gt6w' }, rules, now })), [10, 10, 10]);
});

test('康复师给了次数就用康复师的，并限制在 3–20', () => {
  assert.deepEqual(repsOf(buildPlan({ exercises, profile: { ...base, clinicianReps: 12 }, rules, now })), [12, 12, 12]);
  assert.deepEqual(repsOf(buildPlan({ exercises, profile: { ...base, clinicianReps: 50 }, rules, now })), [20, 20, 20]);
});

test('今天疼痛 ≥ 3 分：次数减少', () => {
  const p = buildPlan({ exercises, profile: base, rules, painToday: 4, now });
  assert.deepEqual(repsOf(p), [6, 6, 6]); // 8 × 0.7 ≈ 6
  assert.ok(p.items[0].reasons.some((r) => r.includes('4 分')));
});

test('上次有点疼（72 小时内）减 2 次；超过 72 小时不减', () => {
  const recent = [{ date: ago(20), painAfter: 'yellow' }];
  const old = [{ date: ago(100), painAfter: 'yellow' }];
  assert.deepEqual(repsOf(buildPlan({ exercises, profile: base, rules, records: recent, now })), [6, 6, 6]);
  assert.deepEqual(repsOf(buildPlan({ exercises, profile: base, rules, records: old, now })), [8, 8, 8]);
});

test('上次很疼（48 小时内）只做一半，且不低于 3 次', () => {
  const recs = [{ date: ago(10), painAfter: 'red' }];
  assert.deepEqual(repsOf(buildPlan({ exercises, profile: base, rules, records: recs, now })), [4, 4, 4]);
  const low = buildPlan({ exercises, profile: { ...base, stage: 'lt2w' }, rules, painToday: 4, records: recs, now });
  assert.deepEqual(repsOf(low), [3, 3, 3]);
});

test('只看最近一次的感受：上次不疼就不减', () => {
  const recs = [{ date: ago(30), painAfter: 'red' }, { date: ago(5), painAfter: 'green' }];
  assert.deepEqual(repsOf(buildPlan({ exercises, profile: base, rules, records: recs, now })), [8, 8, 8]);
});

test('医生没明确允许站立承重：不安排扶椅微蹲', () => {
  for (const stand of ['no', 'unsure']) {
    const p = buildPlan({ exercises, profile: { ...base, stand }, rules, now });
    assert.deepEqual(p.items.map((i) => i.exercise.id), ['seated_knee_extension', 'seated_heel_slide']);
    assert.equal(p.excluded[0].exercise.id, 'chair_mini_squat');
  }
});

test('不修改原配置；坐姿伸膝没有分阶段参数，角度不变', () => {
  const before = JSON.stringify(exercises);
  const p = buildPlan({ exercises, profile: { ...base, stage: 'gt6w' }, rules, now });
  assert.equal(JSON.stringify(exercises), before);
  assert.deepEqual(p.items[0].exercise.target, exercises[0].target);
});

const byId = (plan, id) => plan.items.find((i) => i.exercise.id === id)?.exercise;

test('足跟滑动按阶段：2 周内屈膝 90°（膝角 ≤ 90），6 周以上约 120°（膝角 ≤ 60）', () => {
  const early = buildPlan({ exercises, profile: { ...base, stage: 'lt2w' }, rules, now });
  const late = buildPlan({ exercises, profile: { ...base, stage: 'gt6w' }, rules, now });
  assert.equal(byId(early, 'seated_heel_slide').target.max, 90);
  assert.equal(byId(late, 'seated_heel_slide').target.max, 60);
  assert.match(byId(late, 'seated_heel_slide').steps.join(), /120 度/);
});

test('微蹲按阶段加深，但任何阶段报警线都不低于膝角 120°（屈膝 60°）', () => {
  for (const stage of ['lt2w', '2to6w', 'gt6w', 'unknown']) {
    const sq = byId(buildPlan({ exercises, profile: { ...base, stage }, rules, now }), 'chair_mini_squat');
    assert.ok(sq.warn.max >= 120 && sq.target.min >= 120, stage);
  }
});

test('说不清时间：按最保守的早期参数，并提示先在现场指导下学会动作', () => {
  const p = buildPlan({ exercises, profile: { ...base, stage: 'unknown' }, rules, now });
  assert.equal(byId(p, 'seated_heel_slide').target.max, 90);
  const reasons = p.items[0].reasons.join();
  assert.match(reasons, /现场指导/);
  assert.match(reasons, /术后早期的标准/);
});

test('normalizeProfile 丢掉不合法的值', () => {
  assert.equal(normalizeProfile(null, rules), null);
  assert.equal(normalizeProfile({ side: 'left', stage: 'xx', stand: 'yes' }, rules), null);
  assert.deepEqual(normalizeProfile({ side: 'right', stage: 'gt6w', stand: 'no', clinicianReps: '8' }, rules),
    { side: 'right', joint: 'knee', stage: 'gt6w', stand: 'no', clinicianReps: 8, maxFlexion: null }); // v1.0 加了 joint、maxFlexion
  assert.equal(normalizeProfile({ ...base, clinicianReps: -2 }, rules).clinicianReps, null);
});
