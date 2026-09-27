export type SessionStatus =
  | "idle"
  | "creating"
  | "waiting"
  | "connecting"
  | "verifying"
  | "connected"
  | "recovering"
  | "closed"
  | "error"

export interface ChatMessage {
  id: string
  text: string
  direction: "incoming" | "outgoing"
  status: "sent" | "delivered"
  timestamp: number
}

export interface PeerState {
  status: SessionStatus
  deviceName: string
  deviceId: string
  peerName: string | null
  peerId: string | null
  pairingLink: string | null
  expiresAt: number | null
  verificationCode: string | null
  approved: boolean
  peerApproved: boolean
  route: "direct" | "relay" | "checking" | null
  messages: ChatMessage[]
  error: string | null
  errorCode: FailureCode | null
  mode: ConnectionMode
  signalingStatus:
    "offline" | "connecting" | "available" | "reconnecting" | "retired"
  relayAvailable: boolean | null
  recoveryAttempt: number
  connectedAt: number | null
  roundTripTimeMs: number | null
}

export type ConnectionMode = "automatic" | "direct" | "relay"
export type FailureCode =
  | "signaling-unavailable"
  | "invitation-expired"
  | "peer-left"
  | "authentication-failed"
  | "direct-unavailable"
  | "relay-unavailable"
  | "connection-interrupted"
  | "protocol-error"

export interface PairSessionHook extends PeerState {
  ready: boolean
  createPairing: () => Promise<void>
  joinPairing: (link: string) => Promise<void>
  approvePeer: () => void
  sendMessage: (text: string) => void
  disconnect: () => void
  setDeviceName: (name: string) => void
  setConnectionMode: (mode: ConnectionMode) => void
  retryConnection: () => void
  exportDiagnostics: () => string
}
