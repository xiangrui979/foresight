# gate-eval SPEC（Task 1.9 / C5，冻结）

> 判据（DECISIONS §15）：400 条（中英各 200）上 rules 的 **aspect 准确率 ≥80%**
> 则 G1 维持方案 A，否则按 D16 切换方案 B。本 SPEC 冻结后，任何 items/label
> 口径变更必须登记 Changelog/Deviation。

## 1. 数据

- `items.jsonl`：400 条，字段 `{id, lang, text, gold_aspect, gold_anchor_type, hard}`。
- 生成器 `gen.mjs` 确定性产出（仅槽位轮换）；重生成必须逐字节一致。
- 覆盖：4 aspect × anchor 类型（none/point/interval/open）+ 否定/未然/恒常边界 +
  英文时态；`hard=true` 为区间/开放锚与混合时态子集（约 15%）。
- 评测时刻固定 `2026-10-01T00:00:00Z`（UTC，C8）。

## 2. gold 标注口径

| 构造 | gold aspect | gold anchor |
|---|---|---|
| 正在/在跑/be+-ing/been-ing/currently | progressive | 显式区间→interval；自/since→open；否则 none |
| 了/过/已/完成/结束；have+PP/强过去式 | perfect | 显式日期→point；显式区间→interval；否则 point(today) |
| 会/将于/将要/will/going to | prospective | open（predictBy 由日期解析） |
| 计划/打算/准备/plan(s) to/not started yet | prospective | open |
| 无标记陈述/否定句（否定的是习惯，而非事件完成） | gnomic | none |

- 有歧义（完成+进行同现）不进入 gold 集；分类器输出 null 记为错误（保守）。
- category 未纳入门槛（rules 不产出 category；论文仅报告 LLM 臂）。

## 3. 两臂

- **rules 臂（A，默认）**：离线 `classifyByRules`（含 P1.9 双语扩展）。
- **LLM 臂（B）**：`gate.classifier='llm'` + `deepseek-flash`；需 `DEEPSEEK_API_KEY`，
  缺省时报告标记 pending（不阻塞 A 的 G1 判定）。
- 指标：aspect / anchor(type) / joint 准确率，按 lang 与 hard 分层，混淆矩阵；
  第二标注者 κ/AC1 在 G1 前补（人工抽检 ≥40 条）。

## 4. 已知盲点（对抗子集，如实计入准确率，不修规则）

| 构造 | 误判 | 说明 |
|---|---|---|
| `用户不要{X}`（否定偏好） | 要 → prospective | 应 gnomic；`要` 缺少否定上下文判别 |
| `{任务}即将上线` | 未覆盖 → gnomic | 应 prospective；`即将` 未入标记集 |
| `is going to the gym`（移动义） | going to → prospective | 应 progressive；未区分 going to + 地点/动词 |
| `The will to X remains`（名词 will） | will → prospective | 应 gnomic；未区分名词/情态 |

以上为 P1.9 规则版真实局限，作为后续 rules 演进的候选；G1 阈值仅要求 aspect ≥80%。

## 5. 运行

```bash
node eval/gate-eval/gen.mjs              # 重新生成（确定性）
node eval/gate-eval/report.mjs           # rules 臂报告 → eval/gate-eval/report/
node eval/gate-eval/report.mjs --llm     # 追加 LLM 臂（需 key）
```
