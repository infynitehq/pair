import { isIP } from "node:net"
import { CoordinationError, CoordinationService } from "./coordination"
import {
  RedisCoordinationStore,
  StoreUnavailable,
  type CoordinationStore,
} from "./coordination-store"
import { createIceProvider } from "./ice"

const operations = new Set([
  "session.create",
  "session.join",
  "session.status",
  "session.established",
  "session.turn",
  "session.close",
  "code.publish",
  "code.resolve",
  "code.revoke",
  "discovery.presence",
  "discovery.list",
  "discovery.leave",
  "discovery.request",
  "discovery.accept",
])
export function coordinationStore(env = process.env): CoordinationStore {
  if (
    !env.KV_REST_API_URL ||
    !env.KV_REST_API_TOKEN
  )
    throw new StoreUnavailable()
  const stage =
    env.VERCEL_ENV ??
    (env.NODE_ENV === "production" ? "production" : "development")
  return new RedisCoordinationStore(
    env.KV_REST_API_URL,
    env.KV_REST_API_TOKEN,
    `pair:${stage}:v1`
  )
}

async function boundedJson(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new CoordinationError("INVALID_INPUT", 415)
  const reader = request.body?.getReader()
  if (!reader) throw new CoordinationError("INVALID_INPUT")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) {
        await reader.cancel()
        throw new CoordinationError("INPUT_TOO_LARGE", 413)
      }
      chunks.push(value)
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error()
    return input as Record<string, unknown>
  } catch (error) {
    if (error instanceof CoordinationError) throw error
    throw new CoordinationError("INVALID_INPUT")
  } finally {
    reader.releaseLock()
  }
}

/** Same-origin, no cookies, no cache, and deliberately redacted errors. */
export async function handleCoordination(
  request: Request,
  service?: CoordinationService
) {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }
  try {
    const development =
      process.env.NODE_ENV === "development" && !process.env.VERCEL
    const url = new URL(request.url)
    let origin = url.origin
    // Next dev builds request.url from its bind hostname, not necessarily the
    // browser-facing LAN host. Accept only explicitly allowlisted Host values.
    if (development) {
      const allowedDevOrigins = [
        "localhost",
        "127.0.0.1",
        "[::1]",
        ...(process.env.ALLOWED_DEV_ORIGINS ?? "")
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
      ]
      const host = request.headers.get("host")
      if (host) {
        try {
          const browserUrl = new URL(`${url.protocol}//${host}`)
          if (
            browserUrl.host === host &&
            allowedDevOrigins.includes(browserUrl.hostname)
          )
            origin = browserUrl.origin
        } catch {
          throw new CoordinationError("ORIGIN_REJECTED", 403)
        }
      }
    }
    if (
      request.headers.get("origin") !== origin ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      throw new CoordinationError("ORIGIN_REJECTED", 403)
    const input = await boundedJson(request)
    if (typeof input.operation !== "string" || !operations.has(input.operation))
      throw new CoordinationError("UNKNOWN_OPERATION", 404)
    // Vercel overwrites this platform header. Never trust arbitrary X-Forwarded-For.
    const forwarded =
      process.env.VERCEL === "1"
        ? request.headers.get("x-vercel-forwarded-for")?.trim()
        : undefined
    const platformIp = forwarded && isIP(forwarded) ? forwarded : undefined
    const ip =
      platformIp ?? (development ? "local-development" : "unattributed")
    const backend =
      service ??
      new CoordinationService(
        coordinationStore(),
        createIceProvider(),
        process.env.PAIR_RENDEZVOUS_KEY
      )
    const data = await backend.execute(input.operation, input, {
      origin,
      ip,
      discoveryAllowed: !!platformIp || development,
    })
    return Response.json({ v: 1, data }, { headers })
  } catch (error) {
    const known = error instanceof CoordinationError
    const status = known ? error.status : 503
    const code = known ? error.code : "COORDINATION_UNAVAILABLE"
    // Never serialize exceptions, request bodies, invitation material, IPs or TURN credentials.
    return Response.json({ v: 1, error: { code } }, { status, headers })
  }
}
