"use client"

import { useEffect, useRef, useState } from "react"
import { Radar } from "lucide-react"
import type { PairSessionHook } from "@/lib/peer/types"
import {
  coordinationId,
  coordinationRequest,
  coordinationToken,
} from "@/lib/peer/coordination-client"
import { parsePairingLink } from "@/lib/peer/session"
import { Button } from "./ui/button"

interface Device {
  id: string
  name: string
}
export function PairDiscovery({ session }: { session: PairSessionHook }) {
  const [enabled, setEnabled] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [incoming, setIncoming] = useState<Device | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [online, setOnline] = useState(false)
  const [error, setError] = useState("")
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const current = useRef(session)
  const credentials = useRef<{
    deviceId: string
    authorization: string
  } | null>(null)
  const accepting = useRef<string | null>(null)
  const pendingRef = useRef<{ id: string; expiresAt: number } | null>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    current.current = session
  }, [session])
  const active =
    enabled &&
    (session.status === "idle" ||
      (acceptingId !== null &&
        ["creating", "waiting"].includes(session.status)))
  async function request(
    operation: string,
    input: Record<string, unknown> = {}
  ) {
    return coordinationRequest(
      operation,
      { ...credentials.current, ...input },
      controller.current?.signal
    )
  }
  useEffect(() => {
    if (!active) return
    credentials.current ??= {
      deviceId: coordinationId(),
      authorization: coordinationToken(),
    }
    const abort = new AbortController()
    controller.current = abort
    let timer: ReturnType<typeof setTimeout>
    let renewedAt = 0
    let failures = 0
    const poll = async () => {
      try {
        if (Date.now() - renewedAt >= 15_000) {
          await request("discovery.presence", {
            name: current.current.deviceName,
          })
          renewedAt = Date.now()
        }
        const result = await request("discovery.list")
        if (abort.signal.aborted) return
        if (
          !Array.isArray(result.devices) ||
          !Array.isArray(result.requests) ||
          !Array.isArray(result.results) ||
          result.devices.length > 50
        )
          throw new Error("Invalid discovery response")
        setDevices(result.devices)
        setIncoming(result.requests[0] ?? null)
        setOnline(true)
        setError("")
        failures = 0
        for (const item of result.results) {
          if (
            item.id !== pendingRef.current?.id ||
            current.current.status !== "idle"
          )
            continue
          pendingRef.current = null
          setPending(null)
          if (item.accepted && typeof item.link === "string") {
            parsePairingLink(item.link, window.location.origin)
            await current.current.joinPairing(item.link)
          } else setError("Connection request declined.")
        }
        if (pendingRef.current && pendingRef.current.expiresAt <= Date.now()) {
          pendingRef.current = null
          setPending(null)
          setError("Connection request expired. Try again.")
        }
      } catch {
        if (abort.signal.aborted) return
        failures++
        setOnline(false)
        setDevices([])
        setError(
          "Discovery unavailable. QR codes and pairing links work independently."
        )
      }
      if (!abort.signal.aborted)
        timer = setTimeout(
          () => void poll(),
          Math.min(2000 * 2 ** failures, 15_000)
        )
    }
    void poll()
    return () => {
      abort.abort()
      clearTimeout(timer)
      controller.current = null
      // Best effort. Presence disappears after its 45-second lease regardless.
      void coordinationRequest("discovery.leave", {
        ...credentials.current,
      }).catch(() => {})
    }
  }, [active])
  useEffect(() => {
    const requestId = accepting.current
    if (
      !requestId ||
      session.status !== "waiting" ||
      !session.pairingLink ||
      !credentials.current
    )
      return
    const { deviceId, authorization } = credentials.current
    void current.current
      .acceptDiscovery(requestId, deviceId, authorization)
      .then(() => {
        accepting.current = null
        setAcceptingId(null)
        setEnabled(false)
      })
      .catch(() => {
        accepting.current = null
        setAcceptingId(null)
        setEnabled(false)
        setError(
          "Could not deliver the invitation. Share its QR code or link instead."
        )
      })
  }, [session.status, session.pairingLink])
  if (session.status !== "idle") return null
  return (
    <section className="mt-7 border-t pt-5" aria-label="Device discovery">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Radar className="size-4" />
            Find another device
          </h2>
          <p className="mt-2 max-w-sm text-xs leading-5 text-muted-foreground">
            Approximate discovery by shared public IP, not proof of proximity.
            Shared networks and VPNs can include strangers. Opt in, compare
            codes, and approve on both devices.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={!session.ready}
          onClick={() => {
            setEnabled(!enabled)
            setDevices([])
            setError("")
            setOnline(false)
          }}
        >
          {enabled ? "Stop discovery" : "Make discoverable"}
        </Button>
      </div>
      {enabled && (
        <div className="mt-4 space-y-3">
          {!devices.length && (
            <p className="text-xs text-muted-foreground">
              {online
                ? "No discoverable devices yet. Open Pair and enable discovery on the other device."
                : "Connecting to discovery…"}
            </p>
          )}
          {devices.map((device) => (
            <div
              key={device.id}
              className="flex items-center justify-between rounded-lg bg-muted/40 p-3"
            >
              <span className="text-sm">{device.name}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={!online || !!pending || !!incoming}
                onClick={() => {
                  const requestId = coordinationId()
                  pendingRef.current = {
                    id: requestId,
                    expiresAt: Date.now() + 60_000,
                  }
                  setPending(requestId)
                  void request("discovery.request", {
                    targetId: device.id,
                    requestId,
                    createdAt: Date.now(),
                  }).catch(() => {
                    pendingRef.current = null
                    setPending(null)
                    setError("Device unavailable or busy. Try again.")
                  })
                }}
              >
                Request connection
              </Button>
            </div>
          ))}
          {pending && (
            <p role="status" className="text-xs text-muted-foreground">
              Waiting for the other device to accept your request…
            </p>
          )}
          {incoming && (
            <div className="rounded-lg border p-3">
              <p className="text-sm">{incoming.name} wants to pair.</p>
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    accepting.current = incoming.id
                    setAcceptingId(incoming.id)
                    setIncoming(null)
                    void session.createPairing()
                  }}
                >
                  Accept request
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void request("discovery.accept", {
                      requestId: incoming.id,
                      accepted: false,
                    }).catch(() => setError("Request unavailable."))
                    setIncoming(null)
                  }}
                >
                  Decline request
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
