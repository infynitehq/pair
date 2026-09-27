import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import test from "node:test"
import { createIceProvider } from "./ice"

const secret = "test-only-secret-with-at-least-32-characters"
const configured = {
  TURN_URLS:
    "turn:relay.example:3478?transport=udp,turns:relay.example:5349?transport=tcp",
  TURN_SHARED_SECRET: secret,
}

test("empty and STUN-only configurations do not advertise relay", () => {
  assert.deepEqual(createIceProvider({}).issue("alice"), {
    iceServers: [],
    expiresAt: null,
    relayAvailable: false,
  })
  assert.deepEqual(
    createIceProvider({
      STUN_URLS: " stun:stun.example:3478,stuns:[::1]:5349 ",
    }).issue("alice"),
    {
      iceServers: [{ urls: ["stun:stun.example:3478", "stuns:[::1]:5349"] }],
      expiresAt: null,
      relayAvailable: false,
    }
  )
})

test("REST credentials use exact Unix expiry and standard base64 HMAC-SHA1", (t) => {
  t.mock.method(Date, "now", () => 1_800_000_000_987)
  const provider = createIceProvider({
    ...configured,
    STUN_URLS: "stun:stun.example",
  })
  const result = provider.issue("private-participant@example.com")
  const turn = result.iceServers[1]
  assert.equal(result.expiresAt, 1_800_000_600_000)
  assert.equal(result.relayAvailable, true)
  assert.match(turn.username!, /^1800000600:[a-f0-9]{64}$/)
  assert.equal(
    turn.credential,
    createHmac("sha1", secret).update(turn.username!).digest("base64")
  )
  assert.equal(Buffer.from(turn.credential!, "base64").length, 20)
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(!JSON.stringify(result).includes("private-participant"))
  t.mock.method(Date, "now", () => 1_800_000_010_000)
  assert.equal(provider.issue("alice").expiresAt, 1_800_000_610_000)
})

test("issuance is participant-specific and randomized; credentials cannot be swapped", (t) => {
  t.mock.method(Date, "now", () => 1_800_000_000_000)
  const provider = createIceProvider(configured)
  const alice = provider.issue("alice").iceServers[0]
  const bob = provider.issue("bob").iceServers[0]
  const again = provider.issue("alice").iceServers[0]
  assert.equal(new Set([alice.username, bob.username, again.username]).size, 3)
  assert.notEqual(
    alice.credential,
    createHmac("sha1", secret).update(bob.username!).digest("base64")
  )
  alice.urls.length = 0
  assert.equal(provider.issue("bob").iceServers[0].urls.length, 2)
})

test("TTL boundaries and IPv6 TURN URLs are supported", (t) => {
  t.mock.method(Date, "now", () => 1_800_000_000_000)
  for (const ttl of [60, 3600]) {
    const result = createIceProvider({
      ...configured,
      TURN_URLS: "turn:[::1]:3478?transport=tcp",
      TURN_CREDENTIAL_TTL_SECONDS: String(ttl),
    }).issue("alice")
    assert.equal(result.expiresAt, (1_800_000_000 + ttl) * 1000)
  }
})

test("partial TURN and invalid TTL configurations fail without echoing values", () => {
  const invalid: Record<string, string | undefined>[] = [
    { TURN_URLS: configured.TURN_URLS },
    { TURN_SHARED_SECRET: secret },
    { TURN_CREDENTIAL_TTL_SECONDS: "600" },
    { ...configured, TURN_SHARED_SECRET: "short" },
    ...["59", "3601", "NaN", "60.5", "6e2", secret].map((ttl) => ({
      ...configured,
      TURN_CREDENTIAL_TTL_SECONDS: ttl,
    })),
  ]
  for (const env of invalid) {
    assert.throws(
      () => createIceProvider(env),
      (error: Error) => {
        assert.ok(!error.message.includes(secret))
        assert.ok(!error.message.includes("short"))
        return true
      }
    )
  }
})

test("malformed ICE URLs and userinfo are rejected without leaking input", () => {
  const bad = [
    "https:relay.example",
    "turn://relay.example",
    `turn:${secret}@relay.example`,
    "turn:relay.example/path",
    "turn:relay.example#fragment",
    "turn:relay.example?transport=sctp",
    "turn:relay.example?transport=udp&x=y",
    "turn:relay.example:0",
    "turn:relay.example:65536",
    "turn:[:::1]",
    "turn:999.1.1.1",
    "turn:-bad.example",
    "turn:relay..example",
    "turn:relay.example,",
    "turns:relay.example?transport=udp",
  ]
  for (const value of bad) {
    assert.throws(
      () => createIceProvider({ ...configured, TURN_URLS: value }),
      (error: Error) => {
        assert.equal(error.message, "Invalid TURN_URLS configuration")
        return true
      }
    )
  }
  for (const value of [
    "turn:relay.example",
    "stun:stun.example?transport=udp",
    `stun:${secret}@stun.example`,
  ]) {
    assert.throws(
      () => createIceProvider({ STUN_URLS: value }),
      /Invalid STUN_URLS configuration/
    )
  }
})
