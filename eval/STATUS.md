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

## P1–P5

| 阶段 | 状态 | 备注 |
|---|---|---|
| P1 机制修复与评估基建（C1–C11，10 task，2 checkpoint） | ⬜ | 未过 G1 不得进入 P2 |
| P2 主实验（pilot → 主矩阵 → 消融 → 人审 → 冻结） | ⬜ | |
| P3 bench-timesuite（7 类 × 60 + 留出集 + 盲评 140） | ⬜ | |
| P4 分析与写作（统计图表 → 草稿 → 合规审计 → 评审 → G3.5） | ⬜ | |
| P5 发布（repo 0.2.0 / artifact / arXiv） | ⬜ | |

## 已知阻塞

| 项 | 影响 | 处理 |
|---|---|---|
| `DEEPSEEK_API_KEY` 环境依赖 | P1.4 judge/LLM 基建真实调用 | P0.6 seed 补测已完成（2026-10-01 临时注入）；P1 真实调用前需确认 key 供应 |
| CI 远端首跑未验证（已解决） | ✅ G0「CI 绿」已确认 | 2026-10-01：两轮修复后 12/12 全绿（run `36879528894`）；pnpm@10.34.6（`295dd1c`）+ Windows node-gyp@12.4.0（`16a520e`） |
