import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAngleRange, bestValue, summarize, progressMessage, FLUCTUATION_DEG } from '../js/progress.js';
import { doneTodayIds } from '../js/storage.js';

const config = JSON.parse(readFileSync(new URL('../config/exercises.json', import.meta.url), 'utf8'));
const ex = (id) => config.exercises.find((e) => e.id === id);
const rec = (id, best, day = 1) => ({ exerciseId: id, best, date: `2026-10-${String(day).padStart(2, '0')}T10:00:00` });

test('角度范围忽略 NaN', () => {
  const r = createAngleRange();
  [120, NaN, 95, 171, 100].forEach((a) => r.push(a));
  assert.equal(r.min, 95);
  assert.equal(r.max, 171);
  assert.ok(Number.isNaN(createAngleRange().min));
});

test('伸直取最大膝角，屈膝取 180 − 最小膝角', () => {
  const r = createAngleRange();
  [150, 88.6, 172.4].forEach((a) => r.push(a));
  assert.equal(bestValue('extension', r), 172);
  assert.equal(bestValue('flexion', r), 91);
  assert.equal(bestValue(undefined, r), null);
  assert.equal(bestValue('flexion', createAngleRange()), null);
});

test('扶椅微蹲不设进步指标', () => {
  assert.equal(summarize([rec('chair_mini_squat', 30)], ex('chair_mini_squat')), null);
});

test('进步对比：上升、持平、下降、只有一次', () => {
  const heel = ex('seated_heel_slide');
  const up = summarize([rec(heel.id, 80, 1), rec(heel.id, 95, 5)], heel);
  assert.equal(up.trend, 'up');
  assert.equal(up.delta, 15);
  const flat = summarize([rec(heel.id, 80, 1), rec(heel.id, 80 + FLUCTUATION_DEG - 1, 5)], heel);
  assert.equal(flat.trend, 'flat');
  const down = summarize([rec(heel.id, 90, 1), rec(heel.id, 100, 2), rec(heel.id, 80, 5)], heel);
  assert.equal(down.trend, 'down');
  assert.equal(down.best, 100);
  assert.equal(summarize([rec(heel.id, 85)], heel).trend, 'single');
  assert.equal(summarize([], heel), null);
});

test('没有指标值的记录（比如没识别到人）不参与对比', () => {
  const heel = ex('seated_heel_slide');
  const s = summarize([rec(heel.id, null, 1), rec(heel.id, 85, 2)], heel);
  assert.equal(s.count, 1);
});

test('提示语不出现负面词', () => {
  const heel = ex('seated_heel_slide');
  const cases = [[80, 95], [80, 81], [100, 80], [85]];
  for (const c of cases) {
    const msg = progressMessage(summarize(c.map((v, i) => rec(heel.id, v, i + 1)), heel));
    assert.ok(msg.length > 0);
    for (const bad of ['退步', '变差', '失败', '不行', '太差']) assert.ok(!msg.includes(bad), `${msg} 含有「${bad}」`);
  }
});

test('今天完成的动作：排除因不适中止和 0 次', () => {
  const today = new Date('2026-10-27T20:00:00');
  const ids = doneTodayIds([
    { exerciseId: 'a', reps: 10, date: '2026-10-27T09:00:00' },
    { exerciseId: 'b', reps: 3, stopped: true, date: '2026-10-27T09:00:00' },
    { exerciseId: 'c', reps: 0, date: '2026-10-27T09:00:00' },
    { exerciseId: 'd', reps: 10, date: '2026-10-26T09:00:00' },
  ], today);
  assert.deepEqual([...ids], ['a']);
});
