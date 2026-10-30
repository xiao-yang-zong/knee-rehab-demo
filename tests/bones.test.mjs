// 识别合理性检查测试：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoneCheck, BONE_DEFAULTS } from '../js/bones.js';

// 侧面坐姿：髋在左、膝在右，小腿按膝角朝下或朝前；thigh、shank 是像素长度
function leg(angleDeg, { thigh = 120, shank = 115, ox = 200, oy = 300 } = {}) {
  const hip = { x: ox, y: oy };
  const knee = { x: ox + thigh, y: oy };
  const th = ((180 - angleDeg) * Math.PI) / 180;
  const ankle = { x: knee.x + shank * Math.cos(th), y: knee.y + shank * Math.sin(th) };
  return { hip, knee, ankle };
}

function feed(bc, frames, fps = 30, t0 = 0) {
  let t = t0;
  return frames.map(([angle, opts]) => { const r = bc.check(leg(angle, opts), angle, t); t += 1 / fps; return r; });
}

test('正常做动作：角度连续变化，全部判为合理', () => {
  const bc = createBoneCheck();
  const frames = [];
  for (let i = 0; i < 90; i++) frames.push([100 + 60 * Math.abs(Math.sin(i / 15)), {}]);
  assert.ok(feed(bc, frames).every((r) => r.ok));
});

test('斜着拍：小腿投影长度随动作平滑缩短到 55%，不能拦（v0.9 第一版的缺陷）', () => {
  const bc = createBoneCheck();
  const frames = [];
  for (let i = 0; i <= 45; i++) frames.push([100 + (68 * i) / 45, { shank: 115 * (1 - 0.45 * (i / 45)) }]);
  assert.ok(feed(bc, frames).every((r) => r.ok));
});

test('人离镜头远近变化（大腿小腿一起缩放）不算不合理', () => {
  const bc = createBoneCheck();
  const frames = [];
  for (let i = 0; i < 60; i++) { const k = 1 + i / 100; frames.push([110, { thigh: 120 * k, shank: 115 * k }]); }
  assert.ok(feed(bc, frames).every((r) => r.ok));
});

test('“小腿”一帧之内变成 1.6 倍长（跳到椅子腿上）判为跳点', () => {
  const bc = createBoneCheck();
  const rs = feed(bc, [...Array(10).fill([100, {}]), [100, { shank: 115 * 1.6 }]]);
  assert.equal(rs.at(-1).ok, false);
  assert.equal(rs.at(-1).reason, 'ratio');
});

test('膝角一帧之内跳 60° 判为跳点；正常速度（1 秒 60°）不算', () => {
  const bc = createBoneCheck();
  const rs = feed(bc, [...Array(10).fill([100, {}]), [160, {}]]);
  assert.equal(rs.at(-1).reason, 'jump');
  const slow = [];
  for (let i = 0; i <= 30; i++) slow.push([100 + 2 * i, {}]);
  assert.ok(feed(createBoneCheck(), slow).every((r) => r.ok));
});

test('一闪而过的认错帧（交替出现）被丢掉，正常帧照常通过', () => {
  const bc = createBoneCheck();
  const frames = [];
  for (let i = 0; i < 30; i++) frames.push(i % 5 === 4 ? [100, { shank: 200 }] : [100, {}]);
  const rs = feed(bc, frames);
  rs.forEach((r, i) => assert.equal(r.ok, i % 5 !== 4, `第 ${i} 帧`));
});

test('新状态持续超过 spikeSec 就接受为新基准，不会卡死', () => {
  const bc = createBoneCheck();
  const n = Math.ceil((BONE_DEFAULTS.spikeSec + 0.1) * 30);
  const rs = feed(bc, [...Array(10).fill([100, {}]), ...Array(n).fill([165, {}])]);
  assert.equal(rs[10].ok, false);
  assert.equal(rs.at(-1).ok, true);
});

test('最近 3 秒内被丢很多帧时标记 noisy', () => {
  const bc = createBoneCheck();
  const frames = [];
  for (let i = 0; i < 90; i++) frames.push(i % 2 ? [100, { shank: 230 }] : [100, {}]);
  assert.equal(feed(bc, frames).at(-1).noisy, true);
});

test('关键点重合（长度为 0）判为不合理', () => {
  const bc = createBoneCheck();
  const r = bc.check({ hip: { x: 0, y: 0 }, knee: { x: 0, y: 0 }, ankle: { x: 5, y: 5 } }, 120, 0);
  assert.equal(r.ok, false);
});
