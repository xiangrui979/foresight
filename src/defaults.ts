/**
 * ForeSight defaults — the ONLY place in the codebase where
 * machine-dependent values and service addresses are allowed.
 *
 * Everything here is a safe cross-platform default. Users override via
 * config file or environment variable (see README → Configuration/TOCTOU).
 */

/** Embedding dimensionality (sqlite-vec vec0 is fixed at schema creation). */
export const EMBED_DIM = 768

/** Data directory: resolved at runtime from FORESIGHT_MEMORY_DIR, platform
 *  defaults (APPDATA on Windows, XDG_DATA_HOME on Linux/macOS), or cwd/memory
 *  of last resort. Never hardcode a user's path in source. */
export const DEFAULT_DB_FILE = 'foresight.db'

/** Ollama is the default embed provider; both URL and model are overridable. */
export const DEFAULT_EMBED_BASE_URL = 'http://localhost:11434'
export const DEFAULT_EMBED_MODEL = 'nomic-embed-text-v2-moe'

/** HTTP service (memory server endpoints). Bound to loopback only. */
export const DEFAULT_SERVER_HOST = '127.0.0.1'
export const DEFAULT_SERVER_PORT = 9288

/** LLM provider for classification/derivation/dialectic. */
export const DEFAULT_LLM_BASE_URL = 'https://api.deepseek.com/v1'
export const DEFAULT_LLM_MODEL = 'deepseek-flash'
export const DEFAULT_LLM_TIMEOUT_MS = 60_000
export const DEFAULT_LLM_MAX_RETRIES = 2

/** Policy version this build understands. */
export const POLICY_VERSION = 3
