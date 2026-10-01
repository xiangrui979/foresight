# eval/configs

运行配置目录（P0.4 建立；实际文件在 Task 1.5 落地）。

命名约定：

| 前缀 | 含义 |
|---|---|
| `foresight-full` | ForeSight 全量机制（3 档预算的基线配置） |
| `budget-{s,m,l}` | 预注册 3 档预算 `(top_k, tokens)`：`(5, 1k) / (10, 2k) / (20, 4k)` |
| `ablation-*` | 消融：decay-off / anchor-off / conflict-off / prospective-off / lifecycle-off |
| `baseline-*` | recency / rag / summary / fullcontext / closedbook |
| `smoke-*` | Task 1.10 合成冒烟 |

约束（预注册，见 `eval/DECISIONS.md`）：

- 所有系统在同一 eval 层 token 预算下运行；baseline 扫描其自身 k/N。
- `fullcontext` 截断策略冻结后写入配置注释；排除于 H3 支配判定。
- 每条结果记录 `config_hash`（整份配置序列化后哈希）。
- 配置不得写入密钥；密钥只来自环境变量（`DEEPSEEK_API_KEY` 等）。
