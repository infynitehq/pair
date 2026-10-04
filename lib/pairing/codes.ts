import { parsePairingLink } from "../peer/session"
import {
  coordinationRequest,
  coordinationToken,
} from "../peer/coordination-client"

export async function resolvePairingCode(code: string): Promise<string> {
  const normalized = code.replace(/[\s-]/g, "").toUpperCase()
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(normalized))
    throw new Error("Enter an eight-character pairing code.")
  const result = await coordinationRequest("code.resolve", {
    code: normalized,
    claimant: coordinationToken(),
  })
  if (typeof result.link !== "string")
    throw new Error("Invalid pairing response")
  parsePairingLink(result.link, window.location.origin)
  return result.link
}
