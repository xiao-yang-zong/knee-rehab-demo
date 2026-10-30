# 无头浏览器端到端测试（Playwright）

不在 `npm test` 里，改界面或流程后手动跑。需要先装一次：

```bash
npm i -D playwright && npx playwright install chromium
```

先在项目根目录起本地服务：`python3 -m http.server 8092`，另开一个终端运行：

| 脚本 | 做什么 | 命令 |
|---|---|---|
| flow.cjs | 新用户完整流程：欢迎 → 我的情况（右腿、2–6 周、允许承重、次数 3）→ 计划 → 训练前确认 → 三个动作 → 今天完成 → 记录 → 摘要 → 清除数据 → 疼痛 6 分被拦 → 关于页返回。每步截图到 OUT 目录，最后打印结果 JSON（errors、external 必须为空） | `node tests/e2e/flow.cjs http://127.0.0.1:8092 /tmp/shots tests/e2e/fakepose.js light`（最后一个参数换成 dark 测深色） |
| extra.cjs | 跳过“我的情况”→ 通用计划；刷新后出现引导卡；直接打开 #prep 会先弹确认；返回键回到“今天”；手机 / 电脑宽屏 / 减弱动态效果三种环境 | `node tests/e2e/extra.cjs http://127.0.0.1:8092 /tmp/shots` |
| live-model.cjs | 不替换模型，测真实 MediaPipe 加载时间、模型文件大小、外部请求（可以直接对线上 https://www.rehabgo.online 跑） | `node tests/e2e/live-model.cjs https://www.rehabgo.online /tmp/shots` |

| camera-demo.cjs | 后置摄像头（画面不镜像、提示出现）+ 演示模式（选视频文件走同一套计数，历史标“演示视频”） | `node tests/e2e/camera-demo.cjs http://127.0.0.1:8092 /tmp/shots tests/e2e/fakepose.js demo.mp4` |
| demo-end.cjs | 演示视频比动作先播完时，这一组自动结束 | `node tests/e2e/demo-end.cjs http://127.0.0.1:8092 tests/e2e/fakepose.js demo.mp4` |

测试视频可以用 ffmpeg 生成：`ffmpeg -f lavfi -i testsrc=duration=14:size=480x640:rate=24 -pix_fmt yuv420p demo.mp4`（假姿态不看画面内容，只需要能播放）。

## 假姿态（fakepose.js）怎么工作
测试时拦截 `vendor/mediapipe/pose/pose.js`，换成 fakepose.js：按时间生成膝角，再换算成髋、膝、踝坐标（左右腿都放）。`window.__FAKE_MODE` 选动作：`ext` 坐姿伸膝 100°↔168°、`heel` 足跟滑动 125°↔72°、`squat` 微蹲 172°↔152°。flow.cjs 还把所有 holdSec 改成 1 秒以加快测试。

注意：计划里的“术后阶段”会改变目标角度（例如 2–6 周的足跟滑动要到膝角 ≤78°），假数据弯得不够就会一直不计数，这时是测试数据的问题，不是 bug。
