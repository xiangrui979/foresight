# ForeSight 评估任务仪表盘（STATUS）

> 每个 task 完成即更新本文件（计划 §12）。预注册见 `eval/DECISIONS.md`（冻结，只可追加）。
> 计划：`plans/2026-10-01_180525-foresight-eval-plan-v3.1.md`（v3.1）

## 里程碑 Gate

| Gate | 判据 | 状态 |
|---|---|---|
| G0（P0 末） | 预注册提交；CI 绿；分类器默认+切换规则冻结；seed 支持性入档；风险签字 | 🟡 条件性通过（预注册/分类器已冻结；seed 已入档；CI 12/12 全绿 2026-10-01）；待关闭：风险签字 |
| G1（P1 末） | smoke 7/7；golden 5/5；机制修复 C1–C11 通过；成本误差 <15%；C5 终审；stale 抽检 ≥90% | ⬜ |
| G2（P2 pilot 末） | 仿真功效完成；样本量/扩样决策落 DECISIONS；judge 人审 ≥80% | ⬜ |
| G3（P2 末） | 矩阵无缺失格；`--no-cache` 双跑 Δ 报告；κ ≥0.7 | ⬜ |
| G4（P3 末） | 机制表完成；failure taxonomy 定稿；同向性检查通过 | ⬜ |
| G3.5（P4 末） | `ship-only / ship+C / revise-B` 决策记录 | ⬜ |
| G5（P4 末） | 预注册合规审计通过；内部评审闭环 | ⬜ |

## P0 · 预注册与仓库基线（2–3 天）

| Task | 状态 | commit | 备注 |
|---|---|---|---|
| 0.1 预注册 DECISIONS.md | ✅ | `141057e` | pre-reg-v1；含 C-extension 段 / stale_gt 协议 / decorative 清单 |
| 0.2 测试命令 + pin Node + CI | ✅ | `ce8b628` | `node --test`；`.nvmrc=24`；CI {ubuntu,windows}×{20,22,24}×{UTC,Asia/Shanghai}；首跑修复两轮后 12/12 全绿（2026-10-01，run `36879528894`） |
| 0.3 trace schema v2 + STATUS | ✅ | `36a163f` | schema + `lib/trace.mjs`（validate/SIR 复算）+ 3 条样例；修复 `/lib/` 误忽略 eval/lib |
| 0.4 eval 脚手架 | ✅ | `a1cfbb2` | runner --help / configs / eval README / artifact ignores |
| 0.5 成本模型骨架 | ✅ | `7961719` | budget.mjs / cost.mjs / fullcontext 入模（tokensPerCall.reader）/ 双跑 ×2；自检通过 |
| 0.6 冻结开关 + seed 探针 | ✅ | `d2b4fbe` | §14 开关/时间线冻结；`eval/scripts/seed-probe.mjs` 交付；seed 实测完成（2026-10-01 补测）：`seed_effective`（DECISIONS §4） |
| 0.7 分类器语言决策门 | ✅ | `278241a` | §15 默认 A（双语 rules）+ G1 切换规则 + 成本影响 + P1.9 范围冻结 |

**P0 收尾验证（2026-10-01，本机 Node v24.11.1）**：`pnpm build` ✅ · `pnpm test` 80/80 ✅ · `trace --validate` 3/3 ✅ · `cost/budget --selfcheck` ✅ · `runner --help` ✅（exit 0）。

## P1 · 机制修复与评估基建（10–12 天，2 checkpoint；D21）

> Checkpoint-1（Task 1.1–1.4 后）：时钟/生命周期/因子/UTC + trace/预算 + judge 基建跑通。
> Checkpoint-2（Task 1.5–1.7 后）：7 系统 + 3 adapter + golden 5/5；gate-eval（1.9）可与 P2 并行。

| Task | 状态 | commit | 备注 |
|---|---|---|---|
| 1.1 Clock + 生命周期接线 + 过期统一 + UTC（C1/C2/C7/C8/C10/C11） | ✅ | `af5049b` | 93/93（旧 80 + 新 13）；TZ=UTC / Asia/Shanghai 双跑通过；`Date.now()` 仅 `src/clock.ts`；nudge 重复实现删除；point 锚 TTL 修正；未然体证据通道；旧 gate 时区夹具 UTC 化（C8 语义） |
| 1.2 检索因子对齐 + 全 policy 表面一致性（C3/C9） | ✅ | `134051b` | 99/99；模板因子名对齐（embed/time/activation/links）+ 权重冻结 0.40/0.20/0.25/0.15；render_anchor 值域接线；全表面叶子审计（执行者或 §13 decorative）；DECISIONS §13 定稿 |
| 1.3 Trace + token 记账 + 预算护栏 | ✅ | `1ea22b0` | 99/99；`--selfcheck` 5 题离线端到端（真实 Store/search/render + ManualClock）→ trace v2 校验通过；运行时 SIR-i/SIR 与 `trace.mjs --sir` 一致；tokenizer=estimate@v1（偏离已登记） |
| 1.4 LLM 缓存 + judge 基建（D1/D6） | ✅ | `13fbec7` | 缓存 0 调用 / --no-cache 真调用 / 断网命中 / 退避重试自检通过；judge prompt 冻结 `42d5fff0-...` + 篡改检测 + 可插拔 |
| 1.5 消融开关 + 7 系统 + 预算渲染（D8/C6/D17） | ✅ | `(next)` | 106/106（旧 99 + 新 7）；开关单测（lifecycle/conflict/classifier）；插件侧预算 + eval render-budget 同 counter；7 系统 × 3 题 dry-run = 21 trace 校验通过；D17 混合口径已登记 deviation |

**Checkpoint-1（Task 1.1–1.4）✅ 2026-10-01**：build ✅ · 99/99（当时） · TZ 双跑 ✅ · trace/cost/budget/llm/judge/runner selfcheck ✅。
| 1.6 Bench adapter（D7/D14） | ⬜ | — | SPEC 冻结 + golden 5/5 |
| 1.7 基准拉取与许可核验 | ⬜ | — | SHA256/题量回填 DECISIONS |
| 1.8 评分器（score/stats 骨架） | ⬜ | — | |
| 1.9 Gate/aspect×anchor 分类器评估（C5，400 条） | ⬜ | — | G1 终审 A/B |
| 1.10 Smoke 矩阵（G1 门槛） | ⬜ | — | 7/7 + 机制清单 |

## P1–P5

| 阶段 | 状态 | 备注 |
|---|---|---|
| P1 机制修复与评估基建（C1–C11，10 task，2 checkpoint） | 🔄 | 1.1 ✅；未过 G1 不得进入 P2 |
| P2 主实验（pilot → 主矩阵 → 消融 → 人审 → 冻结） | ⬜ | |
| P3 bench-timesuite（7 类 × 60 + 留出集 + 盲评 140） | ⬜ | |
| P4 分析与写作（统计图表 → 草稿 → 合规审计 → 评审 → G3.5） | ⬜ | |
| P5 发布（repo 0.2.0 / artifact / arXiv） | ⬜ | |

## 已知阻塞

| 项 | 影响 | 处理 |
|---|---|---|
| `DEEPSEEK_API_KEY` 环境依赖 | P1.4 judge/LLM 基建真实调用 | P0.6 seed 补测已完成（2026-10-01 临时注入）；P1 真实调用前需确认 key 供应 |
| CI 远端首跑未验证（已解决） | ✅ G0「CI 绿」已确认 | 2026-10-01：两轮修复后 12/12 全绿（run `36879528894`）；pnpm@10.34.6（`295dd1c`）+ Windows node-gyp@12.4.0（`16a520e`） |
