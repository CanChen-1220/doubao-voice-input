/**
 * Minimal RFC 6455 WebSocket client, dependency-free.
 *
 * The DSH host runs inside Electron's Node, so `node:tls` and `node:crypto` are
 * always present, while a third-party `ws` dependency would have to survive a
 * pnpm install inside the user's profile. This client covers exactly what a
 * request/response speech socket needs: a masked binary client stream, text and
 * binary server frames, ping/pong, and close handling.
 */
import { connect as tlsConnect } from 'node:tls'
import { createHash, randomBytes } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa
const OP_CONTINUATION = 0x0

/** Encode one masked client frame. */
function encodeFrame(opcode, payload) {
  const length = payload.length
  const mask = randomBytes(4)
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  const masked = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index & 3]
  return Buffer.concat([header, mask, masked])
}

/** Raised when the server refuses the opening handshake. */
export class HandshakeError extends Error {
  /**
   * @param {string} message - short human readable summary.
   * @param {number} status - HTTP status of the refused upgrade.
   * @param {string} headers - raw response head.
   * @param {string} body - response body, which carries the server's own reason.
   */
  constructor(message, status, headers, body = '') {
    super(message)
    this.name = 'HandshakeError'
    this.status = status
    this.headers = headers
    this.detail = body.trim()
    /** Server-provided explanation parsed out of a JSON body, when present. */
    this.reason = extractReason(body)
  }
}

/** Pull a human-readable reason out of a ByteDance error envelope. */
function extractReason(body) {
  const text = (body ?? '').trim()
  if (text === '') return ''
  try {
    const parsed = JSON.parse(text)
    return String(parsed?.error ?? parsed?.header?.message ?? parsed?.message ?? '').trim()
  } catch {
    return text.slice(0, 300)
  }
}

/** One upgraded WebSocket connection, exposed as `send` plus async `next`. */
export class WebSocketClient {
  #socket
  #buffer = Buffer.alloc(0)
  #queue = []
  #waiters = []
  #failure
  #closed = false
  #fragment = null
  #fragmentOpcode = 0

  constructor(socket) {
    this.#socket = socket
    socket.on('data', (chunk) => {
      this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
      try {
        this.#drain()
      } catch (error) {
        this.#fail(error)
      }
    })
    socket.on('error', (error) => this.#fail(error))
    socket.on('close', () => this.#fail(new Error('WebSocket connection closed')))
    socket.on('end', () => this.#fail(new Error('WebSocket connection ended')))
  }

  /**
   * Open a `wss://` connection with extra handshake headers.
   * @param {string} url - absolute wss URL.
   * @param {Record<string, string>} headers - additional handshake headers.
   * @param {number} timeoutMs - handshake deadline.
   * @returns {Promise<WebSocketClient>} upgraded connection.
   */
  static connect(url, headers, timeoutMs) {
    const target = new URL(url)
    if (target.protocol !== 'wss:') throw new Error(`Unsupported WebSocket scheme: ${target.protocol}`)
    const key = randomBytes(16).toString('base64')
    const lines = [
      `GET ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${target.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ]
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || value === null || value === '') continue
      lines.push(`${name}: ${value}`)
    }
    const request = `${lines.join('\r\n')}\r\n\r\n`

    return new Promise((resolve, reject) => {
      const socket = tlsConnect({ host: target.hostname, port: Number(target.port || 443), servername: target.hostname })
      let settled = false
      let headersParsed = false
      let raw = Buffer.alloc(0)
      let refusal = null
      let refusalBody = ''
      let refusalTimer = null

      const buildRefusal = () => new HandshakeError(`WebSocket handshake rejected: ${refusal.statusLine}`, refusal.status, refusal.head, refusalBody)

      const timer = setTimeout(() => finish(new Error(`WebSocket handshake timed out after ${timeoutMs} ms`)), timeoutMs)

      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(refusalTimer)
        socket.removeListener('data', onData)
        socket.removeListener('error', onError)
        socket.removeListener('close', onClose)
        if (error) {
          reject(error)
          socket.destroy()
        } else {
          resolve(value)
        }
      }

      const onError = (error) => finish(refusal ? buildRefusal() : error)
      const onClose = () => finish(refusal ? buildRefusal() : new Error('WebSocket handshake aborted: connection closed'))

      const onData = (chunk) => {
        if (headersParsed) {
          // After a refused upgrade the body carries the server's own reason, which
          // is far more actionable than the bare status line.
          if (refusal) refusalBody += chunk.toString('utf8')
          return
        }
        raw = Buffer.concat([raw, chunk])
        const end = raw.indexOf('\r\n\r\n')
        if (end === -1) return
        headersParsed = true
        const head = raw.subarray(0, end).toString('latin1')
        const rest = raw.subarray(end + 4)
        const statusLine = head.split('\r\n')[0] ?? ''
        const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)
        const status = match ? Number(match[1]) : 0

        if (status !== 101) {
          clearTimeout(timer)
          refusal = { status, statusLine, head }
          if (rest.length > 0) refusalBody += rest.toString('utf8')
          // Wait briefly for the diagnostic body, then reject with it attached.
          refusalTimer = setTimeout(() => finish(buildRefusal()), 900)
          return
        }

        const accept = /^sec-websocket-accept:\s*(.+)$/im.exec(head)?.[1]?.trim()
        const expected = createHash('sha1').update(key + GUID).digest('base64')
        if (accept !== expected) {
          finish(new Error('WebSocket handshake failed: unexpected Sec-WebSocket-Accept'))
          return
        }
        const client = new WebSocketClient(socket)
        finish(null, client)
        if (rest.length > 0) client.pushRaw(rest)
      }

      socket.setNoDelay(true)
      socket.on('error', onError)
      socket.on('close', onClose)
      socket.on('data', onData)
      socket.once('secureConnect', () => socket.write(request))
    })
  }

  pushRaw(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    this.#drain()
  }

  #fail(error) {
    if (this.#failure || this.#closed) return
    this.#failure = error
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  #deliver(payload) {
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve(payload)
    else this.#queue.push(payload)
  }

  #drain() {
    for (;;) {
      const buffer = this.#buffer
      if (buffer.length < 2) return
      const fin = (buffer[0] & 0x80) !== 0
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      let mask = null
      if (masked) {
        if (buffer.length < offset + 4) return
        mask = buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (buffer.length < offset + length) return
      let payload = buffer.subarray(offset, offset + length)
      if (mask) {
        const unmasked = Buffer.allocUnsafe(length)
        for (let index = 0; index < length; index += 1) unmasked[index] = payload[index] ^ mask[index & 3]
        payload = unmasked
      }
      this.#buffer = buffer.subarray(offset + length)

      if (opcode === OP_CLOSE) {
        this.close()
        return
      }
      if (opcode === OP_PING) {
        this.#write(OP_PONG, payload)
        continue
      }
      if (opcode === OP_PONG) continue
      if (opcode === OP_CONTINUATION) {
        this.#fragment = this.#fragment ? Buffer.concat([this.#fragment, payload]) : payload
      } else {
        this.#fragment = payload
        this.#fragmentOpcode = opcode
      }
      if (fin) {
        const message = this.#fragment
        this.#fragment = null
        if (this.#fragmentOpcode === OP_TEXT || this.#fragmentOpcode === OP_BINARY) this.#deliver(message)
      }
    }
  }

  #write(opcode, payload) {
    if (this.#closed || this.#failure) return
    try {
      this.#socket.write(encodeFrame(opcode, payload))
    } catch (error) {
      this.#fail(error)
    }
  }

  /** Send one binary message. */
  send(payload) {
    if (this.#closed) throw new Error('WebSocket is closed')
    this.#write(OP_BINARY, Buffer.from(payload))
  }

  /** Resolve with the next message payload, or reject when the socket ends. */
  next() {
    const queued = this.#queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.#failure) return Promise.reject(this.#failure)
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
  }

  /** Close the connection; safe to call more than once. */
  close() {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#socket.write(encodeFrame(OP_CLOSE, Buffer.from([0x03, 0xe8])))
    } catch {
      // The peer may already be gone; destruction below still releases the socket.
    }
    this.#socket.end()
    this.#socket.destroy()
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error('WebSocket closed by caller'))
  }
}
