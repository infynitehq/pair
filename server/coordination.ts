import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
import type { CoordinationStore, StoredRecord } from "./coordination-store"
import type { IceProvider, IceConfiguration } from "./ice"

export class CoordinationError extends Error {
  constructor(
    public code: string,
    public status = 400
  ) {
    super(code)
  }
}
const fail = (code: string, status = 400): never => {
  throw new CoordinationError(code, status)
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("base64url")
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
export const validToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)
const token = (value: unknown) =>
  validToken(value) ? value : fail("INVALID_INPUT")
const id = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{32}$/.test(value)
    ? value
    : fail("INVALID_INPUT")
const role = (value: unknown): "host" | "guest" =>
  value === "host" || value === "guest" ? value : fail("INVALID_INPUT")
interface Member {
  authorization: string
  established: boolean
  turnRequest?: string
  turnAt?: number
  ice?: IceConfiguration
}
interface Session extends StoredRecord {
  origin: string
  verifier: string
  pairingExpiresAt: number
  host: Member
  guest?: Member
  closed?: boolean
  code?: string
}
interface Code extends StoredRecord {
  origin: string
  sessionId: string
  encrypted: string
  claimant?: string
  revoked?: boolean
}
interface Presence extends StoredRecord {
  authorization: string
  name: string
}
interface Group extends StoredRecord {
  devices: Record<string, Presence>
  requests: Record<
    string,
    {
      from: string
      to: string
      name: string
      expiresAt: number
      accepted?: boolean
      encrypted?: string
      sessionId?: string
    }
  >
}
export interface CoordinationContext {
  ip: string
  origin: string
  discoveryAllowed: boolean
}

/** Transport-independent, synchronous CAS reducers. No authoritative process-local state. */
export class CoordinationService {
  constructor(
    private store: CoordinationStore,
    private ice: IceProvider,
    private encryptionKey?: string,
    private now = Date.now
  ) {}
  private key() {
    if (!validToken(this.encryptionKey))
      return fail("RENDEZVOUS_UNAVAILABLE", 503)
    const key = Buffer.from(this.encryptionKey, "base64url")
    if (key.length !== 32) return fail("RENDEZVOUS_UNAVAILABLE", 503)
    return key
  }
  private encrypt(link: string) {
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv)
    return Buffer.concat([
      iv,
      cipher.update(link, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64url")
  }
  private decrypt(value: string) {
    const data = Buffer.from(value, "base64url")
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key(),
      data.subarray(0, 12)
    )
    cipher.setAuthTag(data.subarray(-16))
    return Buffer.concat([
      cipher.update(data.subarray(12, -16)),
      cipher.final(),
    ]).toString("utf8")
  }
  private session(
    records: Map<string, StoredRecord | null>,
    sessionId: string,
    origin: string,
    admission = false
  ) {
    const session = records.get(`session:${sessionId}`) as Session | null
    const now = this.now()
    if (
      !session ||
      session.expiresAt <= now ||
      session.closed ||
      ((!session.host.established || !session.guest?.established) &&
        session.pairingExpiresAt <= now) ||
      (admission && session.pairingExpiresAt <= now)
    )
      return fail("SESSION_EXPIRED", 410)
    if (session.origin !== origin) return fail("UNAUTHORIZED", 401)
    return session
  }
  private authorize(session: Session, input: Record<string, unknown>) {
    const member = session[role(input.role)]
    if (
      !member ||
      !equal(member.authorization, hash(token(input.authorization)))
    )
      return fail("UNAUTHORIZED", 401)
    return member
  }
  private invitation(
    session: Session,
    sessionId: string,
    link: unknown,
    origin: string
  ) {
    if (typeof link !== "string" || link.length > 2048)
      return fail("INVALID_INPUT")
    let url: URL
    try {
      url = new URL(link)
    } catch {
      return fail("INVALID_INPUT")
    }
    if (
      url.origin !== origin ||
      url.pathname !== "/" ||
      url.searchParams.get("pair") !== sessionId ||
      !validToken(url.hash.slice(1))
    )
      return fail("INVALID_INPUT")
    const proof = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(url.hash.slice(1), "base64url"),
        Buffer.alloc(0),
        Buffer.from("pair.admission.v2"),
        32
      )
    ).toString("base64url")
    if (!equal(hash(proof), session.verifier)) return fail("UNAUTHORIZED", 401)
    return link
  }
  private async limit(
    context: CoordinationContext,
    operation: string,
    max: number
  ) {
    const key = `rate:${hash(context.ip)}:${operation}`
    const allowed = await this.store.transact([key], (records) => {
      const now = this.now()
      const value = records.get(key)
      const counter =
        value && value.expiresAt > now
          ? value
          : { count: 0, expiresAt: now + 60_000 }
      if (Number(counter.count) >= max) return false
      counter.count = Number(counter.count) + 1
      records.set(key, counter)
      return true
    })
    if (!allowed) fail("RATE_LIMITED", 429)
  }
  async execute(
    operation: string,
    input: Record<string, unknown>,
    context: CoordinationContext
  ): Promise<Record<string, unknown>> {
    if (input.protocol !== 2 || input.transport !== "nostr-http-v1")
      return fail("PROTOCOL_MISMATCH", 409)
    await this.limit(
      context,
      operation,
      operation === "code.resolve"
        ? 5
        : operation === "session.create"
          ? 20
          : operation === "discovery.request"
            ? 10
            : 120
    )
    const now = this.now()
    if (operation.startsWith("discovery."))
      return this.discovery(operation, input, context)
    if (operation === "code.resolve") {
      const code = this.code(input.code)
      const claimant = hash(token(input.claimant))
      const record = await this.store.transact(
        [`code:${code}`],
        (records) => records.get(`code:${code}`) as Code | null
      )
      if (!record) return fail("CODE_UNAVAILABLE", 410)
      const encrypted = await this.store.transact(
        [`code:${code}`, `session:${record.sessionId}`],
        (records) => {
          const current = records.get(`code:${code}`) as Code | null
          if (
            !current ||
            current.revoked ||
            current.origin !== context.origin ||
            current.expiresAt <= this.now() ||
            current.sessionId !== record.sessionId ||
            (current.claimant && current.claimant !== claimant)
          )
            return fail("CODE_UNAVAILABLE", 410)
          const session = this.session(
            records,
            current.sessionId,
            context.origin,
            true
          )
          if (session.guest) return fail("CODE_UNAVAILABLE", 410)
          current.claimant = claimant
          return current.encrypted
        }
      )
      return { link: this.decrypt(encrypted) }
    }
    const sessionId = id(input.sessionId)
    const sessionKey = `session:${sessionId}`
    if (operation === "session.create") {
      if (
        typeof input.createdAt !== "number" ||
        !Number.isSafeInteger(input.createdAt) ||
        input.createdAt > now + 30_000 ||
        input.createdAt < now - 120_000
      )
        return fail("REQUEST_EXPIRED", 410)
      const verifier = token(input.joinVerifier)
      const authorization = hash(token(input.authorization))
      return this.store.transact([sessionKey], (records) => {
        const now = this.now()
        let session = records.get(sessionKey) as Session | null
        if (session) {
          if (
            session.closed ||
            session.expiresAt <= now ||
            session.pairingExpiresAt <= now
          )
            return fail("SESSION_EXPIRED", 410)
          if (
            !equal(session.host.authorization, authorization) ||
            session.origin !== context.origin ||
            !equal(session.verifier, verifier)
          )
            return fail("CONFLICT", 409)
        } else {
          session = {
            origin: context.origin,
            verifier,
            host: { authorization, established: false },
            pairingExpiresAt: now + 120_000,
            expiresAt: now + 7_200_000,
          }
          records.set(sessionKey, session)
        }
        return {
          sessionId,
          expiresAt: session.pairingExpiresAt,
          authorizationExpiresAt: session.expiresAt,
        }
      })
    }
    const publishCode =
      operation === "code.publish"
        ? Array.from(
            createHash("sha256")
              .update(token(input.requestId))
              .digest()
              .subarray(0, 8),
            (byte) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[byte & 31]
          ).join("")
        : undefined
    const codeKey = publishCode ? `code:${publishCode}` : undefined
    const snapshot =
      operation === "code.revoke" || operation === "session.close"
        ? await this.store.transact(
            [sessionKey],
            (records) => records.get(sessionKey) as Session | null
          )
        : null
    const oldCodeKey = snapshot?.code ? `code:${snapshot.code}` : undefined
    return this.store.transact(
      [
        sessionKey,
        ...(codeKey ? [codeKey] : []),
        ...(oldCodeKey ? [oldCodeKey] : []),
      ],
      (records) => {
        const now = this.now()
        const raw = records.get(sessionKey) as Session | null
        if (
          operation === "session.close" &&
          raw?.closed &&
          raw.expiresAt > this.now()
        ) {
          if (raw.origin !== context.origin) return fail("UNAUTHORIZED", 401)
          this.authorize(raw, input)
          return { closed: true }
        }
        const session = this.session(
          records,
          sessionId,
          context.origin,
          operation === "session.join" || operation === "code.publish"
        )
        if (operation === "session.join") {
          if (!equal(hash(token(input.joinToken)), session.verifier))
            return fail("UNAUTHORIZED", 401)
          const authorization = hash(token(input.authorization))
          if (
            session.guest &&
            !equal(session.guest.authorization, authorization)
          )
            return fail("SESSION_FULL", 409)
          session.guest ??= { authorization, established: false }
          return {
            sessionId,
            expiresAt: session.pairingExpiresAt,
            authorizationExpiresAt: session.expiresAt,
          }
        }
        const member = this.authorize(session, input)
        switch (operation) {
          case "session.status":
            return {
              guestJoined: !!session.guest,
              guestClaimant: session.guest?.authorization,
              established:
                session.host.established && !!session.guest?.established,
              expiresAt: session.pairingExpiresAt,
              authorizationExpiresAt: session.expiresAt,
            }
          case "session.established":
            if (!session.guest) return fail("PEER_NOT_READY", 409)
            member.established = true
            return {
              established:
                session.host.established && session.guest.established,
            }
          case "session.turn": {
            const request = token(input.requestId)
            if (
              member.turnRequest === request &&
              member.ice &&
              (member.ice.expiresAt === null || member.ice.expiresAt > now)
            )
              return { iceConfig: member.ice }
            if (member.turnAt !== undefined && now - member.turnAt < 10_000)
              return fail("RATE_LIMITED", 429)
            member.ice = this.ice.issue(`${sessionId}:${role(input.role)}`)
            member.turnRequest = request
            member.turnAt = now
            return { iceConfig: member.ice }
          }
          case "code.publish": {
            if (input.role !== "host" || session.guest)
              return fail("UNAUTHORIZED", 401)
            if (session.code && session.code !== publishCode)
              return fail("CONFLICT", 409)
            const existing = records.get(codeKey!) as Code | null
            if (existing && existing.sessionId !== sessionId)
              return fail("CONFLICT", 409)
            if (existing?.revoked) return fail("CONFLICT", 409)
            const link = this.invitation(
              session,
              sessionId,
              input.link,
              context.origin
            )
            if (!existing)
              records.set(codeKey!, {
                origin: context.origin,
                sessionId,
                encrypted: this.encrypt(link),
                expiresAt: session.pairingExpiresAt,
              })
            session.code = publishCode
            return { code: publishCode, expiresAt: session.pairingExpiresAt }
          }
          case "code.revoke":
          case "session.close":
            if (operation === "code.revoke" && input.role !== "host")
              return fail("UNAUTHORIZED", 401)
            if (session.code && `code:${session.code}` !== oldCodeKey)
              return fail("CONFLICT", 409)
            if (oldCodeKey)
              records.set(oldCodeKey, {
                origin: context.origin,
                sessionId,
                expiresAt: session.pairingExpiresAt,
                encrypted: "",
                revoked: true,
              })
            session.code = undefined
            if (operation === "session.close") session.closed = true
            return { closed: operation === "session.close", revoked: true }
          default:
            return fail("UNKNOWN_OPERATION", 404)
        }
      }
    )
  }
  private code(value: unknown) {
    if (
      typeof value !== "string" ||
      !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(value)
    )
      return fail("INVALID_INPUT")
    return value
  }
  private async discovery(
    operation: string,
    input: Record<string, unknown>,
    context: CoordinationContext
  ): Promise<Record<string, unknown>> {
    if (!context.discoveryAllowed) return fail("DISCOVERY_UNAVAILABLE", 503)
    const deviceId = id(input.deviceId)
    const authorization = hash(token(input.authorization))
    const groupKey = `discovery:${hash(`${context.origin}:${context.ip}`)}`
    const sessionId =
      operation === "discovery.accept" && input.accepted === true
        ? id(input.sessionId)
        : undefined
    const result: Record<string, unknown> = await this.store.transact(
      [groupKey, ...(sessionId ? [`session:${sessionId}`] : [])],
      (records) => {
        const now = this.now()
        const group = (records.get(groupKey) as Group | null) ?? {
          devices: {},
          requests: {},
          expiresAt: now + 120_000,
        }
        for (const [key, value] of Object.entries(group.devices))
          if (value.expiresAt <= now) delete group.devices[key]
        for (const [key, value] of Object.entries(group.requests))
          if (
            value.expiresAt <= now ||
            (value.accepted === undefined &&
              (!group.devices[value.from] || !group.devices[value.to]))
          )
            delete group.requests[key]
        records.set(groupKey, group)
        if (operation === "discovery.presence") {
          if (
            typeof input.name !== "string" ||
            !input.name.trim() ||
            input.name.length > 40
          )
            return fail("INVALID_INPUT")
          if (
            group.devices[deviceId] &&
            !equal(group.devices[deviceId].authorization, authorization)
          )
            return fail("UNAUTHORIZED", 401)
          if (
            !group.devices[deviceId] &&
            Object.keys(group.devices).length >= 50
          )
            return fail("CAPACITY", 429)
          group.devices[deviceId] = {
            authorization,
            name: input.name.trim(),
            expiresAt: now + 45_000,
          }
          group.expiresAt = now + 120_000
          return { expiresAt: now + 45_000 }
        }
        const device = group.devices[deviceId]
        if (!device || !equal(device.authorization, authorization))
          return fail("UNAUTHORIZED", 401)
        switch (operation) {
          case "discovery.leave":
            delete group.devices[deviceId]
            for (const [key, request] of Object.entries(group.requests)) {
              if (
                request.accepted === undefined &&
                (request.from === deviceId || request.to === deviceId)
              )
                delete group.requests[key]
            }
            return { left: true }
          case "discovery.list":
            return {
              devices: Object.entries(group.devices)
                .filter(([key]) => key !== deviceId)
                .map(([id, entry]) => ({ id, name: entry.name })),
              requests: Object.entries(group.requests)
                .filter(
                  ([, request]) =>
                    request.to === deviceId && request.accepted === undefined
                )
                .map(([id, request]) => ({
                  id,
                  name: request.name,
                  expiresAt: request.expiresAt,
                })),
              outgoing: Object.entries(group.requests)
                .filter(
                  ([, request]) =>
                    request.from === deviceId && request.accepted === undefined
                )
                .map(([id, request]) => ({
                  id,
                  name: group.devices[request.to]?.name ?? "Other browser",
                  expiresAt: request.expiresAt,
                })),
              results: Object.entries(group.requests)
                .filter(
                  ([, request]) =>
                    request.from === deviceId && request.accepted !== undefined
                )
                .map(([id, request]) => ({
                  id,
                  accepted: request.accepted,
                  encrypted: request.encrypted,
                  sessionId: request.sessionId,
                })),
            }
          case "discovery.request": {
            if (
              typeof input.createdAt !== "number" ||
              !Number.isSafeInteger(input.createdAt) ||
              input.createdAt > now + 30_000 ||
              input.createdAt < now - 60_000
            )
              return fail("REQUEST_EXPIRED", 410)
            const target = id(input.targetId)
            const requestId = id(input.requestId)
            const existing = group.requests[requestId]
            if (existing) {
              if (existing.from !== deviceId || existing.to !== target)
                return fail("CONFLICT", 409)
              return { requestId, expiresAt: existing.expiresAt }
            }
            // CAS makes the first request authoritative. A simultaneous reverse
            // request joins that same handshake instead of creating a deadlock.
            const reverse = Object.entries(group.requests).find(
              ([, request]) =>
                request.accepted === undefined &&
                request.from === target &&
                request.to === deviceId
            )
            if (reverse) {
              const [id, request] = reverse
              return {
                incoming: {
                  id,
                  name: request.name,
                  expiresAt: request.expiresAt,
                },
              }
            }
            if (
              target === deviceId ||
              !group.devices[target] ||
              Object.values(group.requests).some(
                (request) =>
                  request.accepted === undefined &&
                  ([request.from, request.to].includes(deviceId) ||
                    [request.from, request.to].includes(target))
              ) ||
              Object.keys(group.requests).length >= 50
            )
              return fail("DEVICE_BUSY", 409)
            group.requests[requestId] = {
              from: deviceId,
              to: target,
              name: device.name,
              expiresAt: now + 60_000,
            }
            return { requestId, expiresAt: now + 60_000 }
          }
          case "discovery.cancel": {
            const requestId = id(input.requestId)
            const request = group.requests[requestId]
            if (!request) return { cancelled: true }
            if (request.from !== deviceId) return fail("UNAUTHORIZED", 401)
            // Acceptance wins a race with cancellation; retain the invitation
            // so the sender can complete the existing handshake.
            if (request.accepted === true) return { cancelled: false }
            delete group.requests[requestId]
            return { cancelled: true }
          }
          case "discovery.accept": {
            const request = group.requests[id(input.requestId)]
            if (!request || request.to !== deviceId)
              return fail("REQUEST_EXPIRED", 410)
            if (request.accepted !== undefined) {
              if (
                request.accepted !== input.accepted ||
                request.sessionId !== sessionId
              )
                return fail("CONFLICT", 409)
              return { accepted: request.accepted }
            }
            if (typeof input.accepted !== "boolean")
              return fail("INVALID_INPUT")
            if (input.accepted) {
              const session = this.session(
                records,
                sessionId!,
                context.origin,
                true
              )
              this.authorize(session, {
                role: "host",
                authorization: input.hostAuthorization,
              })
              if (session.guest) return fail("SESSION_FULL", 409)
              request.encrypted = this.encrypt(
                this.invitation(session, sessionId!, input.link, context.origin)
              )
              request.sessionId = sessionId
            }
            request.accepted = input.accepted
            return { accepted: request.accepted }
          }
          default:
            return fail("UNKNOWN_OPERATION", 404)
        }
      }
    )
    if (operation === "discovery.list" && "results" in result) {
      const results = result.results as Array<{
        id: string
        accepted: boolean
        encrypted?: string
        sessionId?: string
      }>
      result.results = await Promise.all(
        results.map(async (item) => {
          if (!item.encrypted || !item.sessionId)
            return { id: item.id, accepted: false }
          // Closing or claiming a session also revokes discovery invitations, without
          // unbounded reverse indexes. Always recheck the authoritative session on read.
          try {
            await this.store.transact(
              [`session:${item.sessionId}`],
              (records) => {
                const session = this.session(
                  records,
                  item.sessionId!,
                  context.origin,
                  true
                )
                if (session.guest) return fail("SESSION_FULL", 409)
              }
            )
            return {
              id: item.id,
              accepted: true,
              link: this.decrypt(item.encrypted),
            }
          } catch (error) {
            if (!(error instanceof CoordinationError)) throw error
            return { id: item.id, accepted: false }
          }
        })
      )
    }
    return result
  }
}
