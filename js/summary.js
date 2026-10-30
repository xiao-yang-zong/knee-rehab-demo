// 训练摘要：只根据本机真实记录做统计和拼句子，不做任何推断或诊断。
// 全部是纯函数，测试见 tests/summary.test.mjs。

import { summarize } from './progress.js';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const PAIN_RANK = { green: 0, yellow: 1, red: 2 };

export function localDay(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function md(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function validRecords(records) {
  return (records || []).filter((r) => r && Number.isFinite(new Date(r.date).getTime()));
}

// 最近 n 天（含今天），按日期从早到晚。每天：完成了几组（reps > 0 且未中止）、共几次、最差的训练后感受
export function lastNDays(records, today = new Date(), n = 7) {
  const list = validRecords(records);
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = localDay(d);
    const rs = list.filter((r) => localDay(new Date(r.date)) === key);
    const sets = rs.filter((r) => !r.stopped && r.reps > 0).length;
    const reps = rs.reduce((s, r) => s + (Number.isFinite(r.reps) ? Math.max(r.reps, 0) : 0), 0);
    const pains = rs.map((r) => r.painAfter).filter((p) => p in PAIN_RANK);
    const worst = pains.sort((a, b) => PAIN_RANK[b] - PAIN_RANK[a])[0] || null;
    days.push({
      key, label: i === 0 ? '今天' : `周${WEEK[d.getDay()]}`, date: md(d),
      sets, reps, stops: rs.filter((r) => r.stopped).length, worstPain: worst, records: rs.length,
    });
  }
  return days;
}

export function weekSummary(records, today = new Date()) {
  const days = lastNDays(records, today, 7);
  const inWeek = new Set(days.map((d) => d.key));
  const list = validRecords(records).filter((r) => inWeek.has(localDay(new Date(r.date))));
  const lastWithPain = [...list].reverse().find((r) => r.painAfter in PAIN_RANK);
  return {
    days,
    from: days[0].date,
    to: days[days.length - 1].date,
    trainedDays: days.filter((d) => d.sets > 0).length,
    sets: days.reduce((s, d) => s + d.sets, 0),
    reps: days.reduce((s, d) => s + d.reps, 0),
    stops: days.reduce((s, d) => s + d.stops, 0),
    lastPain: lastWithPain ? lastWithPain.painAfter : null,
    painCount: {
      green: list.filter((r) => r.painAfter === 'green').length,
      yellow: list.filter((r) => r.painAfter === 'yellow').length,
      red: list.filter((r) => r.painAfter === 'red').length,
    },
    painBefore: list.map((r) => r.painBefore).filter(Number.isFinite),
    completion: completionRate(list),
    records: list.length,
  };
}

// 完成度（依从性）：每组实际完成次数 ÷ 计划次数的平均值，因不适停止的组也算在内。没有可算的组时返回 null
export function completionRate(list) {
  const sets = (list || []).filter((r) => Number.isFinite(r.target) && r.target > 0 && Number.isFinite(r.reps));
  if (!sets.length) return null;
  return sets.reduce((s, r) => s + Math.min(r.reps / r.target, 1), 0) / sets.length;
}

const PAIN_TEXT = { green: '不疼', yellow: '有点疼', red: '很疼' };

// 一句话客观描述，不评价、不解释成“恢复好了/变差了”
export function summaryText(ws) {
  if (!ws.records) return '最近 7 天还没有训练记录。完成一次训练后，这里会自动整理你的情况。';
  const parts = [`最近 7 天，你有 ${ws.trainedDays} 天进行了训练，完成 ${ws.sets} 组、共 ${ws.reps} 次动作。`];
  if (ws.stops > 0) parts.push(`其中 ${ws.stops} 次因为不适提前停止。`);
  if (ws.lastPain) parts.push(`最近一次训练后的感受是“${PAIN_TEXT[ws.lastPain]}”。`);
  if (ws.lastPain === 'red') parts.push('如果疼痛还没有缓解，先休息，并联系你的医生或康复师。');
  return parts.join('');
}

// 给医生或康复师看的纯文本摘要（用户自己复制、自己决定发给谁）
// profile（可选）：{ stageLabel, standLabel }，用户在“我的情况”里自己填的，原样写出，标明是自填
export function buildReport(records, exercises, today = new Date(), profile = null) {
  const ws = weekSummary(records, today);
  const y = today.getFullYear();
  const lines = [
    `RehabGo 训练摘要（${y}/${md(today)} 生成）`,
    `统计范围：最近 7 天（${ws.from}–${ws.to}）`,
  ];
  if (profile) {
    const part = profile.partLabel ? `部位 ${profile.partLabel}；` : '';
    lines.push(`· 用户自填：${part}距离手术或受伤 ${profile.stageLabel}；医生是否允许站立承重：${profile.standLabel}`);
    if (profile.maxFlexion) lines.push(`· 用户自填的医生屈膝上限：${profile.maxFlexion}°（训练中超过会提醒，超过的那一次不计数）`);
  }
  if (!ws.records) {
    lines.push('这段时间没有训练记录。');
  } else {
    lines.push(`· 训练天数：${ws.trainedDays} 天；完成 ${ws.sets} 组，共 ${ws.reps} 次动作`);
    if (ws.completion !== null) lines.push(`· 完成度：平均每组完成计划次数的 ${Math.round(ws.completion * 100)}%（含因不适停止的组）`);
    (exercises || []).forEach((ex) => {
      const s = summarize(validRecords(records), ex);
      if (!s) return;
      lines.push(s.count > 1
        ? `· ${ex.name}（${s.label}）：第一次 ${s.first}° → 最近一次 ${s.latest}°，共 ${s.count} 次有效记录`
        : `· ${ex.name}（${s.label}）：${s.latest}°，目前只有 1 次记录`);
    });
    if (ws.painBefore.length) lines.push(`· 训练前疼痛（0–10 分），按时间顺序：${ws.painBefore.join('、')}`);
    const pc = ws.painCount;
    if (pc.green + pc.yellow + pc.red) lines.push(`· 训练后感受：不疼 ${pc.green} 次，有点疼 ${pc.yellow} 次，很疼 ${pc.red} 次`);
    lines.push(`· 因不适提前停止：${ws.stops} 次`);
  }
  lines.push('说明：角度由手机摄像头估算，仅供参考，以医生测量为准。本摘要由本机记录自动整理，不包含任何诊断结论。');
  return lines.join('\n');
}
