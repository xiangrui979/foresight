# ForeSight

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-blue?logo=github)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-black?logo=deepseek)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/github/license/xiangrui979/foresight.svg)](LICENSE)

[English](README.md) | **中文**

**面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的时相化长期记忆插件。**

每条记忆都携带显式的时间语义——语言学的*体*（aspect：进行体 / 完成体 / 未然体 / 恒常体）与*锚*（anchor：时点 / 区间 / 开放 / 无关）配对。框架机械地执行生命周期：锚到期衰减、TTL 兜底、续期提醒（nudge）、先行体审查、预测到期自动判定，以及基于证据的冲突消解，全部由单一保守/激进系数 β 控制。

与聊天厂商的滚动窗口式记忆不同，ForeSight 把记忆当作**调度的第一等数据**：过期、注入资格、检索权重与矛盾消解全部由一份结构化策略文件（`policy.yaml`）推导——零硬编码行为。

## 为什么存在

长期记忆是数据管理问题，不是提示词工程问题。ForeSight 应用两个关键轴：

| 轴 | 取值 | 控制什么 |
|---|---|---|
| 体 (aspect) | 进行体 / 完成体 / 未然体 / 恒常体 | 生命周期：到期、永久、待验证、永不注入 |
| 锚定 (anchor) | 无锚 / 时点 / 区间 / 开放 | 语句何时为真（有效时间） |

## 环境要求

- Node.js ≥ 20
- 带 [cordis](https://github.com/deepseek-ai/cordis) 插件系统的 DeepSeek Harness（dsh）
- 一个 embedding 后端（默认：[Ollama](https://ollama.com/) + `nomic-embed-text-v2-moe`，768 维）
- （可选）用于分类/推导的 LLM API（默认：DeepSeek 兼容 API；存在规则兜底，无 API 也能运行）

## 安装（dsh profile）

```bash
# 在你的 ~/.dsh/profiles/<name>/ 目录下
pnpm add @foresight/memory
```

然后将插件加入 profile 的 bundle 列表，并在 patch 中接线：

```yaml
# cordis.patch.yml（profile 级）
- id: foresight-core
  config:
    memoryRoot: '<你的数据目录>'   # 例如 /home/you/.config/foresight
    dbFile: 'foresight.db'
    embedBaseUrl: 'http://localhost:11434'
    embedModel: 'nomic-embed-text-v2-moe'
```

## 配置——我的数据存在哪？

**你的数据存放在仓库之外，自己的数据目录里。** 插件绝不携带任何用户数据；仓库是纯代码 + 模板。

### 数据目录结构

```
<memoryRoot>/
├── SOUL.md          # 人格设定（从 templates/SOUL.md.example 复制）
├── user.md          # 用户画像（从 templates/user.md.example 复制）
├── policy.yaml      # 全部可调参数（从 templates/policy.yaml.example 复制）
└── foresight.db     # SQLite 存储（自动创建）
```

首次运行时插件期望那三个文本文件已存在。插件会按需创建目录，但**不会静默写入 policy**——请先复制模板，再自行调整：

```bash
mkdir -p ~/.config/foresight
cp templates/SOUL.md.example  ~/.config/foresight/SOUL.md
cp templates/user.md.example  ~/.config/foresight/user.md
cp templates/policy.yaml.example ~/.config/foresight/policy.yaml
```

### 解析链

`显式选项（adapter）→ 环境变量 → policy.yaml → 默认值`

| 设置 | 环境变量 | 默认值 |
|---|---|---|
| 数据目录 | `FORESIGHT_MEMORY_DIR` | `%APPDATA%/foresight`（win）/ `~/.local/share/foresight`（unix） |
| db 文件 | `FORESIGHT_DB_FILE` | `foresight.db` |
| embedding URL | `FORESIGHT_EMBED_URL` | `http://localhost:11434` |
| embedding 模型 | `FORESIGHT_EMBED_MODEL` | `nomic-embed-text-v2-moe` |
| LLM base URL | `FORESIGHT_LLM_BASE_URL` | `https://api.deepseek.com/v1` |
| LLM 模型 | `FORESIGHT_LLM_MODEL` | `deepseek-v4-flash` |

### 策略文件

`policy.yaml` 是行为的唯一事实来源：权限矩阵、体注册表（TTL、驻留期、注入模式）、gate 分类、激活 β 与衰减常数、检索因子权重、注入预算、nudge 频率、服务器端口/token。**你的助手的人格、画像与记忆策略由你决定**——没有任何一项被硬编码进代码。

## 目录结构

```
src/
├── types.ts            # 领域类型（体×锚）
├── defaults.ts         # 默认值唯一的存放处
├── config.ts           # 解析链 + 数据目录引导
├── policy.ts           # policy.yaml 加载器 + 行为查询
├── schema.ts           # SQLite DDL + 迁移 + sqlite-vec
├── store.ts            # CRUD、软删除、向量、FTS、审计
├── gate/               # 写入门：分类 + 校验（aspect-text）
├── govern/             # 权限模型
├── evolve/             # 时间性过期/TTL、激活、β 冲突消解
├── retrieve/           # 可组合评分因子 + 搜索（3 种形态）
└── store/embed.ts      # embed provider 接口（默认 Ollama）
```

## 验证

```bash
pnpm install
pnpm build     # tsc
pnpm test      # node --test tests/ — 无需外部服务
```

所有测试针对内存/临时存储与假 embedder 运行——整套测试在干净机器上通过，不需要 Ollama、不需要 API key、不需要数据目录。

## 许可证

MIT
