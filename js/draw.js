// 在画布上画骨架。前置摄像头画面在 CSS 里做了镜像，这里画点时也把 x 镜像，
// 文字本身不镜像，保证读起来是正的。

import { CONNECTIONS } from './pose.js';

export function drawFrame(canvas, { landmarks, width, height }, leg, angle, mirror = true) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  if (!landmarks) return;

  const X = (p) => (mirror ? width - p.x : p.x);
  const scale = Math.max(width, height) / 640;

  ctx.lineWidth = 3 * scale;
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  for (const [a, b] of CONNECTIONS) {
    const p = landmarks[a], q = landmarks[b];
    if (!p || !q || p.visibility < 0.3 || q.visibility < 0.3) continue;
    ctx.beginPath();
    ctx.moveTo(X(p), p.y);
    ctx.lineTo(X(q), q.y);
    ctx.stroke();
  }

  if (!leg) return;
  ctx.lineWidth = 6 * scale;
  ctx.strokeStyle = '#2bd17e';
  ctx.beginPath();
  ctx.moveTo(X(leg.hip), leg.hip.y);
  ctx.lineTo(X(leg.knee), leg.knee.y);
  ctx.lineTo(X(leg.ankle), leg.ankle.y);
  ctx.stroke();

  ctx.fillStyle = '#2bd17e';
  for (const p of [leg.hip, leg.knee, leg.ankle]) {
    ctx.beginPath();
    ctx.arc(X(p), p.y, 7 * scale, 0, Math.PI * 2);
    ctx.fill();
  }

  if (Number.isFinite(angle)) {
    const label = `${Math.round(angle)}°`;
    ctx.font = `600 ${Math.round(26 * scale)}px -apple-system, "PingFang SC", sans-serif`;
    const tx = X(leg.knee) + 14 * scale;
    const ty = leg.knee.y - 14 * scale;
    ctx.lineWidth = 5 * scale;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText(label, tx, ty);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, tx, ty);
  }
}
