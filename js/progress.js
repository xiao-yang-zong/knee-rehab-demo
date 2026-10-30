// 进步计算：每次训练记一个“最好角度”，记录页拿第一次和最近一次对比。
// 全部是纯函数，不碰页面和存储，测试见 tests/progress.test.mjs。
//
// 两种指标（在 config/exercises.json 的 progress.metric 里指定）：
//   extension：伸直程度，取本次最大膝角（越接近 180° 越直）
//   flexion：  弯曲程度，取 180 − 本次最小膝角（屈膝角，越大弯得越多）
// 扶椅微蹲不追求蹲得更深，所以不设指标。

// 小于这个差值视为正常波动（手机单摄的膝角误差约 6°）
export const FLUCTUATION_DEG = 5;

// 记录一次训练里出现过的最大、最小膝角
export function createAngleRange() {
  let min = Infinity;
  let max = -Infinity;
  return {
    push(angle) {
      if (!Number.isFinite(angle)) return;
      if (angle < min) min = angle;
      if (angle > max) max = angle;
    },
    get min() { return Number.isFinite(min) ? min : NaN; },
    get max() { return Number.isFinite(max) ? max : NaN; },
  };
}

// 把一次训练的角度范围换算成指标值（整数度），没有数据时返回 null
export function bestValue(metric, range) {
  if (metric === 'extension' && Number.isFinite(range.max)) return Math.round(range.max);
  if (metric === 'flexion' && Number.isFinite(range.min)) return Math.round(180 - range.min);
  return null;
}

// 汇总某个动作的进步情况。records 按时间从旧到新。
// 返回 null 表示这个动作没有指标或还没有数据。
export function summarize(records, exercise) {
  const metric = exercise?.progress?.metric;
  if (!metric) return null;
  const list = records.filter((r) => r.exerciseId === exercise.id && Number.isFinite(r.best));
  if (!list.length) return null;
  const first = list[0].best;
  const latest = list[list.length - 1].best;
  const best = Math.max(...list.map((r) => r.best));
  const delta = latest - first;
  let trend = 'single';
  if (list.length > 1) {
    if (delta >= FLUCTUATION_DEG) trend = 'up';
    else if (delta <= -FLUCTUATION_DEG) trend = 'down';
    else trend = 'flat';
  }
  return { metric, label: exercise.progress.label, count: list.length, first, latest, best, delta, trend };
}

// 生成给用户看的一句话。按心理老师的建议：只用正向或中性的说法，不说“退步”。
export function progressMessage(s) {
  if (!s) return '';
  switch (s.trend) {
    case 'single': return `已经记下第一次的 ${s.latest}°，之后每次训练都会和它对比。`;
    case 'up': return `比第一次多了 ${s.delta}°，按计划继续，复诊时可以把这个变化告诉医生。`;
    case 'flat': return '和第一次差不多。平台期很常见，往往是下一次突破前的积累，按计划继续就好。';
    case 'down': return `这次 ${s.latest}°，你最好的一次是 ${s.best}°。角度每天都会有正常波动，拍摄角度也会影响读数，保持训练，下次再看。`;
    default: return '';
  }
}

// 训练后疼痛三档（红绿灯）
export const PAIN_LEVELS = ['green', 'yellow', 'red'];
