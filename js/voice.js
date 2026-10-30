// 语音提示：用浏览器自带的朗读功能（中文）。
// iPhone 要求第一次朗读必须发生在用户点击里，所以“开始训练”按钮会先调用 unlock()。

let zhVoice = null;
let lastSpoken = {};

function pickVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  zhVoice = voices.find((v) => /zh[-_]CN/i.test(v.lang)) || voices.find((v) => /^zh/i.test(v.lang)) || null;
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  pickVoice();
  window.speechSynthesis.onvoiceschanged = pickVoice;
}

export function voiceSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function unlock(text = '开始训练') {
  speak(text, { force: true });
  importantUntil = 0; // 解锁用的这一句不算“重要的话”，后面的提示可以正常打断它
}

let importantUntil = 0; // 重要的话（停止、就医建议）播完之前，普通提示不打断它

// key 相同的提示在 minGapMs 内不重复播报，避免刷屏。
// force: 重要的话（停止、很疼的建议），总是立刻打断前一句；
// 普通提示：只打断普通提示，不打断正在播的重要的话（修复 D16：以前每句都无条件打断上一句）。
export function speak(text, { key = text, minGapMs = 2500, force = false } = {}) {
  if (!text || !voiceSupported()) return;
  const now = Date.now();
  if (!force && now < importantUntil && window.speechSynthesis.speaking) return;
  if (!force && lastSpoken[key] && now - lastSpoken[key] < minGapMs) return;
  lastSpoken[key] = now;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  if (zhVoice) u.voice = zhVoice;
  u.rate = 1.0;
  // 按每秒约 4 个字估算播完的时间；onend 不可靠（部分浏览器不触发），所以用估算兜底
  importantUntil = force ? now + 1000 + text.length * 250 : importantUntil;
  if (force) u.onend = () => { importantUntil = 0; };
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  importantUntil = 0;
  if (voiceSupported()) window.speechSynthesis.cancel();
}
