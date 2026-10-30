// 识别结果合理性检查：挡住“一闪而过的认错帧”，例如识别瞬间跳到椅子腿、桌腿上。
// 纯函数模块，不碰页面，测试见 tests/bones.test.mjs。
//
// 为什么需要：MediaPipe 对认错或被挡住的关节，往往仍给出很高的可见度分数，光看 visibility 挡不住误识别。
// 认错的典型表现是“突变”：一帧之内膝角跳几十度，或者小腿 / 大腿的长度比突然变了一大截。
// 真实的动作是连续的，所以只拦突变，不和长期平均值比较——
// 手机斜着拍时，小腿朝镜头方向摆动，投影长度会平滑地变短，这是正常的，不能拦（v0.9 第一版这样拦过，会让计数失灵）。
//
// 规则：
//   - 和上一个“被接受的帧”比较，相隔不到 spikeSec 秒时，膝角差超过 jumpDeg 或长度比变化超过 ratioJump，判为跳点，丢掉；
//   - 如果新的状态持续超过 spikeSec 秒，就接受它作为新的基准（可能是真的动作，也可能是持续认错，后者要靠模型和拍摄环境解决）。
//     所以一次异常最多丢 spikeSec 秒的画面，不会卡死。
//   - 最近 noisyWindowSec 秒内被丢的帧太多，标记 noisy，界面提示“换个背景简单的地方”。
// 被丢的帧在 app.js 里当作“这一帧看不到腿”，计数器的保持容错（graceSec）会兜住。

export const BONE_DEFAULTS = {
  spikeSec: 0.2,        // 和上一个被接受的帧相隔不到这么久，才做突变判断
  jumpDeg: 40,          // 膝角突变阈值（度）
  ratioJump: 0.3,       // 小腿 / 大腿长度比的突变阈值（相对变化）
  noisyWindowSec: 3,    // 统计最近这么多秒内被丢的帧
  noisyCount: 12,       // 超过这么多帧被丢，判为干扰较多
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// check(leg, angle, t) → { ok, reason?, noisy }
//   leg: { hip, knee, ankle }（像素坐标）；angle: 这一帧的原始膝角（度）；t: 秒
export function createBoneCheck(options = {}) {
  const o = { ...BONE_DEFAULTS, ...options };
  let last = null; // { angle, ratio, t }：上一个被接受的帧
  let rejects = []; // 最近被丢帧的时间

  function noisy(t) {
    rejects = rejects.filter((x) => t - x <= o.noisyWindowSec);
    return rejects.length >= o.noisyCount;
  }

  function check(leg, angle, t) {
    const thigh = dist(leg.hip, leg.knee);
    const shank = dist(leg.knee, leg.ankle);
    if (!(thigh > 1) || !(shank > 1) || !Number.isFinite(angle)) {
      rejects.push(t);
      return { ok: false, reason: 'degenerate', noisy: noisy(t) };
    }
    const ratio = shank / thigh;
    if (last && t - last.t <= o.spikeSec) {
      const jump = Math.abs(angle - last.angle) > o.jumpDeg;
      const stretch = Math.abs(ratio - last.ratio) / last.ratio > o.ratioJump;
      if (jump || stretch) {
        rejects.push(t);
        return { ok: false, reason: jump ? 'jump' : 'ratio', noisy: noisy(t) };
      }
    }
    last = { angle, ratio, t };
    return { ok: true, noisy: noisy(t) };
  }

  function reset() {
    last = null;
    rejects = [];
  }

  return { check, reset };
}
