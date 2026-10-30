// 膝角函数的测试。你实现 js/angle.js 之后运行：npm run test:angle
import test from 'node:test';
import assert from 'node:assert/strict';
import { angleDeg } from '../js/angle.js';

const close = (actual, expected, tol = 0.01) =>
  assert.ok(Math.abs(actual - expected) < tol, `期望约 ${expected}，实际 ${actual}`);

test('三点共线、腿伸直时是 180°', () => {
  close(angleDeg({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 0, y: 200 }), 180);
});

test('直角是 90°', () => {
  close(angleDeg({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }), 90);
});

test('45°', () => {
  close(angleDeg({ x: 100, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 100 }), 45);
});

test('结果和三点的排列方向无关（a、c 对调结果相同）', () => {
  const a = { x: 10, y: 20 }, b = { x: 50, y: 80 }, c = { x: 120, y: 90 };
  close(angleDeg(a, b, c), angleDeg(c, b, a));
});

test('浮点误差不会导致 NaN（几乎共线）', () => {
  const r = angleDeg({ x: 0, y: 0 }, { x: 1e-9, y: 1 }, { x: 0, y: 2 });
  assert.ok(Number.isFinite(r), '几乎共线时应返回接近 180 的数，而不是 NaN');
});

test('某个向量长度为 0 时返回 NaN', () => {
  assert.ok(Number.isNaN(angleDeg({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 10, y: 10 })));
});
