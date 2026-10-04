import {
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  type Event,
} from "nostr-tools/pure"
import { decode, type SealedSignal } from "./crypto"

export const NOSTR_SIGNAL_KIND = 20078 // NIP-01 ephemeral; no offline mailbox.
export const NOSTR_NAMESPACE = "pair.signaling.v1"
export type NostrStatus =
  "connecting" | "available" | "reconnecting" | "offline"
interface Options {
  urls: string[]
  secret: string
  sessionId: string
  role: "host" | "guest"
  receive: (payload: SealedSignal) => Promise<void>
  acknowledged?: (seq: number) => void
  status: (status: NostrStatus) => void
  failure: (error: Error) => void
  socket?: (url: string) => WebSocket
}
interface Relay {
  url: string
  socket?: WebSocket
  subscription: string
  ready: boolean
  attempts: number
  reconnect?: ReturnType<typeof setTimeout>
  deadline?: ReturnType<typeof setTimeout>
  queue: string[]
  writing?: ReturnType<typeof setTimeout>
}
const MAX_BYTES = 1024 * 1024
const validPayload = (payload: unknown): payload is SealedSignal => {
  if (!payload || typeof payload !== "object") return false
  const value = payload as SealedSignal
  return (
    Number.isSafeInteger(value.seq) &&
    value.seq >= 0 &&
    typeof value.iv === "string" &&
    /^[A-Za-z0-9_-]{16}$/.test(value.iv) &&
    typeof value.ciphertext === "string" &&
    /^[A-Za-z0-9_-]{22,60000}$/.test(value.ciphertext)
  )
}
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/** Signed ephemeral delivery around Pair's existing direction-specific AES-GCM ciphertext. */
export class NostrSignaling {
  private relays: Relay[]
  private closed = false
  private everReady = false
  private nextReceive = 0
  private nextSend = 0
  private pending = new Map<
    number,
    { payload: SealedSignal; sentAt: number; bytes: number }
  >()
  private incoming = new Map<number, SealedSignal>()
  private processing = false
  private ack = -1
  private ackTimer?: ReturnType<typeof setTimeout>
  private retry?: ReturnType<typeof setInterval>
  private readyResolve?: () => void
  private readyReject?: (error: Error) => void
  private readyDeadline?: ReturnType<typeof setTimeout>
  private readyPromise: Promise<void>

  static async create(options: Options) {
    if (!options.urls.length)
      throw new Error("No Nostr signaling relay configured")
    const material = await crypto.subtle.importKey(
      "raw",
      decode(options.secret),
      "HKDF",
      false,
      ["deriveBits"]
    )
    const derive = async (label: string) =>
      new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: new TextEncoder().encode(options.sessionId),
            info: new TextEncoder().encode(`${NOSTR_NAMESPACE}.${label}`),
          },
          material,
          256
        )
      )
    const [key, remoteKey, topic] = await Promise.all([
      derive(options.role),
      derive(options.role === "host" ? "guest" : "host"),
      derive("topic"),
    ])
    const remoteAuthor = getPublicKey(remoteKey)
    remoteKey.fill(0)
    return new NostrSignaling(
      { ...options, secret: "" },
      key,
      remoteAuthor,
      hex(topic)
    )
  }
  private constructor(
    private options: Options,
    private key: Uint8Array,
    private remoteAuthor: string,
    private topic: string
  ) {
    this.relays = options.urls.map((url) => ({
      url,
      subscription: crypto.randomUUID(),
      ready: false,
      attempts: 0,
      queue: [],
    }))
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    void this.readyPromise.catch(() => {})
    this.readyDeadline = setTimeout(() => {
      this.readyReject?.(
        new Error(
          "Nostr signaling relay did not accept a subscription. Check its URL and network."
        )
      )
      this.close()
    }, 10_000)
    this.options.status("connecting")
    for (const relay of this.relays) this.connect(relay)
    this.retry = setInterval(() => this.flush(), 1000)
  }
  ready() {
    return this.readyPromise
  }
  private updateStatus() {
    if (this.closed) return
    const ready = this.relays.some((relay) => relay.ready)
    this.options.status(
      ready ? "available" : this.everReady ? "reconnecting" : "connecting"
    )
    if (ready && !this.everReady) {
      this.everReady = true
      clearTimeout(this.readyDeadline)
      this.readyResolve?.()
      this.readyResolve = undefined
      this.readyReject = undefined
    }
  }
  private connect(relay: Relay) {
    if (this.closed) return
    relay.ready = false
    relay.queue = []
    let socket: WebSocket
    try {
      socket = (this.options.socket ?? ((url) => new WebSocket(url)))(relay.url)
    } catch {
      this.reconnect(relay)
      return
    }
    relay.socket = socket
    const current = () => !this.closed && relay.socket === socket
    relay.deadline = setTimeout(() => {
      if (current() && !relay.ready) socket.close()
    }, 6000)
    socket.onopen = () => {
      if (!current()) return
      // nostr-rs-relay 0.10 does not emit EOSE for limit:0. Ephemeral kinds still
      // have no stored history; a positive bounded limit acknowledges readiness.
      this.write(
        relay,
        JSON.stringify([
          "REQ",
          relay.subscription,
          {
            kinds: [NOSTR_SIGNAL_KIND],
            authors: [this.remoteAuthor],
            "#d": [this.topic],
            "#t": [NOSTR_NAMESPACE],
            since: Math.floor(Date.now() / 1000) - 120,
            limit: 128,
          },
        ])
      )
    }
    socket.onmessage = (event) => {
      if (
        !current() ||
        typeof event.data !== "string" ||
        event.data.length > 65_536
      )
        return
      try {
        const frame = JSON.parse(event.data)
        if (!Array.isArray(frame)) return
        if (frame[0] === "EOSE" && frame[1] === relay.subscription) {
          relay.ready = true
          relay.attempts = 0
          clearTimeout(relay.deadline)
          this.updateStatus()
          for (const pending of this.pending.values()) pending.sentAt = 0
          this.flush()
        } else if (frame[0] === "EVENT" && frame[1] === relay.subscription)
          this.receiveEvent(frame[2])
        else if (frame[0] === "CLOSED" && frame[1] === relay.subscription)
          socket.close()
        else if (frame[0] === "OK" && frame[2] === false) {
          // Relay acceptance is not peer delivery. A refusal never discards ciphertext.
          socket.close()
        }
      } catch {
        /* Ignore unrelated/malformed public relay traffic. */
      }
    }
    socket.onerror = () => {
      if (current()) socket.close()
    }
    socket.onclose = () => {
      if (!current()) return
      clearTimeout(relay.deadline)
      clearTimeout(relay.writing)
      relay.writing = undefined
      relay.ready = false
      relay.queue = []
      this.updateStatus()
      this.reconnect(relay)
    }
  }
  private reconnect(relay: Relay) {
    if (this.closed || relay.reconnect) return
    relay.reconnect = setTimeout(
      () => {
        relay.reconnect = undefined
        this.connect(relay)
      },
      Math.min(500 * 2 ** relay.attempts++, 10_000) + Math.random() * 200
    )
  }
  private write(relay: Relay, frame: string) {
    if (relay.socket?.readyState !== WebSocket.OPEN || this.closed) return
    if (relay.queue.length >= 64) {
      relay.socket.close()
      return
    }
    relay.queue.push(frame)
    if (relay.writing) return
    const drain = () => {
      relay.writing = undefined
      if (this.closed || relay.socket?.readyState !== WebSocket.OPEN) return
      if (relay.socket.bufferedAmount > 256 * 1024) {
        relay.socket.close()
        return
      }
      const next = relay.queue.shift()
      if (next) relay.socket.send(next)
      if (next) relay.writing = setTimeout(drain, 100)
    }
    drain()
  }
  private publish(body: Record<string, unknown>) {
    if (this.closed || !this.relays.some((relay) => relay.ready)) return
    const created_at = Math.floor(Date.now() / 1000)
    const event = finalizeEvent(
      {
        kind: NOSTR_SIGNAL_KIND,
        created_at,
        tags: [
          ["d", this.topic],
          ["t", NOSTR_NAMESPACE],
          ["expiration", String(created_at + 120)],
          ["nonce", crypto.randomUUID()],
        ],
        content: JSON.stringify(body),
      },
      this.key
    )
    const frame = JSON.stringify(["EVENT", event])
    if (frame.length > 65_536)
      throw new Error("Nostr signaling frame is too large")
    for (const relay of this.relays) if (relay.ready) this.write(relay, frame)
  }
  send(payload: SealedSignal) {
    if (this.closed || !validPayload(payload) || payload.seq !== this.nextSend)
      throw new Error("Invalid Nostr signal sequence")
    const bytes = JSON.stringify(payload).length * 2
    if (
      this.pending.size >= 128 ||
      Array.from(this.pending.values()).reduce(
        (sum, item) => sum + item.bytes,
        bytes
      ) > MAX_BYTES
    )
      throw new Error("Nostr signaling queue is full")
    this.nextSend++
    this.pending.set(payload.seq, { payload, sentAt: 0, bytes })
    this.flush()
  }
  private flush() {
    if (this.closed || !this.relays.some((relay) => relay.ready)) return
    for (const item of Array.from(this.pending.values()).slice(0, 4))
      if (Date.now() - item.sentAt >= 1500) {
        item.sentAt = Date.now()
        this.publish({ v: 1, type: "signal", payload: item.payload })
      }
  }
  private receiveEvent(event: Event) {
    const now = Math.floor(Date.now() / 1000)
    if (
      !event ||
      event.kind !== NOSTR_SIGNAL_KIND ||
      event.pubkey !== this.remoteAuthor ||
      !Number.isSafeInteger(event.created_at) ||
      event.created_at < now - 120 ||
      event.created_at > now + 30 ||
      !Array.isArray(event.tags) ||
      !event.tags.some((tag) => tag[0] === "d" && tag[1] === this.topic) ||
      !event.tags.some((tag) => tag[0] === "t" && tag[1] === NOSTR_NAMESPACE) ||
      typeof event.content !== "string" ||
      event.content.length > 62_000 ||
      !verifyEvent(event)
    )
      return
    const body = JSON.parse(event.content)
    if (body?.v !== 1) return
    if (body.type === "ack") {
      if (
        !Number.isSafeInteger(body.seq) ||
        body.seq < 0 ||
        body.seq >= this.nextSend
      )
        return
      for (const seq of this.pending.keys())
        if (seq <= body.seq) {
          this.pending.delete(seq)
          this.options.acknowledged?.(seq)
        }
      this.flush()
      return
    }
    if (body.type !== "signal" || !validPayload(body.payload)) return
    const payload: SealedSignal = body.payload
    if (payload.seq < this.nextReceive) {
      this.acknowledge()
      return
    }
    if (payload.seq > this.nextReceive + 127) {
      this.abort(new Error("Nostr receive sequence exceeded its window"))
      return
    }
    const previous = this.incoming.get(payload.seq)
    if (
      previous &&
      (previous.iv !== payload.iv || previous.ciphertext !== payload.ciphertext)
    ) {
      this.abort(new Error("Conflicting authenticated Nostr signal"))
      return
    }
    this.incoming.set(payload.seq, payload)
    if (
      Array.from(this.incoming.values()).reduce(
        (sum, item) => sum + JSON.stringify(item).length * 2,
        0
      ) > MAX_BYTES
    ) {
      this.abort(new Error("Nostr receive queue is full"))
      return
    }
    void this.process()
  }
  private async process() {
    if (this.processing || this.closed) return
    this.processing = true
    try {
      while (!this.closed && this.incoming.has(this.nextReceive)) {
        const payload = this.incoming.get(this.nextReceive)!
        await this.options.receive(payload)
        if (this.closed) return
        this.incoming.delete(this.nextReceive++)
        this.ack = this.nextReceive - 1
        this.acknowledge()
      }
    } catch (error) {
      this.abort(
        error instanceof Error ? error : new Error("Nostr signaling failed")
      )
    } finally {
      this.processing = false
    }
  }
  private acknowledge() {
    if (this.ack < 0 || this.ackTimer || this.closed) return
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined
      this.publish({ v: 1, type: "ack", seq: this.ack })
    }, 100)
  }
  private abort(error: Error) {
    this.options.failure(error)
    this.close()
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.readyReject?.(new Error("Nostr signaling cancelled"))
    this.readyReject = undefined
    clearTimeout(this.readyDeadline)
    clearTimeout(this.ackTimer)
    clearInterval(this.retry)
    for (const relay of this.relays) {
      clearTimeout(relay.reconnect)
      clearTimeout(relay.deadline)
      clearTimeout(relay.writing)
      if (relay.socket?.readyState === WebSocket.OPEN)
        relay.socket.send(JSON.stringify(["CLOSE", relay.subscription]))
      relay.socket?.close()
      relay.queue = []
    }
    this.key.fill(0)
    this.pending.clear()
    this.incoming.clear()
    this.options.status("offline")
  }
}
