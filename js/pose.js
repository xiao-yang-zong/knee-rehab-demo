// 摄像头 + MediaPipe Pose（旧版 solution，模型和 wasm 全部自托管在 vendor/，不依赖国外 CDN）
// 输出：每帧的关键点（像素坐标）和选中那条腿的髋、膝、踝。

const VENDOR = 'vendor/mediapipe/pose/';

// BlazePose 关键点编号
export const LM = {
  L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30, L_FOOT: 31, R_FOOT: 32, // FOOT = 脚尖（foot index）
};

export const CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
];

// 每个关节用哪三个点算角度：膝角 = 髋-膝-踝；踝角 = 膝-踝-脚尖
const TRIPLES = {
  knee: { left: [LM.L_HIP, LM.L_KNEE, LM.L_ANKLE], right: [LM.R_HIP, LM.R_KNEE, LM.R_ANKLE] },
  ankle: { left: [LM.L_KNEE, LM.L_ANKLE, LM.L_FOOT], right: [LM.R_KNEE, LM.R_ANKLE, LM.R_FOOT] },
};

// side: 'auto' | 'left' | 'right'。auto 选可见度更高的那一侧（侧面拍摄时离镜头近的那侧）。
// joint: 'knee' | 'ankle'。返回的 hip / knee / ankle 是“近端 / 顶点 / 远端”三个点：
//   膝关节就是髋、膝、踝；踝关节是膝、踝、脚尖。后面算角度、跳点过滤、画骨架都按这三个点，不用分关节写两套。
export function pickLeg(landmarks, side = 'auto', joint = 'knee') {
  const sets = TRIPLES[joint] || TRIPLES.knee;
  const vis = (ids) => ids.reduce((s, i) => s + (landmarks[i]?.visibility ?? 0), 0) / ids.length;
  let chosen = side;
  if (side === 'auto') chosen = vis(sets.left) >= vis(sets.right) ? 'left' : 'right';
  const [h, k, a] = sets[chosen].map((i) => landmarks[i] || { x: NaN, y: NaN, visibility: 0 });
  return { side: chosen, hip: h, knee: k, ankle: a, visibility: Math.min(h.visibility ?? 0, k.visibility ?? 0, a.visibility ?? 0) };
}

// 提前下载模型文件：进入“动作准备”页时调用，用户看说明的同时在后台下载约 12 MB，
// 点“开始”时直接用浏览器缓存，少等十几秒。每次打开页面只下载一次；下载失败不影响正常加载。
const MODEL_FILES = [
  'pose_solution_packed_assets_loader.js',
  'pose_solution_simd_wasm_bin.js',
  'pose_solution_simd_wasm_bin.wasm',
  'pose_solution_packed_assets.data',
  'pose_landmark_full.tflite',
  'pose_web.binarypb',
];
let prefetching = null;

export function prefetchModel() {
  if (!prefetching) {
    prefetching = Promise.all(MODEL_FILES.map((f) =>
      fetch(VENDOR + f).then((r) => r.arrayBuffer()).catch(() => null)));
  }
  return prefetching;
}

// facing: 'user' 前置（默认，画面镜像显示）| 'environment' 后置。用 ideal，只有一个摄像头的设备（电脑）会自动用那一个。
export async function startCamera(video, facing = 'user') {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前浏览器不支持摄像头。请用 HTTPS 链接，并在 Safari 或 Chrome 中打开。');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();
  return stream;
}

// 演示模式：用录好的视频代替摄像头，走同一套识别和计数。先停在第一帧，等模型准备好再从头播放。
export async function startVideoFile(video, file) {
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.loop = false;
  await new Promise((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => { const e = new Error('video'); e.name = 'VideoFileError'; reject(e); };
  });
  video.pause();
  video.currentTime = 0;
}

// 停止视频来源：摄像头流或视频文件都能停
export function stopVideo(video) {
  stopCamera(video);
  if (video.getAttribute('src')) {
    video.pause();
    URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
  }
  video.onended = null;
}

export function stopCamera(video) {
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

// onFrame({ landmarks, width, height }) —— landmarks 已换算为像素坐标；没检测到人时 landmarks 为 null
export function createPoseTracker(video, onFrame) {
  if (typeof window.Pose !== 'function') {
    throw new Error('姿态模型脚本没有加载，请检查 vendor/mediapipe/pose/pose.js 是否存在。');
  }
  const pose = new window.Pose({ locateFile: (file) => VENDOR + file });
  pose.setOptions({
    // 1 = full 模型（6.4 MB）。v0.9 起从 lite 升级：真人测试时坐姿下肢、椅子腿附近识别不准，
    // Google 官方数据 full 比 lite 准，速度约为 lite 的 70%（Pixel 5 网页端每秒 32 → 22 帧），仍够用。
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  let running = false;
  let busy = false;
  const stamps = []; // 最近 2 秒内每帧结果的时间，用来估算帧率
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  pose.onResults((results) => {
    readyResolve();
    const now = performance.now();
    stamps.push(now);
    while (stamps.length && now - stamps[0] > 2000) stamps.shift();
    const width = video.videoWidth || 640;
    const height = video.videoHeight || 480;
    const raw = results.poseLandmarks;
    const landmarks = raw
      ? raw.map((p) => ({ x: p.x * width, y: p.y * height, visibility: p.visibility ?? 0 }))
      : null;
    onFrame({ landmarks, width, height });
  });

  async function loop() {
    if (!running) return;
    if (!busy && video.readyState >= 2) {
      busy = true;
      try { await pose.send({ image: video }); } catch (e) { console.error(e); }
      busy = false;
    }
    requestAnimationFrame(loop);
  }

  return {
    ready,
    // 最近 2 秒的平均帧率（每秒处理几帧）。手机太卡时计数和角度都会不准。
    get fps() { return stamps.length > 1 ? (stamps.length - 1) / ((stamps.at(-1) - stamps[0]) / 1000) : 0; },
    start() { if (!running) { running = true; loop(); } },
    stop() { running = false; },
    async close() { running = false; try { await pose.close(); } catch (_) { /* ignore */ } },
  };
}
