# ForeSight 评估包（eval）

预注册评估与论文产出的执行目录。**先读 `eval/DECISIONS.md`（冻结项）与 `eval/STATUS.md`（进度）。**

## 快速开始

```bash
pnpm install
pnpm build
pnpm test                                  # 插件单测（无需外部服务）

node eval/runner.mjs --help                # 评估 CLI（P0.4 脚手架，P1.3 接线）
node eval/lib/trace.mjs --validate eval/schema/sample.jsonl
node eval/lib/trace.mjs --sir eval/schema/sample.jsonl
```

## 目录

| 路径 | 内容 |
|---|---|
| `DECISIONS.md` | 预注册（冻结；只可追加 Changelog/Deviations） |
| `STATUS.md` | 任务仪表盘与 Gate 状态 |
| `runner.mjs` | CLI：`--bench --system --config --out [--seed/--budget-tokens/--no-cache/--drive-nudge]` |
| `schema/` | trace JSON Schema v2 + 手造样例 |
| `lib/` | trace / tokens / budget / cost / render-budget / llm / judge / stale / stats |
| `systems/` | 7 系统适配器（foresight / nolifecycle / recency / rag / summary / fullcontext / closedbook） |
| `adapters/` | 数据集 → 写入/探针映射（SPEC 冻结） |
| `fetch/` | 基准拉取与 `--check`（SHA256/许可/题量） |
| `configs/` | 运行配置（命名约定见 `configs/README.md`） |
| `gate-eval/` | 分类器内在评估（400 条，中英各 200） |
| `bench-timesuite/` | 自建时效性微基准 SPEC/gen/verify/items/REVIEW |
| `controls/` | 闭卷/污染/参数知识泄漏检查 |
| `analysis/` | 统计脚本与图表源数据 |
| `results/` | 结果 JSON + traces + `RUNLOG.md`（原始基准数据不入库） |

## 数据与密钥政策

- **绝不提交**第三方原始数据与任何密钥；基准数据由 `fetch/` 脚本拉取到 `eval/data/`（gitignore）。
- 密钥只来自环境变量：`DEEPSEEK_API_KEY`（reader/judge/LLM）、`FORESIGHT_*`（数据目录/embedding/LLM）。
- 成本硬帽：`EVAL_MAX_CNY`（默认 300）、`EVAL_MAX_CALLS`（默认 50000）；主表双跑必须 `--no-cache`。
- 每条结果必须带 `run_id` 与 `config_hash`；`RUNLOG.md` 每单元对账（含双跑 ×2）。
