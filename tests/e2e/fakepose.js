// 按 window.__FAKE_MODE 生成不同动作的膝角（每次开始训练时重新计时）
(function () {
  function angleAt(mode, t) {
    if (mode === 'ext') { const c = t % 3.2; return c < 1 ? 100 : c < 2.6 ? 168 : 100; }
    if (mode === 'heel') { const c = t % 3.2; return c < 1 ? 125 : c < 2.6 ? 72 : 125; }
    if (mode === 'squat') { const c = t % 3; return c < 1.4 ? 172 : c < 2.2 ? 152 : 172; }
    return 170;
  }
  class Pose {
    constructor() { this.cb = null; this.t0 = null; }
    setOptions() {}
    onResults(cb) { this.cb = cb; }
    async send(input) {
      const img = input && input.image;
      const W = (img && img.videoWidth) || 640, H = (img && img.videoHeight) || 480;
      const now = performance.now() / 1000;
      if (this.t0 === null) this.t0 = now;
      const th = angleAt(window.__FAKE_MODE, now - this.t0) * Math.PI / 180;
      const knee = { x: 320, y: 300 }, hip = { x: 320, y: 180 };
      const ankle = { x: knee.x + 120 * Math.sin(th), y: knee.y - 120 * Math.cos(th) };
      const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.1 }));
      const put = (i, p) => { lm[i] = { x: p.x / W, y: p.y / H, visibility: 0.95 }; };
      put(23, hip); put(25, knee); put(27, ankle); put(24, hip); put(26, knee); put(28, ankle); put(11, { x: 320, y: 60 });
      await new Promise((r) => setTimeout(r, 30));
      this.cb && this.cb({ poseLandmarks: lm });
    }
    async close() {}
  }
  window.Pose = Pose;
})();
