/**
 * ForeSight config — resolution chain.
 *
 * Precedence (highest first):
 *   1. explicit constructor options (from platform adapter / CLI)
 *   2. environment variables  FORESIGHT_*
 *   3. policy.yaml values     (memoryRoot/policy.yaml)
 *   4. defaults.ts            (cross-platform safe defaults)
 *
 * Machine-dependent values (paths, URLs, model names) NEVER appear in source
 * outside defaults.ts; users override through env or their own policy file.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import {
  DEFAULT_DB_FILE,
  DEFAULT_EMBED_BASE_URL,
  DEFAULT_EMBED_MODEL,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
} from './defaults.js'

export interface Config {
  /** Data directory (SOUL.md / user.md / policy.yaml / foresight.db). */
  memoryRoot: string
  dbFile: string
  embedBaseUrl: string
  embedModel: string
  llmBaseUrl: string
  llmModel: string
}

function env(name: string): string | undefined {
  return process.env[name]
}

/** Platform default data dir: %APPDATA%/foresight on Windows,
 *  $XDG_DATA_HOME/foresight or ~/.local/share/foresight otherwise. */
export function defaultMemoryRoot(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'foresight')
  }
  return path.join(
    env('XDG_DATA_HOME') ?? path.join(os.homedir(), '.local', 'share'),
    'foresight',
  )
}

/**
 * Resolve the effective config. Absent value → env → default.
 * Explicit options (dsh patch config) always win, then env, then defaults.
 */
export function resolveConfig(override?: Partial<Config>): Config {
  const root = override?.memoryRoot ?? env('FORESIGHT_MEMORY_DIR') ?? defaultMemoryRoot()
  return {
    memoryRoot: root,
    dbFile: override?.dbFile ?? env('FORESIGHT_DB_FILE') ?? DEFAULT_DB_FILE,
    embedBaseUrl: override?.embedBaseUrl ?? env('FORESIGHT_EMBED_URL') ?? DEFAULT_EMBED_BASE_URL,
    embedModel: override?.embedModel ?? env('FORESIGHT_EMBED_MODEL') ?? DEFAULT_EMBED_MODEL,
    llmBaseUrl: override?.llmBaseUrl ?? env('FORESIGHT_LLM_BASE_URL') ?? DEFAULT_LLM_BASE_URL,
    llmModel: override?.llmModel ?? env('FORESIGHT_LLM_MODEL') ?? DEFAULT_LLM_MODEL,
  }
}

/**
 * Data directory bootstrap shim: users may run the plugin before creating a
 * data dir. Create it if missing (mkdir -p semantics), like Hermes does.
 * Does NOT write policy files — the plugin raises a clear error if policy.yaml
 * is absent, telling the user to copy from templates/. (No silent magic.)
 */
export function ensureDataDir(config: Config): void {
  if (!fs.existsSync(config.memoryRoot)) {
    fs.mkdirSync(config.memoryRoot, { recursive: true })
  }
}
