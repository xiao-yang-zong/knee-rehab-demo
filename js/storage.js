// 本地存储：训练记录只保存在这台手机的浏览器里，不上传。
// 浏览器无痕模式或禁用存储时会失败，所以每次读写都包在 try/catch 里。

const KEYS = {
  records: 'krd.records.v1',
  confirmed: 'krd.doctorConfirmed.v1',
  profile: 'krd.profile.v1',
  onboarded: 'krd.onboarded.v1',
};

// 最多保存的记录条数（每天练 3 组，约半年）。超过后丢掉最早的。
export const MAX_RECORDS = 500;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

export function getRecords() {
  return normalizeRecords(read(KEYS.records, []));
}

// 读入时校验每条记录：日期非法的丢弃，数字夹到合理范围，避免脏数据显示成“达标 8300%”这类荒谬数字。
// 纯函数，测试见 tests/storage.test.mjs。
export function normalizeRecords(list) {
  if (!Array.isArray(list)) return [];
  const num = (v, min, max) => (Number.isFinite(v) ? Math.min(Math.max(v, min), max) : null);
  return list
    .filter((r) => r && typeof r === 'object' && Number.isFinite(new Date(r.date).getTime()))
    .map((r) => {
      const target = num(r.target, 0, 100) ?? 0;
      return {
        ...r,
        reps: num(r.reps, 0, Math.max(target, 0)) ?? 0,
        target,
        hitRate: num(r.hitRate, 0, 1),
        painBefore: num(r.painBefore, 0, 10),
        best: num(r.best, 0, 180),
        painAfter: ['green', 'yellow', 'red'].includes(r.painAfter) ? r.painAfter : undefined,
        stopped: r.stopped === true,
      };
    });
}

// record: { date: ISO 字符串, exerciseId, exerciseName, reps, target, hitRate, painBefore,
//           best（本次指标角度，可能为 null）, painAfter（'green' | 'yellow' | 'red'）, stopped }
export function addRecord(record) {
  const list = getRecords();
  list.push(record);
  return write(KEYS.records, list.slice(-MAX_RECORDS));
}

export function updateLastRecord(patch) {
  const list = getRecords();
  if (!list.length) return false;
  Object.assign(list[list.length - 1], patch);
  return write(KEYS.records, list);
}

// 我的情况（生成训练计划用）：{ side, stage, stand, clinicianReps }
export function getProfile() {
  return read(KEYS.profile, null);
}

export function setProfile(profile) {
  return write(KEYS.profile, profile);
}

// 清除这台设备上的全部数据（训练记录、“医生已允许”的确认、我的情况、欢迎页的确认）
export function clearAll() {
  try {
    Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
    return true;
  } catch (_) {
    return false;
  }
}

export function isDoctorConfirmed() {
  return read(KEYS.confirmed, false) === true;
}

export function setDoctorConfirmed(value) {
  return write(KEYS.confirmed, !!value);
}

// 第一次使用时在欢迎页确认过免责声明（清除全部数据后需要重新确认）
export function isOnboarded() {
  return read(KEYS.onboarded, false) === true;
}

export function setOnboarded(value) {
  return write(KEYS.onboarded, !!value);
}

// 连续训练天数：从今天（或昨天）往前数，每天至少有一条记录
export function streakDays(records = getRecords(), today = new Date()) {
  const days = new Set(records.map((r) => localDay(new Date(r.date))));
  let cursor = new Date(today);
  if (!days.has(localDay(cursor))) cursor.setDate(cursor.getDate() - 1);
  let n = 0;
  while (days.has(localDay(cursor))) {
    n += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return n;
}

// 今天做过（且没有因不适中止）的动作 id
export function doneTodayIds(records = getRecords(), today = new Date()) {
  const key = localDay(today);
  return new Set(records.filter((r) => !r.stopped && r.reps > 0 && localDay(new Date(r.date)) === key).map((r) => r.exerciseId));
}

function localDay(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
