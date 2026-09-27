import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import {
  generateIdentity,
  SignalCipher,
  signDescription,
  type DeviceIdentity,
  type SealedSignal,
} from "./crypto"
import { ConnectionError, type IceConfiguration } from "./connectivity"
import { PeerSession } from "./session"

class MockSocket {
  static OPEN = 1
  readyState = 0
  sent: Array<Record<string, unknown>> = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null

  open() {
    this.readyState = MockSocket.OPEN
    this.onopen?.()
  }

  send(data: string) {
    assert.equal(this.readyState, MockSocket.OPEN)
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3
    // Browser close/error events are asynchronous; tests deliver them explicitly.
  }

  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ v: 2, ...message }) })
  }
}

class MockChannel {
  readyState = "open"
  bufferedAmount = 0
  sent: Array<Record<string, unknown>> = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null

  constructor(readonly label: string) {}

  send(data: string) {
    assert.equal(this.readyState, "open")
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = "closed"
  }

  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ v: 2, ...message }) })
  }
}

// Narrow fixture controls for transport transitions; wire messages still exercise
// installed handlers, encryption, ordered queues, and session cleanup.
interface SessionTransport {
  attachChannel(channel: RTCDataChannel): void
  receiveQueue: Promise<void>
  sendQueue: Promise<void>
  generation: number
  sessionId: string
  negotiation: number
  remoteNegotiation: number
  transport: "initial" | "restart" | "replace"
  peer: RTCPeerConnection | null
  ice: IceConfiguration
  cipher: SignalCipher | null
  receivePayload(value: unknown, generation: number): Promise<void>
  sendSignal(value: unknown): void
  enterRecovery(): void
  finishRecovery(): void
  remoteMode: "automatic" | "direct" | "relay" | null
  localPolicySent: boolean
  refresh: unknown | null
  resumeTokens: string[]
  reconnectAttempts: number
  activeRoleUntil: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  requestResume(tokens: string[]): void
  scheduleResume(): void
}

class MockPeer {
  remoteDescription: RTCSessionDescriptionInit | null = null
  connectionState = "connecting"
  signalingState = "stable"
  constructor(public configuration: RTCConfiguration) {}
  createDataChannel(label: string) {
    return new MockChannel(label)
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0\r\n" }
  }
  async createAnswer() {
    return { type: "answer", sdp: "v=0\r\n" }
  }
  async setLocalDescription() {}
  async setRemoteDescription(value: RTCSessionDescriptionInit) {
    this.remoteDescription = value
  }
  setConfiguration(value: RTCConfiguration) {
    this.configuration = value
  }
  async getStats() {
    return new Map()
  }
  close() {}
}

function relayIce(expiresAt = Date.now() + 120_000): IceConfiguration {
  return {
    iceServers: [
      {
        urls: ["stun:example:3478", "turn:example:3478"],
        username: "temporary",
        credential: "password",
      },
    ],
    relayAvailable: true,
    expiresAt,
  }
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail("Timed out waiting for asynchronous session work")
}

async function fixture(t: TestContext) {
  const identity = await generateIdentity()
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const sockets: MockSocket[] = []
  const session = new PeerSession(identity, "Test browser", () => {})
  const transport = session as unknown as SessionTransport

  function replaceGlobal(name: string, descriptor: PropertyDescriptor) {
    if (!saved.has(name))
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      ...descriptor,
    })
  }

  t.after(() => {
    try {
      session.dispose()
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  })

  replaceGlobal("window", {
    value: {
      location: {
        href: "http://localhost:3000/",
        origin: "http://localhost:3000",
      },
    },
  })
  replaceGlobal("WebSocket", {
    value: class extends MockSocket {
      constructor() {
        super()
        sockets.push(this)
      }
    },
  })

  function channels() {
    const control = new MockChannel("control")
    const chat = new MockChannel("chat")
    transport.attachChannel(control as unknown as RTCDataChannel)
    transport.attachChannel(chat as unknown as RTCDataChannel)
    return { control, chat }
  }

  function establish(peerId = "verified-peer") {
    const attached = channels()
    session.state = {
      ...session.state,
      status: "connecting",
      peerId,
      verificationCode: "ABCD 1234 5678",
    }
    attached.chat.onopen?.()
    attached.chat.receive({ type: "session.approve" })
    session.approve()
    assert.equal(session.state.status, "connected")
    attached.chat.sent.length = 0
    return attached
  }

  async function create() {
    const index = sockets.length
    const pending = session.create()
    const socket = await eventually(() => sockets[index])
    socket.open()
    await pending
    return socket
  }

  async function created() {
    const socket = await create()
    socket.receive({
      type: "created",
      sessionId: "test-session-1234567890",
      expiresAt: Date.now() + 60_000,
      resumeToken: "r".repeat(43),
      iceConfig: { iceServers: [], relayAvailable: false, expiresAt: null },
    })
    await transport.receiveQueue
    assert.equal(session.state.status, "waiting")
    return socket
  }

  async function joined() {
    const secret = "s".repeat(43)
    const sessionId = "test-session-1234567890"
    const pending = session.join(
      `http://localhost:3000/?pair=${sessionId}#${secret}`
    )
    const socket = await eventually(() => sockets[0])
    socket.open()
    await pending
    socket.receive({
      type: "joined",
      sessionId,
      expiresAt: Date.now() + 60_000,
      resumeToken: "r".repeat(43),
      iceConfig: relayIce(),
    })
    await transport.receiveQueue
    return {
      socket,
      remote: await SignalCipher.create(secret, sessionId, "host"),
    }
  }

  function mockPeers() {
    const peers: MockPeer[] = []
    replaceGlobal("RTCPeerConnection", {
      value: class extends MockPeer {
        constructor(config: RTCConfiguration) {
          super(config)
          peers.push(this)
        }
      },
    })
    return peers
  }

  return {
    session,
    transport,
    sockets,
    channels,
    establish,
    create,
    created,
    joined,
    mockPeers,
    replaceGlobal,
  }
}

test("a cancelled socket's late error cannot dispose a replacement session", async (t) => {
  const { session, sockets } = await fixture(t)
  const first = session.create()
  const cancelled = await eventually(() => sockets[0])
  session.disconnect()
  const replacement = session.create()
  const current = await eventually(() => sockets[1])

  cancelled.onerror?.()
  await first
  // Settle the replacement even if a regression already closed its socket.
  if (current.readyState === 0) current.open()
  else current.onerror?.()
  await replacement

  assert.equal(session.state.status, "creating")
  assert.equal(current.readyState, MockSocket.OPEN)
  assert.equal(current.sent.length, 1)
  assert.equal(current.sent[0].v, 2)
  assert.equal(current.sent[0].type, "create")
  assert.match(String(current.sent[0].joinVerifier), /^[A-Za-z0-9_-]{43}$/)
  assert.equal(session.state.error, null)
})

test("cancelling after socket open but before the create continuation sends nothing", async (t) => {
  const { session, sockets } = await fixture(t)
  const pending = session.create()
  const socket = await eventually(() => sockets[0])
  socket.open()
  session.disconnect()
  await pending

  assert.equal(session.state.status, "closed")
  assert.equal(session.state.error, null)
  assert.equal(
    sockets[0].sent.some((message) => message.type === "create"),
    false
  )
})

test("signaling expiry and closure leave established chat usable", async (t) => {
  const { session, transport, create, establish } = await fixture(t)
  const socket = await create()
  const { control, chat } = establish()

  socket.receive({
    type: "error",
    code: "SESSION_EXPIRED",
    message: "Session expired",
  })
  await transport.receiveQueue
  socket.close()
  socket.onclose?.()

  assert.equal(session.state.status, "connected")
  assert.equal(chat.readyState, "open")
  assert.equal(control.readyState, "open")
  session.sendText("Still connected")
  chat.receive({ type: "chat.message", id: "remote-1", text: "Me too" })
  assert.deepEqual(
    session.state.messages.map((message) => message.text),
    ["Still connected", "Me too"]
  )
  assert.equal(chat.sent[0].type, "chat.message")
  assert.deepEqual(control.sent, [
    { v: 2, type: "chat.receipt", id: "remote-1" },
  ])
})

for (const [approved, peerApproved] of [
  [false, false],
  [true, false],
  [false, true],
]) {
  test(`application data is rejected without mutual approval (local=${approved}, remote=${peerApproved})`, async (t) => {
    const { session, channels } = await fixture(t)
    const { control, chat } = channels()
    session.state = {
      ...session.state,
      status: "verifying",
      peerId: "verified-peer",
      verificationCode: "ABCD 1234 5678",
      approved,
      peerApproved,
    }

    assert.throws(() => session.sendText("Must not send"))
    assert.deepEqual(chat.sent, [])
    chat.receive({
      type: "chat.message",
      id: "too-early",
      text: "Must not display",
    })

    assert.equal(session.state.status, "error")
    assert.deepEqual(session.state.messages, [])
    assert.deepEqual(control.sent, [])
    assert.equal(chat.readyState, "closed")
  })
}

test("local approval precedes the first text on the same chat stream", async (t) => {
  const { session, channels } = await fixture(t)
  const { control, chat } = channels()
  session.state = {
    ...session.state,
    status: "connecting",
    peerId: "verified-peer",
    verificationCode: "ABCD 1234 5678",
    peerApproved: true,
  }
  chat.onopen?.()
  assert.equal(session.state.status, "verifying")

  session.approve()
  session.sendText("First message")

  assert.equal(session.state.status, "connected")
  assert.deepEqual(
    chat.sent.map((message) => message.type),
    ["session.approve", "chat.message"]
  )
  assert.equal(chat.sent[1].text, "First message")
  assert.deepEqual(control.sent, [])
})

test("authenticated peer approval can precede the diagnostic code without bypassing local approval", async (t) => {
  const { session, channels } = await fixture(t)
  const { chat } = channels()
  session.state = {
    ...session.state,
    status: "connecting",
    peerId: "verified-peer",
  }

  chat.receive({ type: "session.approve" })

  assert.equal(session.state.peerApproved, true)
  assert.equal(session.state.approved, false)
  assert.equal(session.state.status, "connecting")
  assert.equal(session.state.verificationCode, null)
  session.approve()
  assert.throws(() => session.sendText("Too early"))
  assert.equal(chat.sent.length, 0)

  session.state = { ...session.state, verificationCode: "ABCD 1234 5678" }
  chat.onopen?.()
  assert.equal(session.state.status, "verifying")
  session.approve()
  assert.equal(session.state.status, "connected")
  assert.equal(chat.sent[0].type, "session.approve")
})

test("peer approval before identity verification is rejected", async (t) => {
  const { session, channels } = await fixture(t)
  const { chat } = channels()
  session.state = { ...session.state, status: "connecting" }
  chat.receive({ type: "session.approve" })
  assert.equal(session.state.status, "error")
  assert.equal(session.state.peerApproved, false)
})

for (const failure of ["access denied", "quota exceeded"]) {
  test(`optional name persistence tolerates localStorage ${failure}`, async (t) => {
    const { session, sockets, replaceGlobal } = await fixture(t)
    if (failure === "access denied") {
      replaceGlobal("localStorage", {
        get() {
          throw new Error("Storage access denied")
        },
      })
    } else {
      replaceGlobal("localStorage", {
        value: {
          setItem() {
            throw new Error("Quota exceeded")
          },
        },
      })
    }

    assert.doesNotThrow(() => session.setName("  In-memory name  "))
    assert.equal(session.state.deviceName, "In-memory name")
    const pending = session.create()
    const socket = await eventually(() => sockets[0])
    socket.open()
    await pending
    assert.equal(session.state.status, "creating")
    assert.equal(session.state.deviceName, "In-memory name")
    assert.equal(session.state.error, null)
  })
}

async function description(
  identity: DeviceIdentity,
  sessionId: string,
  negotiation: number
) {
  return signDescription(identity, {
    kind: "description",
    v: 2,
    sessionId,
    role: "guest",
    name: "Remote device",
    publicKey: identity.publicKey,
    sdp: "v=0\r\na=ice-ufrag:current\r\n",
    negotiation,
    transport: negotiation === 0 ? "initial" : "restart",
    mode: "automatic",
  })
}

test("authenticated policy precedes ICE and automatic honors the peer's direct-only policy", async (t) => {
  const { session, transport, created, mockPeers } = await fixture(t)
  const peers = mockPeers()
  const socket = await created()
  const secret = new URL(session.state.pairingLink!).hash.slice(1)
  const remote = await SignalCipher.create(secret, transport.sessionId, "guest")
  transport.ice = relayIce()
  socket.receive({ type: "peer-ready" })
  await transport.receiveQueue
  await transport.sendQueue
  assert.equal(peers.length, 0)
  assert.deepEqual(
    await remote.open(
      socket.sent.find((message) => message.type === "signal")!
        .payload as SealedSignal
    ),
    { kind: "policy", mode: "automatic" }
  )
  socket.receive({
    type: "signal",
    payload: await remote.seal({ kind: "policy", mode: "direct" }),
  })
  await transport.receiveQueue
  assert.equal(peers.length, 1)
  assert.equal(session.state.mode, "automatic")
  assert.deepEqual(
    peers[0].configuration.iceServers?.map((server) => server.urls),
    [["stun:example:3478"]]
  )
  assert.equal(session.state.error, null)

  const identity = await generateIdentity()
  // A valid signature cannot override the already authenticated policy.
  socket.receive({
    type: "signal",
    payload: await remote.seal(
      await description(identity, transport.sessionId, 0)
    ),
  })
  await transport.receiveQueue
  assert.equal(session.state.errorCode, "authentication-failed")
  assert.equal(peers[0].remoteDescription, null)
})

for (const mode of ["direct", "relay"] as const) {
  test(`${mode} rejects an authenticated incompatible policy before creating ICE transport`, async (t) => {
    const { session, transport, create, mockPeers } = await fixture(t)
    const peers = mockPeers()
    session.setMode(mode)
    const socket = await create()
    socket.receive({
      type: "created",
      sessionId: "test-session-1234567890",
      expiresAt: Date.now() + 60_000,
      resumeToken: "r".repeat(43),
      iceConfig: relayIce(),
    })
    await transport.receiveQueue
    const remote = await SignalCipher.create(
      new URL(session.state.pairingLink!).hash.slice(1),
      transport.sessionId,
      "guest"
    )
    socket.receive({ type: "peer-ready" })
    await transport.receiveQueue
    assert.equal(peers.length, 0)
    socket.receive({
      type: "signal",
      payload: await remote.seal({
        kind: "policy",
        mode: mode === "direct" ? "relay" : "direct",
      }),
    })
    await transport.receiveQueue
    assert.equal(peers.length, 0)
    assert.equal(session.state.errorCode, "direct-unavailable")
    assert.match(session.state.error!, /modes conflict/i)
  })
}

test("initial pairing refreshes near-expiry credentials before creating a peer", async (t) => {
  const { session, transport, created, mockPeers } = await fixture(t)
  const peers = mockPeers()
  const socket = await created()
  const remote = await SignalCipher.create(
    new URL(session.state.pairingLink!).hash.slice(1),
    transport.sessionId,
    "guest"
  )
  transport.ice = relayIce(Date.now() + 1_000)
  socket.receive({ type: "peer-ready" })
  await transport.receiveQueue
  socket.receive({
    type: "signal",
    payload: await remote.seal({ kind: "policy", mode: "automatic" }),
  })
  const request = await eventually(() =>
    socket.sent.find((message) => message.type === "ice-refresh")
  )
  assert.equal(peers.length, 0)
  const fresh = relayIce()
  fresh.iceServers[0].credential = "refreshed-password"
  socket.receive({ type: "ice-config", requestId: request.requestId, ...fresh })
  await eventually(() => peers[0])
  await transport.receiveQueue
  assert.deepEqual(peers[0].configuration.iceServers, fresh.iceServers)
  assert.equal(session.state.error, null)
})

test("guest recovery refresh resumes outside the blocked description queue after socket loss", async (t) => {
  const { session, transport, sockets, joined, establish } = await fixture(t)
  const { socket, remote } = await joined()
  const identity = await generateIdentity()
  const peer = new MockPeer({ iceServers: [] })
  transport.peer = peer as unknown as RTCPeerConnection
  transport.remoteMode = "automatic"
  establish(identity.deviceId)
  transport.ice = relayIce(Date.now() + 1_000)
  const offer = await signDescription(identity, {
    kind: "description",
    v: 2,
    sessionId: transport.sessionId,
    role: "host",
    name: "Host",
    publicKey: identity.publicKey,
    sdp: "v=0\r\na=ice-ufrag:recovered\r\n",
    negotiation: 1,
    transport: "restart",
    mode: "automatic",
  })
  socket.receive({ type: "signal", payload: await remote.seal(offer) })
  await eventually(() =>
    socket.sent.find((message) => message.type === "ice-refresh")
  )
  let processed = false
  void transport.receiveQueue.then(() => {
    processed = true
  })
  assert.equal(Boolean(peer.remoteDescription), false)
  socket.close()
  socket.onclose?.()
  const resumed = await eventually(() => sockets[1])
  resumed.open()
  await eventually(() =>
    resumed.sent.find((message) => message.type === "resume")
  )
  assert.equal(processed, false)
  const fresh = relayIce()
  resumed.receive({
    type: "resumed",
    sessionId: transport.sessionId,
    role: "guest",
    peerOnline: true,
    iceConfig: fresh,
  })
  await eventually(() => (processed ? true : undefined))
  assert.equal(transport.refresh, null)
  assert.equal(peer.remoteDescription?.sdp, offer.sdp)
  assert.deepEqual(peer.configuration.iceServers, fresh.iceServers)
  assert.equal(transport.remoteNegotiation, 1)
  assert.equal(session.state.signalingStatus, "available")
  assert.equal(session.state.error, null)
  await transport.sendQueue
  assert.equal(
    resumed.sent.some(
      (message) => message.type === "signal-received" && message.seq === 0
    ),
    true
  )
})

test("ROLE_ACTIVE preserves the accepted token and retries beyond the ordinary limit within a fixed deadline", async (t) => {
  const { session, transport, created, establish } = await fixture(t)
  const socket = await created()
  establish()
  const accepted = transport.resumeTokens[0]
  let until = 0
  for (let attempt = 0; attempt < 6; attempt++) {
    socket.open()
    transport.requestResume([...transport.resumeTokens])
    const request = socket.sent.at(-1)!
    assert.equal(request.resumeToken, accepted)
    assert.notEqual(request.nextResumeToken, accepted)
    socket.receive({ type: "error", code: "ROLE_ACTIVE" })
    assert.deepEqual(transport.resumeTokens, [accepted])
    if (!until) {
      until = transport.activeRoleUntil
      assert.ok(until > Date.now() && until <= Date.now() + 65_000)
    }
    assert.equal(transport.activeRoleUntil, until)
  }
  transport.reconnectAttempts = 5
  socket.onclose?.()
  assert.equal(session.state.signalingStatus, "reconnecting")
  assert.ok(transport.reconnectTimer)
  clearTimeout(transport.reconnectTimer)
  transport.reconnectTimer = null
  t.mock.method(Date, "now", () => until + 1)
  transport.scheduleResume()
  assert.equal(session.state.signalingStatus, "retired")
  assert.equal(transport.reconnectTimer, null)
  assert.equal(session.state.status, "connected")
})

test("an admitted guest resumed with an offline host initializes policy and accepts replayed signaling", async (t) => {
  const { session, transport, sockets, joined, mockPeers } = await fixture(t)
  const peers = mockPeers()
  const { socket, remote } = await joined()
  const identity = await generateIdentity()
  const policy = await remote.seal({ kind: "policy", mode: "automatic" })
  const offer = await remote.seal(
    await signDescription(identity, {
      kind: "description",
      v: 2,
      sessionId: transport.sessionId,
      role: "host",
      name: "Offline host",
      publicKey: identity.publicKey,
      sdp: "v=0\r\n",
      negotiation: 0,
      transport: "initial",
      mode: "automatic",
    })
  )
  socket.close()
  socket.onclose?.()
  const resumed = await eventually(() => sockets[1])
  resumed.open()
  await eventually(() =>
    resumed.sent.find((message) => message.type === "resume")
  )
  resumed.receive({
    type: "resumed",
    sessionId: transport.sessionId,
    role: "guest",
    peerOnline: false,
    iceConfig: relayIce(),
  })
  await transport.sendQueue
  assert.equal(transport.localPolicySent, true)
  assert.equal(peers.length, 0)
  assert.deepEqual(
    await remote.open(
      resumed.sent.find((message) => message.type === "signal")!
        .payload as SealedSignal
    ),
    { kind: "policy", mode: "automatic" }
  )
  resumed.receive({ type: "signal", payload: policy })
  resumed.receive({ type: "signal", payload: offer })
  await transport.receiveQueue
  await transport.sendQueue
  assert.equal(peers.length, 1)
  assert.equal(peers[0].remoteDescription?.type, "offer")
  assert.equal(session.state.peerId, identity.deviceId)
  assert.ok(session.state.verificationCode)
  assert.equal(session.state.error, null)
  assert.equal(transport.cipher!.receivedCount, 2)
  // Duplicate ciphertext is acknowledged, not re-dispatched as a second policy.
  resumed.receive({ type: "signal", payload: policy })
  resumed.receive({ type: "signal", payload: offer })
  await transport.receiveQueue
  assert.equal(session.state.error, null)
  assert.equal(peers.length, 1)
  assert.equal(transport.cipher!.receivedCount, 2)
})

test("direct-only filters relay candidates from signed SDP and trickle ICE", async (t) => {
  const { session, transport } = await fixture(t)
  session.setMode("direct")
  const identity = await generateIdentity()
  const direct = "candidate:1 1 udp 1 192.0.2.1 1234 typ host"
  const relay = "candidate:2 1 udp 1 192.0.2.2 5678 typ relay"
  const candidates: RTCIceCandidateInit[] = []
  let remoteDescription: RTCSessionDescriptionInit | null = null
  transport.peer = {
    get remoteDescription() {
      return remoteDescription
    },
    async setRemoteDescription(value: RTCSessionDescriptionInit) {
      remoteDescription = value
    },
    async addIceCandidate(value: RTCIceCandidateInit) {
      candidates.push(value)
    },
    close() {},
  } as unknown as RTCPeerConnection
  const signed = await signDescription(identity, {
    kind: "description",
    v: 2,
    sessionId: transport.sessionId,
    role: "guest",
    name: "Remote",
    publicKey: identity.publicKey,
    negotiation: 0,
    transport: "initial",
    mode: "direct",
    sdp: `v=0\r\na=ice-ufrag:current\r\na=${direct}\r\na=${relay}\r\n`,
  })
  await transport.receivePayload(signed, transport.generation)
  assert.equal(
    transport.peer.remoteDescription?.sdp,
    `v=0\r\na=ice-ufrag:current\r\na=${direct}\r\n`
  )
  for (const candidate of [relay, direct]) {
    await transport.receivePayload(
      {
        kind: "candidate",
        negotiation: 0,
        candidate: { candidate, usernameFragment: "current" },
      },
      transport.generation
    )
  }
  await transport.receivePayload(
    {
      kind: "candidate",
      negotiation: 0,
      candidate: { candidate: direct, usernameFragment: "previous" },
    },
    transport.generation
  )
  assert.deepEqual(candidates, [
    { candidate: direct, usernameFragment: "current" },
  ])
  assert.equal(session.state.peerId, identity.deviceId)
})

test("a correctly signed recovery from a changed identity is rejected", async (t) => {
  const { session, transport, establish } = await fixture(t)
  const approved = await generateIdentity()
  const replacement = await generateIdentity()
  establish(approved.deviceId)
  transport.enterRecovery()
  transport.negotiation = 1
  transport.transport = "restart"
  const payload = await description(replacement, transport.sessionId, 1)

  await assert.rejects(
    transport.receivePayload(payload, transport.generation),
    (error: unknown) =>
      error instanceof ConnectionError &&
      error.code === "authentication-failed" &&
      /different identity/i.test(error.message)
  )
  assert.equal(session.state.peerId, approved.deviceId)
  assert.equal(session.state.status, "recovering")
})

test("stale recovery descriptions, candidates, and readiness cannot advance negotiation", async (t) => {
  const { session, transport, establish } = await fixture(t)
  const identity = await generateIdentity()
  const { chat } = establish(identity.deviceId)
  transport.enterRecovery()
  transport.negotiation = 2
  transport.remoteNegotiation = 2
  transport.transport = "restart"
  await transport.receivePayload(
    await description(identity, transport.sessionId, 1),
    transport.generation
  )
  await transport.receivePayload(
    {
      kind: "candidate",
      negotiation: 1,
      candidate: { candidate: "old candidate" },
    },
    transport.generation
  )
  chat.receive({ type: "session.ready", negotiation: 1 })
  assert.equal(session.state.status, "recovering")
  assert.equal(transport.remoteNegotiation, 2)
  await assert.rejects(
    transport.receivePayload(
      await description(identity, transport.sessionId, 2),
      transport.generation
    ),
    /replayed/
  )
  await assert.rejects(
    transport.receivePayload(
      { kind: "candidate", negotiation: 4, candidate: {} },
      transport.generation
    ),
    /generation/
  )
})

test("chat sends are blocked during recovery and incoming chat waits for recovery completion", async (t) => {
  const { session, transport, establish } = await fixture(t)
  const { chat, control } = establish()
  transport.enterRecovery()
  assert.throws(() => session.sendText("Do not send yet"), /Connect to a peer/)
  chat.receive({
    type: "chat.message",
    id: "during-recovery",
    text: "In flight",
  })
  assert.equal(chat.sent.length, 0)
  assert.equal(control.sent.length, 0)
  assert.equal(session.state.messages.length, 0)
  assert.equal(session.state.status, "recovering")
  transport.finishRecovery()
  assert.equal(session.state.messages[0].text, "In flight")
  assert.deepEqual(control.sent, [
    { v: 2, type: "chat.receipt", id: "during-recovery" },
  ])
  session.sendText("Recovered")
  assert.equal(chat.sent[0].text, "Recovered")
})

test("cancelling admission derivation prevents a late socket from being created", async (t) => {
  const { session, sockets } = await fixture(t)
  const pending = session.create()
  session.disconnect()
  await pending
  assert.equal(sockets.length, 0)
  assert.equal(session.state.status, "closed")
  assert.equal(session.state.error, null)
})

test("cancellation ignores a late resume response and socket errors", async (t) => {
  const { session, transport, sockets, created, establish } = await fixture(t)
  const socket = await created()
  establish()
  socket.close()
  socket.onclose?.()
  const resumed = await eventually(() => sockets[1])
  resumed.open()
  await eventually(() =>
    resumed.sent.find((message) => message.type === "resume")
  )
  session.disconnect()
  resumed.receive({
    type: "resumed",
    sessionId: "test-session-1234567890",
    role: "host",
    iceConfig: { iceServers: [], relayAvailable: false, expiresAt: null },
  })
  resumed.onerror?.()
  resumed.onclose?.()
  await transport.receiveQueue
  assert.equal(session.state.status, "closed")
  assert.equal(session.state.error, null)
  assert.equal(
    resumed.sent.some((message) => message.type === "established"),
    false
  )
})

test("socket resume replays identical ciphertext and preserves both cipher counters", async (t) => {
  const { session, transport, sockets, created, establish } = await fixture(t)
  const socket = await created()
  const secret = new URL(session.state.pairingLink!).hash.slice(1)
  const remote = await SignalCipher.create(secret, transport.sessionId, "guest")
  // Only the remote-description presence is needed for candidate dispatch here.
  transport.peer = {
    close() {},
    async getStats() {
      return new Map()
    },
  } as unknown as RTCPeerConnection
  establish()
  const incoming = await remote.seal({
    kind: "candidate",
    negotiation: 0,
    candidate: { candidate: "candidate:remote" },
  })
  socket.receive({ type: "signal", payload: incoming })
  await transport.receiveQueue
  const cipher = transport.cipher!
  assert.equal(cipher.receivedCount, 1)
  transport.sendSignal({
    kind: "candidate",
    negotiation: 0,
    candidate: { candidate: "candidate:local" },
  })
  await transport.sendQueue
  const first = socket.sent.find((message) => message.type === "signal")!
    .payload as SealedSignal
  assert.equal(first.seq, 0)
  await remote.open(first)
  socket.close()
  socket.onclose?.()
  const resumed = await eventually(() => sockets[1])
  resumed.open()
  await eventually(() =>
    resumed.sent.find((message) => message.type === "resume")
  )
  resumed.receive({
    type: "resumed",
    sessionId: transport.sessionId,
    role: "host",
    iceConfig: { iceServers: [], relayAvailable: false, expiresAt: null },
  })
  await transport.receiveQueue
  assert.equal(transport.cipher, cipher)
  assert.deepEqual(
    resumed.sent.find((message) => message.type === "signal")!.payload,
    first
  )
  resumed.receive({ type: "signal", payload: incoming })
  await transport.receiveQueue
  assert.equal(cipher.receivedCount, 1)
  resumed.receive({
    type: "signal",
    payload: await remote.seal({
      kind: "candidate",
      negotiation: 0,
      candidate: {},
    }),
  })
  await transport.receiveQueue
  assert.equal(cipher.receivedCount, 2)
  transport.sendSignal({ kind: "candidate", negotiation: 0, candidate: {} })
  await transport.sendQueue
  const signals = resumed.sent.filter((message) => message.type === "signal")
  const second = signals[1].payload as SealedSignal
  assert.equal(second.seq, 1)
  assert.deepEqual(await remote.open(second), {
    kind: "candidate",
    negotiation: 0,
    candidate: {},
  })
  assert.equal(session.state.status, "connected")
})

test("cancelling recovery while relay refresh is pending cannot produce a late error", async (t) => {
  const { session, transport, created, establish } = await fixture(t)
  const socket = await created()
  establish()
  transport.ice = {
    iceServers: [],
    relayAvailable: false,
    expiresAt: Date.now() + 1_000,
  }
  session.retryConnection()
  await eventually(() =>
    socket.sent.find((message) => message.type === "ice-refresh")
  )
  session.disconnect()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(session.state.status, "closed")
  assert.equal(session.state.error, null)
})
