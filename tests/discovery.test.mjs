import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { hkdfSync, createHash, randomBytes } from "node:crypto"
import test from "node:test"
import ts from "typescript"

// Execute the actual service without requiring a Next server or Redis secrets.
const source = await readFile(
  new URL("../server/coordination.ts", import.meta.url),
  "utf8"
)
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText
const { CoordinationService } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
)

function setup() {
  let now = 1_800_000_000_000
  const data = new Map()
  let queue = Promise.resolve()
  const store = {
    transact(keys, change) {
      const operation = queue.then(() => {
        const records = new Map(
          keys.map((key) => {
            const value = data.get(key)
            return [
              key,
              value && value.expiresAt > now ? structuredClone(value) : null,
            ]
          })
        )
        const result = change(records)
        for (const [key, value] of records) {
          if (value) data.set(key, value)
          else data.delete(key)
        }
        return result
      })
      queue = operation.catch(() => {})
      return operation
    },
  }
  const context = {
    origin: "https://app.local",
    ip: "local-development",
    discoveryAllowed: true,
  }
  const service = new CoordinationService(
    store,
    {
      issue: () => ({ iceServers: [], expiresAt: null, relayAvailable: false }),
    },
    randomBytes(32).toString("base64url"),
    () => now
  )
  const a = {
    deviceId: "a".repeat(32),
    authorization: randomBytes(32).toString("base64url"),
    name: "Normal Chrome",
  }
  const b = {
    deviceId: "b".repeat(32),
    authorization: randomBytes(32).toString("base64url"),
    name: "Incognito Chrome",
  }
  const c = {
    deviceId: "c".repeat(32),
    authorization: randomBytes(32).toString("base64url"),
    name: "Third browser",
  }
  const call = (operation, device, input = {}, customContext = context) =>
    service.execute(
      operation,
      { ...device, ...input, protocol: 2, transport: "nostr-http-v1" },
      customContext
    )
  const presence = async () => {
    for (const device of [a, b, c]) await call("discovery.presence", device)
  }
  const request = (from, to, requestId = "d".repeat(32)) =>
    call("discovery.request", from, {
      targetId: to.deviceId,
      requestId,
      createdAt: now,
    })
  const accept = async (requestId) => {
    const sessionId = "f".repeat(32)
    const authorization = randomBytes(32).toString("base64url")
    const secret = randomBytes(32).toString("base64url")
    const proof = hkdfSync(
      "sha256",
      Buffer.from(secret, "base64url"),
      Buffer.alloc(0),
      Buffer.from("pair.admission.v2"),
      32
    )
    await call(
      "session.create",
      {},
      {
        sessionId,
        authorization,
        joinVerifier: createHash("sha256")
          .update(Buffer.from(proof).toString("base64url"))
          .digest("base64url"),
        createdAt: now,
      }
    )
    const link = `${context.origin}/?pair=${sessionId}#${secret}`
    await call("discovery.accept", b, {
      requestId,
      accepted: true,
      sessionId,
      hostAuthorization: authorization,
      link,
    })
    return link
  }
  return {
    a,
    b,
    c,
    call,
    presence,
    request,
    accept,
    advance: (ms) => {
      now += ms
    },
  }
}

test("crossed simultaneous requests become one handshake with one recipient", async () => {
  const f = setup()
  await f.presence()
  const [first, second] = await Promise.all([
    f.request(f.a, f.b),
    f.request(f.b, f.a, "e".repeat(32)),
  ])
  assert.equal(first.requestId, "d".repeat(32))
  assert.equal(second.incoming.id, first.requestId)
  assert.equal(second.incoming.name, f.a.name)
  const a = await f.call("discovery.list", f.a)
  const b = await f.call("discovery.list", f.b)
  assert.equal(a.outgoing.length, 1)
  assert.equal(a.requests.length, 0)
  assert.equal(b.outgoing.length, 0)
  assert.equal(b.requests.length, 1)
})

test("pending participants cannot initiate or receive an unrelated request", async () => {
  const f = setup()
  await f.presence()
  await f.request(f.a, f.b)
  for (const [from, to] of [
    [f.b, f.c],
    [f.c, f.a],
    [f.c, f.b],
    [f.a, f.c],
  ]) {
    await assert.rejects(f.request(from, to, "e".repeat(32)), {
      code: "DEVICE_BUSY",
    })
  }
})

test("sender cancellation removes the recipient prompt and permits another request", async () => {
  const f = setup()
  await f.presence()
  const r = await f.request(f.a, f.b)
  await assert.rejects(
    f.call("discovery.cancel", f.c, { requestId: r.requestId }),
    { code: "UNAUTHORIZED" }
  )
  assert.equal(
    (await f.call("discovery.cancel", f.a, { requestId: r.requestId }))
      .cancelled,
    true
  )
  assert.equal((await f.call("discovery.list", f.b)).requests.length, 0)
  assert.equal((await f.call("discovery.list", f.a)).outgoing.length, 0)
  await f.request(f.a, f.b, "e".repeat(32))
})

test("decline is visible to the sender and frees both browsers", async () => {
  const f = setup()
  await f.presence()
  const r = await f.request(f.a, f.b)
  await f.call("discovery.accept", f.b, {
    requestId: r.requestId,
    accepted: false,
  })
  const result = await f.call("discovery.list", f.a)
  assert.equal(result.results[0].accepted, false)
  assert.equal(result.outgoing.length, 0)
  await f.request(f.b, f.a, "e".repeat(32))
})

test("leaving discovery withdraws pending requests but retains an accepted invitation", async () => {
  const f = setup()
  await f.presence()
  await f.request(f.a, f.b)
  await f.call("discovery.leave", f.b)
  assert.equal((await f.call("discovery.list", f.a)).outgoing.length, 0)
  await f.call("discovery.presence", f.b)
  const next = await f.request(f.a, f.b, "e".repeat(32))
  const link = await f.accept(next.requestId)
  await f.call("discovery.leave", f.b)
  assert.equal((await f.call("discovery.list", f.a)).results[0].link, link)
})

test("acceptance wins a later cancellation without losing the invitation", async () => {
  const f = setup()
  await f.presence()
  const r = await f.request(f.a, f.b)
  const link = await f.accept(r.requestId)
  assert.equal(
    (await f.call("discovery.cancel", f.a, { requestId: r.requestId }))
      .cancelled,
    false
  )
  assert.equal((await f.call("discovery.list", f.a)).results[0].link, link)
})

test("cancellation before acceptance makes the old request unavailable", async () => {
  const f = setup()
  await f.presence()
  const r = await f.request(f.a, f.b)
  await f.call("discovery.cancel", f.a, { requestId: r.requestId })
  await assert.rejects(f.accept(r.requestId), { code: "REQUEST_EXPIRED" })
})

test("expired requests disappear and discovery groups remain isolated by origin", async () => {
  const f = setup()
  await f.presence()
  await f.request(f.a, f.b)
  f.advance(61_000)
  await f.presence()
  assert.equal((await f.call("discovery.list", f.a)).outgoing.length, 0)
  assert.equal((await f.call("discovery.list", f.b)).requests.length, 0)
  await f.call(
    "discovery.presence",
    f.c,
    {},
    {
      origin: "https://other.local",
      ip: "local-development",
      discoveryAllowed: true,
    }
  )
  const isolated = await f.call(
    "discovery.list",
    f.c,
    {},
    {
      origin: "https://other.local",
      ip: "local-development",
      discoveryAllowed: true,
    }
  )
  assert.equal(isolated.devices.length, 0)
})

test("an expired recipient presence releases the sender's pending request", async () => {
  const f = setup()
  await f.presence()
  await f.request(f.a, f.b)
  f.advance(46_000)
  await f.call("discovery.presence", f.a)
  const result = await f.call("discovery.list", f.a)
  assert.equal(result.outgoing.length, 0)
  assert.equal(result.devices.length, 0)
  await f.call("discovery.presence", f.b)
  await f.request(f.a, f.b, "e".repeat(32))
})
