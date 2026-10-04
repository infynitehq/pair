import { ConnectionError } from "./connectivity"
import { encode } from "./crypto"

export const coordinationToken = () =>
  encode(crypto.getRandomValues(new Uint8Array(32)))
export const coordinationId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
export class ApiError extends ConnectionError {
  constructor(public category: string) {
    super(
      category === "SESSION_EXPIRED" || category === "CODE_UNAVAILABLE"
        ? "invitation-expired"
        : category === "UNAUTHORIZED"
          ? "authentication-failed"
          : category === "PROTOCOL_MISMATCH"
            ? "protocol-error"
            : "signaling-unavailable",
      category === "RATE_LIMITED"
        ? "Too many requests. Wait a minute and try again."
        : category === "SESSION_FULL"
          ? "This invitation has already been claimed."
          : category === "SESSION_EXPIRED" || category === "CODE_UNAVAILABLE"
            ? "Invitation unavailable or expired. Ask for a fresh invite."
            : category === "PROTOCOL_MISMATCH"
              ? "Incompatible Pair version. Reload both devices."
              : "Pair coordination is unavailable. Try again or use a QR/link invitation if discovery is unavailable."
    )
  }
}

/** Retries reuse the exact input (including credentials/request IDs). No secrets in URLs. */
export async function coordinationRequest(
  operation: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const body = JSON.stringify({
    ...input,
    operation,
    protocol: 2,
    transport: "nostr-http-v1",
  })
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted()
    try {
      const response = await fetch("/api/v1/coordination", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        cache: "no-store",
        // Preview deployment protection may use a platform cookie. Pair itself
        // authorizes only the page-memory participant credential in this body.
        credentials: "same-origin",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      })
      const envelope = await response.json()
      if (envelope.v !== 1) throw new ApiError("PROTOCOL_MISMATCH")
      if (!response.ok)
        throw new ApiError(envelope.error?.code ?? "COORDINATION_UNAVAILABLE")
      if (!envelope.data || typeof envelope.data !== "object")
        throw new ApiError("PROTOCOL_MISMATCH")
      return envelope.data
    } catch (error) {
      signal?.throwIfAborted()
      if (
        error instanceof ApiError &&
        error.category !== "COORDINATION_UNAVAILABLE"
      )
        throw error
      if (attempt === 2)
        throw error instanceof ApiError
          ? error
          : new ApiError("COORDINATION_UNAVAILABLE")
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer)
          reject(signal?.reason)
        }
        const timer = setTimeout(
          () => {
            signal?.removeEventListener("abort", abort)
            resolve()
          },
          300 * 2 ** attempt
        )
        signal?.addEventListener("abort", abort, { once: true })
      })
    }
  }
  throw new ApiError("COORDINATION_UNAVAILABLE")
}
