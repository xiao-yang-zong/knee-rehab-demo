// 记录校验测试（D10）：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecords } from '../js/storage.js';

test('非法日期和非对象的记录被丢弃', () => {
  const out = normalizeRecords([null, 'x', { date: 'not-a-date' }, { date: '2026-10-28T10:00:00Z', reps: 5, target: 10 }]);
  assert.equal(out.length, 1);
});

test('数字被夹到合理范围（hitRate=83 不会显示成 8300%）', () => {
  const [r] = normalizeRecords([{ date: '2026-10-28T10:00:00Z', reps: 15, target: 10, hitRate: 83, painBefore: 12, best: 999, painAfter: 'purple' }]);
  assert.equal(r.reps, 10);
  assert.equal(r.hitRate, 1);
  assert.equal(r.painBefore, 10);
  assert.equal(r.best, 180);
  assert.equal(r.painAfter, undefined);
});

test('缺省的可选字段保持为空，不编造数据', () => {
  const [r] = normalizeRecords([{ date: '2026-10-28T10:00:00Z', reps: 3, target: 10, hitRate: null, best: null }]);
  assert.equal(r.hitRate, null);
  assert.equal(r.best, null);
  assert.equal(r.stopped, false);
});

test('存储里不是数组时返回空列表', () => {
  assert.deepEqual(normalizeRecords({ a: 1 }), []);
});
