# CLAUDE.md — 交接说明（Claude Code 每次启动自动读取）

开始工作前按顺序读：本文件 → docs/HANDOFF.md（2026-10-28 的全部决策、原因、风险、待办，从桌面端 Work 模式交接过来）→ PROJECT.md（项目背景、红线、动作参数、核心逻辑、版本记录）。端到端测试脚本和用法在 tests/e2e/README.md。

## 现在的状态（2026-10-28）
- 版本 v1.0（关节选择 + 踝泵、课程、康复师、医嘱护栏；v0.9 的识别算法不变），已部署：https://www.rehabgo.online （同一个站：https://rehabgo.pages.dev）
- 最新提交用 git log 查看；本地和 GitHub（xiao-yang-zong/knee-rehab-demo，公开）保持同步，push 后 1–2 分钟线上自动更新
- 单元测试 85 个全部通过（npm test）
- 比赛：2026 中国消费名品产业创新大赛，校内提交 10/30，截止 10/31

## 部署方式
- push 到 GitHub 的 main 分支 → Cloudflare Pages 自动部署，1–2 分钟生效，网址不变
- Cloudflare 只发布网页文件（index.html css js config assets vendor），PROJECT.md 等文档不会公开
- 推送前必须 npm test 全过

## 下一步（按优先级）
1. 收同学的真人计数测试结果（每个动作做 10 次，计数误差 ≤2 次算合格），不合格就调 js/counter.js 的 DEFAULT_COUNTING 或 config/exercises.json，不要改康复标准本身，安全侧（蹲太深、过快）不放宽
2. 可用性测试：找没见过产品的同学，不讲解，计时看能否 2 分钟内做完第一个动作，按卡住的地方改一轮
3. 真 iPhone（Safari）和安卓手机实测，关 VPN、校园网；第一次加载模型约 12 MB
4. 上面改完后代码冻结；新想法写进方案的“后续迭代”，不进代码
5. 演示视频、申报文档与 demo 对齐（文档写的功能 demo 里必须有）

## 工作约定
- 大改之前把要改的文件复制到 _backup/<版本说明>/（_backup、_dist 已在 .gitignore）
- 改完：npm test → tests/e2e/flow.cjs（浅色、深色）和 extra.cjs，0 报错再提交（用法见 tests/e2e/README.md）
- 无头测试用假姿态：拦截 vendor/mediapipe/pose/pose.js，按时间生成膝角；注意计划里的患侧和术后阶段会改变腿和目标角度
- 界面文案不能出现“治疗、治愈、康复效果、纠正、完全有效、绝对安全”等词；只说“训练参考和动作反馈”
- 用户是产品负责人：解释做了什么、为什么，关键逻辑要让他能自己讲清楚（答辩会问）
