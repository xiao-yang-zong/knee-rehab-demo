// v1.0：按关节安排动作、医嘱护栏（屈膝上限）。npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPlan, normalizeProfile, splitPart, applyGuard } from '../js/plan.js';
import { effectiveZones, createCounter } from '../js/counter.js';

const rules = JSON.parse(readFileSync(new URL('../config/plan.json', import.meta.url)));
const { exercises } = JSON.parse(readFileSync(new URL('../config/exercises.json', import.meta.url)));
const base = { stage: 'lt2w', stand: 'yes' };
const ids = (plan) => plan.items.map((i) => i.exercise.id);

test('旧版只存了 side 的“我的情况”按膝关节读入', () => {
  const p = normalizeProfile({ side: 'left', stage: 'lt2w', stand: 'yes' }, rules);
  assert.equal(p.joint, 'knee');
  assert.equal(p.maxFlexion, null);
});

test('部位值拆分：左踝 → left + ankle；非法值 → null', () => {
  assert.deepEqual(splitPart('left_ankle'), { side: 'left', joint: 'ankle' });
  assert.equal(splitPart('left_leg'), null);
  assert.equal(splitPart(undefined), null);
});

test('选膝关节只安排膝关节动作，选踝关节只安排踝泵', () => {
  const knee = buildPlan({ exercises, rules, profile: normalizeProfile({ ...base, side: 'right', joint: 'knee' }, rules) });
  assert.deepEqual(ids(knee), ['seated_knee_extension', 'seated_heel_slide', 'chair_mini_squat']);
  const ankle = buildPlan({ exercises, rules, profile: normalizeProfile({ ...base, side: 'right', joint: 'ankle' }, rules) });
  assert.deepEqual(ids(ankle), ['ankle_pump']);
});

test('没填“我的情况”的通用计划不变（只有膝关节动作）', () => {
  const plan = buildPlan({ exercises, rules, profile: null });
  assert.equal(plan.items.some((i) => i.exercise.id === 'ankle_pump'), false);
  assert.equal(plan.items.length, 3);
});

test('从课程进入（anyJoint）可以拿到别的关节的动作，但站立承重限制照样生效', () => {
  const p = normalizeProfile({ side: 'left', joint: 'ankle', stage: 'lt2w', stand: 'no' }, rules);
  const all = buildPlan({ exercises, rules, profile: p, anyJoint: true });
  assert.ok(ids(all).includes('seated_heel_slide'));
  assert.ok(all.excluded.some((e) => e.exercise.id === 'chair_mini_squat'));
});

test('踝关节不接受屈膝上限', () => {
  const p = normalizeProfile({ side: 'left', joint: 'ankle', stage: 'lt2w', stand: 'yes', maxFlexion: 90 }, rules);
  assert.equal(p.maxFlexion, null);
});

test('护栏：医生说屈膝不超过 90°，足跟滑动目标放浅、超过上限报警且不计数', () => {
  const p = normalizeProfile({ side: 'left', joint: 'knee', stage: 'gt6w', stand: 'yes', maxFlexion: 90 }, rules);
  const plan = buildPlan({ exercises, rules, profile: p });
  const heel = plan.items.find((i) => i.exercise.id === 'seated_heel_slide').exercise;
  assert.equal(heel.warn.max, 90);          // 膝角 < 90（屈膝 > 90°）报警
  assert.equal(heel.target.min, 90);        // 超过上限不在目标区
  assert.equal(heel.target.max, 100);       // 原来 6 周以上要求屈膝 120°，改成 80°
  assert.equal(heel.prompts.warn, rules.copy.guardWarn);
  assert.ok(heel.guardNote.includes('90°'));
  const z = effectiveZones(heel);
  assert.ok(z.enter.min > 90, '进入目标区的范围不能越过上限');
});

test('护栏：计数器在超过上限时报警，超过的那一次不计数', () => {
  const p = normalizeProfile({ side: 'left', joint: 'knee', stage: 'lt2w', stand: 'yes', maxFlexion: 90 }, rules);
  const heel = buildPlan({ exercises, rules, profile: p }).items.find((i) => i.exercise.id === 'seated_heel_slide').exercise;
  const c = createCounter({ ...heel, holdSec: 1 });
  let t = 0; let snap;
  const run = (angle, sec) => { for (let k = 0; k < sec * 30; k++) { snap = c.update(angle, t); t += 1 / 30; } return snap; };
  run(125, 1);            // 起始区
  const deep = run(80, 3); // 弯过头：屈膝 100°
  assert.equal(deep.warn, true);
  run(125, 1);
  assert.equal(snap.reps, 0, '弯过上限的那一次不算');
  run(97, 2);              // 屈膝 83°，在上限以内
  run(125, 1);
  assert.equal(snap.reps, 1);
});

test('护栏：上限比扶椅微蹲原有的“蹲太深”更保守时，用医生的上限', () => {
  const p = normalizeProfile({ side: 'left', joint: 'knee', stage: 'gt6w', stand: 'yes', maxFlexion: 40 }, rules);
  const plan = buildPlan({ exercises, rules, profile: p });
  const squat = plan.items.find((i) => i.exercise.id === 'chair_mini_squat')?.exercise;
  assert.ok(squat, '40° 上限下微蹲仍能做');
  assert.equal(squat.warn.max, 140);
});

test('护栏：上限太小，动作做不了就排除，不硬塞', () => {
  const p = normalizeProfile({ side: 'left', joint: 'knee', stage: 'lt2w', stand: 'yes', maxFlexion: 30 }, rules);
  const plan = buildPlan({ exercises, rules, profile: p });
  assert.ok(plan.excluded.some((e) => e.exercise.id === 'seated_heel_slide'));
  assert.ok(ids(plan).includes('seated_knee_extension'), '伸膝不受屈膝上限影响');
});

test('护栏不改伸直方向的动作', () => {
  const ext = exercises.find((e) => e.id === 'seated_knee_extension');
  const r = applyGuard(ext, 90, rules);
  assert.equal(r.exercise, ext);
});
