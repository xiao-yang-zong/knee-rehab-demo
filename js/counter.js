// 计数状态机：只依赖角度和时间，不依赖摄像头，方便单元测试。
// 动作参数（康复标准）来自 config/exercises.json；“判定有多宽松”由下面的 counting 参数决定，两者分开。
//
// 状态流转：
//   WAIT_REST  先回到起始姿势（扶椅微蹲在这一步顺便做“站直校准”）
//   READY      在起始姿势，等待进入目标区
//   IN_TARGET  进入目标区，开始累计保持时间
//   HELD       保持时间已够，等待回到起始姿势
//   回到起始姿势 → 次数 +1 → READY
//
// v0.7 判定放宽（2026-10-28，原因：真人试用很难刷出次数）。做法参考：
//   1. 测量余量 marginDeg：单摄像头角度误差约 6°，进入目标区、回到起始姿势的门槛各放宽这么多度。
//      两区之间至少留 minGapDeg，避免在中间来回抖动时重复计数。（类似 FormCheck 的 hysteresis 偏移）
//   2. 迟滞 hysteresisDeg：进入目标区要过“进入线”，离开要越过更宽的“离开线”。
//      （MediaPipe / ML Kit RepetitionCounter 用 enter=6、exit=4 两个阈值，原理相同）
//   3. 保持容错 graceSec：保持期间短暂出界或看不到腿，在这个时间内回来不作废，只是计时暂停。
//      一回到起始姿势就算放弃，立即作废。
//   4. 站直校准 calibrate（只用于站着做的动作）：站直不动约 1 秒，记下此时读数，
//      把“摄像头读出来的站直角度”校正到 refDeg，消掉拍摄角度造成的固定偏差。
// 安全侧不放宽：warn（蹲太深）始终用未校正的原始角度和配置里的原始阈值；过快提示不变。
//
// 事件（event）供界面播放语音：ready / enter_target / hold_broken / held / rep / done
// snapshot.warn：进入警告区；snapshot.tooFast：角速度超过 exercise.maxSpeed（度/秒）。

export const MIN_DWELL_SEC = 0.3; // 防抖：即使 holdSec 为 0，也要在目标区停留这么久
export const SPEED_ALPHA = 0.3;   // 角速度的指数平滑系数，避免单帧抖动误报“太快”

export const DEFAULT_COUNTING = {
  marginDeg: 8,     // 测量余量（度）
  hysteresisDeg: 5, // 迟滞（度）
  graceSec: 0.8,    // 保持容错（秒）
  minGapDeg: 6,     // 放宽后起始区与目标区的最小间隔（度）
};

const CAL_STILL_SPEED = 20; // 站直校准：角速度低于这个值（度/秒）算“站着不动”
const CAL_STILL_SEC = 0.8;  // 需要不动这么久才完成校准

export function inRange(value, range) {
  if (!range || !Number.isFinite(value)) return false;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

// 把康复标准（rest / target / warn）换算成实际用于判定的区间。纯函数，测试见 tests/counter.test.mjs。
// 返回 { dir, rest, enter, stay, counting }：
//   rest  回到起始姿势的判定区（已放宽）
//   enter 进入目标区的判定区（已放宽）
//   stay  已在目标区时，留在目标区的判定区（再加迟滞）
export function effectiveZones(exercise) {
  const c = { ...DEFAULT_COUNTING, ...(exercise.counting || {}) };
  const { rest, target, warn } = exercise;
  const up = rest.max !== undefined; // 起始区在下面（弯着），目标在上面（伸直）
  const restB = up ? rest.max : rest.min;
  const reachB = up ? target.min : target.max; // 靠近起始区那一侧的目标边界
  const gap = Math.abs(reachB - restB);
  const m = Math.max(0, Math.min(c.marginDeg, (gap - c.minGapDeg) / 2));
  const s = up ? 1 : -1; // 从起始区朝目标区的方向

  const restZone = up ? { ...rest, max: restB + m } : { ...rest, min: restB - m };
  const reachEnter = reachB - s * m;
  const reachStay = reachEnter - s * c.hysteresisDeg;
  // 远端边界（例如微蹲“最多蹲到 30°”）只按配置，不放宽，也不能进入警告区
  const farKey = up ? 'max' : 'min';
  let far = target[farKey];
  if (far !== undefined && warn && warn[up ? 'min' : 'max'] !== undefined) {
    const w = warn[up ? 'min' : 'max'];
    far = up ? Math.min(far, w - 0.5) : Math.max(far, w + 0.5);
  }
  const build = (reach) => {
    const z = up ? { min: reach } : { max: reach };
    if (far !== undefined) z[farKey] = far;
    return z;
  };
  // 离开线不能越过起始区
  const stayReach = up ? Math.max(reachStay, restZone.max + 0.5) : Math.min(reachStay, restZone.min - 0.5);
  return { dir: up ? 'up' : 'down', rest: restZone, enter: build(reachEnter), stay: build(stayReach), counting: c };
}

export function createCounter(exercise) {
  const zones = effectiveZones(exercise);
  const { graceSec } = zones.counting;
  const cal = exercise.calibrate || null; // { refDeg, maxOffsetDeg }
  const holdSec = Math.max(exercise.holdSec || 0, 0);
  const needSec = Math.max(holdSec, MIN_DWELL_SEC);

  let state = 'WAIT_REST';
  let reps = 0;
  let done = false;
  let holdAcc = 0;      // 本次已累计的保持时间
  let outSince = NaN;   // 保持期间开始出界的时间
  let lastT = NaN;
  let prevAngle = NaN;
  let prevT = NaN;
  let speed = 0;        // 平滑后的角速度（度/秒）
  let offset = cal ? NaN : 0; // 站直校准的修正量；NaN 表示还没校准
  let calSince = NaN;
  let calSum = 0;
  let calN = 0;

  function snapshot(event, t) {
    let holdProgress = 0;
    if (state === 'IN_TARGET') holdProgress = Math.min(holdAcc / needSec, 1);
    if (state === 'HELD') holdProgress = 1;
    return {
      state, reps, holdProgress, event, warn: false, done, speed, tooFast: false,
      paused: state === 'IN_TARGET' && Number.isFinite(outSince),
      calibrated: Number.isFinite(offset), offset,
    };
  }

  function trackSpeed(angle, t) {
    const dt = t - prevT;
    if (Number.isFinite(prevAngle) && dt > 0) {
      speed += SPEED_ALPHA * (Math.abs(angle - prevAngle) / dt - speed);
    }
    prevAngle = angle;
    prevT = t;
  }

  // 站直校准：在起始姿势附近站着不动 CAL_STILL_SEC 秒，取平均读数
  function tryCalibrate(raw, t) {
    const loose = zones.rest.min - cal.maxOffsetDeg;
    if (raw >= loose && speed < CAL_STILL_SPEED) {
      if (!Number.isFinite(calSince)) { calSince = t; calSum = 0; calN = 0; }
      calSum += raw; calN += 1;
      if (t - calSince >= CAL_STILL_SEC) {
        offset = Math.min(Math.max(cal.refDeg - calSum / calN, 0), cal.maxOffsetDeg);
        return true;
      }
    } else {
      calSince = NaN;
    }
    return false;
  }

  function breakHold() {
    state = 'READY';
    holdAcc = 0;
    outSince = NaN;
    return holdSec > 0 ? 'hold_broken' : null;
  }

  function update(raw, t) {
    if (!Number.isFinite(raw) || done) return snapshot(null, t);
    trackSpeed(raw, t);
    const dt = Number.isFinite(lastT) ? Math.max(t - lastT, 0) : 0;
    lastT = t;

    let event = null;
    if (cal && !Number.isFinite(offset)) {
      if (tryCalibrate(raw, t)) { state = 'READY'; event = 'ready'; }
      return finish(event, raw, t);
    }
    // 校准后如果站得更直了，修正量只往小里调（自我纠正，不会越调越松）
    if (cal && raw + offset > cal.refDeg) offset = Math.max(cal.refDeg - raw, 0);
    const angle = raw + offset;

    switch (state) {
      case 'WAIT_REST':
        if (inRange(angle, zones.rest)) { state = 'READY'; event = 'ready'; }
        break;
      case 'READY':
        if (inRange(angle, zones.enter)) {
          state = 'IN_TARGET'; holdAcc = 0; outSince = NaN; event = 'enter_target';
        }
        break;
      case 'IN_TARGET':
        if (inRange(angle, zones.rest)) {
          event = breakHold(); // 回到起始姿势 = 放弃这一次
        } else if (inRange(angle, zones.stay)) {
          outSince = NaN;
          holdAcc += dt;
          if (holdAcc >= needSec) { state = 'HELD'; event = 'held'; }
        } else {
          if (!Number.isFinite(outSince)) outSince = t;
          if (t - outSince > graceSec) event = breakHold();
        }
        break;
      case 'HELD':
        if (inRange(angle, zones.rest)) {
          reps += 1;
          state = 'READY';
          event = 'rep';
          if (reps >= exercise.reps) { done = true; event = 'done'; }
        }
        break;
    }
    return finish(event, raw, t);
  }

  function finish(event, raw, t) {
    const snap = snapshot(event, t);
    snap.warn = inRange(raw, exercise.warn); // 安全侧：原始角度、原始阈值
    snap.tooFast = exercise.maxSpeed > 0 && speed > exercise.maxSpeed;
    return snap;
  }

  // 画面里看不到腿（被挡住、走出画面）时调用。
  // 保持期间：graceSec 内回来不作废（计时暂停）；超过才算这一次作废。
  // 已经保持够（HELD）的不受影响，回到起始姿势照常计数。
  function lose(t) {
    if (done) return snapshot(null, t);
    prevAngle = NaN; // 看不到腿期间不算速度，回来后重新开始
    speed = 0;
    lastT = t;
    calSince = NaN;
    let event = null;
    if (state === 'IN_TARGET') {
      if (!Number.isFinite(outSince)) outSince = t;
      if (t - outSince > graceSec) event = breakHold();
    }
    return snapshot(event, t);
  }

  return { update, lose, zones, get reps() { return reps; }, get state() { return state; } };
}

// 指数平滑，减少关键点抖动带来的角度跳变。alpha 越小越平滑，但反应越慢。
export function createSmoother(alpha = 0.35) {
  let value = NaN;
  return {
    push(x) {
      if (!Number.isFinite(x)) return value;
      value = Number.isFinite(value) ? value + alpha * (x - value) : x;
      return value;
    },
    reset() { value = NaN; },
  };
}
