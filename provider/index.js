/**
 * Doubao (Volcengine) cloud speech-to-text provider.
 *
 * Registers a `cloud` recognizer with `ctx.speechToText`, so the browser voice
 * input plugin records locally, posts the recording through the host, and gets
 * back text transcribed by Doubao's Seed-ASR streaming model. Audio leaves the
 * machine only for this provider, only for the duration of one request.
 *
 * Two properties of the service shape this implementation:
 *   1. Utterance segmentation follows `end_window_size`. Left at the server
 *      default, a burst-uploaded recording is cut at every packet boundary.
 *   2. A session dies with 45000081 ("Timed out waiting for the next audio
 *      packet") when the server needs more than ~10 s to finish after the last
 *      packet arrives. That caps one session at roughly 25 s of audio, so longer
 *      recordings are split at quiet points and transcribed concurrently.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketClient, HandshakeError } from './ws.js'
import {
  buildInitPacket,
  buildAudioPacket,
  parseServerPacket,
  extractWavPcm,
  SERVER_ERROR_RESPONSE,
} from './protocol.js'

export const name = 'speech-to-text-doubao'
export const inject = ['speechToText']

/**
 * Endpoint and resource fallbacks for Doubao Seed-ASR 2.0 (豆包流式语音识别模型 2.0).
 * These stay out of DEFAULTS so an explicit value in the sidecar file is not
 * shadowed by a default that is always non-empty.
 */
const FALLBACK_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
const FALLBACK_RESOURCE_ID = 'volc.seedasr.sauc.duration'

const BYTES_PER_SECOND = 16000 * 2

const DEFAULTS = {
  providerId: 'doubao-cloud',
  endpoint: '',
  resourceId: '',
  appKey: '',
  accessKey: '',
  uid: 'dsh',
  language: '',
  chunkMs: 100,
  connectTimeoutMs: 15000,
  timeoutMs: 60000,
  enablePunc: true,
  enableItn: true,
  enableDdc: false,
  /**
   * Milliseconds of trailing silence before the server closes an utterance.
   * The server default is far shorter than a human pause, so a burst-uploaded
   * recording was being cut at each packet boundary ("早上。好呀。cloud。").
   */
  endWindowSize: 800,
  /** Longest audio handed to one session; see the 45000081 note above. */
  segmentSeconds: 12,
  /** Parallel sessions. Twelve-second segments keep enough margin for three. */
  concurrency: 3,
  /** Attempts per segment; only transport/idle timeouts are retried. */
  maxAttempts: 2,
  credentialsFile: '',
}

/** A rejection carrying the service's own error code, so retry policy can branch. */
class SpeechServiceError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'SpeechServiceError'
    this.code = code
  }
}

/** Sessions that ended because the server ran out of patience are worth one retry. */
function isRetryable(error) {
  if (error instanceof SpeechServiceError) return error.code === 45000081
  return /Timed out waiting for the next audio packet/i.test(error?.message ?? '')
}

/** Read the optional sidecar credentials file; missing or invalid files are ignored. */
function readCredentialFile(path) {
  try {
    // Editors and PowerShell on Windows happily prepend a BOM; JSON.parse rejects it.
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
}

/** Resolve credentials from plugin config, then env, then the sidecar file. */
function resolveCredentials(config) {
  const file = readCredentialFile(config.credentialsFile || join(homedir(), '.dsh', 'doubao-asr.json'))
  const pick = (...values) => values.find((value) => typeof value === 'string' && value.trim() !== '')?.trim() ?? ''
  return {
    appKey: pick(config.appKey, process.env.DOUBAO_ASR_APP_KEY, file.appKey),
    accessKey: pick(config.accessKey, process.env.DOUBAO_ASR_ACCESS_KEY, file.accessKey),
    resourceId: pick(config.resourceId, process.env.DOUBAO_ASR_RESOURCE_ID, file.resourceId) || FALLBACK_RESOURCE_ID,
    endpoint: pick(config.endpoint, process.env.DOUBAO_ASR_ENDPOINT, file.endpoint) || FALLBACK_ENDPOINT,
    language: pick(config.language, file.language),
  }
}

/** Turn transport-level failures into messages a person can act on. */
function describeFailure(error) {
  if (!(error instanceof HandshakeError)) return error
  const reason = (error.reason || '').trim()
  const suffix = reason ? `（${reason}）` : ''
  if (/not granted/i.test(reason)) {
    return new Error(`豆包识别：这个应用还没开通这项语音服务${suffix}。请到火山控制台给应用开通「流式语音识别大模型」`)
  }
  if (/appid mismatch/i.test(reason)) {
    return new Error(`豆包识别：App ID 和 Access Token 不属于同一个应用${suffix}`)
  }
  if (/is not allowed/i.test(reason)) {
    return new Error(`豆包识别：端点不接受这个资源名${suffix}`)
  }
  if (error.status === 401 || error.status === 403) {
    return new Error(`豆包识别鉴权失败（HTTP ${error.status}）${suffix}`)
  }
  return new Error(`豆包识别握手失败（HTTP ${error.status}）${suffix || '：' + error.message}`)
}

/** Flatten the service's error envelope into one line. */
function serverError(packet) {
  const code = Number(packet.error?.code)
  const raw = packet.error?.message
  const text = typeof raw === 'string' ? raw : (raw?.error ?? JSON.stringify(raw ?? ''))
  return new SpeechServiceError(`豆包识别返回错误：${text}`, Number.isFinite(code) ? code : undefined)
}

/**
 * Choose a cut point near `to` at the quietest 30 ms frame, so a segment boundary
 * does not land in the middle of a syllable.
 */
function quietCut(pcm, from, to) {
  const frame = 960
  let best = to
  let bestEnergy = Number.POSITIVE_INFINITY
  for (let position = from; position + frame <= to; position += frame) {
    let energy = 0
    for (let index = position; index < position + frame; index += 2) energy += Math.abs(pcm.readInt16LE(index))
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = position + frame / 2
    }
  }
  return best
}

/**
 * Split PCM into sessions the service will finish inside its idle window.
 * @param {Buffer} pcm - 16 kHz mono PCM16 samples.
 * @param {number} segmentSeconds - target maximum segment length.
 * @returns {Buffer[]} segments in order.
 */
function splitPcm(pcm, segmentSeconds) {
  const maxBytes = Math.max(BYTES_PER_SECOND, Math.round(segmentSeconds * BYTES_PER_SECOND))
  const minBytes = Math.min(maxBytes, Math.round(4 * BYTES_PER_SECOND))
  const segments = []
  let offset = 0
  while (offset < pcm.length) {
    let end = Math.min(offset + maxBytes, pcm.length)
    if (end < pcm.length) {
      const from = Math.min(end, Math.max(offset + minBytes, end - 3 * BYTES_PER_SECOND))
      if (from < end) end = quietCut(pcm, from, end)
    }
    if (end <= offset) end = Math.min(offset + maxBytes, pcm.length)
    segments.push(pcm.subarray(offset, end))
    offset = end
  }
  return segments
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

const CJK = /[\u3000-\u9fff\uff00-\uffef]/
const CJK_END = /[。！？，、；：）】」』…—]/
const LATIN_END = /[.!?,;:)\]"']/

/** Join segment transcripts without inventing sentence breaks mid-clause. */
function joinTranscripts(parts) {
  const cleaned = parts.map((part) => part.trim()).filter((part) => part !== '')
  if (cleaned.length === 0) return ''
  let joined = cleaned[0]
  for (let index = 1; index < cleaned.length; index += 1) {
    const tail = joined.slice(-1)
    const head = cleaned[index].charAt(0)
    if (CJK_END.test(tail)) {
      joined += cleaned[index]
    } else if (LATIN_END.test(tail)) {
      joined += ` ${cleaned[index]}`
    } else if (CJK.test(tail) || CJK.test(head)) {
      joined += `，${cleaned[index]}`
    } else {
      joined += ` ${cleaned[index]}`
    }
  }
  return joined
}

/** Transcribe one segment over its own WebSocket session. */
async function transcribeSegment(credentials, request, pcm, config, signal) {
  const chunkBytes = Math.max(2, Math.round((BYTES_PER_SECOND * (config.chunkMs || DEFAULTS.chunkMs)) / 1000))
  const deadlineMs = config.timeoutMs || DEFAULTS.timeoutMs

  return await new Promise((resolve, reject) => {
    let client
    let settled = false
    let timer
    const onAbort = () => finish(new Error('豆包识别已取消'))
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      cleanup()
      try {
        client?.close()
      } catch {
        // Closing a half-open socket is best effort.
      }
      if (error) reject(error)
      else resolve(value)
    }

    timer = setTimeout(() => finish(new Error(`豆包识别超时（${deadlineMs} ms）`)), deadlineMs)
    if (signal?.aborted) {
      finish(new Error('豆包识别已取消'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    void (async () => {
      try {
        client = await WebSocketClient.connect(
          credentials.endpoint,
          {
            'X-Api-App-Key': credentials.appKey,
            'X-Api-Access-Key': credentials.accessKey,
            'X-Api-Resource-Id': credentials.resourceId,
            'X-Api-Request-Id': randomUUID(),
            'X-Api-Connect-Id': randomUUID(),
          },
          config.connectTimeoutMs || DEFAULTS.connectTimeoutMs,
        )

        client.send(buildInitPacket(request))
        let packet = parseServerPacket(await client.next())
        if (packet.messageType === SERVER_ERROR_RESPONSE) throw serverError(packet)

        for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
          if (signal?.aborted) throw new Error('豆包识别已取消')
          const end = Math.min(offset + chunkBytes, pcm.length)
          client.send(buildAudioPacket(pcm.subarray(offset, end), end >= pcm.length))
        }

        let latest = ''
        for (;;) {
          packet = parseServerPacket(await client.next())
          if (packet.messageType === SERVER_ERROR_RESPONSE) throw serverError(packet)
          const result = packet.payload?.result
          if (typeof result?.text === 'string' && result.text.length > 0) latest = result.text
          if (packet.isLast) break
        }

        finish(null, latest.trim())
      } catch (error) {
        finish(describeFailure(error))
      }
    })()
  })
}

/**
 * Transcribe one canonical 16 kHz mono PCM16 recording.
 * @param {object} config - merged plugin configuration.
 * @param {Uint8Array} audio - WAV bytes from the speech service.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<{text: string, audioSeconds: number, inferenceSeconds: number}>}
 */
async function transcribe(config, audio, signal) {
  const startedAt = Date.now()
  const credentials = resolveCredentials(config)
  if (!credentials.appKey || !credentials.accessKey) {
    throw new Error('豆包识别还没配凭据：请在 ~/.dsh/doubao-asr.json 里填写 appKey（App ID）和 accessKey（Access Token）')
  }

  const { pcm } = extractWavPcm(audio)
  const audioSeconds = pcm.length / BYTES_PER_SECOND
  if (pcm.length === 0) return { text: '', audioSeconds, inferenceSeconds: 0 }

  const request = {
    user: { uid: config.uid || DEFAULTS.uid },
    audio: {
      format: 'pcm',
      codec: 'raw',
      sample_rate: 16000,
      channel: 1,
      bits: 16,
      ...(credentials.language ? { language: credentials.language } : {}),
    },
    request: {
      model_name: 'bigmodel',
      enable_punc: config.enablePunc !== false,
      enable_itn: config.enableItn !== false,
      enable_ddc: config.enableDdc === true,
      end_window_size: Number(config.endWindowSize) > 0 ? Number(config.endWindowSize) : DEFAULTS.endWindowSize,
    },
  }

  const segments = splitPcm(pcm, Number(config.segmentSeconds) > 0 ? Number(config.segmentSeconds) : DEFAULTS.segmentSeconds)
  const attempts = Math.max(1, Number(config.maxAttempts) || DEFAULTS.maxAttempts)

  const texts = await mapLimit(segments, Number(config.concurrency) || DEFAULTS.concurrency, async (segment) => {
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      signal?.throwIfAborted()
      try {
        return await transcribeSegment(credentials, request, segment, config, signal)
      } catch (error) {
        lastError = error
        if (!isRetryable(error) || attempt === attempts) throw error
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
      }
    }
    throw lastError
  })

  return { text: joinTranscripts(texts), audioSeconds, inferenceSeconds: (Date.now() - startedAt) / 1000 }
}

/**
 * Register the cloud recognizer with the host speech service.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context providing `speechToText`.
 * @param {object} config - validated deployment configuration.
 */
export function apply(ctx, config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  if (!merged.providerId || typeof merged.providerId !== 'string') throw new Error('Doubao speech provider requires a providerId')

  const provider = {
    info: {
      id: merged.providerId,
      name: '豆包 Seed-ASR (云端)',
      location: 'cloud',
      languages: ['auto', 'zh', 'en'],
    },
    transcribe: async (input, signal) => await transcribe(merged, input.audio, signal),
  }

  ctx.effect(() => {
    const unregister = ctx.speechToText.register(provider)
    return async () => {
      await unregister()
    }
  })
}
