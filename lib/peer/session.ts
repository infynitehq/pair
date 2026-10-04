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
import { content, type Scope } from "../storage/content"
import { TransferManager } from "../transfer/manager"
import { nostrRelayUrls } from "./nostr-config"
import { NostrSignaling } from "./nostr-signaling"
import {
  ApiError,
  coordinationId,
  coordinationRequest,
  coordinationToken,
} from "./coordination-client"

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
  storageError: null,
  filesAvailable: false,
  transfers: [],
  pairingCode: null,
  nostrStatus: "offline",
}

export function parsePairingLink(input: string, origin: string) {
  const url = new URL(input)
  const sessionId = url.searchParams.get("pair")
  const secret = url.hash.slice(1)
  if (
    url.origin !== origin ||
    url.pathname !== "/" ||
    !sessionId ||
    !/^[a-f0-9]{32}$/.test(sessionId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(secret)
  )
    throw new ConnectionError(
      "authentication-failed",
      "Paste a complete Pair invite from this site, including its secret after #."
    )
  return { sessionId, secret }
}

type Transport = SignedDescription["transport"]
type Candidate = { negotiation: number; candidate: RTCIceCandidateInit }
const emptyIce: IceConfiguration = {
  iceServers: [],
  relayAvailable: false,
  expiresAt: null,
}
const tokenValid = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)

export class PeerSession {
  state: PeerState
  private peer: RTCPeerConnection | null = null
  private control: RTCDataChannel | null = null
  private chat: RTCDataChannel | null = null
  private files: RTCDataChannel | null = null
  private transferManager: TransferManager | null = null
  private scope: Promise<Scope> | null = null
  private applicationQueue = Promise.resolve()
  private applicationBytes = 0
  private cipher: SignalCipher | null = null
  private role: "host" | "guest" = "host"
  private sessionId = ""
  private secret = ""
  private hostSdp = ""
  private guestSdp = ""
  private candidates: Candidate[] = []
  private receiveQueue = Promise.resolve()
  private sendQueue = Promise.resolve()
  private deadline: ReturnType<typeof setTimeout> | null = null
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private generation = 0
  private seenMessages = new Set<string>()
  private channelReady = false
  private ice: IceConfiguration = emptyIce
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
  private nostr: NostrSignaling | null = null
  private nostrStarting: Promise<void> | null = null
  private nostrUrls: string[]
  private apiAuthorization = ""
  private apiAbort: AbortController | null = null
  private statusPoll: ReturnType<typeof setTimeout> | null = null
  private statusAbort: AbortController | null = null
  private authorizationDeadline: ReturnType<typeof setTimeout> | null = null
  private readyClaimant = ""
  private admittedClaimant = ""
  private codeRequest = ""

  constructor(
    private identity: DeviceIdentity,
    name: string,
    private onChange: (state: PeerState) => void,
    mode: ConnectionMode = "automatic",
    private durable = false,
    relays = nostrRelayUrls(
      process.env.NEXT_PUBLIC_NOSTR_RELAY_URLS ?? "wss://nostr.infynite.in"
    )
  ) {
    this.state = {
      ...initialState,
      deviceId: identity.deviceId,
      deviceName: name,
      mode,
    }
    this.nostrUrls = relays
  }

  private ensureNostr(generation: number): Promise<void> {
    this.nostrStarting ??= (async () => {
      const transport = await NostrSignaling.create({
        urls: this.nostrUrls,
        secret: this.secret,
        sessionId: this.sessionId,
        role: this.role,
        receive: (payload) => {
          this.receiveQueue = this.receiveQueue.then(async () => {
            if (generation === this.generation)
              await this.receiveSignal(payload, generation)
          })
          return this.receiveQueue
        },
        status: (nostrStatus) => {
          if (generation === this.generation) {
            this.update({ nostrStatus })
            if (this.state.signalingStatus !== "retired") {
              this.update({
                signalingStatus:
                  nostrStatus === "available" ? "available" : "reconnecting",
              })
              if (
                nostrStatus === "available" &&
                this.state.status === "recovering" &&
                !this.recoveryBusy
              )
                this.requestRecovery()
            }
          }
        },
        failure: (error) => {
          if (generation === this.generation) {
            if (this.state.status === "connected")
              this.update({
                nostrStatus: "offline",
                signalingStatus: "reconnecting",
              })
            else this.fail(error, "signaling-unavailable")
          }
        },
      })
      if (generation !== this.generation) {
        transport.close()
        await transport.ready().catch(() => {})
        return
      }
      this.nostr = transport
      await transport.ready()
    })()
    return this.nostrStarting
  }

  private localScope() {
    if (!this.state.peerId) throw new Error("No approved peer")
    this.scope ??= content.ensureConversation(
      this.state.peerId,
      this.state.peerName ?? "Peer"
    )
    return this.scope
  }
  private storageFailure(error: unknown) {
    this.update({
      storageError:
        error instanceof Error
          ? error.message
          : "Could not save content locally.",
    })
  }
  offerFile(file: File) {
    if (this.state.status !== "connected" || !this.transferManager)
      throw new Error("Connect before sending files.")
    this.transferManager.offer(file)
  }
  async acceptFile(id: string) {
    await this.transferManager?.accept(id)
  }
  async cancelFile(id: string) {
    await this.transferManager?.cancel(id)
  }
  enablePairingCode() {
    if (
      this.role !== "host" ||
      this.state.status !== "waiting" ||
      !this.state.pairingLink
    )
      return
    const generation = this.generation
    this.codeRequest ||= coordinationToken()
    void this.api("code.publish", {
      requestId: this.codeRequest,
      link: this.state.pairingLink,
    })
      .then((result) => {
        if (generation !== this.generation || this.state.status !== "waiting")
          return
        if (
          typeof result.code !== "string" ||
          !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(result.code)
        )
          throw new Error("Invalid pairing code")
        this.update({ pairingCode: result.code })
      })
      .catch(() => {
        if (generation === this.generation)
          this.update({
            error:
              "Pairing codes unavailable. Use this invitation’s QR code or link.",
          })
      })
  }

  async acceptDiscovery(
    requestId: string,
    deviceId: string,
    authorization: string
  ) {
    if (this.role !== "host" || !this.state.pairingLink)
      throw new Error("Create an invitation first.")
    const generation = this.generation
    await coordinationRequest(
      "discovery.accept",
      {
        requestId,
        deviceId,
        authorization,
        accepted: true,
        sessionId: this.sessionId,
        hostAuthorization: this.apiAuthorization,
        link: this.state.pairingLink,
      },
      this.apiAbort?.signal
    ).catch((error) => {
      if (generation === this.generation)
        this.update({
          error:
            "Discovery invitation could not be delivered. Share this QR code or link instead.",
        })
      throw error
    })
  }

  private api(
    operation: string,
    input: Record<string, unknown> = {},
    signal?: AbortSignal
  ) {
    return coordinationRequest(
      operation,
      {
        sessionId: this.sessionId,
        role: this.role,
        authorization: this.apiAuthorization,
        ...input,
      },
      signal && this.apiAbort
        ? AbortSignal.any([signal, this.apiAbort.signal])
        : (signal ?? this.apiAbort?.signal)
    )
  }
  private async initializeHttp(
    type: "created" | "joined",
    input: Record<string, unknown>,
    generation: number
  ) {
    if (!this.nostrUrls.length)
      throw new ConnectionError(
        "signaling-unavailable",
        "Nostr signaling must be configured. No fallback transport is used."
      )
    this.apiAuthorization = coordinationToken()
    this.apiAbort = new AbortController()
    const result = await this.api(
      type === "created" ? "session.create" : "session.join",
      input
    )
    if (generation !== this.generation) return
    const turn = await this.api("session.turn", {
      requestId: coordinationToken(),
    })
    if (generation !== this.generation) return
    if (
      result.sessionId !== this.sessionId ||
      typeof result.expiresAt !== "number" ||
      !Number.isFinite(result.expiresAt)
    )
      throw new Error("Invalid pairing session")
    if (!this.cipher) {
      const cipher = await SignalCipher.create(
        this.secret,
        this.sessionId,
        this.role
      )
      if (generation !== this.generation) return
      this.cipher = cipher
    }
    this.useIce(turn.iceConfig)
    await this.ensureNostr(generation)
    if (generation !== this.generation) return
    this.update({ expiresAt: result.expiresAt, signalingStatus: "available" })
    if (type === "created") {
      const link = new URL("/", window.location.origin)
      link.searchParams.set("pair", this.sessionId)
      link.hash = this.secret
      this.update({ status: "waiting", pairingLink: link.toString() })
      this.setDeadline(
        Math.max(1, Math.min(result.expiresAt - Date.now(), 120_000)),
        new ConnectionError(
          "invitation-expired",
          "This invite expired. Create a new one."
        )
      )
    }
    const expiresAt = result.authorizationExpiresAt
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))
      throw new Error("Invalid authorization lifetime")
    this.authorizationDeadline = setTimeout(
      () => this.retireSignaling(),
      Math.max(1, expiresAt - Date.now())
    )
    this.pollStatus(generation)
    if (type === "joined") {
      const claimant = encode(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(this.apiAuthorization)
        )
      )
      if (generation !== this.generation) return
      // Readiness is an ordinary encrypted, ordered, acknowledged frame. Sent exactly once;
      // Nostr retries the same ciphertext without resetting either sequence counter.
      this.sendSignal({ kind: "ready", claimant })
      await this.startPair(generation)
    }
  }
  private pollStatus(generation: number, attempt = 0) {
    if (
      generation !== this.generation ||
      this.everConnected ||
      ["closed", "error"].includes(this.state.status)
    )
      return
    this.statusPoll = setTimeout(
      () => {
        this.statusPoll = null
        this.statusAbort = new AbortController()
        void this.api("session.status", {}, this.statusAbort.signal)
          .then(async (result) => {
            if (generation !== this.generation || this.everConnected) return
            if (typeof result.guestClaimant === "string")
              this.admittedClaimant = result.guestClaimant
            if (
              this.role === "host" &&
              this.readyClaimant &&
              this.readyClaimant === this.admittedClaimant
            )
              await this.startPair(generation)
            this.pollStatus(generation, 0)
          })
          .catch((error) => {
            if (generation !== this.generation || this.everConnected) return
            if (
              error instanceof ApiError &&
              error.category === "SESSION_EXPIRED"
            )
              this.fail(error)
            else this.pollStatus(generation, attempt + 1)
          })
      },
      Math.min(1000 * 2 ** attempt, 8000)
    )
  }
  async refreshHistory() {
    if (!this.scope) return
    const generation = this.generation
    try {
      const scope = await this.scope
      const messages = await content.messages(scope.id, Infinity, 500)
      if (generation === this.generation) this.update({ messages })
    } catch (error) {
      this.storageFailure(error)
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
      this.sessionId = coordinationId()
      await this.initializeHttp(
        "created",
        { joinVerifier, createdAt: Date.now() },
        generation
      )
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
      await this.initializeHttp("joined", { joinToken }, generation)
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
    this.channelReady = false
    this.everConnected = false
    this.recoveryBusy = false
    this.negotiation = 0
    this.remoteNegotiation = -1
    this.transport = "initial"
    this.peerReadyNegotiation = -1
    this.readySentNegotiation = -1
    this.deferredChat = []
    this.ice = emptyIce
    this.localPolicySent = false
    this.remoteMode = null
    this.effectiveMode = null
    this.initializing = false
    this.readyClaimant = ""
    this.admittedClaimant = ""
    this.codeRequest = ""
    this.sendQueue = Promise.resolve()
    this.receiveQueue = Promise.resolve()
    this.update({
      ...initialState,
      status,
      deviceId: this.identity.deviceId,
      deviceName: this.state.deviceName,
      mode: this.state.mode,
      signalingStatus: "connecting",
      nostrStatus: "connecting",
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
  private retireSignaling() {
    this.update({ signalingStatus: "retired" })
    this.nostr?.close()
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
        const payload = await this.cipher.seal(value)
        if (generation !== this.generation) return
        await this.ensureNostr(generation)
        if (generation === this.generation) this.nostr!.send(payload)
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

  private async receiveSignal(payload: SealedSignal, generation: number) {
    if (!this.cipher) throw new Error("Unexpected signaling data")
    if (!payload || !Number.isSafeInteger(payload.seq) || payload.seq < 0)
      throw new Error("Invalid signal sequence")
    if (payload.seq < this.cipher.receivedCount) return
    let value: unknown
    try {
      value = await this.cipher.open(payload)
    } catch {
      throw new ConnectionError(
        "authentication-failed",
        "The pairing secret or encrypted signaling could not be verified."
      )
    }
    if (generation === this.generation)
      await this.receivePayload(value, generation)
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
    if (
      this.role === "host" &&
      (!this.readyClaimant || this.readyClaimant !== this.admittedClaimant)
    )
      return
    if (this.peer) return // Readiness and status polling can race.
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
    this.files?.close()
    old?.close()
    this.control = null
    this.chat = null
    this.files = null
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
        !["control", "chat", "files"].includes(channel.label)
      ) {
        channel.close()
        return
      }
      this.attachChannel(channel)
    }
    if (this.role === "host") {
      this.attachChannel(peer.createDataChannel("control", { ordered: true }))
      this.attachChannel(peer.createDataChannel("chat", { ordered: true }))
      if (this.durable)
        this.attachChannel(peer.createDataChannel("files", { ordered: true }))
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
    if (value.kind === "ready") {
      if (this.role !== "host" || !tokenValid(value.claimant))
        throw new Error("Invalid admission readiness")
      if (this.readyClaimant && this.readyClaimant !== value.claimant)
        throw new Error("Conflicting admission readiness")
      this.readyClaimant = value.claimant
      if (this.admittedClaimant === this.readyClaimant && !this.everConnected)
        await this.startPair(generation)
      return
    }
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
    if (channel.label === "files") {
      if (!this.durable || this.files) {
        channel.close()
        return
      }
      this.files = channel
      this.transferManager ??= new TransferManager(
        () => this.localScope(),
        (transfers, filesAvailable) =>
          this.update({ transfers, filesAvailable }),
        (message) => this.storageFailure(new Error(message))
      )
      this.transferManager.attach(channel)
      return
    }
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
    if (this.statusPoll) clearTimeout(this.statusPoll)
    this.statusPoll = null
    this.statusAbort?.abort()
    this.statusAbort = null
    const establishedGeneration = this.generation
    void this.api("session.established").catch(() => {
      if (establishedGeneration === this.generation)
        this.update({
          error:
            "Peer connection is active, but recovery authorization could not be recorded.",
        })
    })
    this.secret = ""
    if (this.durable) {
      const generation = this.generation
      void this.localScope()
        .then((scope) => content.messages(scope.id, Infinity, 500))
        .then((messages) => {
          if (generation !== this.generation) return
          const merged = new Map<string, PeerState["messages"][number]>(
            messages.map((message) => [
              `${message.direction}:${message.id}`,
              message,
            ])
          )
          for (const message of this.state.messages)
            merged.set(`${message.direction}:${message.id}`, message)
          this.update({
            messages: Array.from(merged.values())
              .sort((a, b) => a.timestamp - b.timestamp)
              .slice(-500),
          })
        })
        .catch((error) => this.storageFailure(error))
    }
    this.transferManager?.activate(true)
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
    this.transferManager?.activate(false)
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
    const generation = this.generation
    const result = await this.api("session.turn", {
      requestId: coordinationToken(),
    })
    if (generation === this.generation) this.useIce(result.iceConfig)
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
        (this.files !== null && this.files.readyState !== "open") ||
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
    this.transferManager?.activate(true)
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
      if (this.durable)
        void this.localScope()
          .then((scope) => content.receipt(scope, message.id))
          .catch((error) => this.storageFailure(error))
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
    if (this.durable) {
      const generation = this.generation
      const bytes = data.length * 2
      if (this.applicationBytes + bytes > 64_000)
        throw new Error("Local message write queue exceeded")
      this.applicationBytes += bytes
      this.applicationQueue = this.applicationQueue
        .then(async () => {
          if (generation !== this.generation) return
          const scope = await this.localScope()
          const incoming = {
            id: message.id,
            text: message.text,
            direction: "incoming" as const,
            status: "delivered" as const,
            timestamp: Date.now(),
          }
          const saved = await content.saveMessage(scope, incoming)
          if (generation !== this.generation) return
          if (saved && !this.seenMessages.has(message.id)) {
            this.seenMessages.add(message.id)
            if (this.seenMessages.size > 2000)
              this.seenMessages.delete(this.seenMessages.values().next().value!)
            this.update({
              messages: [
                ...this.state.messages.filter(
                  (item) =>
                    !(item.id === message.id && item.direction === "incoming")
                ),
                incoming,
              ].slice(-500),
            })
          }
          if (
            this.control?.readyState === "open" &&
            this.control.bufferedAmount <= 64_000
          )
            this.control.send(
              JSON.stringify({ v: 2, type: "chat.receipt", id: message.id })
            )
        })
        .catch((error) => this.storageFailure(error))
        .finally(() => {
          this.applicationBytes -= bytes
        })
      return
    }
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
    if (this.durable) return this.sendStoredText(value)
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

  private async sendStoredText(text: string) {
    const generation = this.generation
    const scope = await this.localScope()
    const message = {
      id: crypto.randomUUID(),
      text,
      direction: "outgoing" as const,
      status: "sent" as const,
      timestamp: Date.now(),
    }
    try {
      await content.saveMessage(scope, message)
    } catch (error) {
      this.storageFailure(error)
      throw error
    }
    if (
      generation !== this.generation ||
      this.state.status !== "connected" ||
      this.chat?.readyState !== "open"
    ) {
      await content.saveMessage(scope, { ...message, status: "failed" })
      throw new Error(
        "Connection changed. Your message is saved locally but was not sent."
      )
    }
    this.update({
      messages: [...this.state.messages, message].slice(-500),
      storageError: null,
    })
    try {
      if (this.chat.bufferedAmount > 64_000)
        throw new Error("The connection is busy. Your message was not sent.")
      this.chat.send(
        JSON.stringify({ v: 2, type: "chat.message", id: message.id, text })
      )
    } catch (error) {
      await content.saveMessage(scope, { ...message, status: "failed" })
      this.update({
        messages: this.state.messages.map((item) =>
          item.id === message.id ? { ...item, status: "failed" } : item
        ),
      })
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
    this.statusAbort?.abort()
    this.statusAbort = null
    if (this.statusPoll) clearTimeout(this.statusPoll)
    if (this.authorizationDeadline) clearTimeout(this.authorizationDeadline)
    this.statusPoll = null
    this.authorizationDeadline = null
    this.apiAbort?.abort()
    this.apiAbort = null
    if (this.apiAuthorization && this.sessionId) {
      // Best effort only; absolute expiry is the authoritative cleanup mechanism.
      void coordinationRequest("session.close", {
        sessionId: this.sessionId,
        role: this.role,
        authorization: this.apiAuthorization,
      }).catch(() => {})
    }
    this.apiAuthorization = ""
    this.transferManager?.dispose()
    this.transferManager = null
    this.scope = null
    this.generation++
    this.nostr?.close()
    this.nostr = null
    this.nostrStarting = null
    if (this.deadline) clearTimeout(this.deadline)
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.deadline = null
    this.recoveryTimer = null
    this.statsTimer = null
    this.closeTransport()
    this.cipher = null
    this.secret = ""
    this.deferredChat = []
  }
}
