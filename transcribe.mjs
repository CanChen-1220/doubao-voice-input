#!/usr/bin/env node
/**
 * One-shot transcription CLI — fully portable.
 *
 * Reads credentials from `credentials.json` next to this script, so it works on
 * any Windows machine with Node.js installed, no DeepSeek Harness required.
 *
 *   node transcribe.mjs <recording.wav>
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply } from './provider/index.js'

const here = dirname(fileURLToPath(import.meta.url))

let credentials = {}
try {
  credentials = JSON.parse(readFileSync(join(here, 'credentials.json'), 'utf8').replace(/^\uFEFF/, ''))
} catch {
  credentials = {}
}

let provider = null
apply(
  {
    speechToText: {
      register(candidate) {
        provider = candidate
        return async () => {}
      },
    },
    effect(fn) {
      fn()
    },
  },
  {
    providerId: 'doubao-cloud',
    appKey: credentials.appKey || '',
    accessKey: credentials.accessKey || '',
    endpoint: credentials.endpoint || '',
    resourceId: credentials.resourceId || '',
    language: credentials.language || '',
  },
)

if (!provider) {
  console.error('识别器没有注册成功')
  process.exit(1)
}

const path = process.argv[2]
if (!path) {
  console.error('用法: node transcribe.mjs <recording.wav>')
  process.exit(1)
}

try {
  const result = await provider.transcribe({ audio: readFileSync(path), language: 'auto' }, new AbortController().signal)
  process.stdout.write(result.text)
  process.exit(0)
} catch (error) {
  console.error(error?.message ?? String(error))
  process.exit(1)
}
