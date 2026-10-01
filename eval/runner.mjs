#!/usr/bin/env node
/**
 * ForeSight eval runner (P0.4 脚手架; 实际执行在 P1.3 接线).
 *
 * 预注册见 eval/DECISIONS.md；trace schema 见 eval/schema/trace.schema.json。
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BENCHES = ['longmemeval', 'locomo', 'timesuite', 'smoke']
export const SYSTEMS = ['foresight', 'nolifecycle', 'recency', 'rag', 'summary', 'fullcontext', 'closedbook']

export function usage() {
  return `ForeSight eval runner (P0.4 scaffold)

用法:
  node eval/runner.mjs --bench <name> --system <name> --config <file> --out <file> [options]

必选:
  --bench <name>        数据集: ${BENCHES.join(' | ')}
  --system <name>       系统: ${SYSTEMS.join(' | ')}
  --config <file>       eval 配置 (如 eval/configs/foresight-full.yaml)
  --out <file>          结果输出 (trace JSONL)

运行控制:
  --variant <v>         LME 变体: s | m | oracle (默认 s; C-extension 预留)
  --seed <int>          随机种子 (全链路参数化; 默认 0)
  --budget-tokens <n>   注入 token 预算 (预注册 3 档: 1000/2000/4000)
  --budget-usd <n>      成本护栏 (美元口径)
  --budget-cny <n>      成本护栏 (人民币口径; 与 EVAL_MAX_CNY 一致)
  --no-cache            禁用内容哈希缓存 (主表双跑强制)
  --drive-nudge         由 runner 驱动 turn 计数与 nudge (未然体验证路径)
  --estimate            估算调用数与成本, 不执行
  --dry-run             只做装配与 3 条样例冒烟, 不调用 LLM

其他:
  --help, -h            显示本帮助

环境变量:
  DEEPSEEK_API_KEY      reader/judge/LLM 调用
  EVAL_MAX_CNY          成本硬帽 (默认 300)
  EVAL_MAX_CALLS        调用数硬顶 (默认 50000)
  FORESIGHT_*           ForeSight 数据目录/embedding/LLM 覆盖
`
}

const SCHEMA = {
  bench: { kind: 'value', validate: (v) => BENCHES.includes(v) },
  system: { kind: 'value', validate: (v) => SYSTEMS.includes(v) },
  config: { kind: 'value' },
  out: { kind: 'value' },
  variant: { kind: 'value', validate: (v) => ['s', 'm', 'oracle'].includes(v) },
  seed: { kind: 'value', parse: Number },
  'budget-tokens': { kind: 'value', parse: Number },
  'budget-usd': { kind: 'value', parse: Number },
  'budget-cny': { kind: 'value', parse: Number },
  'no-cache': { kind: 'flag' },
  'drive-nudge': { kind: 'flag' },
  estimate: { kind: 'flag' },
  'dry-run': { kind: 'flag' },
  help: { kind: 'flag' },
  h: { kind: 'flag' },
}

export function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw.startsWith('--')) throw new Error(`未知参数: ${raw}`)
    const key = raw.slice(2)
    const spec = SCHEMA[key]
    if (!spec) throw new Error(`未知参数: ${raw}`)
    if (spec.kind === 'flag') {
      opts[key] = true
      continue
    }
    const value = argv[++i]
    if (value === undefined) throw new Error(`${raw} 缺少取值`)
    if (spec.validate && !spec.validate(value)) throw new Error(`${raw} 取值非法: ${value}`)
    opts[key] = spec.parse ? spec.parse(value) : value
  }
  return opts
}

function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    console.error(`✘ ${e.message}`)
    console.error('使用 --help 查看用法。')
    return 2
  }
  if (opts.help || opts.h || argv.length === 0) {
    console.log(usage())
    return 0
  }
  for (const req of ['bench', 'system', 'config', 'out']) {
    if (!opts[req]) {
      console.error(`✘ 缺少必选参数 --${req}`)
      console.error('使用 --help 查看用法。')
      return 2
    }
  }
  console.error('runner 尚未实现（P0.4 脚手架）：执行逻辑将在 P1.3 接线。')
  console.error(`解析结果: ${JSON.stringify(opts)}`)
  return 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
