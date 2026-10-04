import type { ConnectionMode, FailureCode, PeerState } from "./types"

export interface IceConfiguration {
  iceServers: RTCIceServer[]
  expiresAt: number | null
  relayAvailable: boolean
}

export class ConnectionError extends Error {
  constructor(
    public code: FailureCode,
    message: string
  ) {
    super(message)
    this.name = "ConnectionError"
  }
}

export function readIceConfiguration(value: unknown): IceConfiguration {
  if (!value || typeof value !== "object")
    throw new ConnectionError("protocol-error", "Invalid ICE configuration")
  const config = value as IceConfiguration
  if (
    !Array.isArray(config.iceServers) ||
    config.iceServers.length > 16 ||
    typeof config.relayAvailable !== "boolean" ||
    (config.expiresAt !== null &&
      (!Number.isFinite(config.expiresAt) || config.expiresAt! <= Date.now()))
  )
    throw new ConnectionError(
      "relay-unavailable",
      "The relay configuration is invalid or expired."
    )
  for (const server of config.iceServers) {
    if (
      !server ||
      !Array.isArray(server.urls) ||
      !server.urls.length ||
      server.urls.length > 16 ||
      !server.urls.every(
        (url) =>
          typeof url === "string" &&
          /^(stun|stuns|turn|turns):[^\s@]+$/.test(url)
      )
    )
      throw new ConnectionError("protocol-error", "Invalid ICE server URL")
    if (
      server.urls.some((url) => /^turns?:/.test(url)) &&
      (typeof server.username !== "string" ||
        typeof server.credential !== "string" ||
        server.username.length > 512 ||
        server.credential.length > 512)
    )
      throw new ConnectionError(
        "relay-unavailable",
        "Missing temporary relay credentials"
      )
  }
  return config
}

export function rtcConfiguration(
  config: IceConfiguration,
  mode: ConnectionMode
): RTCConfiguration {
  const iceServers = config.iceServers
    .map((server) => ({
      ...server,
      urls: (server.urls as string[]).filter(
        (url) => mode !== "direct" || !/^turns?:/.test(url)
      ),
    }))
    .filter((server) => server.urls.length)
  if (
    mode === "relay" &&
    !iceServers.some((server) =>
      server.urls.some((url) => /^turns?:/.test(url))
    )
  )
    throw new ConnectionError(
      "relay-unavailable",
      "Relay-only mode needs a configured TURN server. Choose Automatic or configure TURN."
    )
  return { iceServers, iceTransportPolicy: mode === "relay" ? "relay" : "all" }
}

export function redactedDiagnostics(state: PeerState): string {
  return JSON.stringify(
    {
      version: 2,
      exportedAt: new Date().toISOString(),
      status: state.status,
      mode: state.mode,
      signaling: state.signalingStatus,
      nostrStatus: state.nostrStatus,
      route: state.route,
      relayAvailable: state.relayAvailable,
      roundTripTimeMs: state.roundTripTimeMs,
      durationSeconds: state.connectedAt
        ? Math.max(0, Math.floor((Date.now() - state.connectedAt) / 1000))
        : null,
      recoveryAttempt: state.recoveryAttempt,
      errorCode: state.errorCode,
    },
    null,
    2
  )
}
