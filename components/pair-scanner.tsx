"use client"

import { useEffect, useRef, useState } from "react"
import { Camera, X } from "lucide-react"
import { Button } from "./ui/button"

function CameraPreview({
  onScan,
  onClose,
}: {
  onScan: (link: string) => void
  onClose: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState("")
  const scan = useRef(onScan)
  useEffect(() => {
    scan.current = onScan
  }, [onScan])
  useEffect(() => {
    let cancelled = false
    let scanned = false
    let controls: { stop: () => void } | undefined
    const element = video.current!
    void import("@zxing/browser")
      .then(async ({ BrowserQRCodeReader }) => {
        if (cancelled) return
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
          throw new Error(
            "Camera scanning requires HTTPS and camera support. Paste an invitation instead."
          )
        controls = await new BrowserQRCodeReader().decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } }, audio: false },
          element,
          (result) => {
            if (!result || cancelled || scanned) return
            scanned = true
            controls?.stop()
            scan.current(result.getText())
          }
        )
        if (cancelled || scanned) controls.stop()
      })
      .catch((error) => {
        if (!cancelled)
          setError(
            error instanceof Error
              ? error.message
              : "Camera unavailable. Paste an invitation instead."
          )
      })
    return () => {
      cancelled = true
      controls?.stop()
      const stream = element.srcObject
      if (stream instanceof MediaStream)
        for (const track of stream.getTracks()) track.stop()
      element.srcObject = null
    }
  }, [])
  return (
    <div className="mt-3 space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Point your camera at a Pair invitation.
        </p>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Stop camera scanning"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <video
        ref={video}
        playsInline
        muted
        className="aspect-video w-full rounded-lg bg-black object-cover"
        aria-label="QR camera preview"
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

export function PairScanner({ onScan }: { onScan: (link: string) => void }) {
  const [open, setOpen] = useState(false)
  return open ? (
    <CameraPreview onScan={onScan} onClose={() => setOpen(false)} />
  ) : (
    <Button
      variant="ghost"
      className="mt-3 w-full"
      onClick={() => setOpen(true)}
    >
      <Camera />
      Scan a QR code
    </Button>
  )
}
