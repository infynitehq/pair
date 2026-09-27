import assert from "node:assert/strict"
import { test } from "node:test"
import {
  connectionCode,
  encode,
  generateIdentity,
  SignalCipher,
  signDescription,
  verifyDescription,
} from "./crypto"
import { parsePairingLink } from "./session"

test("signaling authenticates both directions and rejects replay, reflection, tampering and wrong secrets", async () => {
  const secret = encode(crypto.getRandomValues(new Uint8Array(32)))
  const host = await SignalCipher.create(secret, "session-a", "host")
  const guest = await SignalCipher.create(secret, "session-a", "guest")
  const first = await host.seal({
    kind: "candidate",
    candidate: "private-network-data",
  })
  assert.ok(!JSON.stringify(first).includes("private-network-data"))
  await assert.rejects(() => host.open(first))
  const wrong = await SignalCipher.create(
    encode(crypto.getRandomValues(new Uint8Array(32))),
    "session-a",
    "guest"
  )
  await assert.rejects(() => wrong.open(first))
  const otherSession = await SignalCipher.create(secret, "session-b", "guest")
  await assert.rejects(() => otherSession.open(first))
  const tampered = {
    ...first,
    ciphertext:
      (first.ciphertext[0] === "A" ? "B" : "A") + first.ciphertext.slice(1),
  }
  await assert.rejects(() => guest.open(tampered))
  assert.deepEqual(await guest.open(first), {
    kind: "candidate",
    candidate: "private-network-data",
  })
  await assert.rejects(() => guest.open(first))
  assert.deepEqual(await host.open(await guest.seal({ accepted: true })), {
    accepted: true,
  })
})

test("signals cannot be reordered", async () => {
  const secret = encode(crypto.getRandomValues(new Uint8Array(32)))
  const host = await SignalCipher.create(secret, "session", "host")
  const guest = await SignalCipher.create(secret, "session", "guest")
  const first = await host.seal("first")
  const second = await host.seal("second")
  await assert.rejects(() => guest.open(second))
  assert.equal(await guest.open(first), "first")
  assert.equal(await guest.open(second), "second")
})

test("device signature binds identity, session, role, name and transport description", async () => {
  const identity = await generateIdentity()
  assert.equal(identity.privateKey.extractable, false)
  const description = await signDescription(identity, {
    kind: "description",
    v: 2,
    negotiation: 0,
    transport: "initial",
    mode: "automatic",
    sessionId: "session",
    role: "host",
    name: "Laptop",
    publicKey: identity.publicKey,
    sdp: "a=fingerprint:sha-256 ORIGINAL",
  })
  assert.equal(await verifyDescription(description), true)
  for (const patch of [
    { sessionId: "other" },
    { role: "guest" as const },
    { name: "Impostor" },
    { sdp: "a=fingerprint:sha-256 SUBSTITUTED" },
  ]) {
    assert.equal(await verifyDescription({ ...description, ...patch }), false)
  }
  const other = await generateIdentity()
  assert.equal(
    await verifyDescription({ ...description, publicKey: other.publicKey }),
    false
  )
  assert.equal(
    await connectionCode("session", "host", "guest"),
    await connectionCode("session", "host", "guest")
  )
  assert.notEqual(
    await connectionCode("session", "host", "guest"),
    await connectionCode("session", "guest", "host")
  )
})

test("pairing links require the same origin and a full-length secret", () => {
  const secret = encode(crypto.getRandomValues(new Uint8Array(32)))
  const id = encode(crypto.getRandomValues(new Uint8Array(24)))
  assert.deepEqual(
    parsePairingLink(
      `https://pair.example/?pair=${id}#${secret}`,
      "https://pair.example"
    ),
    { sessionId: id, secret }
  )
  assert.throws(() =>
    parsePairingLink(
      `https://other.example/?pair=${id}#${secret}`,
      "https://pair.example"
    )
  )
  assert.throws(() =>
    parsePairingLink(`https://pair.example/?pair=${id}`, "https://pair.example")
  )
  assert.throws(() =>
    parsePairingLink(
      `https://pair.example/?pair=${id}#123456`,
      "https://pair.example"
    )
  )
})
