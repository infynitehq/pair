import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import WebSocket, { WebSocketServer } from "ws"
import {
  createIceProvider,
  type IceProvider,
  type IceConfiguration,
} from "./ice"

export interface SignalingOptions {
  iceProvider?: IceProvider
  reconnectGraceMs?: number
  iceRefreshIntervalMs?: number
  resumeWindowMs?: number
  maxResumeAttemptsPerIp?: number
  allowedOrigins?: readonly string[]
  pairingTtlMs?: number
  sessionMaxAgeMs?: number
  sweepIntervalMs?: number
  heartbeatIntervalMs?: number
  maxPayloadBytes?: number
  maxSessions?: number
  maxConnections?: number
  maxConnectionsPerIp?: number
  maxTrackedIps?: number
  rateWindowMs?: number
  maxMessagesPerWindow?: number
  creationWindowMs?: number
  maxCreationsPerIp?: number
  maxCreationsPerSocket?: number
}

interface Counter {
  startedAt: number
  count: number
}

interface Peer {
  socket: WebSocket
  ip: string
  alive: boolean
  session?: Session
  participant?: Participant
  messages: Counter
  creations: Counter
}

interface SignalPayload {
  seq: number
  iv: string
  ciphertext: string
}

interface Participant {
  id: string
  role: "host" | "guest"
  peer?: Peer
  resumeToken: string
  offlineUntil?: number
  established: boolean
  iceConfig: IceConfiguration
  lastIceRefresh: number
  nextSignalSeq: number
  deliveredMax: number
  receivedMax: number
  queue: Array<{ payload: SignalPayload; bytes: number }>
  queueBytes: number
}

interface Session {
  id: string
  host: Participant
  guest?: Participant
  joinVerifier: string
  pairingExpiresAt: number
  absoluteExpiresAt: number
  established: boolean
}

interface IpState {
  connections: number
  creations: Counter
  resumes: Counter
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)
}

function equalToken(a: string, b: string) {
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function consume(
  counter: Counter,
  now: number,
  windowMs: number,
  limit: number
) {
  if (now - counter.startedAt >= windowMs) {
    counter.startedAt = now
    counter.count = 0
  }
  if (counter.count >= limit) return false
  counter.count += 1
  return true
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Origins are exact matches. Forwarded IP headers are deliberately not trusted. */
export function createSignalingServer(options: SignalingOptions = {}) {
  const configuredOrigins =
    options.allowedOrigins ?? process.env.SIGNALING_ORIGINS?.split(",")
  if (
    process.env.NODE_ENV === "production" &&
    !configuredOrigins?.some((origin) => origin.trim())
  ) {
    throw new Error(
      "SIGNALING_ORIGINS must be explicitly configured in production"
    )
  }
  const origins = new Set(
    (configuredOrigins ?? ["http://localhost:3000", "http://127.0.0.1:3000"])
      .map((origin) => origin.trim())
      .filter(Boolean)
  )
  for (const origin of origins) {
    const url = new URL(origin)
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
      throw new Error("SIGNALING_ORIGINS must contain exact HTTP(S) origins")
    }
  }

  const limits = {
    reconnectGraceMs: options.reconnectGraceMs ?? 30_000,
    iceRefreshIntervalMs: options.iceRefreshIntervalMs ?? 10_000,
    resumeWindowMs: options.resumeWindowMs ?? 60_000,
    maxResumeAttemptsPerIp: options.maxResumeAttemptsPerIp ?? 30,
    pairingTtlMs: options.pairingTtlMs ?? 120_000,
    sessionMaxAgeMs: options.sessionMaxAgeMs ?? 7_200_000,
    sweepIntervalMs: options.sweepIntervalMs ?? 1_000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
    maxPayloadBytes: options.maxPayloadBytes ?? 64 * 1024,
    maxSessions: options.maxSessions ?? 1_000,
    maxConnections: options.maxConnections ?? 3_000,
    maxConnectionsPerIp: options.maxConnectionsPerIp ?? 30,
    maxTrackedIps: options.maxTrackedIps ?? 10_000,
    rateWindowMs: options.rateWindowMs ?? 10_000,
    maxMessagesPerWindow: options.maxMessagesPerWindow ?? 100,
    creationWindowMs: options.creationWindowMs ?? 60_000,
    maxCreationsPerIp: options.maxCreationsPerIp ?? 20,
    maxCreationsPerSocket: options.maxCreationsPerSocket ?? 5,
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Invalid ${name}`)
  }

  const sessions = new Map<string, Session>()
  const iceProvider = options.iceProvider ?? createIceProvider()
  const peers = new Map<WebSocket, Peer>()
  const ips = new Map<string, IpState>()
  const closingTimers = new Set<ReturnType<typeof setTimeout>>()
  let stopping = false

  const httpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      response.end('{"ok":true}')
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxPayloadBytes,
    perMessageDeflate: false,
  })

  function send(peer: Peer, message: Record<string, unknown>) {
    if (peer.socket.readyState !== WebSocket.OPEN) return false
    if (peer.socket.bufferedAmount > limits.maxPayloadBytes * 4) {
      peer.socket.terminate()
      return false
    }
    peer.socket.send(JSON.stringify({ ...message, v: 2 }))
    return true
  }

  function sendParticipant(
    participant: Participant | undefined,
    message: Record<string, unknown>
  ) {
    if (participant?.peer) send(participant.peer, message)
  }

  function participant(role: "host" | "guest", peer: Peer): Participant {
    const id = randomBytes(16).toString("hex")
    return {
      id,
      role,
      peer,
      resumeToken: randomBytes(32).toString("base64url"),
      established: false,
      iceConfig: iceProvider.issue(id),
      lastIceRefresh: 0,
      nextSignalSeq: 0,
      deliveredMax: -1,
      receivedMax: -1,
      queue: [],
      queueBytes: 0,
    }
  }

  function deliver(destination: Participant, payload: SignalPayload) {
    if (destination.peer?.socket.readyState !== WebSocket.OPEN) return
    if (send(destination.peer, { type: "signal", payload }))
      destination.deliveredMax = Math.max(destination.deliveredMax, payload.seq)
  }

  function expiresAt(session: Session) {
    return session.established
      ? session.absoluteExpiresAt
      : Math.min(session.pairingExpiresAt, session.absoluteExpiresAt)
  }

  function error(peer: Peer, code: string, message: string) {
    send(peer, { type: "error", code, message })
  }

  function closePeer(peer: Peer, code = 1000) {
    if (peer.socket.readyState === WebSocket.CLOSED) return
    peer.socket.close(code)
    // A client that never acknowledges close must not retain a connection forever.
    const timer = setTimeout(() => {
      closingTimers.delete(timer)
      peer.socket.terminate()
    }, 1_000)
    timer.unref()
    closingTimers.add(timer)
    peer.socket.once("close", () => {
      clearTimeout(timer)
      closingTimers.delete(timer)
    })
  }

  function dispose(
    session: Session,
    reason: "left" | "expired" | "overflow",
    departed?: Participant
  ) {
    if (!sessions.delete(session.id)) return
    for (const member of [session.host, session.guest]) {
      if (!member) continue
      member.queue = []
      member.queueBytes = 0
      const peer = member.peer
      member.peer = undefined
      if (!peer) continue
      peer.session = undefined
      peer.participant = undefined
      if (reason === "expired") {
        if (session.established) send(peer, { type: "session-retired" })
        else error(peer, "SESSION_EXPIRED", "Session expired")
      } else if (reason === "overflow")
        error(peer, "SIGNAL_QUEUE_OVERFLOW", "Signal queue capacity exceeded")
      else if (member !== departed) send(peer, { type: "peer-left" })
      closePeer(peer)
    }
  }

  function expired(session: Session, now: number) {
    return (
      now >= session.absoluteExpiresAt ||
      (!session.established && now >= session.pairingExpiresAt)
    )
  }

  function graceExpired(session: Session, now: number) {
    return [session.host, session.guest].find(
      (member) =>
        member?.offlineUntil !== undefined && now >= member.offlineUntil
    )
  }

  function sweep(now: number) {
    for (const session of sessions.values()) {
      if (expired(session, now)) dispose(session, "expired")
      else {
        const departed = graceExpired(session, now)
        if (departed) dispose(session, "left", departed)
      }
    }
    for (const [ip, state] of ips) {
      if (
        state.connections === 0 &&
        now - state.creations.startedAt >= limits.creationWindowMs &&
        now - state.resumes.startedAt >= limits.resumeWindowMs
      ) {
        ips.delete(ip)
      }
    }
  }

  httpServer.on("upgrade", (request, socket, head) => {
    const reject = (status: string) => {
      socket.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
      )
    }
    if (stopping) return reject("503 Service Unavailable")
    if (request.url !== "/signal") return reject("404 Not Found")
    if (!request.headers.origin || !origins.has(request.headers.origin))
      return reject("403 Forbidden")
    const ip = request.socket.remoteAddress ?? "unknown"
    const state = ips.get(ip)
    if (
      peers.size >= limits.maxConnections ||
      (state?.connections ?? 0) >= limits.maxConnectionsPerIp ||
      (!state && ips.size >= limits.maxTrackedIps)
    )
      return reject("429 Too Many Requests")
    webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      webSocketServer.emit("connection", ws, request)
    })
  })

  webSocketServer.on("connection", (socket, request) => {
    const now = Date.now()
    const ip = request.socket.remoteAddress ?? "unknown"
    const state = ips.get(ip) ?? {
      connections: 0,
      creations: { startedAt: now, count: 0 },
      resumes: { startedAt: now, count: 0 },
    }
    state.connections += 1
    ips.set(ip, state)
    const peer: Peer = {
      socket,
      ip,
      alive: true,
      messages: { startedAt: now, count: 0 },
      creations: { startedAt: now, count: 0 },
    }
    peers.set(socket, peer)
    socket.on("pong", () => {
      peer.alive = true
    })
    socket.on("error", () => {
      socket.terminate()
    })
    socket.on("close", () => {
      peers.delete(socket)
      state.connections -= 1
      const member = peer.participant
      if (peer.session && member?.peer === peer) {
        member.peer = undefined
        member.offlineUntil = Date.now() + limits.reconnectGraceMs
        sendParticipant(
          member === peer.session.host ? peer.session.guest : peer.session.host,
          { type: "peer-offline" }
        )
      }
    })
    socket.on("message", (data, binary) => {
      if (stopping || socket.readyState !== WebSocket.OPEN) return
      if (peer.participant && peer.participant.peer !== peer) return
      const now = Date.now()
      if (
        !consume(
          peer.messages,
          now,
          limits.rateWindowMs,
          limits.maxMessagesPerWindow
        )
      ) {
        error(peer, "RATE_LIMITED", "Message rate limit exceeded")
        if (peer.session) dispose(peer.session, "left", peer.participant)
        closePeer(peer, 1008)
        return
      }
      if (peer.session && expired(peer.session, now)) {
        dispose(peer.session, "expired")
        return
      }
      let message: unknown
      try {
        if (binary) throw new Error("Binary message")
        message = JSON.parse(data.toString())
      } catch {
        error(peer, "INVALID_MESSAGE", "Expected a JSON text message")
        return
      }
      if (
        !isObject(message) ||
        message.v !== 2 ||
        typeof message.type !== "string"
      ) {
        error(
          peer,
          "INVALID_MESSAGE",
          "Expected protocol v:2 and a command type"
        )
        return
      }
      switch (message.type) {
        case "create": {
          if (peer.session)
            return error(
              peer,
              "ALREADY_BOUND",
              "Socket already belongs to a session"
            )
          if (!isToken(message.joinVerifier))
            return error(peer, "INVALID_MESSAGE", "Invalid join verifier")
          sweep(now)
          if (sessions.size >= limits.maxSessions)
            return error(peer, "CAPACITY", "Session capacity reached")
          if (
            !consume(
              peer.creations,
              now,
              limits.creationWindowMs,
              limits.maxCreationsPerSocket
            ) ||
            !consume(
              state.creations,
              now,
              limits.creationWindowMs,
              limits.maxCreationsPerIp
            )
          )
            return error(
              peer,
              "RATE_LIMITED",
              "Session creation rate limit exceeded"
            )
          let id: string
          do {
            id = randomBytes(16).toString("hex")
          } while (sessions.has(id))
          let host: Participant
          try {
            host = participant("host", peer)
          } catch {
            return error(
              peer,
              "ICE_UNAVAILABLE",
              "ICE configuration unavailable"
            )
          }
          const session: Session = {
            id,
            host,
            joinVerifier: message.joinVerifier,
            established: false,
            pairingExpiresAt: now + limits.pairingTtlMs,
            absoluteExpiresAt: now + limits.sessionMaxAgeMs,
          }
          peer.session = session
          peer.participant = session.host
          sessions.set(id, session)
          send(peer, {
            type: "created",
            sessionId: id,
            resumeToken: session.host.resumeToken,
            iceConfig: session.host.iceConfig,
            expiresAt: Math.min(
              session.pairingExpiresAt,
              session.absoluteExpiresAt
            ),
          })
          return
        }
        case "join": {
          if (peer.session)
            return error(
              peer,
              "ALREADY_BOUND",
              "Socket already belongs to a session"
            )
          if (
            typeof message.sessionId !== "string" ||
            !/^[a-f0-9]{32}$/.test(message.sessionId) ||
            !isToken(message.joinToken)
          ) {
            return error(peer, "INVALID_MESSAGE", "Invalid session ID")
          }
          const session = sessions.get(message.sessionId)
          if (!session)
            return error(peer, "SESSION_NOT_FOUND", "Session not found")
          if (expired(session, now)) {
            dispose(session, "expired")
            return error(peer, "SESSION_EXPIRED", "Session expired")
          }
          const verifier = createHash("sha256")
            .update(message.joinToken)
            .digest("base64url")
          if (!equalToken(verifier, session.joinVerifier))
            return error(peer, "INVALID_JOIN_TOKEN", "Invalid join proof")
          const departed = graceExpired(session, now)
          if (departed) {
            dispose(session, "left", departed)
            return error(peer, "SESSION_NOT_FOUND", "Reconnect grace expired")
          }
          if (session.guest)
            return error(peer, "SESSION_FULL", "Session already has two peers")
          try {
            session.guest = participant("guest", peer)
          } catch {
            return error(
              peer,
              "ICE_UNAVAILABLE",
              "ICE configuration unavailable"
            )
          }
          peer.session = session
          peer.participant = session.guest
          send(peer, {
            type: "joined",
            sessionId: session.id,
            resumeToken: session.guest.resumeToken,
            iceConfig: session.guest.iceConfig,
            expiresAt: Math.min(
              session.pairingExpiresAt,
              session.absoluteExpiresAt
            ),
          })
          sendParticipant(session.host, { type: "peer-ready" })
          send(peer, { type: "peer-ready" })
          return
        }
        case "resume": {
          if (peer.session)
            return error(
              peer,
              "ALREADY_BOUND",
              "Socket already belongs to a session"
            )
          if (
            !consume(
              state.resumes,
              now,
              limits.resumeWindowMs,
              limits.maxResumeAttemptsPerIp
            )
          )
            return error(
              peer,
              "RATE_LIMITED",
              "Resume attempt rate limit exceeded"
            )
          if (
            typeof message.sessionId !== "string" ||
            !/^[a-f0-9]{32}$/.test(message.sessionId) ||
            (message.role !== "host" && message.role !== "guest") ||
            !isToken(message.resumeToken) ||
            !isToken(message.nextResumeToken)
          )
            return error(peer, "INVALID_MESSAGE", "Invalid resume request")
          const session = sessions.get(message.sessionId)
          if (!session)
            return error(peer, "SESSION_NOT_FOUND", "Session not found")
          if (expired(session, now)) {
            dispose(session, "expired")
            return error(peer, "SESSION_EXPIRED", "Session expired")
          }
          const member = session[message.role]
          if (!member || !equalToken(member.resumeToken, message.resumeToken))
            return error(
              peer,
              "INVALID_RESUME_TOKEN",
              "Invalid resume credentials"
            )
          if (member.peer?.socket.readyState === WebSocket.OPEN)
            return error(peer, "ROLE_ACTIVE", "Participant is already online")
          const departed = graceExpired(session, now)
          if (departed) {
            dispose(session, "left", departed)
            return error(peer, "SESSION_NOT_FOUND", "Reconnect grace expired")
          }
          if (equalToken(message.resumeToken, message.nextResumeToken))
            return error(peer, "INVALID_MESSAGE", "Resume token must rotate")
          if (
            member.iceConfig.expiresAt !== null &&
            member.iceConfig.expiresAt <= now + 30_000
          ) {
            try {
              member.iceConfig = iceProvider.issue(member.id)
              member.lastIceRefresh = now
            } catch {
              return error(
                peer,
                "ICE_UNAVAILABLE",
                "ICE configuration unavailable"
              )
            }
          }
          // Replace the binding before the old socket's close event can run.
          member.resumeToken = message.nextResumeToken
          member.peer = peer
          member.offlineUntil = undefined
          peer.participant = member
          peer.session = session
          const other = member === session.host ? session.guest : session.host
          send(peer, {
            type: "resumed",
            sessionId: session.id,
            role: member.role,
            expiresAt: expiresAt(session),
            iceConfig: member.iceConfig,
            peerOnline: other?.peer?.socket.readyState === WebSocket.OPEN,
          })
          sendParticipant(other, { type: "peer-online" })
          for (const queued of member.queue) deliver(member, queued.payload)
          return
        }
        case "ice-refresh": {
          if (
            typeof message.requestId !== "string" ||
            message.requestId.length === 0 ||
            message.requestId.length > 128
          )
            return error(peer, "INVALID_MESSAGE", "Invalid ICE request ID")
          const member = peer.participant
          if (!member)
            return error(
              peer,
              "NOT_BOUND",
              "Socket does not belong to a session"
            )
          if (now - member.lastIceRefresh < limits.iceRefreshIntervalMs) {
            send(peer, {
              type: "error",
              code: "ICE_RATE_LIMITED",
              requestId: message.requestId,
            })
            return
          }
          member.lastIceRefresh = now
          try {
            member.iceConfig = iceProvider.issue(member.id)
          } catch {
            send(peer, {
              type: "error",
              code: "ICE_UNAVAILABLE",
              requestId: message.requestId,
            })
            return
          }
          send(peer, {
            type: "ice-config",
            requestId: message.requestId,
            ...member.iceConfig,
          })
          return
        }
        case "signal-received": {
          const member = peer.participant
          if (!member)
            return error(
              peer,
              "NOT_BOUND",
              "Socket does not belong to a session"
            )
          const seq = message.seq
          if (
            typeof seq !== "number" ||
            !Number.isSafeInteger(seq) ||
            seq < 0 ||
            seq > member.deliveredMax ||
            seq < member.receivedMax
          )
            return error(
              peer,
              "SIGNAL_SEQUENCE_ERROR",
              "Invalid delivery acknowledgement"
            )
          member.receivedMax = seq
          while (member.queue.length && member.queue[0].payload.seq <= seq) {
            member.queueBytes -= member.queue.shift()!.bytes
          }
          return
        }
        case "signal": {
          if (!isObject(message.payload))
            return error(
              peer,
              "INVALID_MESSAGE",
              "Signal payload must be an object"
            )
          const session = peer.session
          if (!session)
            return error(
              peer,
              "NOT_BOUND",
              "Socket does not belong to a session"
            )
          const member = peer.participant!
          const other = session.host === member ? session.guest : session.host
          if (!other)
            return error(peer, "PEER_NOT_READY", "Waiting for another peer")
          const { seq, iv, ciphertext } = message.payload
          if (
            typeof seq !== "number" ||
            !Number.isSafeInteger(seq) ||
            seq < 0 ||
            typeof iv !== "string" ||
            typeof ciphertext !== "string"
          )
            return error(peer, "INVALID_MESSAGE", "Invalid encrypted signal")
          if (seq > member.nextSignalSeq)
            return error(peer, "SIGNAL_SEQUENCE_ERROR", "Signal sequence gap")
          if (seq < member.nextSignalSeq) {
            send(peer, { type: "signal-ack", seq })
            return
          }
          const payload = { seq, iv, ciphertext }
          const bytes = Buffer.byteLength(JSON.stringify(payload))
          if (
            other.queue.length >= 128 ||
            other.queueBytes + bytes > 1024 * 1024
          ) {
            dispose(session, "overflow")
            return
          }
          other.queue.push({ payload, bytes })
          other.queueBytes += bytes
          member.nextSignalSeq += 1
          deliver(other, payload)
          send(peer, { type: "signal-ack", seq })
          return
        }
        case "established": {
          const session = peer.session
          if (!session)
            return error(
              peer,
              "NOT_BOUND",
              "Socket does not belong to a session"
            )
          if (!session.guest)
            return error(peer, "PEER_NOT_READY", "Waiting for another peer")
          peer.participant!.established = true
          session.established =
            session.host.established && session.guest.established
          return
        }
        case "leave": {
          if (!peer.session)
            return error(
              peer,
              "NOT_BOUND",
              "Socket does not belong to a session"
            )
          dispose(peer.session, "left", peer.participant)
          return
        }
        default:
          error(peer, "INVALID_MESSAGE", "Unknown command")
      }
    })
  })

  const sweepTimer = setInterval(
    () => sweep(Date.now()),
    limits.sweepIntervalMs
  )
  const heartbeatTimer = setInterval(() => {
    for (const peer of peers.values()) {
      if (!peer.alive) {
        peer.socket.terminate()
        continue
      }
      if (peer.socket.readyState !== WebSocket.OPEN) continue
      peer.alive = false
      peer.socket.ping()
    }
  }, limits.heartbeatIntervalMs)
  sweepTimer.unref()
  heartbeatTimer.unref()

  let closePromise: Promise<void> | undefined
  return {
    httpServer,
    webSocketServer,
    listen(port = 0, host = "127.0.0.1"): Promise<AddressInfo> {
      return new Promise((resolve, reject) => {
        const onError = (cause: Error) => {
          reject(cause)
        }
        httpServer.once("error", onError)
        httpServer.listen(port, host, () => {
          httpServer.off("error", onError)
          resolve(httpServer.address() as AddressInfo)
        })
      })
    },
    close(): Promise<void> {
      if (closePromise) return closePromise
      stopping = true
      clearInterval(sweepTimer)
      clearInterval(heartbeatTimer)
      for (const timer of closingTimers) clearTimeout(timer)
      closingTimers.clear()
      sessions.clear()
      for (const peer of peers.values()) {
        peer.session = undefined
        peer.socket.terminate()
      }
      ips.clear()
      closePromise = Promise.all([
        new Promise<void>((resolve) => webSocketServer.close(() => resolve())),
        new Promise<void>((resolve, reject) => {
          if (!httpServer.listening) return resolve()
          httpServer.close((cause) => (cause ? reject(cause) : resolve()))
          httpServer.closeAllConnections()
        }),
      ]).then(() => undefined)
      return closePromise
    },
  }
}
