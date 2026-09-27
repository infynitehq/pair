"use client"

import { useEffect, useRef, useState } from "react"
import { loadIdentity } from "@/lib/peer/identity"
import { initialState, PeerSession } from "@/lib/peer/session"
import type {
  ConnectionMode,
  PairSessionHook,
  PeerState,
} from "@/lib/peer/types"
import { redactedDiagnostics } from "@/lib/peer/connectivity"

export function usePairSession(): PairSessionHook {
  const [state, setState] = useState<PeerState>(initialState)
  const [ready, setReady] = useState(false)
  const session = useRef<PeerSession | null>(null)
  const invitation = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const url = new URL(window.location.href)
    if (url.searchParams.has("pair")) {
      invitation.current = url.toString()
      window.history.replaceState(null, "", "/")
    }
    loadIdentity()
      .then((identity) => {
        if (cancelled) return
        let savedName: string | null = null
        let mode: ConnectionMode = "automatic"
        try {
          savedName = localStorage.getItem("pair-device-name")
          const savedMode = localStorage.getItem("pair-connection-mode")
          if (savedMode === "direct" || savedMode === "relay") mode = savedMode
        } catch {
          /* Name persistence is optional. */
        }
        const name =
          savedName ||
          (/iPhone|iPad/.test(navigator.userAgent)
            ? "My iPhone or iPad"
            : /Android/.test(navigator.userAgent)
              ? "My Android"
              : "My computer")
        const instance = new PeerSession(
          identity,
          name.slice(0, 40),
          setState,
          mode
        )
        session.current = instance
        setState(instance.state)
        setReady(true)
        if (invitation.current) {
          const link = invitation.current
          invitation.current = null
          void instance.join(link)
        }
      })
      .catch((error) => {
        if (!cancelled)
          setState({
            ...initialState,
            status: "error",
            error:
              error instanceof Error
                ? error.message
                : "Could not initialize this device.",
          })
      })
    return () => {
      cancelled = true
      session.current?.dispose()
      session.current = null
    }
  }, [])

  return {
    ...state,
    ready,
    createPairing: async () => {
      await session.current?.create()
    },
    joinPairing: async (link) => {
      await session.current?.join(link)
    },
    approvePeer: () => session.current?.approve(),
    sendMessage: (text) => session.current?.sendText(text),
    disconnect: () => session.current?.disconnect(),
    setDeviceName: (name) => session.current?.setName(name),
    setConnectionMode: (mode) => session.current?.setMode(mode),
    retryConnection: () => session.current?.retryConnection(),
    exportDiagnostics: () =>
      session.current?.exportDiagnostics() ?? redactedDiagnostics(state),
  }
}
