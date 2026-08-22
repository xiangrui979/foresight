#!/usr/bin/env node
/**
 * Module 2 tests: config resolution chain + policy loading.
 * All ficitonal data; temp dirs only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { resolveConfig, defaultMemoryRoot, ensureDataDir } = await import('../lib/config.js')
const { loadPolicy, behavior } = await import('../lib/policy.js')
const { POLICY_VERSION } = await import('../lib/defaults.js')

test('config: defaults are platform-safe, no user paths', () => {
  const c = resolveConfig()
  assert.equal(c.dbFile, 'foresight.db')
  assert.equal(c.embedBaseUrl, 'http://localhost:11434')
  assert.equal(c.embedModel, 'nomic-embed-text-v2-moe')
  // data dir must NOT contain any personal path fragment
  assert.ok(!c.memoryRoot.includes('Users/'), 'memoryRoot must not hardcode user dir')
})

test('config: env overrides defaults', () => {
  process.env.FORESIGHT_MEMORY_DIR = '/tmp/foresight-env-test'
  process.env.FORESIGHT_EMBED_MODEL = 'some-other-model'
  const c = resolveConfig()
  assert.equal(c.memoryRoot, '/tmp/foresight-env-test')
  assert.equal(c.embedModel, 'some-other-model')
  delete process.env.FORESIGHT_MEMORY_DIR
  delete process.env.FORESIGHT_EMBED_MODEL
})

test('config: explicit options win over env', () => {
  process.env.FORESIGHT_MEMORY_DIR = '/tmp/env-root'
  const c = resolveConfig({ memoryRoot: '/tmp/explicit-root' })
  assert.equal(c.memoryRoot, '/tmp/explicit-root')
  delete process.env.FORESIGHT_MEMORY_DIR
})

test('config: ensureDataDir creates missing dir', () => {
  const p = path.join(os.tmpdir(), 'foresight-cfg-' + Date.now())
  ensureDataDir({ memoryRoot: p })
  assert.ok(fs.existsSync(p))
  fs.rmSync(p, { recursive: true, force: true })
})

test('policy: loads valid file, version checked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-pol-'))
  const p = path.join(dir, 'policy.yaml')
  fs.writeFileSync(p, `foresight:\n  policy_version: ${POLICY_VERSION}\n  aspects:\n    progressive:\n      storage: memory\n      injection: conditional\n      expiry: anchor\n      render_anchor: true\n      renewable: true\n      default_ttl_days: 7\n      review_every_turns: 30\n    perfect:\n      storage: memory\n      injection: conditional\n      expiry: never\n      render_anchor: short\n      renewable: false\n      default_ttl_days: 0\n      review_every_turns: 0\n    gnomic:\n      storage: doc\n      injection: always\n      expiry: never\n      render_anchor: false\n      renewable: false\n      default_ttl_days: 0\n      review_every_turns: 0\n    prospective:\n      storage: memory\n      injection: renewal\n      expiry: ttl\n      render_anchor: true\n      renewable: true\n      default_ttl_days: 30\n      review_every_turns: 30\n`)
  const pol = loadPolicy(p)
  assert.equal(pol.policy_version, POLICY_VERSION)
  const b = behavior(pol, 'progressive')
  assert.equal(b.default_ttl_days, 7)
  assert.equal(b.review_every_turns, 30)
  assert.equal(b.storage, 'memory')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('policy: version mismatch raises', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foresight-pol-'))
  const p = path.join(dir, 'policy.yaml')
  fs.writeFileSync(p, `foresight:\n  policy_version: 99\n`)
  assert.throws(() => loadPolicy(p), /version mismatch/)
  fs.rmSync(dir, { recursive: true, force: true })
})
