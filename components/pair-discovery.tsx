"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowRight, Check, Loader2, Radar, ShieldCheck, X } from "lucide-react"
import type { PairSessionHook } from "@/lib/peer/types"
import {
  ApiError,
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
interface DiscoveryRequest extends Device {
  expiresAt: number
}
interface Pending extends DiscoveryRequest {
  confirmed: boolean
}

function discoveryError(error: unknown) {
  if (error instanceof ApiError) {
    switch (error.category) {
      case "RATE_LIMITED":
        return "Discovery is busy. Retrying shortly."
      case "ORIGIN_REJECTED":
        return "This site address was rejected. Check your development hostname and HTTPS proxy configuration."
      case "DISCOVERY_UNAVAILABLE":
        return "Discovery is unavailable on this host. You can still share an invitation link."
      case "DEVICE_BUSY":
        return "That browser is handling another request. Try again in a moment."
      case "REQUEST_EXPIRED":
        return "That request expired. Send a new one when you're ready."
    }
  }
  return "Couldn't reach discovery. Retrying automatically; you can also use an invitation link."
}

function RequestTime({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <span className="font-mono tabular-nums">
      {Math.max(0, Math.ceil((expiresAt - now) / 1000))}s remaining
    </span>
  )
}

function IncomingRequest({
  request,
  busy,
  online,
  error,
  onAccept,
  onDecline,
}: {
  request: DiscoveryRequest
  busy: boolean
  online: boolean
  error: string
  onAccept: () => void
  onDecline: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      aria-labelledby="discovery-request-title"
      aria-describedby="discovery-request-description"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onDecline()
      }}
      className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      <div className="p-6 sm:p-8">
        <div className="mb-6 flex items-center justify-between">
          <span className="flex size-12 items-center justify-center rounded-full bg-primary/5">
            <Radar className="size-5" aria-hidden="true" />
          </span>
          <span className="text-xs text-muted-foreground">
            <RequestTime expiresAt={request.expiresAt} />
          </span>
        </div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground">
          INCOMING REQUEST
        </p>
        <h3
          id="discovery-request-title"
          className="text-xl font-semibold tracking-tight"
        >
          {request.name} wants to pair.
        </h3>
        <p
          id="discovery-request-description"
          className="mt-3 text-sm leading-6 text-muted-foreground"
        >
          Expecting this browser? Accept to set up a connection, then compare
          the connection-check code on both screens.
        </p>
        <div className="mt-6 flex gap-3">
          <Button
            className="flex-1"
            disabled={busy || !online}
            onClick={onAccept}
          >
            {busy ? (
              <Loader2 className="motion-safe:animate-spin" />
            ) : (
              <Check />
            )}
            Accept request
          </Button>
          <Button variant="outline" disabled={busy} onClick={onDecline}>
            {online ? "Decline" : "Stop discovery"}
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <p className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
          Nothing is shared until both browsers approve.
        </p>
      </div>
    </dialog>
  )
}

export function PairDiscovery({ session }: { session: PairSessionHook }) {
  const [enabled, setEnabled] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [incoming, setIncoming] = useState<DiscoveryRequest | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [online, setOnline] = useState(false)
  const [pollError, setPollError] = useState("")
  const [actionError, setActionError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const current = useRef(session)
  const credentials = useRef<{
    deviceId: string
    authorization: string
  } | null>(null)
  const accepting = useRef<string | null>(null)
  const actionBusy = useRef(false)
  const actionVersion = useRef(0)
  const pendingRef = useRef<Pending | null>(null)
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
  function updatePending(value: Pending | null) {
    pendingRef.current = value
    setPending(value)
  }

  useEffect(() => {
    if (!active) return
    // Every discovery run gets fresh credentials. Strict Mode cleanup or a slow
    // previous leave request cannot remove this run's newly registered presence.
    const identity = {
      deviceId: coordinationId(),
      authorization: coordinationToken(),
    }
    credentials.current = identity
    const abort = new AbortController()
    controller.current = abort
    let timer: ReturnType<typeof setTimeout>
    let renewedAt = 0
    let failures = 0
    let polling = false
    const call = (operation: string, input: Record<string, unknown> = {}) =>
      coordinationRequest(operation, { ...identity, ...input }, abort.signal)
    const poll = async () => {
      if (polling || abort.signal.aborted) return
      polling = true
      clearTimeout(timer)
      const waitingAtStart = pendingRef.current
      const version = actionVersion.current
      try {
        if (Date.now() - renewedAt >= 15_000) {
          await call("discovery.presence", { name: current.current.deviceName })
          renewedAt = Date.now()
        }
        const result = await call("discovery.list")
        if (abort.signal.aborted) return
        if (actionBusy.current || version !== actionVersion.current) return
        if (
          !Array.isArray(result.devices) ||
          !Array.isArray(result.requests) ||
          !Array.isArray(result.results) ||
          !Array.isArray(result.outgoing)
        )
          throw new Error("Invalid discovery response")
        setDevices(result.devices)
        setIncoming(result.requests[0] ?? null)
        setOnline(true)
        setPollError("")
        failures = 0
        const waiting = waitingAtStart
        if (waiting && pendingRef.current?.id === waiting.id) {
          const resolution = result.results.find(
            (item) => item.id === waiting.id
          )
          if (resolution && current.current.status === "idle") {
            updatePending(null)
            if (resolution.accepted && typeof resolution.link === "string") {
              parsePairingLink(resolution.link, window.location.origin)
              setNotice("Request accepted. Setting up your connection…")
              await current.current.joinPairing(resolution.link)
            } else
              setNotice(
                `${waiting.name} declined the request. You can try another browser.`
              )
          } else if (
            waiting.confirmed &&
            !result.outgoing.some((item) => item.id === waiting.id)
          ) {
            updatePending(null)
            setNotice(
              "The request ended. The other browser may have left discovery; you can try again."
            )
          } else if (waiting.expiresAt <= Date.now()) {
            updatePending(null)
            setNotice(
              "No response this time. Your request expired; you can send another."
            )
          }
        }
      } catch (error) {
        if (abort.signal.aborted) return
        failures++
        renewedAt = 0
        setOnline(false)
        setPollError(discoveryError(error))
      } finally {
        polling = false
        if (!abort.signal.aborted)
          timer = setTimeout(
            () => void poll(),
            Math.min(2000 * 2 ** failures, 15_000)
          )
      }
    }
    const wake = () => {
      if (document.visibilityState === "visible") void poll()
    }
    document.addEventListener("visibilitychange", wake)
    window.addEventListener("online", wake)
    void poll()
    return () => {
      abort.abort()
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", wake)
      window.removeEventListener("online", wake)
      if (controller.current === abort) controller.current = null
      void coordinationRequest("discovery.leave", identity).catch(() => {})
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
        setNotice("Request accepted. Waiting for the other browser…")
      })
      .catch(() => {
        setActionError(
          "Couldn't deliver the invitation. Share the invitation link shown above."
        )
      })
      .finally(() => {
        accepting.current = null
        setAcceptingId(null)
        setEnabled(false)
        actionBusy.current = false
        setBusy(false)
      })
  }, [session.status, session.pairingLink])

  async function connect(device: Device, createdAt: number) {
    if (actionBusy.current || pendingRef.current || incoming || !online) return
    actionBusy.current = true
    actionVersion.current++
    setBusy(true)
    setActionError("")
    setNotice("")
    const abort = controller.current
    const waiting: Pending = {
      ...device,
      id: coordinationId(),
      expiresAt: createdAt + 60_000,
      confirmed: false,
    }
    updatePending(waiting)
    try {
      const result = await request("discovery.request", {
        targetId: device.id,
        requestId: waiting.id,
        createdAt,
      })
      if (abort?.signal.aborted) return
      if (result.incoming) {
        updatePending(null)
        setIncoming(result.incoming as DiscoveryRequest)
        setNotice(
          "You both reached out. There's one shared request; accept it to continue."
        )
      } else {
        updatePending({
          ...waiting,
          confirmed: true,
          expiresAt: result.expiresAt as number,
        })
      }
    } catch (error) {
      if (!abort?.signal.aborted) {
        updatePending(null)
        setActionError(discoveryError(error))
      }
    } finally {
      actionVersion.current++
      actionBusy.current = false
      setBusy(false)
    }
  }

  async function cancel() {
    const waiting = pendingRef.current
    if (!waiting || actionBusy.current) return
    actionBusy.current = true
    actionVersion.current++
    setBusy(true)
    const abort = controller.current
    try {
      const result = await request("discovery.cancel", {
        requestId: waiting.id,
      })
      if (abort?.signal.aborted) return
      if (result.cancelled) {
        updatePending(null)
        setNotice("Request cancelled. You're still discoverable.")
      } else
        setNotice(
          "The other browser already accepted. Setting up your connection…"
        )
    } catch (error) {
      if (!abort?.signal.aborted) setActionError(discoveryError(error))
    } finally {
      actionVersion.current++
      actionBusy.current = false
      setBusy(false)
    }
  }

  async function decline() {
    if (!incoming || actionBusy.current) return
    if (!online) {
      setEnabled(false)
      setIncoming(null)
      updatePending(null)
      setNotice(
        "Discovery stopped. You can try again when your connection returns."
      )
      return
    }
    actionBusy.current = true
    actionVersion.current++
    setBusy(true)
    const abort = controller.current
    try {
      await request("discovery.accept", {
        requestId: incoming.id,
        accepted: false,
      })
      if (abort?.signal.aborted) return
      setIncoming(null)
      setActionError("")
      setNotice("Request declined. You're still discoverable.")
    } catch (error) {
      if (!abort?.signal.aborted) setActionError(discoveryError(error))
    } finally {
      actionVersion.current++
      actionBusy.current = false
      setBusy(false)
    }
  }
  function accept() {
    if (!incoming || actionBusy.current || !online) return
    actionBusy.current = true
    setBusy(true)
    accepting.current = incoming.id
    setAcceptingId(incoming.id)
    setIncoming(null)
    void session.createPairing()
  }

  if (session.status !== "idle") {
    if (acceptingId && ["creating", "waiting"].includes(session.status))
      return (
        <p
          role="status"
          className="mb-4 text-center text-sm text-muted-foreground"
        >
          Accepting request. Setting up your connection…
        </p>
      )
    if (session.status === "waiting" && (notice || actionError))
      return (
        <p
          role={actionError ? "alert" : "status"}
          className="mb-4 text-center text-sm text-muted-foreground"
        >
          {actionError || notice}
        </p>
      )
    return null
  }
  return (
    <section className="mt-7 border-t pt-6" aria-label="Device discovery">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Radar className="size-4" aria-hidden="true" />
            Find another browser
          </h2>
          <p className="mt-2 max-w-sm text-xs leading-5 text-muted-foreground">
            Open Pair on both browsers and make each discoverable. Then choose
            one to connect.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!session.ready || busy}
          onClick={() => {
            setEnabled(!enabled)
            setDevices([])
            setIncoming(null)
            updatePending(null)
            setActionError("")
            setPollError("")
            setNotice("")
            setOnline(false)
          }}
        >
          {enabled ? (
            <>
              <X />
              Stop discovery
            </>
          ) : (
            <>
              <Radar />
              Make discoverable
            </>
          )}
        </Button>
      </div>
      {enabled && (
        <div className="mt-5 overflow-hidden rounded-xl border bg-muted/20">
          <div
            className="flex items-center gap-3 border-b px-4 py-3"
            role="status"
            aria-live="polite"
          >
            <span className="relative flex size-2 shrink-0">
              {online && (
                <span className="absolute inline-flex size-full rounded-full bg-emerald-500 opacity-40 motion-safe:animate-ping" />
              )}
              <span
                className={`relative inline-flex size-2 rounded-full ${online ? "bg-emerald-500" : "bg-muted-foreground"}`}
              />
            </span>
            <p className="text-xs font-medium">
              {pollError
                ? "Reconnecting to discovery…"
                : !online
                  ? "Starting discovery…"
                  : pending
                    ? "Waiting for a response"
                    : devices.length
                      ? `${devices.length} ${devices.length === 1 ? "browser" : "browsers"} available · You're discoverable`
                      : "Looking for other browsers…"}
            </p>
          </div>
          {pending ? (
            <div className="p-5">
              <div className="flex items-start gap-3">
                <Loader2
                  className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin"
                  aria-hidden="true"
                />
                <div>
                  <p className="text-sm font-medium">
                    {pending.confirmed
                      ? `Request sent to ${pending.name}`
                      : `Reaching ${pending.name}…`}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    They&apos;ll see an accept-or-decline prompt in Pair. Keep
                    this page open.
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    <RequestTime expiresAt={pending.expiresAt} />
                  </p>
                </div>
              </div>
              <Button
                className="mt-4"
                variant="outline"
                size="sm"
                disabled={busy || !online}
                onClick={() => void cancel()}
              >
                Cancel request
              </Button>
            </div>
          ) : devices.length ? (
            <ul className="divide-y">
              {devices.map((device) => (
                <li
                  key={device.id}
                  className="flex items-center justify-between gap-3 px-4 py-4"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {device.name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Ready to receive a request
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!online || busy || !!incoming}
                    onClick={() => void connect(device, Date.now())}
                  >
                    Connect
                    <ArrowRight />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-7 text-center">
              <Radar
                className="mx-auto mb-3 size-7 text-muted-foreground motion-safe:animate-pulse"
                aria-hidden="true"
              />
              <p className="text-sm font-medium">
                {pollError
                  ? "Discovery is taking a moment"
                  : "Ready when your other browser is"}
              </p>
              <p className="mx-auto mt-2 max-w-xs text-xs leading-5 text-muted-foreground">
                {pollError
                  ? "We'll keep trying. Your pairing link is another way to connect."
                  : "Click “Make discoverable” there too. Browsers appear here automatically."}
              </p>
            </div>
          )}
        </div>
      )}
      {notice && (
        <p
          role="status"
          className="mt-3 text-xs leading-5 text-muted-foreground"
        >
          {notice}
        </p>
      )}
      {(actionError || pollError) && (
        <p role="alert" className="mt-3 text-xs leading-5 text-destructive">
          {actionError || pollError}
        </p>
      )}
      {enabled && (
        <p className="mt-3 flex items-start gap-2 text-[11px] leading-5 text-muted-foreground">
          <ShieldCheck
            className="mt-0.5 size-3.5 shrink-0"
            aria-hidden="true"
          />
          Discovery groups browsers by public IP. Shared networks and VPNs can
          include strangers; compare the code before approving.
        </p>
      )}
      {incoming && (
        <IncomingRequest
          key={incoming.id}
          request={incoming}
          busy={busy}
          online={online}
          error={actionError || pollError}
          onAccept={accept}
          onDecline={() => void decline()}
        />
      )}
    </section>
  )
}
