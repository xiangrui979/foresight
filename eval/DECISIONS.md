# ForeSight 评估预注册（DECISIONS）

> **状态**：PRE-REGISTRATION v1 — 冻结于首次主跑前（Task 0.1, P0）
> **依据计划**：`plans/2026-10-01_180525-foresight-eval-plan-v3.1.md`（SHA256 `66229837950D204CB2BD444618C085B7520365CFFA6EFCF690A2CBF62631E067`）
> **执行规则**：本文件冻结行不可修改；一切变更只能**追加**到 `Changelog`（版本/时间/内容）或 `Deviations`（时间/原因/影响/补偿实验）。
> **审计基线**：本预注册基于代码审计 commit `ebd642b`（详见计划 §2；C1–C11 机制问题在 P1 修复，未过 G1 不得进入 P2）。

- 预注册版本：`pre-reg-v1`
- 创建日期：2026-10-01
- 执行者：solo（+ 学长抽检；C-extension 前补第二位标注者，见 §11.3）
- 预注册提交记录：见 git log（本文件首个 commit）；commit hash 于 `eval/STATUS.md` 登记

---

## 1. 主张、操作化定义与反驳条件（H1–H3）

### H1（陈旧抑制）

带生命周期的记忆系统，注入已过期/已被取代内容的比率显著更低。

| 指标 | 定义 | 来源 |
|---|---|---|
| **SIR-i（主）** | stale 注入条数 / 注入总条数 | trace 确定性复算（不依赖 judge） |
| SIR（次） | 含 ≥1 条 stale 注入的查询数 / 总查询数 | trace |

- stale 判定以 **ground truth** 为准：`stale_gt=true`（timesuite 期望行为；公开基准旧值证据的冻结标注，见 §12）。每条注入明细携带 `stale_gt/stale_reason`。
- **等预算要求**：SIR-i/SIR 比较必须在同一 eval 层 token 预算档（§5）下进行；同时报告原始注入条数。
- 主证据：timesuite；辅证：公开基准 knowledge-update 的「旧值答案」+ stale 代理标注。**两路必须同向**才主张 H1。
- **反驳条件**：配对检验（McNemar）经 Holm 校正后不显著，**或** SIR-i 差值的配对 bootstrap 95% CI 含 0。**不使用「CI 重叠」判据，不使用 Wilson（配对差无效）。**

### H2（事实更新跟随）

在知识更新场景中，显著更常给出当前事实而非历史事实。

| 指标 | 定义 | 来源 |
|---|---|---|
| **UFA（主）** | LME cleaned knowledge-update 全量上，**冻结 judge**（prompt hash 入档）判定的正确率 | judge |
| CRA（机制辅证） | timesuite 冲突题「返回当前事实且不再注入旧值」/ n | 期望行为（确定性） |

- 措辞不称「官方判定」；官方 `evaluate_qa.py`（GPT-4o）口径仅作辅证/敏感性分析。
- **覆盖率分层**：主分析 = 全题集（未写入证据的系统自然失分，如实呈现）；次分析 = ForeSight 写入接受子集（报告写入接受率与证据覆盖率）。两层均预注册。
- **功效前置（LME-KU underpowered 处理，D13）**：LME-KU 题量固定且偏小（cleaned 约 78，以 `fetch --check` 回填），不参与扩样。P2.1 功效分析后若主比较 underpowered，按以下**预注册顺序**执行，不得临时改口径：
  1. 主分析切换为 **pooled**（KU + timesuite CRA，要求同向）；
  2. pooled 仍 underpowered 或方向不一致 → **H2 降级为探索性**；
  3. 均不成立 → 如实报告 **inconclusive**，不主张 H2。
- **反驳条件**：UFA 差值（配对 bootstrap）95% CI 含 0（校正后）。

### H3（预算效率）

同等注入预算下正确率更高；或达到同等正确率所需注入 token 更少。

- 预算由 eval 层统一渲染器（`lib/render-budget.mjs`）定义，所有系统同一实现、同一 tokenizer。
- 主报告：**等预算点差**（3 档预注册，§5）+ **曲线 AUC（粗粒度）**；同时报 mean/p95 注入 token。
- `fullcontext` 仅作上界参考，**排除于 H3 支配判定**。
- **评估口径（D17）**：优先把 token 预算下沉到插件注入路径（单一实现，评估=shipped 行为）；若保留 eval 层渲染，登记 deviation + 按 `channel`（system_prompt vs tool_retrieval）分层报告，并在论文显式声明。
- **反驳条件（D22 改写）**：3 档预算上，ForeSight 的 accuracy 均不高于**且**注入 token 不少于同一基线（配对校正后），即被该基线支配。

### 次要 / 探索性

- 检索层：LME turn/session recall（官方标签口径）。
- 幻觉控制：LME 30 条 abstention（`_abs`）+ LoCoMo adversarial（category 5）。
- 机制级：锚渲染正确率、未然体到期验证正确率（fulfilled/falsified/uncertain 三分类）。
- 写入接受率、证据覆盖率、闭卷对照正确率、参数知识泄漏指标（reader 对更新前/后值的偏好）。
- 延迟与成本（本地 embedding、LLM 调用数）。

---

## 2. 数据集与子集

| 数据集 | 用途 | 子集 | 版本/许可 |
|---|---|---|---|
| **LongMemEval（ICLR 2025, MIT）** | 主（H2）+ H1 辅证 | cleaned **KU 全量**；temporal-reasoning（次要）；30 abstention（控制） | cleaned 2025/09；SHA256 于 Task 1.7 回填；污染风险入风险册 |
| **LoCoMo（ACL 2024）** | H2 次要辅证（cat2）；控制（cat5） | `locomo10.json` cat2、cat5 | 许可条款以 `fetch --check` 实测为准（CC BY-NC 4.0 待核验） |
| **timesuite（自建）** | H1 主 + 机制表 | 7 类 × 60 ≈ 420 题；含 ≥120 独立生成留出集；盲评 140（每类 20） | 生成 SPEC 冻结于 P3.1 |
| LongMemEval-V2（2026/05） | 不进 B 主实验 | C-extension Track C 选项 + related work | P4 查新 |

- 题量、类别分布以 `fetch --check` 实测回填（Task 1.7）。
- LME 双角色写入（user + assistant，assistant 为次要分析）；LoCoMo 角色映射 A→user、B→assistant，cat2 仅次要辅证。

---

## 3. 系统、消融与预注册矩阵

系统（7）：`foresight`（3 预算档）、`nolifecycle`、`recency`、`rag`、`summary`、`fullcontext`、`closedbook`。
消融（5，ForeSight 家族）：decay-off / anchor-off / conflict-off / prospective-off / lifecycle-off；外加 gate-LLM 小样本敏感性（n≈100）。

| 数据集 | foresight(3 预算) | nolifecycle | recency | rag | summary | fullcontext | closedbook |
|---|---|---|---|---|---|---|---|
| LME-KU（主） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| LME temporal（次） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| LoCoMo cat2（次） | ✓ | ✓ | ✓ | ✓ | N/A | ✓ | ✓ |
| LoCoMo cat5（控制） | ✓ | ✓ | ✓ | ✓ | N/A | ✓ | ✓ |
| timesuite（主） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 5 消融（ForeSight 家族） | ✓ × 5（跑 LME-KU + timesuite；其余 N/A） | — | — | — | — | — | — |

- 标 N/A 的格在本文登记理由（summary 成本控制），不算缺失。
- **主比较对象（预注册）**：机制主对比 = `nolifecycle`（隔离生命周期）；实用主对比 = `recency`。其余 baseline 为 secondary（BH 校正）。
- `fullcontext` 截断策略在 Task 1.5 冻结（超长按最旧会话截断，或声明无截断上界并排除 H3 支配判定）。

---

## 4. 判定协议（reader / judge）

- **Reader**：`deepseek-v4-flash`（冻结），temperature 0；reader prompt 冻结并记录 hash（Task 1.4）。
- **Judge（冻结）**：主 judge = `gpt-4o`（LME 官方 `evaluate_qa.py` 默认，与 reader 不同源）。
  - **不可得时（预注册兜底）**：改用 `deepseek-v4-flash` 同源 judge，登记 deviation，主表附人类子集敏感性分析，并**触发 C-extension 双 judge**。
  - judge prompt 一文件一版本（文件名带 hash 前缀）；模型 + prompt hash 写入每条 trace 的 `judge.judge_id/prompt_hash`。
- **人审**：分层抽 ≥120 条双盲标注，计算 κ（目标 **≥0.7**）与 per-stratum 一致率 + **AC1**。
  - κ ∈ [0.6, 0.7)：主表附人类子集敏感性分析 + 触发 C-extension 双 judge；
  - κ < 0.6：重写 prompt 重跑。
- **seed**：`--seed` 全链路参数化；seed 支持性探针 `eval/scripts/seed-probe.mjs`（P0.6 已交付）。**状态：待实测**（环境缺 `DEEPSEEK_API_KEY`；判据 = 同 prompt + seed 重放 3 次的输出/usage 差异，结论必须回填本节）。若输出无差异或接口不支持 seed，按 §11.1 扰动方案替代（温度 / 提示顺序 / 同义改写）。

---

## 5. H3 预算预注册（D10）

- 3 档：`(retrieval.top_k=5, budget=1k tokens)`、`(10, 2k)`、`(20, 4k)`。
- 所有系统在同一 eval 层 token 预算下**扫描其自身 k/N**（recency 窗口、rag top-k）。
- AUC 由 3 点估计（声明为粗粒度）；主报告为等预算点差。
- tokenizer 冻结：`cl100k_base`（tiktoken）；不可用时以 provider usage 差值记账并登记 deviation。版本写入 `trace.versions.tokenizer`。

---

## 6. 分析计划（预注册）

- **实验单元**：question；所有系统同题配对。
- **二值指标**：McNemar 精确检验；差值 CI = paired bootstrap（10,000 次）或 McNemar-consistent（Wald/Miettinen）。**删除 Newcombe（面向独立两比例差）；不使用 Wilson 近似配对差。**
- **连续指标**：配对 bootstrap percentile CI；效应量 OR / Cohen's h / Cliff's δ。
- **聚类修正**：timesuite 按模板 cluster bootstrap；LME/LoCoMo 按 session 聚类（如适用）。报告 design effect / 有效样本量。
- **多重比较**：3 主张族内 Holm；secondary 比较（其余 baseline/数据集）BH 校正；**全量报告原始 p**；不做「事后选最强基线」。
- **样本量与 MDE**：pilot 仅校准成本与方差；**仿真功效**（power=0.8、最小感兴趣效应预注册）决定样本量与扩样顺序。扩样顺序：LME temporal-reasoning 全量 → LoCoMo cat2 全量 → 再考虑 oracle。LME-KU 不参与扩样（§1 H2）。
- **偏差登记**：一切偏离进 `Deviations`（时间/原因/影响/补偿实验）。

---

## 7. 冻结项

| 项 | 冻结值 |
|---|---|
| 审计基线 repo commit | `ebd642b` |
| policy_version | `3` |
| Node | pin 24（`.nvmrc`）；CI 矩阵 20/22/24；实验记录 `24.11.1` |
| Ollama | `nomic-embed-text-v2-moe`（tag + digest 于 Task 1.7/执行日回填） |
| DeepSeek reader | `deepseek-v4-flash`（temperature 0） |
| Judge | `gpt-4o`（不同源；兜底见 §4） |
| judge prompt hash | Task 1.4 冻结并回填（文件名带 hash 前缀） |
| reader prompt hash | Task 1.4 冻结并回填 |
| tokenizer | `cl100k_base`（tiktoken；版本回填） |
| config_hash | runner 每条结果记录（全部配置序列化 hash） |
| 价格表 | 见 §10（执行日复核，差异入 Changelog） |

---

## 8. 排除规则

1. 数据损坏（下载不完整、解析失败）；
2. 官方证据缺失（LME `answer_session_ids` / LoCoMo `evidence` 缺失）；
3. 单题超时 > 3 次；
4. 命中排除的题在 `results/` 记录 item_id 与原因，并在论文报告排除计数。

---

## 9. 停止规则与扩样顺序

- **预算硬帽**：`EVAL_MAX_CNY` + `EVAL_MAX_CALLS`（§10）；超帽按预注册顺序裁剪：先裁 LoCoMo 至子集 → 再裁 temporal-reasoning → **不动 LME-KU 与 timesuite**。
- **扩样顺序（仿真功效后执行）**：LME temporal-reasoning 全量 → LoCoMo cat2 全量 → oracle。
- **G3.5 决策门**：按 §11.2 触发条件执行 `ship-only / ship+C / revise-B`，规则在看结果前冻结。

---

## 10. 预算帽与成本口径（D20）

- 统一命名：**`EVAL_MAX_CNY`**（人民币口径），默认等值 **¥300**；硬顶 `EVAL_MAX_CALLS = 50000`。
- 成本公式：`calls = ingest_classify×turns + derive×(turns/N) + summary×sessions + judge×questions + reader×questions + nudge×(turns/N) + dialectic×reason_calls`；fullcontext 超长 prompt 成本入模；主单元 `--no-cache` 双跑按 **×2** 入模。
- 价格表（执行日抄录/复核）：

| 模型 | 输入 ¥/1M tokens | 输出 ¥/1M tokens | 记录日期 |
|---|---|---|---|
| deepseek-v4-flash | 待执行日抄录 | 待执行日抄录 | - |
| gpt-4o（judge） | 待执行日抄录 | 待执行日抄录 | - |

- runner `--estimate` 先行；`RUNLOG.md` 每单元对账（含双跑 ×2）。
- 预期区间（B 档）：主实验 judge+reader 约 ¥80–150；pilot/敏感性/双跑约 ¥40–100；留 20% 缓冲。

---

## 11. C-extension 预注册段（全文；P0.1 第 11 项）

### 11.1 升级内容（相对 B，不新增主张）

1. **多随机种子**：主表单元在 seed ∈ {0,1,2} 下重跑（`--no-cache`），报告跨种子方差与合并估计；**若 P0.6 实测模型不支持 seed，则改用预注册扰动方案**（温度 / 提示顺序 / 同义改写）并报告「扰动方差」。
2. **LME-M 长上下文压力**：`--variant m` 跑 ForeSight + 2 主比较基线，检验长历史下生命周期/预算优势是否保持。
3. **双 judge**：第二位 judge 模型（与第一位及 reader 尽量不同源）独立判定争议题与分层子集；报告双 judge 一致性 + 仲裁规则。
4. **外部评审**：≥2 位外部评审按评审表读稿，修订记录归档。
5. 可选：LME temporal-reasoning 全量、双标注者 κ。

### 11.2 G3.5 触发条件（满足任一即触发）

1. **主效应边缘**：H1–H3 任一主比较的配对差值 95% CI 含 0，或校正后 p ∈ (0.05, 0.15)；
2. **非确定性偏大**：任一主表单元 `--no-cache` 双跑 Δ > 2pp；
3. **judge 可靠性未达标**：κ ∈ [0.6, 0.7)（或 per-stratum/AC1 显示分层不稳）；
4. **内部评审要求**：评审人或作者判定需要外部加固。

输出三选一：`ship-only` / `ship+C` / `revise-B`；决策与依据写入 Changelog。

### 11.3 分析口径与时间线

- C 结果作为稳健性附录并入论文 v2；若 C 与 B 冲突，**以预注册主分析（B）为准**并如实报告冲突。
- 时间线：G3.5 判定 `ship+C` 后约 3 周（种子重跑 ~1 周 / LME-M + adapter ~0.5 周 / 双 judge + 仲裁 ~1 周 / 外部评审 ~0.5 周，可部分并行）。
- 合作者：solo + 学长抽检；C-extension 前找好第二位标注者。

---

## 12. stale_gt 标注协议（D14）

- **定义**：对知识更新类查询，注入证据若包含「更新前的旧值」（pretraining/历史值）即标 `stale_gt=true`，并附 `stale_reason`（如 `pre_update_value`、`superseded_anchor_expired`）。
- **标注器**：`eval/lib/stale.mjs`，**规则优先**（更新前答案匹配 + 人工抽检），版本冻结（`rules@v1`，Task 1.6 交付时定稿版本号）。
- **抽检**：≥30 条双轮抽检，一致率 **≥90%**；<90% 触发复核/重标。
- **留档**：标注器版本写入 `trace.versions.stale_annotator`；公开基准 stale 辅证结果必须附一致率；一致率不达标时 H1 公开基准辅证降级为探索性。
- **禁止**：标注器不得读取答案字段以外信息用于记忆侧写入（泄漏控制，见 Task 1.6 SPEC）。

---

## 13. decorative / reserved 策略字段清单（C9）

> 原则：`policy.yaml` 每个配置字段必须有执行者，或显式登记为 **reserved/decorative**。Task 1.2 完成全 policy 表面一致性测试后在本节定稿（追加）；README/论文措辞同步降级为「已实现的策略字段」。

**P0 已知候选**（待 Task 1.2 审计确认）：

| 字段 | 现状 | 处理 |
|---|---|---|
| `aspects.prospective.expiry: 'ttl'` | `expireCheck` 对非 progressive 直接返回 active → 不生效 | P1.2 接线或登记 decorative |
| `aspects.*.render_anchor`（`true/'short'`） | `renderMemory` 只认 `'always'/'endpoint'` → 永不匹配 | P1.2 统一值域或登记 decorative |
| `aspects.*.injection` | 仅 nudge 文案使用 | P1.2 接线或登记 decorative |
| `aspects.*.storage` | 仅 nudge 文案使用 | P1.2 接线或登记 decorative |
| `aspects.*.review_every_turns` | 需 Task 1.2 核对执行者 | 待审计 |
| `gate.fallback` / `nudge.*` | 需 Task 1.2 核对执行者 | 待审计 |

---

## 14. 其他待拍板开关（计划 §13，默认值）

1. 时间线档位：**B（默认，8–9 周）+ G3.5 决定 C-extension**。
2. venue：**arXiv cs.CL 先行**；workshop 待反馈；中文期刊备选。
3. 开放范围：代码+脚本+timesuite 开放（MIT）；第三方数据仅脚本拉取；汇总结果与 traces 开放（不含原始数据）。
4. 分类器：**默认 A（双语 rules）+ 切换规则，G1 按 Task 1.9 全量实测（400 条，中英各 200）终审**（见 §15）。
5. H3 预算口径：优先下沉插件；否则登记 deviation + channel 分层（§1 H3）。
6. 公开基准 stale_gt：规则标注器 + ≥30 条抽检一致率 ≥90%（§12）。
7. 成本口径：双跑 ×2、nudge/dialectic 入模、`EVAL_MAX_CNY` 统一（§10）。
8. 时间线目标（2026-10-01 起，业余节奏；**非冻结**，实际以 `STATUS.md` 为准）：

| 阶段 | 目标窗口 | 说明 |
|---|---|---|
| P0 预注册与基线 | 2026-10-01 → 10-03 | G0 |
| P1 机制修复与基建 | 10-04 → 10-16 | 2 checkpoint；未过 G1 不进 P2 |
| P2 主实验 | 10-17 → 10-26 | pilot → 主矩阵 → 消融 → 人审 → 冻结（G2/G3） |
| P3 bench-timesuite | 10-27 → 11-02 | 生成 + 校验 + 全系统运行（G4） |
| P4 分析与写作 | 11-03 → 11-17 | 统计图表 → 草稿 → 合规审计 → 评审 → G3.5 |
| P5 发布 | 11-18 → 11-21 | repo 0.2.0 / artifact / arXiv（B 预印本） |

- B 档预印本目标：**2026-11 下旬**（≈8–9 周）；G3.5 判定 `ship+C` 则 C-extension 再 +3 周。

---

## 15. 分类器语言决策门（C5，看结果前定规则）

**背景（代码证据）**：现有 rules 分类器只识别中文强信号（`src/gate/classify.ts:40-43`：会/要/了过/正在）；英文无标记陈述一律落入 `gnomic`（`classify.ts:118-124`），而 gate 明确拒绝 gnomic 写入（`src/gate/gate.ts:242-248`）。因此 LME/LoCoMo 英文 turn 几乎全部拒写、记忆库≈空（C5）。本决策门在看结果前冻结「默认方案 + 切换规则」，G1 按 Task 1.9 全量实测终审（D16，避免循环依赖）。

- **A（默认）**：双语 rules 扩展——英文时态/日期标记、`extractDate` 英文相对日期、中英混合。
  - P1.9 交付范围（冻结）：英文时态/体标记（如 did/have done/am doing/will），ISO 与相对日期解析统一 **UTC**（C8 联动），中英混合句式；**不改变 4 aspect × 4 anchor 定义**。
- **B（备选）**：主实验改用 LLM gate（reader/judge 之外新增分类调用）。
- **切换规则（冻结）**：G1 时若 A 的 gate-eval 全量（400 条，中英各 200）**aspect 准确率 ≥80%** 则维持 A，否则切 B。P0 预实验可用 150/语 做 smoke，**不作最终判据**。anchor/category/forbidden 准确率与混淆矩阵作为报告项（不设切换门槛）。
- **成本影响**：
  - A 增量 LLM 成本 = **¥0**（rules，0 调用），与「确定性优先 / 无 key 可跑」一致；
  - B 增量 = `turns × 1` 分类调用/单元（`cost.mjs` 以 `classifyPerTurn=1` 建模）；若 G1 切 B，按 Task 0.5 执行日价目重估总调用与成本，并**经 Changelog 上调 `EVAL_MAX_CNY`**（默认 ¥300 可能不足）。
- 无论选哪个，adapter 必须报告写入接受率（D7/R14）；英文接受率 <50% 触发 R14 处置。
- **终审在 G1（Task 1.9 实测后）**：实测值与 A/B 决定追加到 Changelog；冻结后的默认与切换规则不得事后更改。

---

## Changelog

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-10-01 | pre-reg-v1 | 初次预注册（Task 0.1）；对应计划 v3.1 |
| 2026-10-01 | pre-reg-v1.1 | Task 0.6：§14 十项开关 + 时间线目标冻结；seed 探针脚本交付（`eval/scripts/seed-probe.mjs`），实测 pending（无 API key，D19 替代方案已预注册于 §11.1） |
| 2026-10-01 | pre-reg-v1.2 | Task 0.7：§15 分类器语言决策门定稿（默认 A + G1 切换规则 + 成本影响 + P1.9 范围冻结） |

## Deviations

| 日期 | 偏离项 | 原因 | 影响 | 补偿实验 |
|---|---|---|---|---|
| 2026-10-01 | seed 支持性实测未执行（无 API key） | 环境无 `DEEPSEEK_API_KEY` | C-extension 跨种子方案待定 | `eval/scripts/seed-probe.mjs` 待 key 就绪后补测并回填 §4/§11.1 |
