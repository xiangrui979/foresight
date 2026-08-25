# ForeSight

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-blue?logo=github)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-black?logo=deepseek)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/github/license/xiangrui979/foresight.svg)](LICENSE)

**English** | [中文](README.zh-CN.md)

**A temporal-aspect long-term memory plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).**

Every memory carries explicit temporal semantics — a linguistic *aspect*
(进行体 / 完成体 / 未然体 / 恒常体) paired with an *anchor* (time point /
interval / open / none). The framework executes lifecycle mechanically:
decay on anchor expiry, TTL fallback, renewal nudge, prospective review,
prediction verification, and conflict resolution by evidence with a single
conservative/aggressive knob (β).

Unlike chat vendors' rolling memories, ForeSight treats memory as
**scheduled first-class data**: expiration, injection eligibility, retrieval
weighting and contradiction resolution all derive from one structured policy
file (`policy.yaml`) — zero hardcoded behavior.

## Why it exists

Long-term memory is a data-management problem, not a prompt-engineering one.
ForeSight applies the two axes that matter:

| Axis | Values | What it controls |
|---|---|---|
| 体 (aspect) | progressive / perfect / prospective / gnomic | lifecycle: expires, permanent, to-verify, never-injected |
| 锚定 (anchor) | none / point / interval / open | when the statement is true (valid time) |

## Requirements

- Node.js ≥ 20
- DeepSeek Harness (dsh) with the [cordis](https://github.com/deepseek-ai/cordis) plugin system
- An embedding backend (default: [Ollama](https://ollama.com/) with
  `nomic-embed-text-v2-moe`, 768-dim)
- (Optional) An LLM API for classification/derivation (default:
  DeepSeek compatible API; rules-based fallbacks exist)

## Installation (dsh profile)

```bash
# in your ~/.dsh/profiles/<name>/
pnpm add @foresight/memory
```

Then add the plugin to your profile's bundle list and wire it in a patch:

```yaml
# cordis.patch.yml (profile-level)
- id: foresight-core
  config:
    memoryRoot: '<your data directory>'   # e.g. /home/you/.config/foresight
    dbFile: 'foresight.db'
    embedBaseUrl: 'http://localhost:11434'
    embedModel: 'nomic-embed-text-v2-moe'
```

## Configuration — where does my data go?

**Your data lives OUTSIDE the repo, in your own data directory.** The plugin
never ships any user data; the repository is pure code + templates.

### Data directory layout

```
<memoryRoot>/
├── SOUL.md          # personality (copy from templates/SOUL.md.example)
├── user.md          # user profile (copy from templates/user.md.example)
├── policy.yaml      # all tunables (copy from templates/policy.yaml.example)
└── foresight.db     # SQLite store (created automatically)
```

On first run the plugin expects the three text files to exist. The plugin
creates the directory if needed but **does not silently write policy** — copy
the templates, then adjust:

```bash
mkdir -p ~/.config/foresight
cp templates/SOUL.md.example  ~/.config/foresight/SOUL.md
cp templates/user.md.example  ~/.config/foresight/user.md
cp templates/policy.yaml.example ~/.config/foresight/policy.yaml
```

### Resolution chain

`explicit options (adapter) → environment variables → policy.yaml → defaults`

| Setting | Env var | Default |
|---|---|---|
| data directory | `FORESIGHT_MEMORY_DIR` | `%APPDATA%/foresight` (win) / `~/.local/share/foresight` (unix) |
| db file | `FORESIGHT_DB_FILE` | `foresight.db` |
| embed URL | `FORESIGHT_EMBED_URL` | `http://localhost:11434` |
| embed model | `FORESIGHT_EMBED_MODEL` | `nomic-embed-text-v2-moe` |
| LLM base URL | `FORESIGHT_LLM_BASE_URL` | `https://api.deepseek.com/v1` |
| LLM model | `FORESIGHT_LLM_MODEL` | `deepseek-v4-flash` |

### Policy file

`policy.yaml` is the single source of truth for behavior: permission matrix,
aspect registry (TTL, dwell, injection mode), gate categories, activation β
and decay constants, retrieval factor weights, injection budgets, nudge
cadence, server port/token. **You decide** your assistant's personality,
profile, and memory policy — none of it is baked into the code.

## Layout

```
src/
├── types.ts            # domain types (aspect×anchor)
├── defaults.ts         # the ONLY place default values live
├── config.ts           # resolution chain + data dir bootstrap
├── policy.ts           # policy.yaml loader + behavior lookup
├── schema.ts           # SQLite DDL + migration + sqlite-vec
├── store.ts            # CRUD, soft-delete, vectors, FTS, audit
├── gate/               # write gate: classify + validate (aspect-text)
├── govern/             # permission model
├── evolve/             # temporal expiry/TTL, activation, β conflict
├── retrieve/           # composable scoring factors + search (3 shapes)
└── store/embed.ts      # embed provider interface (Ollama default)
```

## Verification

```bash
pnpm install
pnpm build     # tsc
pnpm test      # node --test tests/ — no external services required
```

All tests run against an in-memory/temp store and a fake embedder — the suite
passes on a clean machine with no Ollama, no API key, and no data directory.

## License

MIT
