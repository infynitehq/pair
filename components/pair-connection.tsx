"use client"

import { useEffect, useRef, useState } from "react"
import type {
  ConnectionMode,
  FailureCode,
  PairSessionHook,
} from "@/lib/peer/types"
import { Button } from "@/components/ui/button"

const modeDescriptions: Record<ConnectionMode, string> = {
  automatic:
    "Use a direct connection when possible, with TURN relay fallback when available.",
  direct:
    "Connect directly only. TURN relays will not be used; some networks may not connect.",
  relay:
    "Use a TURN relay only. Available relay credentials are required to connect.",
}

export const failureGuidance: Record<
  FailureCode,
  { title: string; help: string }
> = {
  "signaling-unavailable": {
    title: "Signaling is unavailable.",
    help: "Check your network. An established peer connection can continue while signaling reconnects.",
  },
  "invitation-expired": {
    title: "This invitation has expired.",
    help: "Ask for a fresh pairing link and approve the new connection on both browsers.",
  },
  "peer-left": {
    title: "Your peer has left.",
    help: "Keep both pages open and start a new pair when you’re ready.",
  },
  "authentication-failed": {
    title: "The connection could not be verified.",
    help: "Start a fresh pair and compare the connection-check code through a trusted channel.",
  },
  "direct-unavailable": {
    title: "A direct connection is unavailable.",
    help: "Try another network or choose Automatic for a new pair to allow relay fallback.",
  },
  "relay-unavailable": {
    title: "The relay is unavailable.",
    help: "Relay credentials could not be obtained or the relay could not be reached. Try again, or choose Automatic or Direct for a new pair.",
  },
  "connection-interrupted": {
    title: "The peer connection was interrupted.",
    help: "Keep both pages open during recovery. If recovery ends, start a fresh pair.",
  },
  "protocol-error": {
    title: "The browsers could not complete the exchange.",
    help: "Reload both browsers and start a fresh pair.",
  },
}

export function ConnectionModeSelect({
  session,
}: {
  session: PairSessionHook
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <label
          htmlFor="connection-mode"
          className="text-xs text-muted-foreground"
        >
          Connection mode
        </label>
        <select
          id="connection-mode"
          aria-describedby="connection-mode-description"
          value={session.mode}
          disabled={!session.ready}
          onChange={(event) =>
            session.setConnectionMode(event.target.value as ConnectionMode)
          }
          className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:w-56"
        >
          <option value="automatic">Automatic (default)</option>
          <option value="direct">Direct only</option>
          <option value="relay">Relay only</option>
        </select>
      </div>
      <p
        id="connection-mode-description"
        className="max-w-lg text-xs leading-relaxed text-muted-foreground"
      >
        {modeDescriptions[session.mode]} Saved for future pairs on this browser.
      </p>
    </div>
  )
}

export function ConnectionHealth({ session }: { session: PairSessionHook }) {
  const recovering = session.status === "recovering"
  const signalingInterrupted =
    session.signalingStatus === "offline" ||
    session.signalingStatus === "reconnecting" ||
    session.signalingStatus === "connecting" ||
    (session.signalingStatus !== "retired" &&
      session.nostrStatus !== "available")
  return (
    <div
      role="status"
      className="border-b bg-muted/30 px-5 py-3 text-xs leading-relaxed text-muted-foreground sm:px-7"
    >
      {recovering
        ? `Restoring the peer connection${session.recoveryAttempt ? ` · attempt ${session.recoveryAttempt}` : ""}. Messages and your draft stay here; sending is paused.`
        : signalingInterrupted
          ? "Signaling is interrupted. Your peer connection is still active and you can keep sending text."
          : session.signalingStatus === "retired"
            ? "Your peer connection is active. Signaling has retired; reconnecting will require a fresh pair."
            : "Your peer connection is active."}
    </div>
  )
}

function SessionDuration({ connectedAt }: { connectedAt: number | null }) {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    if (connectedAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [connectedAt])
  if (connectedAt === null || now === null) return <>—</>
  const seconds = Math.max(0, Math.floor((now - connectedAt) / 1000))
  return (
    <>
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </>
  )
}

export function ConnectionDetails({ session }: { session: PairSessionHook }) {
  const [exportStatus, setExportStatus] = useState("")
  const downloads = useRef(new Map<string, number>())
  useEffect(() => {
    const pending = downloads.current
    return () => {
      for (const [url, timer] of pending) {
        window.clearTimeout(timer)
        URL.revokeObjectURL(url)
      }
      pending.clear()
    }
  }, [])
  function exportDiagnostics() {
    let url: string | null = null
    const anchor = document.createElement("a")
    try {
      const json = session.exportDiagnostics()
      url = URL.createObjectURL(new Blob([json], { type: "application/json" }))
      anchor.href = url
      anchor.download = "pair-diagnostics.json"
      document.body.appendChild(anchor)
      anchor.click()
      const downloadUrl = url
      downloads.current.set(
        downloadUrl,
        window.setTimeout(() => {
          URL.revokeObjectURL(downloadUrl)
          downloads.current.delete(downloadUrl)
        }, 1000)
      )
      setExportStatus("Diagnostics download requested.")
    } catch {
      if (url) URL.revokeObjectURL(url)
      setExportStatus("Couldn’t download diagnostics. Please try again.")
    } finally {
      anchor.remove()
    }
  }
  return (
    <details className="border-y text-sm">
      <summary className="cursor-pointer px-3 py-3 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Connection details
      </summary>
      <div className="space-y-4 px-4 pb-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <dt className="text-muted-foreground">Mode</dt>
          <dd className="capitalize">{session.mode}</dd>
          <dt className="text-muted-foreground">Route</dt>
          <dd>
            {session.route === "direct"
              ? "Direct"
              : session.route === "relay"
                ? "TURN relay"
                : "Checking"}
          </dd>
          {session.roundTripTimeMs !== null && (
            <>
              <dt className="text-muted-foreground">Round-trip time</dt>
              <dd>{Math.round(session.roundTripTimeMs)} ms</dd>
            </>
          )}
          <dt className="text-muted-foreground">Session duration</dt>
          <dd className="font-mono tabular-nums">
            <SessionDuration connectedAt={session.connectedAt} />
          </dd>
          <dt className="text-muted-foreground">Signaling</dt>
          <dd className="capitalize">{session.signalingStatus}</dd>
          <dt className="text-muted-foreground">Negotiation transport</dt>
          <dd>Nostr · {session.nostrStatus}</dd>
          <dt className="text-muted-foreground">Recovery attempt</dt>
          <dd>{session.recoveryAttempt}</dd>
          <dt className="text-muted-foreground">Relay credentials</dt>
          <dd>
            {session.relayAvailable === null
              ? "Not checked"
              : session.relayAvailable
                ? "Available"
                : "Unavailable"}
          </dd>
        </dl>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Credential availability does not guarantee relay reachability. The
          route above shows the selected connection.
        </p>
        <Button variant="outline" onClick={exportDiagnostics}>
          Export diagnostics
        </Button>
        <p role="status" className="text-xs text-muted-foreground">
          {exportStatus}
        </p>
      </div>
    </details>
  )
}
