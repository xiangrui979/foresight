#!/usr/bin/env node
/**
 * LongMemEval (cleaned 2025/09) fetcher — Task 1.7.
 *
 * Source : https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 * License: MIT (dataset card)
 * Hub rev: 98d7416c24c778c2fee6e6f3006e7a073259d48f (lastModified 2025-09-19)
 *
 * Data lives in eval/data/ (gitignored; never redistributed).
 * CLI: [--variant s,oracle|m] [--force] [--check]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = path.resolve(HERE, '..', 'data', 'longmemeval')
const BASE = 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main'
const MANIFEST = path.join(DATA_ROOT, 'manifest.json')

export const LME_LICENSE = 'MIT'
export const LME_REVISION = '98d7416c24c778c2fee6e6f3006e7a073259d48f'
export const LME_FILES = {
  s: 'longmemeval_s_cleaned.json',
  m: 'longmemeval_m_cleaned.json',
  oracle: 'longmemeval_oracle.json',
}

async function download(name) {
  const url = `${BASE}/${name}`
  const dest = path.join(DATA_ROOT, name)
  if (fs.existsSync(dest) && !process.argv.includes('--force')) {
    console.log(`↷ 已存在，跳过: ${name}`)
  } else {
    fs.mkdirSync(DATA_ROOT, { recursive: true })
    console.log(`↓ ${url}`)
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest))
  }
  const buf = fs.readFileSync(dest)
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  return { name, bytes: buf.byteLength, sha256 }
}

function updateManifest(files) {
  let manifest = { source: 'huggingface:xiaowu0162/longmemeval-cleaned', license: LME_LICENSE, revision: LME_REVISION, files: [] }
  if (fs.existsSync(MANIFEST)) manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  manifest.downloaded_at = new Date().toISOString()
  const byName = new Map(manifest.files.map((f) => [f.name, f]))
  for (const f of files) byName.set(f.name, { ...f, url: `${BASE}/${f.name}` })
  manifest.files = [...byName.values()]
  fs.mkdirSync(DATA_ROOT, { recursive: true })
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
}

export function summarizeLme(file) {
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'))
  const types = {}
  let abstention = 0
  for (const it of arr) {
    const t = it.question_type ?? 'unknown'
    types[t] = (types[t] ?? 0) + 1
    if (String(it.question_id ?? '').endsWith('_abs')) abstention += 1
  }
  return { questions: arr.length, types, abstention }
}

function check() {
  if (!fs.existsSync(MANIFEST)) {
    console.error('✘ manifest 不存在；先运行下载。')
    return 1
  }
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  console.log(`[longmemeval] license=${m.license} revision=${m.revision}`)
  for (const f of m.files) {
    const p = path.join(DATA_ROOT, f.name)
    if (!fs.existsSync(p)) {
      console.log(`  ✘ 缺失: ${f.name}`)
      continue
    }
    const bytes = fs.statSync(p).size
    let extra = ''
    if (f.name.includes('_s_cleaned') || f.name.includes('oracle')) {
      try {
        const s = summarizeLme(p)
        extra = ` questions=${s.questions} abstention=${s.abstention} types=${JSON.stringify(s.types)}`
      } catch (e) {
        extra = ` (统计失败: ${e.message})`
      }
    }
    console.log(`  ${f.name}  ${bytes} B  sha256:${f.sha256.slice(0, 16)}…${extra}`)
  }
  return 0
}

async function main() {
  if (process.argv.includes('--check')) return check()
  const variantArg = process.argv.includes('--variant') ? process.argv[process.argv.indexOf('--variant') + 1] : 's,oracle'
  const names = variantArg.split(',').map((v) => LME_FILES[v.trim()]).filter(Boolean)
  if (names.length === 0) throw new Error('--variant 取值: s,m,oracle（逗号分隔）')
  const files = []
  for (const n of names) files.push(await download(n))
  updateManifest(files)
  console.log('✔ LongMemEval 下载完成并写入 manifest（data/ 已 gitignore，不再分发）')
  return check()
}

main()
  .then((code) => {
    process.exitCode = code ?? 0
  })
  .catch((e) => {
    console.error(`✘ ${e.message}`)
    process.exitCode = 1
  })
