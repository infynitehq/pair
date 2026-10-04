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
import { content, subscribeContent } from "@/lib/storage/content"

export function usePairSession(): PairSessionHook {
  const [state, setState] = useState<PeerState>(initialState)
  const [ready, setReady] = useState(false)
  const session = useRef<PeerSession | null>(null)
  const invitation = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let refreshTimer: ReturnType<typeof setTimeout>
    const unsubscribe = subscribeContent(() => {
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        if (!cancelled) void session.current?.refreshHistory()
      }, 150)
    })
    const url = new URL(window.location.href)
    if (url.searchParams.has("pair")) {
      invitation.current = url.toString()
      window.history.replaceState(null, "", "/")
    }
    Promise.all([loadIdentity(), content.initialize()])
      .then(([identity]) => {
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
          mode,
          true
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
      clearTimeout(refreshTimer)
      unsubscribe()
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
    enablePairingCode: () => session.current?.enablePairingCode(),
    acceptDiscovery: async (requestId, deviceId, authorization) => {
      await session.current?.acceptDiscovery(requestId, deviceId, authorization)
    },
    joinPairing: async (link) => {
      await session.current?.join(link)
    },
    approvePeer: () => session.current?.approve(),
    sendMessage: async (text) => {
      await session.current?.sendText(text)
    },
    offerFile: (file) => session.current?.offerFile(file),
    acceptFile: async (id) => {
      await session.current?.acceptFile(id)
    },
    cancelFile: async (id) => {
      await session.current?.cancelFile(id)
    },
    disconnect: () => session.current?.disconnect(),
    setDeviceName: (name) => session.current?.setName(name),
    setConnectionMode: (mode) => session.current?.setMode(mode),
    retryConnection: () => session.current?.retryConnection(),
    exportDiagnostics: () =>
      session.current?.exportDiagnostics() ?? redactedDiagnostics(state),
  }
}
