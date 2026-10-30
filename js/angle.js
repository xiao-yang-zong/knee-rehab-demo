// 计算三点夹角：返回 b 点处的夹角，单位为度，范围 0–180。
// a、b、c 都是 { x, y }，单位是像素（pose.js 已经把归一化坐标换算成像素）。
// 膝角 = angleDeg(髋, 膝, 踝)，腿完全伸直时约为 180。
//
// 做法（标准的向量夹角公式）：
//   1. 向量 BA = a - b，向量 BC = c - b
//   2. cosθ = (BA · BC) / (|BA| × |BC|)
//   3. 浮点误差可能让 cosθ 略超出 [-1, 1]，先截断，否则 Math.acos 返回 NaN
//   4. 任一向量长度为 0（两个点重合）时夹角无定义，返回 NaN
// 由 AI 实现（2026-10-27，赶提交时间），用户已知情。

export function angleDeg(a, b, c) {
  if (!a || !b || !c) return NaN;
  const bax = a.x - b.x, bay = a.y - b.y;
  const bcx = c.x - b.x, bcy = c.y - b.y;
  const lenBA = Math.hypot(bax, bay);
  const lenBC = Math.hypot(bcx, bcy);
  if (!(lenBA > 0) || !(lenBC > 0)) return NaN;
  let cos = (bax * bcx + bay * bcy) / (lenBA * lenBC);
  cos = Math.min(1, Math.max(-1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}
