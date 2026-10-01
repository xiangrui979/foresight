#!/usr/bin/env node
/**
 * LoCoMo fetcher — Task 1.7.
 *
 * Source : https://github.com/snap-research/locomo (data/locomo10.json)
 * License: CC BY-NC 4.0 (LICENSE.txt 实测确认，2026-10-01)
 *
 * Data lives in eval/data/ (gitignored; non-commercial research use only).
 * CLI: [--force] [--check]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = path.resolve(HERE, '..', 'data', 'locomo')
const URL_JSON = 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json'
const URL_LICENSE = 'https://raw.githubusercontent.com/snap-research/locomo/main/LICENSE.txt'
const MANIFEST = path.join(DATA_ROOT, 'manifest.json')

export const LOCOMO_LICENSE = 'CC BY-NC 4.0'

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function summarizeLocomo(file) {
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'))
  const cats = {}
  let qa = 0
  for (const sample of arr) {
    for (const q of sample.qa ?? []) {
      qa += 1
      const c = String(q.category ?? 'unknown')
      cats[c] = (cats[c] ?? 0) + 1
    }
  }
  return { conversations: arr.length, qa, categories: cats }
}

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.mkdirSync(DATA_ROOT, { recursive: true })
  fs.writeFileSync(dest, buf)
  return buf
}

function check() {
  if (!fs.existsSync(MANIFEST)) {
    console.error('✘ manifest 不存在；先运行下载。')
    return 1
  }
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  console.log(`[locomo] license=${m.license}`)
  const p = path.join(DATA_ROOT, m.file)
  if (!fs.existsSync(p)) {
    console.log(`  ✘ 缺失: ${m.file}`)
    return 1
  }
  const s = summarizeLocomo(p)
  console.log(`  ${m.file}  ${fs.statSync(p).size} B  sha256:${m.sha256.slice(0, 16)}…`)
  console.log(`  conversations=${s.conversations} qa=${s.qa} categories=${JSON.stringify(s.categories)}`)
  return 0
}

async function main() {
  if (process.argv.includes('--check')) return check()
  fs.mkdirSync(DATA_ROOT, { recursive: true })
  const dest = path.join(DATA_ROOT, 'locomo10.json')
  if (fs.existsSync(dest) && !process.argv.includes('--force')) {
    console.log('↷ 已存在 locomo10.json，跳过下载')
  } else {
    console.log(`↓ ${URL_JSON}`)
    await download(URL_JSON, dest)
  }
  let licenseText = ''
  try {
    const res = await fetch(URL_LICENSE)
    if (res.ok) licenseText = await res.text()
  } catch {
    /* license snapshot best-effort */
  }
  const buf = fs.readFileSync(dest)
  const manifest = {
    source: 'github:snap-research/locomo',
    url: URL_JSON,
    license: LOCOMO_LICENSE,
    license_file: URL_LICENSE,
    license_first_line: licenseText.split(/\r?\n/).find((l) => l.trim()) ?? null,
    downloaded_at: new Date().toISOString(),
    file: 'locomo10.json',
    bytes: buf.byteLength,
    sha256: sha256(buf),
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
  console.log('✔ LoCoMo 下载完成并写入 manifest（CC BY-NC 4.0：仅非商业研究使用，不再分发）')
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
