# ForeSight 评估任务仪表盘（STATUS）

> 每个 task 完成即更新本文件（计划 §12）。预注册见 `eval/DECISIONS.md`（冻结，只可追加）。
> 计划：`plans/2026-10-01_180525-foresight-eval-plan-v3.1.md`（v3.1）

## 里程碑 Gate

| Gate | 判据 | 状态 |
|---|---|---|
| G0（P0 末） | 预注册提交；CI 绿；分类器默认+切换规则冻结；seed 支持性入档；风险签字 | 🔄 进行中 |
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
| 0.2 测试命令 + pin Node + CI | ✅ | `ce8b628` | `node --test`；`.nvmrc=24`；CI {ubuntu,windows}×{20,22,24}×{UTC,Asia/Shanghai}（远端首跑待验证） |
| 0.3 trace schema v2 + STATUS | ✅ | `(next)` | schema + `lib/trace.mjs`（validate/SIR 复算）+ 3 条样例 |
| 0.4 eval 脚手架 | ⬜ | — | runner --help / configs / eval README |
| 0.5 成本模型骨架 | ⬜ | — | budget.mjs / cost.mjs / fullcontext 入模 / 双跑 ×2 |
| 0.6 冻结开关 + seed 探针 | ⬜ | — | seed 实测 **pending（无 API key）**，探针脚本先行 |
| 0.7 分类器语言决策门 | ⬜ | — | 默认 A + G1 切换规则 |

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
| `DEEPSEEK_API_KEY` 缺失 | Task 0.6 seed 实测、P1.4 judge/LLM 基建无法真实调用 | 探针脚本 `eval/scripts/seed-probe.mjs` 待 key；偏离已登记 DECISIONS |
| CI 远端首跑未验证 | G0「CI 绿」待确认 | 下次 push 后检查 12 个矩阵 job |
