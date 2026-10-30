// 动作示意动画：侧面小人，用 SVG 自带的 <animate>（SMIL），iOS / 安卓 / 电脑浏览器都支持，不需要视频文件。
// 患侧腿用强调色画；虚线是动作路径。示意图只说明“怎么动”，具体角度以动作说明和康复师要求为准。
// 系统开了“减弱动态效果”时停在第一帧（app.js 调用 pauseAnimations）。

const SPLINE = '0.45 0 0.25 1';

function anim(attr, frames, keyTimes, dur) {
  const splines = Array(keyTimes.length - 1).fill(SPLINE).join(';');
  return `<animate attributeName="${attr}" dur="${dur}s" repeatCount="indefinite" calcMode="spline"
    keyTimes="${keyTimes.join(';')}" keySplines="${splines}" values="${frames.join(';')}"/>`;
}

// 一个姿势 = { head:[cx,cy], torso:'x,y x,y', arm:'…', leg:'hip knee ankle toe' }
function figure(poses, keyTimes, dur) {
  const p0 = poses[0];
  const seq = (k) => poses.map((p) => p[k]);
  return `
    <polyline class="body" points="${p0.arm}">${anim('points', seq('arm'), keyTimes, dur)}</polyline>
    <polyline class="body" points="${p0.torso}">${anim('points', seq('torso'), keyTimes, dur)}</polyline>
    <circle class="head" r="10" cx="${p0.head[0]}" cy="${p0.head[1]}">
      ${anim('cx', poses.map((p) => p.head[0]), keyTimes, dur)}${anim('cy', poses.map((p) => p.head[1]), keyTimes, dur)}
    </circle>
    <polyline class="leg" points="${p0.leg}">${anim('points', seq('leg'), keyTimes, dur)}</polyline>`;
}

// 床边或沙发边：实心的座面，没有细长的腿（凳子腿容易被姿态模型认成人腿）
const STOOL = `
  <rect class="prop" x="30" y="76" width="80" height="48" rx="8"/>
  <rect class="prop-top" x="26" y="70" width="86" height="9" rx="4.5"/>`;
const FLOOR = (y) => `<line class="floor" x1="16" y1="${y}" x2="204" y2="${y}"/>`;

const SEATED_TOP = { head: [80, 22], torso: '81,34 84,74', arm: '81,42 92,60 108,70' };

const SCENES = {
  seated_knee_extension() {
    const rest = { ...SEATED_TOP, leg: '84,74 128,74 128,118 142,121' };
    const up = { ...SEATED_TOP, leg: '84,74 128,74 172,72 175,59' };
    return `${FLOOR(124)}${STOOL}
      <path class="path" d="M128 118 A44 44 0 0 0 172 74"/>
      ${figure([rest, rest, up, up, rest, rest], [0, 0.18, 0.42, 0.72, 0.94, 1], 5)}`;
  },
  seated_heel_slide() {
    const fwd = { ...SEATED_TOP, leg: '84,74 128,74 152,116 166,121' };
    const back = { ...SEATED_TOP, leg: '84,74 128,74 120,120 134,123' };
    return `${FLOOR(124)}${STOOL}
      <path class="path" d="M160 130 L118 130"/><path class="path-head" d="M123 126 L118 130 L123 134"/>
      ${figure([fwd, fwd, back, back, fwd, fwd], [0, 0.18, 0.45, 0.75, 0.95, 1], 6)}`;
  },
  // 踝泵：长坐在床上，腿伸直，只动脚尖（勾 → 保持 → 绷）
  ankle_pump() {
    const top = { head: [44, 30], torso: '46,42 52,88', arm: '47,50 58,70 70,84' };
    const rest = { ...top, leg: '52,88 112,88 168,88 175,73' };
    const up = { ...top, leg: '52,88 112,88 168,88 162,73' };
    const down = { ...top, leg: '52,88 112,88 168,88 185,101' };
    return `<rect class="prop" x="14" y="40" width="10" height="56" rx="4"/>
      <rect class="prop" x="20" y="96" width="190" height="26" rx="6"/>
      <rect class="prop-top" x="16" y="90" width="198" height="9" rx="4.5"/>
      <path class="path" d="M186 100 A20 20 0 0 0 160 70"/>
      ${figure([rest, up, up, down, rest, rest], [0, 0.18, 0.55, 0.78, 0.92, 1], 5)}`;
  },
  chair_mini_squat() {
    const stand = { head: [104, 16], torso: '104,28 104,68', arm: '104,34 74,46 44,52', leg: '104,68 106,98 104,126 118,128' };
    const down = { head: [98, 25], torso: '99,37 96,76', arm: '99,43 72,52 44,54', leg: '96,76 110,100 104,126 118,128' };
    return `${FLOOR(130)}
      <rect class="prop" x="36" y="48" width="7" height="82" rx="3.5"/>
      <line class="prop-line" x1="40" y1="92" x2="72" y2="92"/><line class="prop-line" x1="70" y1="92" x2="70" y2="130"/>
      ${figure([stand, stand, down, down, stand, stand], [0, 0.2, 0.42, 0.62, 0.85, 1], 4)}`;
  },
};

export function demoSVG(id, label = '') {
  const scene = SCENES[id];
  if (!scene) return '';
  return `<svg class="demo" viewBox="0 0 220 140" role="img" aria-label="${label}">${scene()}</svg>`;
}

export function pauseIfReducedMotion(root) {
  if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  root.querySelectorAll('svg.demo').forEach((s) => { try { s.pauseAnimations(); s.setCurrentTime(0); } catch (_) { /* 不支持就算了 */ } });
}
