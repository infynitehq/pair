import {
  admissionProof,
  connectionCode,
  encode,
  fingerprint,
  SignalCipher,
  signDescription,
  verifyDescription,
  type DeviceIdentity,
  type SealedSignal,
  type SignedDescription,
} from "./crypto"
import {
  ConnectionError,
  readIceConfiguration,
  redactedDiagnostics,
  rtcConfiguration,
  type IceConfiguration,
} from "./connectivity"
import type { ConnectionMode, FailureCode, PeerState } from "./types"

export const initialState: PeerState = {
  status: "idle",
  deviceName: "This device",
  deviceId: "",
  peerName: null,
  peerId: null,
  pairingLink: null,
  expiresAt: null,
  verificationCode: null,
  approved: false,
  peerApproved: false,
  route: null,
  messages: [],
  error: null,
  errorCode: null,
  mode: "automatic",
  signalingStatus: "offline",
  relayAvailable: null,
  recoveryAttempt: 0,
  connectedAt: null,
  roundTripTimeMs: null,
}

export function parsePairingLink(input: string, origin: string) {
  const url = new URL(input)
  const sessionId = url.searchParams.get("pair")
  const secret = url.hash.slice(1)
  if (
    url.origin !== origin ||
    url.pathname !== "/" ||
    !sessionId ||
    !/^[A-Za-z0-9_-]{20,100}$/.test(sessionId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(secret)
  )
    throw new ConnectionError(
      "authentication-failed",
      "Paste a complete Pair invite from this site, including its secret after #."
    )
  return { sessionId, secret }
}

function signalingUrl() {
  if (process.env.NEXT_PUBLIC_SIGNALING_URL)
    return process.env.NEXT_PUBLIC_SIGNALING_URL
  const url = new URL(window.location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.port = "3001"
  url.pathname = "/signal"
  url.search = ""
  url.hash = ""
  return url.toString()
}

type Transport = SignedDescription["transport"]
type Candidate = { negotiation: number; candidate: RTCIceCandidateInit }
type Refresh = {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
const emptyIce: IceConfiguration = {
  iceServers: [],
  relayAvailable: false,
  expiresAt: null,
}
const tokenValid = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)

export class PeerSession {
  state: PeerState
  private socket: WebSocket | null = null
  private socketGeneration = 0
  private peer: RTCPeerConnection | null = null
  private control: RTCDataChannel | null = null
  private chat: RTCDataChannel | null = null
  private cipher: SignalCipher | null = null
  private role: "host" | "guest" = "host"
  private sessionId = ""
  private secret = ""
  private hostSdp = ""
  private guestSdp = ""
  private candidates: Candidate[] = []
  private receiveQueue = Promise.resolve()
  private sendQueue = Promise.resolve()
  private pendingSignals = new Map<number, SealedSignal>()
  private resumeTokens: string[] = []
  private resumeRequest: {
    used: string
    next: string
    remaining: string[]
  } | null = null
  private reconnectAttempts = 0
  private activeRoleUntil = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private socketDeadline: ReturnType<typeof setTimeout> | null = null
  private deadline: ReturnType<typeof setTimeout> | null = null
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private generation = 0
  private seenMessages = new Set<string>()
  private channelReady = false
  private ice: IceConfiguration = emptyIce
  private refresh: Refresh | null = null
  private refreshId = ""
  private negotiation = 0
  private remoteNegotiation = -1
  private transport: Transport = "initial"
  private peerReadyNegotiation = -1
  private readySentNegotiation = -1
  private everConnected = false
  private recoveryBusy = false
  private deferredChat: Array<{ channel: string; data: string }> = []
  private localPolicySent = false
  private remoteMode: ConnectionMode | null = null
  private effectiveMode: ConnectionMode | null = null
  private initializing = false

  constructor(
    private identity: DeviceIdentity,
    name: string,
    private onChange: (state: PeerState) => void,
    mode: ConnectionMode = "automatic"
  ) {
    this.state = {
      ...initialState,
      deviceId: identity.deviceId,
      deviceName: name,
      mode,
    }
  }

  private update(patch: Partial<PeerState>) {
    this.state = { ...this.state, ...patch }
    this.onChange(this.state)
  }
  setName(name: string) {
    if (!["idle", "closed", "error"].includes(this.state.status)) return
    const value = name.trim().slice(0, 40) || "This device"
    try {
      localStorage.setItem("pair-device-name", value)
    } catch {
      /* Optional local preference. */
    }
    this.update({ deviceName: value })
  }
  setMode(mode: ConnectionMode) {
    if (
      !["idle", "closed", "error"].includes(this.state.status) ||
      !["automatic", "direct", "relay"].includes(mode)
    )
      return
    try {
      localStorage.setItem("pair-connection-mode", mode)
    } catch {
      /* Optional local preference. */
    }
    this.update({ mode })
  }
  exportDiagnostics() {
    return redactedDiagnostics(this.state)
  }

  async create() {
    this.reset("creating")
    this.role = "host"
    this.secret = encode(crypto.getRandomValues(new Uint8Array(32)))
    const generation = this.generation
    try {
      const { joinVerifier } = await admissionProof(this.secret)
      if (generation !== this.generation) return
      await this.openSocket()
      if (generation === this.generation)
        this.sendSocket({ type: "create", joinVerifier })
    } catch (error) {
      if (generation === this.generation)
        this.fail(error, "signaling-unavailable")
    }
  }

  async join(link: string) {
    let invitation: ReturnType<typeof parsePairingLink>
    try {
      invitation = parsePairingLink(link, window.location.origin)
    } catch (error) {
      this.fail(error)
      return
    }
    this.reset("connecting")
    this.role = "guest"
    this.sessionId = invitation.sessionId
    this.secret = invitation.secret
    const generation = this.generation
    try {
      const [cipher, { joinToken }] = await Promise.all([
        SignalCipher.create(this.secret, this.sessionId, this.role),
        admissionProof(this.secret),
      ])
      if (generation !== this.generation) return
      this.cipher = cipher
      await this.openSocket()
      if (generation === this.generation)
        this.sendSocket({ type: "join", sessionId: this.sessionId, joinToken })
    } catch (error) {
      if (generation === this.generation)
        this.fail(error, "signaling-unavailable")
    }
  }

  private reset(status: PeerState["status"]) {
    this.dispose()
    this.sessionId = ""
    this.hostSdp = ""
    this.guestSdp = ""
    this.candidates = []
    this.seenMessages.clear()
    this.pendingSignals.clear()
    this.resumeTokens = []
    this.resumeRequest = null
    this.channelReady = false
    this.everConnected = false
    this.recoveryBusy = false
    this.negotiation = 0
    this.remoteNegotiation = -1
    this.transport = "initial"
    this.peerReadyNegotiation = -1
    this.readySentNegotiation = -1
    this.deferredChat = []
    this.reconnectAttempts = 0
    this.ice = emptyIce
    this.activeRoleUntil = 0
    this.localPolicySent = false
    this.remoteMode = null
    this.effectiveMode = null
    this.initializing = false
    this.sendQueue = Promise.resolve()
    this.receiveQueue = Promise.resolve()
    this.update({
      ...initialState,
      status,
      deviceId: this.identity.deviceId,
      deviceName: this.state.deviceName,
      mode: this.state.mode,
      signalingStatus: "connecting",
    })
    this.setDeadline(
      20_000,
      new ConnectionError(
        "signaling-unavailable",
        "The signaling service did not respond. Check its URL and try again."
      )
    )
  }

  private setDeadline(ms: number, error: Error) {
    if (this.deadline) clearTimeout(this.deadline)
    this.deadline = setTimeout(() => this.fail(error), ms)
  }
  private clearSocketDeadline() {
    if (this.socketDeadline) clearTimeout(this.socketDeadline)
    this.socketDeadline = null
  }

  private openSocket(): Promise<void> {
    const generation = this.generation
    const socketGeneration = ++this.socketGeneration
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(signalingUrl())
      this.socket = socket
      const current = () =>
        generation === this.generation &&
        socketGeneration === this.socketGeneration
      this.clearSocketDeadline()
      this.socketDeadline = setTimeout(() => {
        if (current()) socket.close()
      }, 6_000)
      socket.onopen = () => {
        if (current()) {
          this.clearSocketDeadline()
          resolve()
        } else reject(new Error("Session cancelled"))
      }
      socket.onerror = () =>
        reject(
          new ConnectionError(
            "signaling-unavailable",
            "Unable to reach signaling. Check the service URL and network."
          )
        )
      socket.onclose = () => {
        reject(new Error("Signaling disconnected"))
        if (!current()) return
        this.clearSocketDeadline()
        if (
          ["closed", "error"].includes(this.state.status) ||
          this.state.signalingStatus === "retired"
        )
          return
        if (this.recoveryTimer) {
          clearTimeout(this.recoveryTimer)
          this.recoveryTimer = null
        }
        if (this.refresh) {
          clearTimeout(this.refresh.timer)
          this.refresh.timer = setTimeout(() => {
            this.refresh?.reject(
              new ConnectionError(
                "signaling-unavailable",
                "Relay refresh could not resume."
              )
            )
            this.refresh = null
          }, 75_000)
        }
        if (this.resumeTokens.length) this.scheduleResume()
        else
          this.fail(
            new ConnectionError(
              "signaling-unavailable",
              "The pairing connection closed. Create a new invitation."
            )
          )
      }
      socket.onmessage = (event) => {
        // Credential refresh may be awaited by negotiation processing. Resolve it
        // outside the ordered encrypted-signal queue to avoid a self-deadlock.
        if (
          current() &&
          typeof event.data === "string" &&
          event.data.length <= 65_536
        ) {
          try {
            const message = JSON.parse(event.data)
            if (
              message?.v === 2 &&
              (message.type === "resumed" ||
                (message.type === "error" && this.resumeRequest) ||
                (this.refresh &&
                  message.requestId === this.refreshId &&
                  (message.type === "ice-config" || message.type === "error")))
            ) {
              void this.receiveSignal(message, generation).catch((error) => {
                if (current()) this.fail(error)
              })
              return
            }
          } catch {
            /* Normal validation below handles malformed frames. */
          }
        }
        this.receiveQueue = this.receiveQueue
          .then(async () => {
            if (!current()) return
            if (typeof event.data !== "string" || event.data.length > 65_536)
              throw new ConnectionError(
                "protocol-error",
                "Invalid signaling frame"
              )
            await this.receiveSignal(JSON.parse(event.data), generation)
          })
          .catch((error) => {
            if (generation === this.generation) this.fail(error)
          })
      }
    })
  }

  private sendSocket(value: Record<string, unknown>) {
    if (this.socket?.readyState !== WebSocket.OPEN)
      throw new ConnectionError(
        "signaling-unavailable",
        "Signaling is unavailable."
      )
    this.socket.send(JSON.stringify({ v: 2, ...value }))
  }

  private scheduleResume() {
    if (this.reconnectTimer || this.state.signalingStatus === "retired") return
    if (
      (this.activeRoleUntil && Date.now() >= this.activeRoleUntil) ||
      (!this.activeRoleUntil && this.reconnectAttempts >= 5)
    ) {
      this.retireSignaling()
      return
    }
    this.update({ signalingStatus: "reconnecting" })
    const delay =
      (this.activeRoleUntil
        ? 3_000
        : Math.min(400 * 2 ** this.reconnectAttempts++, 5_000)) +
      Math.random() * 200
    const generation = this.generation
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.openSocket()
        .then(() => {
          if (generation !== this.generation) return
          this.requestResume([...this.resumeTokens])
        })
        .catch(() => {
          if (generation === this.generation) this.scheduleResume()
        })
    }, delay)
  }

  private requestResume(tokens: string[]) {
    const used = tokens.shift()
    if (!used) {
      this.retireSignaling()
      return
    }
    const next = encode(crypto.getRandomValues(new Uint8Array(32)))
    this.resumeRequest = { used, next, remaining: tokens }
    // Retain both possibilities until the rotation is acknowledged. A lost response
    // can mean either the previous token or the proposed token is current server-side.
    this.resumeTokens = [next, used, ...tokens].slice(0, 8)
    this.sendSocket({
      type: "resume",
      sessionId: this.sessionId,
      role: this.role,
      resumeToken: used,
      nextResumeToken: next,
    })
    this.clearSocketDeadline()
    this.socketDeadline = setTimeout(() => this.socket?.close(), 6_000)
  }

  private retireSignaling() {
    this.clearSocketDeadline()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.resumeTokens = []
    this.resumeRequest = null
    this.update({ signalingStatus: "retired" })
    this.socket?.close()
    if (!this.everConnected || this.state.status === "recovering")
      this.fail(
        new ConnectionError(
          "signaling-unavailable",
          "This session can no longer reconnect. Create a fresh pairing link."
        )
      )
  }

  private sendSignal(value: unknown) {
    const generation = this.generation
    this.sendQueue = this.sendQueue
      .then(async () => {
        if (generation !== this.generation || !this.cipher) return
        if (this.pendingSignals.size >= 128)
          throw new ConnectionError(
            "signaling-unavailable",
            "The signaling queue is full. Pair again."
          )
        const payload = await this.cipher.seal(value)
        if (generation !== this.generation) return
        this.pendingSignals.set(payload.seq, payload)
        if (
          this.state.signalingStatus === "available" &&
          this.socket?.readyState === WebSocket.OPEN
        )
          this.sendSocket({ type: "signal", payload })
      })
      .catch((error) => {
        if (generation === this.generation) this.fail(error)
      })
  }

  private useIce(value: unknown) {
    this.ice = readIceConfiguration(value)
    this.update({ relayAvailable: this.ice.relayAvailable })
    // Fail relay-only early instead of silently falling back to a direct route.
    rtcConfiguration(this.ice, this.connectionMode())
  }

  private async receiveSignal(
    message: Record<string, unknown>,
    generation: number
  ) {
    if (!message || message.v !== 2)
      throw new ConnectionError(
        "protocol-error",
        "This peer uses an incompatible protocol. Reload both browsers."
      )
    switch (message.type) {
      case "created": {
        if (
          this.role !== "host" ||
          this.sessionId ||
          typeof message.sessionId !== "string" ||
          !/^[A-Za-z0-9_-]{20,100}$/.test(message.sessionId) ||
          typeof message.expiresAt !== "number" ||
          !tokenValid(message.resumeToken)
        )
          throw new Error("Invalid pairing session")
        this.sessionId = message.sessionId
        const cipher = await SignalCipher.create(
          this.secret,
          this.sessionId,
          this.role
        )
        if (generation !== this.generation) return
        this.cipher = cipher
        this.resumeTokens = [message.resumeToken]
        this.useIce(message.iceConfig)
        const link = new URL("/", window.location.origin)
        link.searchParams.set("pair", this.sessionId)
        link.hash = this.secret
        this.update({
          status: "waiting",
          signalingStatus: "available",
          pairingLink: link.toString(),
          expiresAt: message.expiresAt,
        })
        this.setDeadline(
          Math.max(1, Math.min(message.expiresAt - Date.now(), 120_000)),
          new ConnectionError(
            "invitation-expired",
            "This invite expired. Create a new one."
          )
        )
        break
      }
      case "joined":
        if (
          this.role !== "guest" ||
          message.sessionId !== this.sessionId ||
          typeof message.expiresAt !== "number" ||
          !tokenValid(message.resumeToken)
        )
          throw new Error("Invalid joined session")
        this.resumeTokens = [message.resumeToken]
        this.useIce(message.iceConfig)
        this.update({
          expiresAt: message.expiresAt,
          signalingStatus: "available",
        })
        break
      case "resumed":
        if (
          !this.resumeRequest ||
          message.sessionId !== this.sessionId ||
          message.role !== this.role
        )
          throw new Error("Invalid resume response")
        this.resumeTokens = [this.resumeRequest.next]
        this.resumeRequest = null
        this.reconnectAttempts = 0
        this.activeRoleUntil = 0
        this.clearSocketDeadline()
        this.useIce(message.iceConfig)
        this.update({ signalingStatus: "available" })
        if (this.refresh) {
          clearTimeout(this.refresh.timer)
          this.refresh.resolve()
          this.refresh = null
        }
        for (const payload of this.pendingSignals.values())
          this.sendSocket({ type: "signal", payload })
        if (this.everConnected) this.sendSocket({ type: "established" })
        if (
          !this.peer &&
          (message.peerOnline === true || this.role === "guest")
        )
          await this.startPair(generation)
        if (this.state.status === "recovering" && !this.recoveryBusy)
          this.requestRecovery()
        else if (this.state.status === "recovering") this.armRecoveryTimeout()
        break
      case "peer-ready":
        await this.startPair(generation)
        break
      case "signal": {
        if (!this.cipher) throw new Error("Unexpected signaling data")
        const payload = message.payload as SealedSignal
        if (!payload || !Number.isSafeInteger(payload.seq) || payload.seq < 0)
          throw new Error("Invalid signal sequence")
        if (payload.seq < this.cipher.receivedCount) {
          this.sendSocket({
            type: "signal-received",
            seq: this.cipher.receivedCount - 1,
          })
          break
        }
        let value: unknown
        try {
          value = await this.cipher.open(payload)
        } catch {
          throw new ConnectionError(
            "authentication-failed",
            "The pairing secret or encrypted signaling could not be verified."
          )
        }
        if (generation !== this.generation) return
        await this.receivePayload(value, generation)
        if (
          generation === this.generation &&
          this.socket?.readyState === WebSocket.OPEN
        )
          this.sendSocket({ type: "signal-received", seq: payload.seq })
        break
      }
      case "signal-ack":
        if (Number.isSafeInteger(message.seq))
          this.pendingSignals.delete(message.seq as number)
        break
      case "ice-config":
        if (message.requestId !== this.refreshId || !this.refresh) return
        this.useIce(message)
        clearTimeout(this.refresh.timer)
        this.refresh.resolve()
        this.refresh = null
        break
      case "peer-offline":
        break // A working data transport is independent of signaling.
      case "peer-online":
        if (!this.peer) await this.startPair(generation)
        if (this.state.status === "recovering" && !this.recoveryBusy)
          this.requestRecovery()
        break
      case "peer-left":
        if (!this.everConnected || this.state.status === "recovering")
          this.fail(
            new ConnectionError(
              "peer-left",
              "The other device left. Create a new invite."
            )
          )
        else this.retireSignaling()
        break
      case "session-retired":
        this.retireSignaling()
        break
      case "error": {
        if (message.requestId === this.refreshId && this.refresh) {
          clearTimeout(this.refresh.timer)
          this.refresh.reject(
            new ConnectionError(
              "relay-unavailable",
              "Could not refresh temporary relay credentials."
            )
          )
          this.refresh = null
          return
        }
        if (this.resumeRequest) {
          if (message.code === "ROLE_ACTIVE") {
            this.resumeTokens = [
              this.resumeRequest.used,
              ...this.resumeRequest.remaining,
            ]
            this.resumeRequest = null
            this.activeRoleUntil ||= Date.now() + 65_000
            if (this.state.status === "recovering")
              this.setDeadline(
                Math.max(1, this.activeRoleUntil - Date.now() + 15_000),
                new ConnectionError(
                  "signaling-unavailable",
                  "The previous signaling socket could not be retired. Pair again."
                )
              )
            this.socket?.close()
            return
          }
          if (
            [
              "INVALID_RESUME_TOKEN",
              "INVALID_RESUME",
              "RESUME_REJECTED",
              "INVALID_TOKEN",
              "UNAUTHORIZED",
            ].includes(String(message.code))
          ) {
            this.requestResume(this.resumeRequest.remaining)
            return
          }
          if (
            ["SESSION_NOT_FOUND", "SESSION_EXPIRED", "RESUME_EXPIRED"].includes(
              String(message.code)
            )
          ) {
            this.retireSignaling()
            return
          }
          this.socket?.close()
          return
        }
        if (this.everConnected && message.code === "SESSION_EXPIRED") {
          this.retireSignaling()
          return
        }
        const codes: Record<string, FailureCode> = {
          SESSION_EXPIRED: "invitation-expired",
          SESSION_NOT_FOUND: "invitation-expired",
          INVALID_JOIN_TOKEN: "authentication-failed",
          INVALID_JOIN: "authentication-failed",
          INVALID_PROOF: "authentication-failed",
          JOIN_REJECTED: "authentication-failed",
          UNAUTHORIZED: "authentication-failed",
        }
        throw new ConnectionError(
          codes[String(message.code)] ?? "signaling-unavailable",
          typeof message.message === "string"
            ? message.message.slice(0, 200)
            : "Pairing failed"
        )
      }
      default:
        throw new Error("Unknown signaling message")
    }
  }

  private routeFailure(): FailureCode {
    return this.state.mode === "relay"
      ? "relay-unavailable"
      : this.state.mode === "direct" || !this.ice.relayAvailable
        ? "direct-unavailable"
        : "connection-interrupted"
  }
  private connectionMode() {
    return this.effectiveMode ?? this.state.mode
  }

  private async startPair(generation: number) {
    if (this.peer) return // A resumed socket can race the initial peer-ready notification.
    if (!this.cipher) throw new Error("Unexpected peer")
    this.update({ status: "connecting", pairingLink: null })
    this.setDeadline(
      90_000,
      new ConnectionError(
        this.routeFailure(),
        "Connection or approval timed out. Keep both devices open and check your network or relay configuration."
      )
    )
    if (!this.localPolicySent) {
      this.localPolicySent = true
      this.sendSignal({ kind: "policy", mode: this.state.mode })
    }
    if (this.remoteMode === null || this.initializing) return
    this.initializing = true
    try {
      await this.refreshIce()
      if (generation !== this.generation) return
      this.createPeer()
      if (this.role === "host") await this.offer(generation)
    } finally {
      if (generation === this.generation) this.initializing = false
    }
  }

  private closeTransport() {
    const old = this.peer
    this.peer = null
    this.control?.close()
    this.chat?.close()
    old?.close()
    this.control = null
    this.chat = null
    this.channelReady = false
  }

  private createPeer() {
    this.closeTransport()
    const peer = new RTCPeerConnection(
      rtcConfiguration(this.ice, this.connectionMode())
    )
    this.peer = peer
    const generation = this.generation
    const current = () => generation === this.generation && this.peer === peer
    peer.onicecandidate = ({ candidate }) => {
      if (candidate && current())
        this.sendSignal({
          kind: "candidate",
          negotiation: this.negotiation,
          candidate: candidate.toJSON(),
        })
    }
    peer.onconnectionstatechange = () => {
      if (!current()) return
      if (peer.connectionState === "connected") this.maybeReady()
      if (
        peer.connectionState === "failed" ||
        peer.connectionState === "disconnected"
      ) {
        if (this.everConnected)
          this.beginRecovery(
            peer.connectionState === "disconnected" ? 2_000 : 0
          )
        else if (peer.connectionState === "failed")
          this.fail(
            new ConnectionError(
              this.routeFailure(),
              "A connection could not be established. Check your network or select a different connection mode."
            )
          )
      }
    }
    peer.ondatachannel = ({ channel }) => {
      if (
        !current() ||
        this.role !== "guest" ||
        !["control", "chat"].includes(channel.label)
      ) {
        channel.close()
        return
      }
      this.attachChannel(channel)
    }
    if (this.role === "host") {
      this.attachChannel(peer.createDataChannel("control", { ordered: true }))
      this.attachChannel(peer.createDataChannel("chat", { ordered: true }))
    }
  }

  private async offer(generation: number) {
    const peer = this.peer!
    const negotiation = this.negotiation
    const offer = await peer.createOffer({
      iceRestart: this.transport === "restart",
    })
    if (
      generation !== this.generation ||
      this.peer !== peer ||
      negotiation !== this.negotiation
    )
      return
    await peer.setLocalDescription(offer)
    if (
      generation !== this.generation ||
      this.peer !== peer ||
      negotiation !== this.negotiation
    )
      return
    await this.sendDescription(offer.sdp!, generation)
  }

  private async sendDescription(sdp: string, generation: number) {
    if (generation !== this.generation) return
    if (this.role === "host") this.hostSdp = sdp
    else this.guestSdp = sdp
    const negotiation = this.negotiation
    const payload = await signDescription(this.identity, {
      kind: "description",
      v: 2,
      sessionId: this.sessionId,
      role: this.role,
      name: this.state.deviceName,
      publicKey: this.identity.publicKey,
      sdp,
      negotiation,
      transport: this.transport,
      mode: this.state.mode,
    })
    if (generation === this.generation && negotiation === this.negotiation)
      this.sendSignal(payload)
  }

  private async addCandidate(candidate: RTCIceCandidateInit) {
    if (
      this.connectionMode() === "direct" &&
      /\btyp relay\b/.test(candidate.candidate ?? "")
    )
      return
    // Late candidates from the previous ICE generation are harmless, not a session failure.
    const remote = this.peer?.remoteDescription?.sdp ?? ""
    if (
      candidate.usernameFragment &&
      !remote.includes(`a=ice-ufrag:${candidate.usernameFragment}\r\n`)
    )
      return
    await this.peer?.addIceCandidate(candidate)
  }

  private async receivePayload(input: unknown, generation: number) {
    if (!input || typeof input !== "object")
      throw new Error("Invalid peer signal")
    const value = input as Record<string, unknown>
    if (value.kind === "policy") {
      if (
        this.remoteMode !== null ||
        this.everConnected ||
        !["automatic", "direct", "relay"].includes(String(value.mode))
      )
        throw new ConnectionError(
          "authentication-failed",
          "Invalid connection policy"
        )
      const remoteMode = value.mode as ConnectionMode
      if (
        (this.state.mode === "direct" && remoteMode === "relay") ||
        (this.state.mode === "relay" && remoteMode === "direct")
      )
        throw new ConnectionError(
          "direct-unavailable",
          "Connection modes conflict: one browser requires Direct only and the other Relay only. Choose compatible modes and pair again."
        )
      this.remoteMode = remoteMode
      this.effectiveMode =
        this.state.mode === "direct" || remoteMode === "direct"
          ? "direct"
          : this.state.mode
      await this.startPair(generation)
      return
    }
    if (value.kind === "recover") {
      if (
        !this.everConnected ||
        this.role !== "host" ||
        !Number.isSafeInteger(value.negotiation) ||
        (value.negotiation as number) > this.negotiation
      )
        throw new Error("Invalid recovery request")
      if (value.negotiation === this.negotiation && !this.recoveryBusy)
        this.beginRecovery(0)
      return
    }
    if (value.kind === "candidate") {
      if (
        !Number.isSafeInteger(value.negotiation) ||
        (value.negotiation as number) < 0 ||
        !value.candidate ||
        typeof value.candidate !== "object" ||
        this.candidates.length >= 128
      )
        throw new Error("Invalid ICE candidate")
      const negotiation = value.negotiation as number
      if (negotiation < this.negotiation) return
      if (negotiation > this.negotiation + 1)
        throw new Error("Unexpected candidate generation")
      if (
        negotiation === this.remoteNegotiation &&
        this.peer?.remoteDescription
      )
        await this.addCandidate(value.candidate as RTCIceCandidateInit)
      else
        this.candidates.push({
          negotiation,
          candidate: value.candidate as RTCIceCandidateInit,
        })
      return
    }
    if (
      value.kind !== "description" ||
      value.v !== 2 ||
      value.sessionId !== this.sessionId ||
      value.role !== (this.role === "host" ? "guest" : "host") ||
      typeof value.name !== "string" ||
      value.name.length > 40 ||
      typeof value.publicKey !== "string" ||
      typeof value.signature !== "string" ||
      typeof value.sdp !== "string" ||
      value.sdp.length > 40_000 ||
      !Number.isSafeInteger(value.negotiation) ||
      (value.negotiation as number) < 0 ||
      !["initial", "restart", "replace"].includes(String(value.transport)) ||
      (this.remoteMode !== null && value.mode !== this.remoteMode)
    )
      throw new ConnectionError(
        "authentication-failed",
        "Invalid peer authentication"
      )
    const description = value as unknown as SignedDescription
    if (!(await verifyDescription(description)))
      throw new ConnectionError(
        "authentication-failed",
        "Peer signature verification failed"
      )
    const peerId = await fingerprint(description.publicKey)
    if (generation !== this.generation) return
    if (this.state.peerId && this.state.peerId !== peerId)
      throw new ConnectionError(
        "authentication-failed",
        "The recovering peer has a different identity. Start a new pairing to approve it."
      )
    if (description.negotiation < this.negotiation) return
    if (description.negotiation === this.remoteNegotiation)
      throw new ConnectionError(
        "authentication-failed",
        "A negotiation description was replayed"
      )
    if (description.negotiation === 0) {
      if (description.transport !== "initial" || this.everConnected)
        throw new Error("Invalid initial negotiation")
    } else {
      if (!this.everConnected || description.transport === "initial")
        throw new Error("Recovery before session approval")
      if (this.role === "guest") {
        if (description.negotiation !== this.negotiation + 1)
          throw new Error("Unexpected recovery generation")
        this.enterRecovery()
        await this.refreshIce()
        if (generation !== this.generation) return
        this.negotiation = description.negotiation
        this.transport = description.transport
        this.recoveryBusy = true
        this.readySentNegotiation = -1
        this.update({
          recoveryAttempt: Math.min(this.state.recoveryAttempt + 1, 2),
        })
        if (description.transport === "replace") this.createPeer()
        else
          this.peer!.setConfiguration(
            rtcConfiguration(this.ice, this.connectionMode())
          )
        this.armRecoveryTimeout()
      } else if (
        description.negotiation !== this.negotiation ||
        description.transport !== this.transport
      )
        throw new Error("Unexpected recovery answer")
    }
    this.update({ peerName: description.name || "Other device", peerId })
    if (this.role === "host") this.guestSdp = description.sdp
    else this.hostSdp = description.sdp
    this.remoteNegotiation = description.negotiation
    const sdp =
      this.connectionMode() === "direct"
        ? description.sdp
            .split("\r\n")
            .filter(
              (line) =>
                !line.startsWith("a=candidate:") || !/\btyp relay\b/.test(line)
            )
            .join("\r\n")
        : description.sdp
    const peer = this.peer!
    await peer.setRemoteDescription({
      type: this.role === "host" ? "answer" : "offer",
      sdp,
    })
    if (generation !== this.generation || peer !== this.peer) return
    const candidates = this.candidates
    this.candidates = []
    for (const queued of candidates) {
      if (generation !== this.generation || peer !== this.peer) return
      if (queued.negotiation === this.negotiation)
        await this.addCandidate(queued.candidate)
    }
    if (generation !== this.generation || peer !== this.peer) return
    if (this.role === "guest") {
      const answer = await peer.createAnswer()
      if (generation !== this.generation || peer !== this.peer) return
      await peer.setLocalDescription(answer)
      if (generation !== this.generation || peer !== this.peer) return
      await this.sendDescription(answer.sdp!, generation)
    }
    if (generation !== this.generation || peer !== this.peer) return
    const verificationCode = await connectionCode(
      this.sessionId,
      this.hostSdp,
      this.guestSdp
    )
    if (generation !== this.generation || peer !== this.peer) return
    this.update({ verificationCode })
    this.maybeReady()
  }

  private attachChannel(channel: RTCDataChannel) {
    if (channel.label === "control") {
      if (this.control) {
        channel.close()
        return
      }
      this.control = channel
    } else {
      if (this.chat) {
        channel.close()
        return
      }
      this.chat = channel
    }
    const generation = this.generation
    const peer = this.peer
    const current = () => generation === this.generation && peer === this.peer
    channel.onopen = () => {
      if (current()) this.maybeReady()
    }
    channel.onclose = () => {
      if (current() && !["closed", "error"].includes(this.state.status)) {
        if (this.everConnected) this.beginRecovery(0)
        else this.disconnect()
      }
    }
    channel.onerror = () => {
      if (current()) {
        if (this.everConnected) this.beginRecovery(0)
        else this.fail(new Error("The encrypted channel failed."))
      }
    }
    channel.onmessage = (event) => {
      if (!current()) return
      try {
        this.receiveData(channel.label, event.data)
      } catch (error) {
        this.fail(error)
      }
    }
  }

  private maybeReady() {
    if (
      !this.state.verificationCode ||
      this.control?.readyState !== "open" ||
      this.chat?.readyState !== "open"
    )
      return
    if (!this.everConnected) {
      if (this.channelReady) return
      this.channelReady = true
      this.update({ status: "verifying", route: "checking" })
      this.startStats()
      return
    }
    if (
      this.state.status !== "recovering" ||
      this.remoteNegotiation !== this.negotiation ||
      this.peer?.connectionState !== "connected"
    )
      return
    if (!this.recoveryBusy) {
      this.finishRecovery()
      return
    } // Transient loss recovered before renegotiation.
    if (this.readySentNegotiation !== this.negotiation) {
      this.chat.send(
        JSON.stringify({
          v: 2,
          type: "session.ready",
          negotiation: this.negotiation,
        })
      )
      this.readySentNegotiation = this.negotiation
    }
    if (this.peerReadyNegotiation === this.negotiation) this.finishRecovery()
  }

  private startStats() {
    if (this.statsTimer) clearInterval(this.statsTimer)
    void this.inspectRoute()
    this.statsTimer = setInterval(() => void this.inspectRoute(), 3_000)
  }
  private async inspectRoute() {
    const peer = this.peer
    const generation = this.generation
    const stats = await peer?.getStats().catch(() => null)
    if (!stats || generation !== this.generation || peer !== this.peer) return
    let selected: RTCStats | undefined
    stats.forEach((report) => {
      if (report.type === "transport" && report.selectedCandidatePairId)
        selected = stats.get(report.selectedCandidatePairId)
    })
    if (!selected)
      stats.forEach((report) => {
        if (
          report.type === "candidate-pair" &&
          report.state === "succeeded" &&
          report.nominated
        )
          selected = report
      })
    const pair = selected as
      | (RTCStats & {
          localCandidateId?: string
          remoteCandidateId?: string
          currentRoundTripTime?: number
        })
      | undefined
    if (!pair) return
    const local = pair.localCandidateId && stats.get(pair.localCandidateId)
    const remote = pair.remoteCandidateId && stats.get(pair.remoteCandidateId)
    if (local && remote)
      this.update({
        route:
          local.candidateType === "relay" || remote.candidateType === "relay"
            ? "relay"
            : "direct",
        roundTripTimeMs:
          typeof pair.currentRoundTripTime === "number"
            ? Math.round(pair.currentRoundTripTime * 1000)
            : null,
      })
  }

  approve() {
    if (
      this.state.status !== "verifying" ||
      this.state.approved ||
      !this.channelReady
    )
      return
    try {
      this.chat!.send(JSON.stringify({ v: 2, type: "session.approve" }))
      this.update({ approved: true })
      this.maybeConnected()
    } catch (error) {
      this.fail(error)
    }
  }
  private maybeConnected() {
    if (this.everConnected || !this.state.approved || !this.state.peerApproved)
      return
    if (this.deadline) clearTimeout(this.deadline)
    this.deadline = null
    this.everConnected = true
    this.update({
      status: "connected",
      expiresAt: null,
      connectedAt: Date.now(),
    })
    if (this.socket?.readyState === WebSocket.OPEN)
      this.sendSocket({ type: "established" })
    this.secret = ""
  }

  retryConnection() {
    if (
      !this.everConnected ||
      !["connected", "recovering"].includes(this.state.status) ||
      this.recoveryBusy
    )
      return
    this.beginRecovery(0)
  }
  private enterRecovery() {
    if (this.state.status === "recovering") return
    this.deferredChat = []
    this.update({
      status: "recovering",
      recoveryAttempt: 0,
      error: null,
      errorCode: null,
      roundTripTimeMs: null,
    })
    this.setDeadline(
      45_000,
      new ConnectionError(
        "connection-interrupted",
        "Recovery timed out. Create a new pairing link."
      )
    )
  }
  private beginRecovery(delay: number) {
    if (!this.everConnected || this.recoveryBusy || this.recoveryTimer) return
    if (this.state.signalingStatus === "retired") {
      this.fail(
        new ConnectionError(
          "signaling-unavailable",
          "Signaling has expired. Pair again to recover this connection."
        )
      )
      return
    }
    this.enterRecovery()
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null
      this.requestRecovery()
    }, delay)
  }
  private requestRecovery() {
    if (
      this.state.status !== "recovering" ||
      this.recoveryBusy ||
      this.state.signalingStatus !== "available"
    )
      return
    if (this.role === "host")
      void this.restartTransport().catch((error) => this.fail(error))
    else {
      this.sendSignal({ kind: "recover", negotiation: this.negotiation })
      this.armRecoveryTimeout()
    }
  }
  private armRecoveryTimeout() {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = setTimeout(
      () => {
        this.recoveryTimer = null
        if (this.state.status !== "recovering") return
        if (this.role === "host" && this.state.recoveryAttempt < 2) {
          this.recoveryBusy = false
          void this.restartTransport(true).catch((error) => this.fail(error))
        } else
          this.fail(
            new ConnectionError(
              this.routeFailure(),
              "The connection could not recover. Pair again or try another network."
            )
          )
      },
      this.role === "host" ? 12_000 : 32_000
    )
  }
  private async refreshIce() {
    if (this.ice.expiresAt === null || this.ice.expiresAt > Date.now() + 30_000)
      return
    if (this.state.signalingStatus !== "available")
      throw new ConnectionError(
        "signaling-unavailable",
        "Signaling is needed to refresh relay credentials."
      )
    if (this.refresh) throw new Error("ICE refresh already in progress")
    this.refreshId = crypto.randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.refresh = null
        reject(
          new ConnectionError(
            "relay-unavailable",
            "Relay credential refresh timed out."
          )
        )
      }, 5_000)
      this.refresh = { resolve, reject, timer }
      this.sendSocket({ type: "ice-refresh", requestId: this.refreshId })
    })
  }
  private async restartTransport(forceReplacement = false) {
    if (this.recoveryBusy || this.state.recoveryAttempt >= 2) return
    this.recoveryBusy = true
    const generation = this.generation
    try {
      await this.refreshIce()
      if (generation !== this.generation) return
      const replace =
        forceReplacement ||
        this.chat?.readyState !== "open" ||
        this.control?.readyState !== "open" ||
        this.peer?.signalingState !== "stable"
      this.negotiation++
      this.transport = replace ? "replace" : "restart"
      this.readySentNegotiation = -1
      this.peerReadyNegotiation = -1
      this.update({ recoveryAttempt: this.state.recoveryAttempt + 1 })
      if (replace) this.createPeer()
      else
        this.peer!.setConfiguration(
          rtcConfiguration(this.ice, this.connectionMode())
        )
      await this.offer(generation)
      if (generation === this.generation) this.armRecoveryTimeout()
    } catch (error) {
      if (generation === this.generation) throw error
    }
  }
  private finishRecovery() {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    if (this.deadline) clearTimeout(this.deadline)
    this.recoveryTimer = null
    this.deadline = null
    this.recoveryBusy = false
    this.channelReady = true
    this.update({ status: "connected", error: null, errorCode: null })
    this.startStats()
    const pending = this.deferredChat
    this.deferredChat = []
    for (const frame of pending) this.receiveData(frame.channel, frame.data)
  }

  private receiveData(channel: string, data: unknown) {
    if (typeof data !== "string" || data.length > 20_000)
      throw new Error("Peer sent an invalid message")
    const message = JSON.parse(data)
    if (!message || message.v !== 2)
      throw new Error("Unsupported peer protocol")
    if (channel === "control" && message.type === "session.close") {
      this.disconnect()
      return
    }
    if (channel === "chat" && message.type === "session.approve") {
      if (!this.state.peerId || this.everConnected)
        throw new ConnectionError(
          "authentication-failed",
          "Unexpected peer approval"
        )
      this.update({ peerApproved: true })
      this.maybeConnected()
      return
    }
    if (channel === "chat" && message.type === "session.ready") {
      if (
        !this.everConnected ||
        !Number.isSafeInteger(message.negotiation) ||
        message.negotiation > this.negotiation + 1
      )
        throw new Error("Invalid recovery readiness")
      if (message.negotiation < this.negotiation) return
      this.peerReadyNegotiation = message.negotiation
      this.maybeReady()
      return
    }
    if (this.state.status === "recovering" && this.everConnected) {
      if (
        this.deferredChat.length >= 16 ||
        this.deferredChat.reduce((sum, frame) => sum + frame.data.length, 0) +
          data.length >
          64_000
      )
        throw new Error("Recovery receive buffer exceeded")
      this.deferredChat.push({ channel, data })
      return
    }
    if (this.state.status !== "connected")
      throw new Error("Application data arrived before approval")
    if (typeof message.id !== "string" || message.id.length > 64)
      throw new Error("Invalid message ID")
    if (channel === "control" && message.type === "chat.receipt") {
      this.update({
        messages: this.state.messages.map((item) =>
          item.id === message.id && item.direction === "outgoing"
            ? { ...item, status: "delivered" }
            : item
        ),
      })
      return
    }
    if (
      channel !== "chat" ||
      message.type !== "chat.message" ||
      typeof message.text !== "string" ||
      !message.text.trim() ||
      message.text.length > 4000
    )
      throw new Error("Invalid chat message")
    if (!this.seenMessages.has(message.id)) {
      this.seenMessages.add(message.id)
      if (this.seenMessages.size > 2000)
        this.seenMessages.delete(this.seenMessages.values().next().value!)
      this.update({
        messages: [
          ...this.state.messages,
          {
            id: message.id,
            text: message.text,
            direction: "incoming",
            status: "delivered",
            timestamp: Date.now(),
          },
        ].slice(-500) as PeerState["messages"],
      })
    }
    if (this.control!.bufferedAmount > 64_000)
      throw new Error("Peer exceeded the receive limit")
    this.control!.send(
      JSON.stringify({ v: 2, type: "chat.receipt", id: message.id })
    )
  }

  sendText(text: string) {
    const value = text.trim()
    if (this.state.status !== "connected" || !value || value.length > 4000)
      throw new Error(
        "Connect to a peer and enter between 1 and 4,000 characters."
      )
    if (this.chat!.bufferedAmount > 64_000)
      throw new Error(
        "The connection is busy. Wait a moment before sending again."
      )
    try {
      const id = crypto.randomUUID()
      this.chat!.send(
        JSON.stringify({ v: 2, type: "chat.message", id, text: value })
      )
      this.update({
        error: null,
        errorCode: null,
        messages: [
          ...this.state.messages,
          {
            id,
            text: value,
            direction: "outgoing",
            status: "sent",
            timestamp: Date.now(),
          },
        ].slice(-500) as PeerState["messages"],
      })
    } catch (error) {
      this.beginRecovery(0)
      throw error
    }
  }

  disconnect() {
    try {
      if (this.control?.readyState === "open")
        this.control.send(JSON.stringify({ v: 2, type: "session.close" }))
    } catch {
      /* Already closed. */
    }
    this.dispose()
    this.update({
      status: "closed",
      signalingStatus: "offline",
      pairingLink: null,
      expiresAt: null,
      error: null,
      errorCode: null,
      messages: [],
    })
  }
  private fail(error: unknown, fallback: FailureCode = "protocol-error") {
    this.dispose()
    this.update({
      status: "error",
      signalingStatus: "offline",
      pairingLink: null,
      expiresAt: null,
      errorCode: error instanceof ConnectionError ? error.code : fallback,
      error:
        error instanceof Error
          ? error.message
          : "Connection failed. Please pair again.",
    })
  }
  dispose() {
    this.generation++
    this.socketGeneration++
    if (this.deadline) clearTimeout(this.deadline)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.clearSocketDeadline()
    this.deadline = null
    this.reconnectTimer = null
    this.recoveryTimer = null
    this.statsTimer = null
    if (this.refresh) {
      clearTimeout(this.refresh.timer)
      this.refresh.reject(new Error("Session ended"))
      this.refresh = null
    }
    try {
      if (this.socket?.readyState === WebSocket.OPEN)
        this.sendSocket({ type: "leave" })
      this.socket?.close()
    } catch {
      /* Teardown is best effort. */
    }
    this.socket = null
    this.closeTransport()
    this.cipher = null
    this.secret = ""
    this.resumeTokens = []
    this.resumeRequest = null
    this.pendingSignals.clear()
    this.deferredChat = []
  }
}
