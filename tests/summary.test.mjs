import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lastNDays, weekSummary, summaryText, buildReport } from '../js/summary.js';

const config = JSON.parse(readFileSync(new URL('../config/exercises.json', import.meta.url), 'utf8'));
const today = new Date('2026-10-28T20:00:00');
const rec = (day, o = {}) => ({
  date: `2026-10-${String(day).padStart(2, '0')}T10:00:00`,
  exerciseId: 'seated_heel_slide', exerciseName: '坐姿足跟滑动', reps: 10, target: 10, stopped: false, ...o,
});

test('最近 7 天：含今天，按日期从早到晚，超出范围的不算', () => {
  const days = lastNDays([rec(28), rec(28, { reps: 4, stopped: true }), rec(22), rec(21)], today);
  assert.equal(days.length, 7);
  assert.equal(days[0].date, '10/22');
  assert.equal(days[6].label, '今天');
  assert.equal(days[6].sets, 1);       // 中止的那组不算完成
  assert.equal(days[6].reps, 14);
  assert.equal(days[6].stops, 1);
  assert.equal(days[0].sets, 1);       // 10/22 在范围内，10/21 不在
});

test('周摘要：统计天数、组数、最近一次感受', () => {
  const ws = weekSummary([rec(26, { painAfter: 'green' }), rec(27, { painAfter: 'yellow' }), rec(27)], today);
  assert.equal(ws.trainedDays, 2);
  assert.equal(ws.sets, 3);
  assert.equal(ws.reps, 30);
  assert.equal(ws.lastPain, 'yellow');
  assert.match(summaryText(ws), /2 天进行了训练，完成 3 组、共 30 次/);
  assert.match(summaryText(ws), /有点疼/);
});

test('没有记录时给空状态，不编数字', () => {
  const ws = weekSummary([], today);
  assert.equal(ws.records, 0);
  assert.match(summaryText(ws), /还没有训练记录/);
  assert.match(buildReport([], config.exercises, today), /没有训练记录/);
});

test('很疼时提示联系医生；脏数据（非法日期）被忽略', () => {
  const ws = weekSummary([rec(28, { painAfter: 'red' }), { date: 'abc', reps: 99 }], today);
  assert.equal(ws.records, 1);
  assert.match(summaryText(ws), /联系你的医生或康复师/);
});

test('给康复师的摘要：包含角度对比和说明，不含诊断类词语', () => {
  const text = buildReport([rec(24, { best: 80, painBefore: 2 }), rec(27, { best: 92, painBefore: 3, painAfter: 'green' })], config.exercises, today);
  assert.match(text, /第一次 80° → 最近一次 92°/);
  assert.match(text, /训练前疼痛（0–10 分），按时间顺序：2、3/);
  assert.match(text, /以医生测量为准/);
  for (const bad of ['康复效果', '治愈', '恢复良好', '退步']) assert.ok(!text.includes(bad), bad);
});

test('完成度：每组完成次数 ÷ 计划次数的平均值，停止的组也算', () => {
  const ws = weekSummary([rec(27, { reps: 10 }), rec(28, { reps: 4, stopped: true })], today);
  assert.equal(ws.completion, 0.7);
  const text = buildReport([rec(27, { reps: 10 }), rec(28, { reps: 4, stopped: true })], config.exercises, today);
  assert.match(text, /完成度：平均每组完成计划次数的 70%/);
});

test('摘要里写出用户自填的阶段和承重情况，并标明是自填', () => {
  const text = buildReport([rec(27)], config.exercises, today, { stageLabel: '2–6 周', standLabel: '允许' });
  assert.match(text, /用户自填：距离手术或受伤 2–6 周；医生是否允许站立承重：允许/);
});
