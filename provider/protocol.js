/**
 * Volcengine "大模型流式语音识别" binary framing.
 *
 * Wire format, per packet: a 4-byte header
 *   [0] protocol version (high nibble) | header size in 4-byte words (low nibble)
 *   [1] message type (high nibble)     | message flags (low nibble)
 *   [2] serialization (high nibble)    | compression (low nibble)
 *   [3] reserved
 * followed by an optional 4-byte sequence, a 4-byte payload length, and the
 * gzip-compressed payload.
 */
import { gzipSync, gunzipSync } from 'node:zlib'

const PROTOCOL_VERSION = 0b0001
const HEADER_SIZE_WORDS = 0b0001

/** Message types. */
export const FULL_CLIENT_REQUEST = 0b0001
export const AUDIO_ONLY_REQUEST = 0b0010
export const FULL_SERVER_RESPONSE = 0b1001
export const SERVER_ERROR_RESPONSE = 0b1111

const FLAG_WITH_SEQUENCE = 0b0001
const FLAG_LAST_NO_SEQUENCE = 0b0010

const SERIALIZATION_JSON = 0b0001
const COMPRESSION_GZIP = 0b0001

function buildHeader(messageType, flags) {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE_WORDS,
    (messageType << 4) | flags,
    (SERIALIZATION_JSON << 4) | COMPRESSION_GZIP,
    0x00,
  ])
}

/** Build the opening full-client-request carrying JSON configuration. */
export function buildInitPacket(configuration, sequence = 1) {
  const payload = gzipSync(Buffer.from(JSON.stringify(configuration), 'utf8'))
  const sequenceBuffer = Buffer.alloc(4)
  sequenceBuffer.writeInt32BE(sequence, 0)
  const sizeBuffer = Buffer.alloc(4)
  sizeBuffer.writeUInt32BE(payload.length, 0)
  return Buffer.concat([buildHeader(FULL_CLIENT_REQUEST, FLAG_WITH_SEQUENCE), sequenceBuffer, sizeBuffer, payload])
}

/** Build one audio packet; `isLast` marks the end of the recording. */
export function buildAudioPacket(pcm, isLast) {
  const payload = gzipSync(pcm)
  const sizeBuffer = Buffer.alloc(4)
  sizeBuffer.writeUInt32BE(payload.length, 0)
  return Buffer.concat([buildHeader(AUDIO_ONLY_REQUEST, isLast ? FLAG_LAST_NO_SEQUENCE : 0b0000), sizeBuffer, payload])
}

/**
 * Decode one server packet.
 * @param {Buffer} data - complete frame payload.
 * @returns {{messageType: number, isLast: boolean, payload?: any, error?: {code: number, message: any}}}
 */
export function parseServerPacket(data) {
  if (data.length < 4) throw new Error('Speech response packet is truncated')
  const headerWords = data[0] & 0x0f
  const messageType = data[1] >> 4
  const flags = data[1] & 0x0f
  const compression = data[2] & 0x0f
  let offset = headerWords * 4
  const result = { messageType, isLast: (flags & 0x02) !== 0 }
  if ((flags & 0x01) !== 0) offset += 4
  if (offset > data.length) throw new Error('Speech response header is truncated')

  const decode = (bytes) => (compression === COMPRESSION_GZIP ? gunzipSync(bytes) : bytes)

  if (messageType === FULL_SERVER_RESPONSE) {
    const size = data.readUInt32BE(offset)
    offset += 4
    const end = Math.min(offset + size, data.length)
    result.payload = JSON.parse(decode(data.subarray(offset, end)).toString('utf8'))
    return result
  }
  if (messageType === SERVER_ERROR_RESPONSE) {
    const code = data.readUInt32BE(offset)
    const size = data.readUInt32BE(offset + 4)
    offset += 8
    const end = Math.min(offset + size, data.length)
    let message = ''
    try {
      message = JSON.parse(decode(data.subarray(offset, end)).toString('utf8'))
    } catch {
      message = decode(data.subarray(offset, end)).toString('utf8')
    }
    result.error = { code, message }
    return result
  }
  return result
}

/**
 * Extract PCM samples from a canonical 16 kHz mono PCM16 WAV recording.
 * @param {Uint8Array|Buffer} audio - wire bytes delivered by the speech service.
 * @returns {{pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number}}
 */
export function extractWavPcm(audio) {
  const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Audio must be a RIFF/WAVE recording')
  }
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(body + 2)
      sampleRate = buffer.readUInt32LE(body + 4)
      bitsPerSample = buffer.readUInt16LE(body + 14)
    } else if (id === 'data') {
      if (sampleRate !== 16000 || channels !== 1 || bitsPerSample !== 16) {
        throw new Error(`Doubao ASR requires 16 kHz mono PCM16 audio, received ${sampleRate} Hz ${channels}ch ${bitsPerSample}bit`)
      }
      return { pcm: buffer.subarray(body, body + size), sampleRate, channels, bitsPerSample }
    }
    offset = body + size + (size % 2)
  }
  throw new Error('WAVE recording has no data chunk')
}
