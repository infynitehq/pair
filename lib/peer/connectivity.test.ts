import assert from "node:assert/strict"
import test from "node:test"
import {
  ConnectionError,
  readIceConfiguration,
  redactedDiagnostics,
  rtcConfiguration,
} from "./connectivity"
import { initialState } from "./session"

test("direct-only removes TURN and TURNS from mixed servers without mutating configuration", () => {
  const config = readIceConfiguration({
    iceServers: [
      {
        urls: [
          "stun:stun.example:3478",
          "turn:relay.example:3478",
          "turns:relay.example:5349",
        ],
        username: "temporary-user",
        credential: "temporary-password",
      },
      {
        urls: ["turn:only-relay.example:3478"],
        username: "user",
        credential: "password",
      },
      { urls: ["stuns:secure-stun.example:5349"] },
    ],
    relayAvailable: true,
    expiresAt: Date.now() + 60_000,
  })
  const original = structuredClone(config)
  const direct = rtcConfiguration(config, "direct")
  assert.equal(direct.iceTransportPolicy, "all")
  assert.deepEqual(
    direct.iceServers?.map((server) => server.urls),
    [["stun:stun.example:3478"], ["stuns:secure-stun.example:5349"]]
  )
  assert.deepEqual(config, original)
  assert.deepEqual(
    rtcConfiguration(config, "automatic").iceServers,
    config.iceServers
  )
  assert.equal(rtcConfiguration(config, "relay").iceTransportPolicy, "relay")
})

test("relay-only without a TURN server reports an actionable error even if advertised available", () => {
  for (const relayAvailable of [false, true]) {
    assert.throws(
      () =>
        rtcConfiguration(
          {
            iceServers: [{ urls: ["stun:example:3478"] }],
            relayAvailable,
            expiresAt: null,
          },
          "relay"
        ),
      (error: unknown) =>
        error instanceof ConnectionError &&
        error.code === "relay-unavailable" &&
        /TURN/.test(error.message) &&
        /Choose Automatic|configure TURN/.test(error.message)
    )
  }
})

test("expired relay credentials and malformed ICE URLs are rejected", () => {
  assert.throws(
    () =>
      readIceConfiguration({
        iceServers: [],
        relayAvailable: true,
        expiresAt: Date.now() - 1,
      }),
    /expired/
  )
  assert.throws(
    () =>
      readIceConfiguration({
        iceServers: [{ urls: ["turn:relay.example"] }],
        relayAvailable: true,
        expiresAt: null,
      }),
    /credentials/
  )
  assert.throws(
    () =>
      readIceConfiguration({
        iceServers: [{ urls: ["https://relay.example"] }],
        relayAvailable: false,
        expiresAt: null,
      }),
    /URL/
  )
})

test("diagnostics export only operational fields, excluding keys, IDs, SDP and chat text", () => {
  const state = {
    ...initialState,
    status: "recovering" as const,
    mode: "relay" as const,
    recoveryAttempt: 1,
    deviceId: "private-device-id",
    peerId: "private-peer-id",
    deviceName: "Private local name",
    peerName: "Private remote name",
    pairingLink: "https://example/?pair=private-session-id#private-secret-key",
    verificationCode: "PRIVATE CODE",
    error: "v=0\r\na=ice-pwd:private-sdp-secret",
    errorCode: "connection-interrupted" as const,
    publicKey: "private-public-key",
    privateKey: "private-signing-key",
    sdp: "private-sdp-body",
    messages: [
      {
        id: "private-message-id",
        text: "private-chat-text",
        direction: "incoming" as const,
        status: "delivered" as const,
        timestamp: 123,
      },
    ],
  }
  const exported = redactedDiagnostics(state)
  assert.doesNotMatch(exported, /private|PRIVATE|v=0|ice-pwd/i)
  const diagnostic = JSON.parse(exported)
  assert.deepEqual(
    Object.keys(diagnostic).sort(),
    [
      "version",
      "exportedAt",
      "status",
      "mode",
      "signaling",
      "route",
      "relayAvailable",
      "roundTripTimeMs",
      "durationSeconds",
      "recoveryAttempt",
      "errorCode",
    ].sort()
  )
  assert.equal(diagnostic.status, "recovering")
  assert.equal(diagnostic.errorCode, "connection-interrupted")
  assert.equal(diagnostic.recoveryAttempt, 1)
})
