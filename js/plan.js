// 训练计划：根据“我的情况”（哪个关节、哪一侧、术后/伤后时间、能否站立承重、康复师给的次数、医生给的屈膝上限）
// 和今天的疼痛分、上次训练后的感受，决定今天做哪几个动作、每个做几次。
// 次数规则在 config/plan.json；角度按术后阶段取自 exercises.json 的 stageParams（康复治疗师访谈），
// 没有 stageParams 的动作（坐姿伸膝）角度不变。测试见 tests/plan.test.mjs。
// 全部是纯函数，不碰页面和存储。

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));

export const JOINTS = ['knee', 'ankle'];

// 动作属于哪个关节（旧配置没写 joint 的都是膝关节动作）
export const jointOf = (ex) => (ex?.joint === 'ankle' ? 'ankle' : 'knee');

// “左膝”这类部位值 ↔ { side, joint }
export function splitPart(part) {
  const [side, joint] = String(part || '').split('_');
  return ['left', 'right'].includes(side) && JOINTS.includes(joint) ? { side, joint } : null;
}

export function partOf(profile) {
  return profile ? `${profile.side}_${profile.joint}` : null;
}

// 把存储里读出来的“我的情况”整理成合法值；不合法返回 null（当作没填）
// v0.3 以前只存了 side（左腿 / 右腿），读进来按膝关节处理。
export function normalizeProfile(raw, rules) {
  if (!raw || typeof raw !== 'object') return null;
  const stageIds = rules.stages.map((s) => s.id);
  const side = raw.side === 'left' || raw.side === 'right' ? raw.side : null;
  const joint = JOINTS.includes(raw.joint) ? raw.joint : 'knee';
  const stage = stageIds.includes(raw.stage) ? raw.stage : null;
  const stand = ['yes', 'no', 'unsure'].includes(raw.stand) ? raw.stand : null;
  if (!side || !stage || !stand) return null;
  const n = Number(raw.clinicianReps);
  const clinicianReps = Number.isInteger(n) && n > 0 ? n : null;
  const g = rules.guard || { min: 30, max: 150 };
  const f = Number(raw.maxFlexion);
  const maxFlexion = joint === 'knee' && Number.isFinite(f) && f >= g.min && f <= g.max ? Math.round(f) : null;
  return { side, joint, stage, stand, clinicianReps, maxFlexion };
}

// 医嘱护栏：医生说“屈膝不超过 N°”，换算成膝角下限 180 − N（膝角 180° 为伸直）。
// 只作用于往“弯”的方向做的膝关节动作（起始区写的是 rest.min：足跟滑动、微蹲）。
//   - warn.max 取更保守的那个，超过上限语音提醒（计数器按原始读数判断，不放宽，见 counter.js）
//   - target.min = 上限：弯过上限就不在目标区，不计数
//   - 阶段目标比上限还深时，目标改为上限再少弯 targetGapDeg 度
//   - 改完以后目标区和起始区挤在一起（动作做不了），这个动作今天不做
// 返回 { exercise, reason } 或 { excluded: reason }；不需要改时原样返回。
export function applyGuard(ex, maxFlexion, rules) {
  if (!maxFlexion || jointOf(ex) !== 'knee' || ex.rest?.min === undefined) return { exercise: ex, reason: null };
  const R = rules.copy.reasons;
  const gap = rules.guard?.targetGapDeg ?? 10;
  const limit = 180 - maxFlexion;
  const out = { ...ex, target: { ...ex.target }, prompts: { ...ex.prompts } };
  const oldWarn = ex.warn?.max;
  if (!(Number.isFinite(oldWarn) && oldWarn >= limit)) {
    out.warn = { ...(ex.warn || {}), max: limit };
    out.prompts.warn = rules.copy.guardWarn;
  }
  out.target.min = Math.max(ex.target.min ?? -Infinity, limit);
  let reason = null;
  if (ex.target.max < limit + gap) {
    out.target.max = limit + gap;
    reason = fill(R.guardTarget, { name: ex.name, m: 180 - out.target.max });
  }
  if (out.target.max >= ex.rest.min - 6 || out.target.max <= out.target.min) {
    return { excluded: fill(R.guardExcluded, { n: maxFlexion }) };
  }
  // 动作准备页显示的一句话（steps 里写的阶段角度可能比上限深，这里说清楚以哪个为准）
  out.guardNote = fill(rules.copy.guardNote, { n: maxFlexion, m: 180 - out.target.max });
  return { exercise: out, reason };
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

// 最近一条带“训练后感受”的记录
function lastPainRecord(records) {
  return [...(records || [])].reverse().find((r) => ['green', 'yellow', 'red'].includes(r?.painAfter)) || null;
}

function hoursSince(iso, now) {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? (now.getTime() - t) / 3600000 : Infinity;
}

// 返回 { personalized, items: [{ exercise, reasons }], excluded: [{ exercise, reason }] }
// exercise 是原动作的拷贝，reps 已按规则改好；原配置不会被修改。
// anyJoint：从“课程”进入别的关节的动作时用，不按关节过滤（其余规则照常，站立承重限制照样生效）
export function buildPlan({ exercises, profile, rules, painToday = null, records = [], now = new Date(), anyJoint = false }) {
  const all = exercises || [];
  const joint = profile?.joint || 'knee'; // 没填“我的情况”的通用计划按膝关节
  const list = anyJoint ? all : all.filter((ex) => jointOf(ex) === joint);
  if (!profile) {
    return { personalized: false, items: list.map((ex) => ({ exercise: { ...ex }, reasons: [] })), excluded: [] };
  }
  const R = rules.copy.reasons;
  const reasons = [];
  const stage = rules.stages.find((s) => s.id === profile.stage);
  if (stage.params === 'lt2w') reasons.push(R.earlyOnsite);

  // 1. 基础次数：康复师给了就用康复师的，否则按术后/伤后时间
  let reps;
  if (profile.clinicianReps) {
    reps = clamp(profile.clinicianReps, rules.repsMin, rules.repsMax);
    reasons.push(fill(R.clinician, { n: reps }));
  } else {
    reps = stage.reps;
    reasons.push(profile.stage === 'unknown' ? fill(R.unknownStage, { n: reps }) : fill(R.stage, { stage: stage.label, n: reps }));
  }

  // 2. 只往少里调：今天疼痛偏高、上次训练后疼
  if (Number.isFinite(painToday) && painToday >= rules.todayPain.from) {
    reps = Math.round(reps * rules.todayPain.factor);
    reasons.push(fill(R.todayPain, { pain: painToday }));
  }
  const last = lastPainRecord(records);
  if (last?.painAfter === 'red' && hoursSince(last.date, now) <= rules.lastRed.withinHours) {
    reps = Math.round(reps * rules.lastRed.factor);
    reasons.push(R.lastRed);
  } else if (last?.painAfter === 'yellow' && hoursSince(last.date, now) <= rules.lastYellow.withinHours) {
    reps -= rules.lastYellow.minus;
    reasons.push(R.lastYellow);
  }
  reps = clamp(reps, rules.repsMin, rules.repsMax);

  // 3. 医生没明确允许站立承重，就不做站立动作
  if (profile.maxFlexion && joint === 'knee') reasons.push(fill(R.guard, { n: profile.maxFlexion }));
  const items = [];
  const excluded = [];
  list.forEach((ex) => {
    if (profile.stand !== 'yes' && rules.standingExercises.includes(ex.id)) {
      excluded.push({ exercise: ex, reason: R.standExcluded });
      return;
    }
    const sp = ex.stageParams?.[stage.params];
    const own = sp?.planReason ? [sp.planReason] : [];
    const { planReason, stageLabel, ...params } = sp || {};
    // 4. 医嘱护栏（只往保守的方向改）
    const g = applyGuard({ ...ex, ...params, reps }, profile.maxFlexion, rules);
    if (g.excluded) { excluded.push({ exercise: ex, reason: g.excluded }); return; }
    items.push({ exercise: g.exercise, reasons: [...reasons, ...own, ...(g.reason ? [g.reason] : [])] });
  });
  return { personalized: true, items, excluded };
}
