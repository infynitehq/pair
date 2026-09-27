import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import test, { type TestContext } from "node:test"
import WebSocket from "ws"
import { createSignalingServer, type SignalingOptions } from "./signaling"

const origin = "http://localhost:3000"
const joinToken = randomBytes(32).toString("base64url")
const joinVerifier = createHash("sha256").update(joinToken).digest("base64url")
const payload = { seq: 0, iv: "opaque", ciphertext: "opaque" }
interface Message {
  v: number
  type: string
  sessionId?: string
  expiresAt?: number
  code?: string
  payload?: unknown
  resumeToken?: string
  peerOnline?: boolean
  requestId?: string
  seq?: number
  iceConfig?: unknown
}

async function fixture(t: TestContext, options: SignalingOptions = {}) {
  const server = createSignalingServer({ allowedOrigins: [origin], ...options })
  t.after(() => server.close())
  const address = await server.listen()
  const base = `127.0.0.1:${address.port}`
  async function connect(autoPong = true) {
    const socket = new WebSocket(`ws://${base}/signal`, { origin, autoPong })
    const queue: Message[] = []
    const waiters: Array<(message: Message) => void> = []
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Message
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else queue.push(message)
    })
    const closed = new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code))
    )
    await once(socket, "open")
    t.after(() => socket.terminate())
    return {
      socket,
      closed,
      send(message: Record<string, unknown>) {
        socket.send(
          JSON.stringify({
            v: 2,
            ...(message.type === "create"
              ? { joinVerifier }
              : message.type === "join"
                ? { joinToken }
                : {}),
            ...message,
          })
        )
      },
      next(): Promise<Message> {
        const message = queue.shift()
        if (message) return Promise.resolve(message)
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timed out waiting for message")),
            2_000
          )
          waiters.push((message) => {
            clearTimeout(timer)
            resolve(message)
          })
        })
      },
    }
  }
  async function pair() {
    const host = await connect()
    const guest = await connect()
    host.send({ type: "create" })
    const created = await host.next()
    assert.equal(created.type, "created")
    assert.match(created.sessionId!, /^[a-f0-9]{32}$/)
    guest.send({ type: "join", sessionId: created.sessionId })
    const joined = await guest.next()
    assert.equal(joined.type, "joined")
    assert.equal(joined.sessionId, created.sessionId)
    assert.match(joined.resumeToken!, /^[A-Za-z0-9_-]{43}$/)
    assert.notEqual(joined.resumeToken, created.resumeToken)
    assert.deepEqual(await host.next(), { v: 2, type: "peer-ready" })
    assert.deepEqual(await guest.next(), { v: 2, type: "peer-ready" })
    return { host, guest, created, joined }
  }
  return { ...server, base, connect, pair }
}

test("pairs two sockets and relays opaque objects in both directions", async (t) => {
  const f = await fixture(t)
  const { host, guest, created } = await f.pair()
  assert.ok(created.expiresAt! > Date.now())
  assert.ok(created.expiresAt! <= Date.now() + 120_000)
  host.send({ type: "signal", payload })
  assert.deepEqual(await guest.next(), { v: 2, type: "signal", payload })
  assert.equal((await host.next()).type, "signal-ack")
  guest.send({ type: "signal", payload })
  assert.deepEqual(await host.next(), {
    v: 2,
    type: "signal",
    payload,
  })
  host.send({ type: "create" })
  assert.equal((await host.next()).code, "ALREADY_BOUND")
})

test("rejects a third peer and prevents unbound sockets from injecting signals", async (t) => {
  const f = await fixture(t)
  const { host, guest, created } = await f.pair()
  const third = await f.connect()
  third.send({ type: "join", sessionId: created.sessionId })
  assert.equal((await third.next()).code, "SESSION_FULL")
  third.send({ type: "signal", sessionId: created.sessionId, payload: {} })
  assert.equal((await third.next()).code, "NOT_BOUND")
  host.send({ type: "signal", payload })
  assert.deepEqual((await guest.next()).payload, payload)
})

test("expires empty sessions and reclaims capacity", async (t) => {
  const f = await fixture(t, {
    pairingTtlMs: 70,
    sweepIntervalMs: 5,
    maxSessions: 1,
  })
  const host = await f.connect()
  host.send({ type: "create" })
  const created = await host.next()
  const next = await f.connect()
  next.send({ type: "create" })
  assert.equal((await next.next()).code, "CAPACITY")
  assert.equal((await host.next()).code, "SESSION_EXPIRED")
  assert.equal(await host.closed, 1000)
  next.send({ type: "join", sessionId: created.sessionId })
  assert.equal((await next.next()).code, "SESSION_NOT_FOUND")
  next.send({ type: "create" })
  assert.equal((await next.next()).type, "created")
})

test("both peers must establish to disable pairing expiry", async (t) => {
  const f = await fixture(t, { pairingTtlMs: 120, sweepIntervalMs: 5 })
  const { host, guest } = await f.pair()
  host.send({ type: "established" })
  assert.equal((await host.next()).code, "SESSION_EXPIRED")
  assert.equal((await guest.next()).code, "SESSION_EXPIRED")
})

test("established sessions survive pairing expiry but respect absolute maximum age", async (t) => {
  const f = await fixture(t, {
    pairingTtlMs: 150,
    sessionMaxAgeMs: 450,
    sweepIntervalMs: 5,
  })
  const { host, guest } = await f.pair()
  host.send({ type: "established" })
  guest.send({ type: "established" })
  await delay(200)
  host.send({ type: "signal", payload })
  assert.deepEqual((await guest.next()).payload, payload)
  assert.equal((await host.next()).type, "signal-ack")
  assert.equal((await host.next()).type, "session-retired")
  assert.equal((await guest.next()).type, "session-retired")
})

for (const action of ["leave", "disconnect"] as const) {
  test(`${action} notifies the other peer and removes the session`, async (t) => {
    const f = await fixture(t, { reconnectGraceMs: 40, sweepIntervalMs: 5 })
    const { host, guest, created } = await f.pair()
    if (action === "leave") host.send({ type: "leave" })
    else host.socket.terminate()
    if (action === "disconnect")
      assert.deepEqual(await guest.next(), { v: 2, type: "peer-offline" })
    assert.deepEqual(await guest.next(), { v: 2, type: "peer-left" })
    assert.equal(await guest.closed, 1000)
    const third = await f.connect()
    third.send({ type: "join", sessionId: created.sessionId })
    assert.equal((await third.next()).code, "SESSION_NOT_FOUND")
  })
}

test("invalid JSON, versions, commands, binary messages and non-object payloads are rejected", async (t) => {
  const f = await fixture(t)
  const peer = await f.connect()
  for (const invalid of [
    "{",
    "null",
    "[]",
    '{"v":2,"type":"create"}',
    '{"v":1,"type":"wat"}',
    '{"v":1,"type":"join","sessionId":"bad"}',
  ]) {
    peer.socket.send(invalid)
    assert.equal((await peer.next()).code, "INVALID_MESSAGE")
  }
  peer.socket.send(Buffer.from('{"v":1,"type":"create"}'))
  assert.equal((await peer.next()).code, "INVALID_MESSAGE")
  for (const payload of [null, [], "ciphertext", 1]) {
    peer.send({ type: "signal", payload })
    assert.equal((await peer.next()).code, "INVALID_MESSAGE")
  }
  peer.send({ type: "create" })
  assert.equal((await peer.next()).type, "created")
})

test("rejects unknown/missing origins and wrong websocket paths; exposes health", async (t) => {
  const f = await fixture(t)
  for (const [path, requestedOrigin, status] of [
    ["/signal", "https://untrusted.example", 403],
    ["/signal", undefined, 403],
    ["/wrong", origin, 404],
  ] as const) {
    const socket = new WebSocket(`ws://${f.base}${path}`, {
      origin: requestedOrigin,
    })
    const result = await new Promise<number>((resolve, reject) => {
      socket.on("error", () => {})
      socket.once("open", () => {
        socket.terminate()
        reject(new Error("Unexpected upgrade"))
      })
      socket.once("unexpected-response", (_request, response) => {
        response.resume()
        socket.terminate()
        resolve(response.statusCode!)
      })
    })
    assert.equal(result, status)
  }
  const response = await fetch(`http://${f.base}/health`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
})

test("bounds message rates and creation attempts across sockets sharing an IP", async (t) => {
  const f = await fixture(t, { maxCreationsPerIp: 1, maxMessagesPerWindow: 2 })
  const first = await f.connect()
  first.send({ type: "create" })
  assert.equal((await first.next()).type, "created")
  first.send({ type: "leave" })
  await first.closed
  const second = await f.connect()
  second.send({ type: "create" })
  assert.equal((await second.next()).code, "RATE_LIMITED")
  second.send({ type: "leave" })
  assert.equal((await second.next()).code, "NOT_BOUND")
  second.send({ type: "create" })
  assert.equal((await second.next()).code, "RATE_LIMITED")
  assert.equal(await second.closed, 1008)
})

test("oversized frames are closed and the paired socket is notified", async (t) => {
  const f = await fixture(t, { maxPayloadBytes: 512 })
  const { host, guest } = await f.pair()
  host.send({ type: "signal", payload: { ciphertext: "x".repeat(512) } })
  assert.equal(await host.closed, 1009)
  assert.deepEqual(await guest.next(), { v: 2, type: "peer-offline" })
})

test(
  "heartbeat terminates unresponsive sockets and disposes their sessions",
  { timeout: 2_000 },
  async (t) => {
    const f = await fixture(t, { heartbeatIntervalMs: 20 })
    const host = await f.connect(false)
    const guest = await f.connect()
    host.send({ type: "create" })
    const created = await host.next()
    guest.send({ type: "join", sessionId: created.sessionId })
    assert.equal((await guest.next()).type, "joined")
    assert.equal((await guest.next()).type, "peer-ready")
    assert.equal((await host.next()).type, "peer-ready")
    assert.equal(await host.closed, 1006)
    assert.deepEqual(await guest.next(), { v: 2, type: "peer-offline" })
  }
)

test("join proof and admitted ICE refresh are required before credential issuance", async (t) => {
  const ids: string[] = []
  const f = await fixture(t, {
    iceProvider: {
      issue(id) {
        ids.push(id)
        return {
          iceServers: [{ urls: ["stun:example.org"] }],
          expiresAt: null,
          relayAvailable: false,
        }
      },
    },
  })
  const host = await f.connect()
  const guest = await f.connect()
  host.send({ type: "create", joinVerifier: undefined })
  assert.equal((await host.next()).code, "INVALID_MESSAGE")
  guest.send({ type: "ice-refresh", requestId: "unbound" })
  assert.equal((await guest.next()).code, "NOT_BOUND")
  assert.equal(ids.length, 0)
  host.send({ type: "create" })
  const created = await host.next()
  guest.send({
    type: "join",
    sessionId: created.sessionId,
    joinToken: randomBytes(32).toString("base64url"),
  })
  assert.equal((await guest.next()).code, "INVALID_JOIN_TOKEN")
  assert.equal(ids.length, 1)
  guest.send({ type: "join", sessionId: created.sessionId })
  assert.equal((await guest.next()).type, "joined")
  await guest.next()
  await host.next()
  assert.equal(ids.length, 2)
  host.send({ type: "ice-refresh", requestId: "refresh" })
  assert.equal((await host.next()).requestId, "refresh")
  assert.equal(ids[0], ids[2])
  host.send({ type: "ice-refresh", requestId: "limited" })
  assert.deepEqual(await host.next(), {
    v: 2,
    type: "error",
    code: "ICE_RATE_LIMITED",
    requestId: "limited",
  })
  assert.equal(ids.length, 3)
})

test("resume authenticates roles, rejects live takeover, rotates tokens and ignores old socket events", async (t) => {
  const f = await fixture(t)
  const { host, guest, created, joined } = await f.pair()
  const replacement = await f.connect()
  const nextResumeToken = randomBytes(32).toString("base64url")
  const resume = {
    type: "resume",
    sessionId: created.sessionId,
    role: "host",
    resumeToken: created.resumeToken,
    nextResumeToken,
  }
  replacement.send({ ...resume, resumeToken: joined.resumeToken })
  assert.equal((await replacement.next()).code, "INVALID_RESUME_TOKEN")
  replacement.send(resume)
  assert.equal((await replacement.next()).code, "ROLE_ACTIVE")
  const oldServerSocket = [...f.webSocketServer.clients][0]
  host.socket.terminate()
  assert.equal((await guest.next()).type, "peer-offline")
  replacement.send(resume)
  const resumed = await replacement.next()
  assert.equal(resumed.type, "resumed")
  assert.equal(resumed.peerOnline, true)
  assert.equal((await guest.next()).type, "peer-online")
  oldServerSocket.emit(
    "message",
    Buffer.from(JSON.stringify({ v: 2, type: "leave" })),
    false
  )
  replacement.send({ type: "signal", payload })
  assert.equal((await replacement.next()).type, "signal-ack")
  assert.deepEqual((await guest.next()).payload, payload)
  replacement.socket.terminate()
  assert.equal((await guest.next()).type, "peer-offline")
  const again = await f.connect()
  again.send(resume)
  assert.equal((await again.next()).code, "INVALID_RESUME_TOKEN")
  again.send({
    ...resume,
    resumeToken: nextResumeToken,
    nextResumeToken: randomBytes(32).toString("base64url"),
  })
  assert.equal((await again.next()).type, "resumed")
  assert.equal((await guest.next()).type, "peer-online")
  again.send({ type: "signal", payload: { ...payload, seq: 1 } })
  assert.equal((await again.next()).seq, 1)
  assert.deepEqual((await guest.next()).payload, { ...payload, seq: 1 })
})

test("queued ciphertext replays in order until delivered acknowledgements, duplicates only ack", async (t) => {
  const f = await fixture(t)
  const { host, guest, created, joined } = await f.pair()
  host.send({ type: "signal", payload: { ...payload, seq: 1 } })
  assert.equal((await host.next()).code, "SIGNAL_SEQUENCE_ERROR")
  guest.send({ type: "signal-received", seq: 0 })
  assert.equal((await guest.next()).code, "SIGNAL_SEQUENCE_ERROR")
  guest.socket.terminate()
  assert.equal((await host.next()).type, "peer-offline")
  for (const seq of [0, 0, 1]) {
    host.send({ type: "signal", payload: { ...payload, seq } })
    assert.deepEqual(await host.next(), { v: 2, type: "signal-ack", seq })
  }
  const replacement = await f.connect()
  const token = randomBytes(32).toString("base64url")
  replacement.send({
    type: "resume",
    sessionId: created.sessionId,
    role: "guest",
    resumeToken: joined.resumeToken,
    nextResumeToken: token,
  })
  assert.equal((await replacement.next()).type, "resumed")
  assert.equal((await host.next()).type, "peer-online")
  for (const seq of [0, 1])
    assert.deepEqual((await replacement.next()).payload, { ...payload, seq })
  replacement.send({ type: "signal-received", seq: 0 })
  replacement.send({ type: "signal-received", seq: 2 })
  assert.equal((await replacement.next()).code, "SIGNAL_SEQUENCE_ERROR")
  replacement.socket.terminate()
  assert.equal((await host.next()).type, "peer-offline")
  const again = await f.connect()
  again.send({
    type: "resume",
    sessionId: created.sessionId,
    role: "guest",
    resumeToken: token,
    nextResumeToken: randomBytes(32).toString("base64url"),
  })
  assert.equal((await again.next()).type, "resumed")
  assert.deepEqual((await again.next()).payload, { ...payload, seq: 1 })
})

test("resume attempts are bounded across sockets sharing an IP", async (t) => {
  const f = await fixture(t, { maxResumeAttemptsPerIp: 1 })
  const first = await f.connect()
  first.send({ type: "resume" })
  assert.equal((await first.next()).code, "INVALID_MESSAGE")
  const second = await f.connect()
  second.send({ type: "resume" })
  assert.equal((await second.next()).code, "RATE_LIMITED")
})

test("signal replay queue overflow terminates the session", async (t) => {
  const f = await fixture(t, { maxMessagesPerWindow: 200 })
  const { host, guest } = await f.pair()
  guest.socket.terminate()
  assert.equal((await host.next()).type, "peer-offline")
  for (let seq = 0; seq < 128; seq++) {
    host.send({ type: "signal", payload: { ...payload, seq } })
    assert.equal((await host.next()).type, "signal-ack")
  }
  host.send({ type: "signal", payload: { ...payload, seq: 128 } })
  assert.equal((await host.next()).code, "SIGNAL_QUEUE_OVERFLOW")
  await host.closed
})

test("production refuses to start without explicit allowed origins", async () => {
  const env: Record<string, string | undefined> = process.env
  const previousNodeEnv = env.NODE_ENV
  const previousOrigins = env.SIGNALING_ORIGINS
  try {
    env.NODE_ENV = "production"
    delete env.SIGNALING_ORIGINS
    assert.throws(() => createSignalingServer(), /explicitly configured/)
    assert.throws(
      () => createSignalingServer({ allowedOrigins: [] }),
      /explicitly configured/
    )
    const server = createSignalingServer({ allowedOrigins: [origin] })
    await server.close()
  } finally {
    if (previousNodeEnv === undefined) delete env.NODE_ENV
    else env.NODE_ENV = previousNodeEnv
    if (previousOrigins === undefined) delete env.SIGNALING_ORIGINS
    else env.SIGNALING_ORIGINS = previousOrigins
  }
})
