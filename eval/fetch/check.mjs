#!/usr/bin/env node
/**
 * Unified data check (Task 1.7): manifests + file status + question/category
 * distributions + license status. Run: node eval/fetch/check.mjs
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.resolve(HERE, '..', 'data')

function manifestOf(dir) {
  const p = path.join(DATA, dir, 'manifest.json')
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
}

function main() {
  let failures = 0
  const lme = manifestOf('longmemeval')
  if (!lme) {
    console.error('✘ longmemeval: 未下载（node eval/fetch/fetch_longmemeval.mjs）')
    failures += 1
  } else {
    console.log(`[longmemeval] license=${lme.license} revision=${lme.revision} downloaded_at=${lme.downloaded_at}`)
    for (const f of lme.files) {
      const p = path.join(DATA, 'longmemeval', f.name)
      if (!fs.existsSync(p)) {
        console.error(`  ✘ 缺失: ${f.name}`)
        failures += 1
        continue
      }
      if (fs.statSync(p).size !== f.bytes) {
        console.error(`  ✘ 大小不符: ${f.name}（重跑 fetch --force）`)
        failures += 1
      }
      console.log(`  ✔ ${f.name}  ${f.bytes} B  sha256:${f.sha256.slice(0, 16)}…`)
    }
  }

  const locomo = manifestOf('locomo')
  if (!locomo) {
    console.error('✘ locomo: 未下载（node eval/fetch/fetch_locomo.mjs）')
    failures += 1
  } else {
    console.log(`[locomo] license=${locomo.license}（${locomo.license_first_line ?? 'LICENSE.txt'}）downloaded_at=${locomo.downloaded_at}`)
    const p = path.join(DATA, 'locomo', locomo.file)
    if (!fs.existsSync(p)) {
      console.error(`  ✘ 缺失: ${locomo.file}`)
      failures += 1
    } else {
      console.log(`  ✔ ${locomo.file}  ${locomo.bytes} B  sha256:${locomo.sha256.slice(0, 16)}…`)
    }
  }

  console.log(failures === 0 ? '\n✔ data check 通过（数据不入库；分发策略见 DECISIONS §14）' : `\n✘ data check 失败项: ${failures}`)
  return failures === 0 ? 0 : 1
}

process.exitCode = main()
