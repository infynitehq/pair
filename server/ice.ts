import { createHmac, randomBytes } from "node:crypto"
import { isIP } from "node:net"

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

export interface IceConfiguration {
  iceServers: IceServer[]
  expiresAt: number | null
  relayAvailable: boolean
}

export interface IceProvider {
  issue(participantId: string): IceConfiguration
}

function urls(value: string | undefined, kind: "STUN" | "TURN"): string[] {
  if (!value?.trim()) return []
  return value.split(",").map((entry) => {
    const url = entry.trim()
    // ICE URIs are not hierarchical URLs: no //, userinfo, paths or fragments.
    const match =
      /^(stuns?|turns?):(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?(?:\?transport=(udp|tcp))?$/.exec(
        url
      )
    const invalid = () => new Error(`Invalid ${kind}_URLS configuration`)
    if (!match || !match[1].startsWith(kind.toLowerCase())) throw invalid()
    const [, scheme, host, port, transport] = match
    if (kind === "STUN" && transport) throw invalid()
    if (scheme === "turns" && transport === "udp") throw invalid()
    if (port && (Number(port) < 1 || Number(port) > 65535)) throw invalid()
    if (host.startsWith("[")) {
      if (isIP(host.slice(1, -1)) !== 6) throw invalid()
    } else {
      const name = host.endsWith(".") ? host.slice(0, -1) : host
      if (
        name.length > 253 ||
        !name
          .split(".")
          .every((label) =>
            /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)
          ) ||
        (/^[0-9.]+$/.test(name) && isIP(name) !== 4)
      )
        throw invalid()
    }
    return url
  })
}

/** Coturn TURN REST authentication, also usable with managed REST-compatible TURN. */
export function createIceProvider(
  env: Record<string, string | undefined> = process.env
): IceProvider {
  const stunUrls = urls(env.STUN_URLS, "STUN")
  const turnUrls = urls(env.TURN_URLS, "TURN")
  const secret = env.TURN_SHARED_SECRET ?? ""
  const ttlValue = env.TURN_CREDENTIAL_TTL_SECONDS?.trim() || "600"
  const ttl = Number(ttlValue)
  if (
    !/^\d+$/.test(ttlValue) ||
    !Number.isInteger(ttl) ||
    ttl < 60 ||
    ttl > 3600
  ) {
    throw new Error(
      "TURN_CREDENTIAL_TTL_SECONDS must be an integer from 60 to 3600"
    )
  }
  const turnConfigured =
    turnUrls.length > 0 ||
    secret.length > 0 ||
    Boolean(env.TURN_CREDENTIAL_TTL_SECONDS?.trim())
  if (turnConfigured && (turnUrls.length === 0 || secret.trim().length < 32)) {
    throw new Error(
      "TURN requires TURN_URLS and TURN_SHARED_SECRET of at least 32 characters"
    )
  }

  return {
    issue(participantId) {
      const iceServers: IceServer[] = stunUrls.length
        ? [{ urls: [...stunUrls] }]
        : []
      if (!turnUrls.length) {
        return { iceServers, expiresAt: null, relayAvailable: false }
      }
      const expiry = Math.floor(Date.now() / 1000) + ttl
      // A keyed, randomized participant binding hides identifiers and avoids
      // reusing credentials between participants or successive issuances.
      const opaque = createHmac("sha256", secret)
        .update(randomBytes(32))
        .update(participantId)
        .digest("hex")
      const username = `${expiry}:${opaque}`
      const credential = createHmac("sha1", secret)
        .update(username)
        .digest("base64")
      iceServers.push({ urls: [...turnUrls], username, credential })
      return { iceServers, expiresAt: expiry * 1000, relayAvailable: true }
    },
  }
}
