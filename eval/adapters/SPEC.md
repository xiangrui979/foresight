# Adapter SPEC（冻结 / D7 + D14 + P1.6）

> 本文件冻结「数据集 → 写入/探针」的映射契约。任何变更必须在
> `eval/DECISIONS.md → Changelog/Deviations` 登记。Golden 5 条/基准须
> `--selfcheck` 通过后本 SPEC 视为生效。

## 1. 每题隔离

- 每题使用独立的临时 `memoryRoot` + 新 DB；`ManualClock` 初始为数据集首个时间戳。
- 题目之间不共享任何状态（Store、embedding 缓存除外只读）。
- 时间戳**全部 UTC**（C8）；数据缺时区按 UTC；同一 session 内保持原始顺序，
  同一时刻的多条以原始 index 稳定排序。

## 2. 事实抽取步骤（v3 显式化）

| 系统家族 | 写入内容 | 说明 |
|---|---|---|
| ForeSight / nolifecycle / 消融 | 逐 turn 过 gate（或冻结抽取器的结构化事实） | `mode: 'gate' \| 'extract'`；可先经冻结抽取器 |
| raw 基线（recency/rag/summary/fullcontext） | 原始 turn 文本 | 不做抽取，口径在论文写明 |

- 报告 **写入接受率**（accepted/turns）与 **证据覆盖率**（含被接受证据的题数/总题数）。
- LME **双角色写入**：user 为主分析，assistant 写入但为次要分析（role tag 入 `sourceRef`）。
- LoCoMo 角色映射：speaker A → user，speaker B → assistant；**cat2 仅作次要辅证**。

## 3. 时间戳与 question_date

- `question_date → clock.set(questionDate)` 前校验其与会话日期单调一致；
  不一致的题在结果中标记 `excluded: date_inconsistent`。
- 缺失 `question_date` 的题：用 last session date + 1 day，并标记 `date_assumed: true`。

## 4. 探针（probe）

`clock.set(questionDate)` → `sweepExpired` → query/检索 → **统一预算渲染**
（`lib/render-budget.mjs`，同一 token counter）→ reader → judge。
探针不得把 `answer`/`evidence id`/`stale` 标注传入记忆侧或 reader 上下文。

## 5. 答案与期望

| 基准 | 答案口径 | 判定 |
|---|---|---|
| LongMemEval | `answer`（当前值） | 冻结 judge（§4 DECISIONS）；官方脚本仅辅证 |
| LoCoMo | `answer` + `evidence` | judge 主；官方 F1 确定性辅指标 |
| timesuite | 期望行为（确定性） | 不依赖 judge |

## 6. 泄漏控制

- adapter 只读历史（写入阶段），禁止把 question/answer/evidence 提前写入记忆。
- 闭卷对照（closedbook）与参数知识泄漏检查（controls/，P1.5 已建系统）同批运行。

## 7. stale_gt 标注协议（D14，冻结）

- 标注器：`eval/lib/stale.mjs`（`rules@v1`）：对每个 `item.stale = [{old, new}]`，
  注入内容包含 `old` 且不含 `new` 的记忆 → `stale_gt=true, reason='pre_update_value'`。
- 抽检：≥30 条双轮人工抽检，一致率 **≥90%**；<90% 触发复核/重标并登记。
- 标注器版本写入 `trace.versions.stale_annotator`；公开基准 stale 辅证必须附一致率。
- 标注器不得读取答案用于记忆侧写入。

## 8. Golden（每基准 5 条）

- 存放：`eval/adapters/golden/<bench>.jsonl`；字段含 `expected: {accepted, stale_marked}`。
- 人工核对项：写入条数、aspect/anchor 合理性、过期抑制、渲染预算、覆盖率。
- 运行：`node eval/adapters/<bench>.mjs --selfcheck`；5/5 通过后 SPEC 生效。
