"use client"

import { useRef, useState } from "react"
import { Download, FileUp, Paperclip, X } from "lucide-react"
import type { PairSessionHook } from "@/lib/peer/types"
import { content } from "@/lib/storage/content"
import { Button } from "@/components/ui/button"

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
}
export async function downloadLocalFile(id: string) {
  const file = (await content.files()).find((item) => item.id === id)
  if (!file) throw new Error("This file was deleted")
  const blob = await content.download(file)
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = file.name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function PairFiles({ session }: { session: PairSessionHook }) {
  const picker = useRef<HTMLInputElement>(null)
  const [error, setError] = useState("")
  function offer(files: FileList | null) {
    setError("")
    if (!files) return
    try {
      for (const file of files) session.offerFile(file)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not offer files")
    }
  }
  async function run(action: () => Promise<void>) {
    try {
      setError("")
      await action()
    } catch (error) {
      setError(error instanceof Error ? error.message : "File action failed")
    }
  }
  return (
    <section
      aria-label="File transfers"
      className="space-y-3 border-t p-4 sm:p-5"
    >
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed bg-muted/20 p-4"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          if (session.filesAvailable) offer(event.dataTransfer.files)
        }}
      >
        <div className="flex items-center gap-3">
          <FileUp className="size-5 text-primary" />
          <div>
            <p className="text-sm font-medium">A file for the other side.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Drop files here. Your peer chooses what to accept.
            </p>
          </div>
        </div>
        <input
          ref={picker}
          type="file"
          multiple
          aria-label="Choose files to send"
          className="sr-only"
          disabled={!session.filesAvailable}
          onChange={(event) => {
            offer(event.target.files)
            event.target.value = ""
          }}
        />
        <Button
          variant="outline"
          disabled={!session.filesAvailable}
          onClick={() => picker.current?.click()}
        >
          <Paperclip />
          Send files
        </Button>
      </div>
      {!session.filesAvailable && (
        <p className="text-xs text-muted-foreground">
          Waiting for an approved, connected file channel. Keep both pages open.
        </p>
      )}
      {session.transfers.map((transfer) => (
        <div
          key={transfer.id}
          className="rounded-lg border p-4"
          data-testid="transfer-card"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium break-all">{transfer.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {transfer.direction === "incoming" ? "Receiving" : "Sending"} ·{" "}
                {formatBytes(transfer.size)}
              </p>
            </div>
            <span className="text-xs text-muted-foreground">
              {transfer.state === "complete"
                ? "Saved on receiver"
                : transfer.state === "offered"
                  ? "Awaiting acceptance"
                  : transfer.state}
            </span>
          </div>
          {transfer.state === "transferring" && (
            <div className="mt-3">
              <progress
                aria-label={`Progress for ${transfer.name}`}
                value={transfer.progress}
                max={transfer.size || 1}
                className="h-1.5 w-full accent-primary"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {formatBytes(transfer.progress)} / {formatBytes(transfer.size)}
                {session.status === "recovering"
                  ? " · Paused during recovery"
                  : ""}
              </p>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {transfer.direction === "incoming" &&
              transfer.state === "offered" && (
                <Button
                  size="sm"
                  disabled={!session.filesAvailable}
                  onClick={() =>
                    void run(() => session.acceptFile(transfer.id))
                  }
                >
                  Accept file
                </Button>
              )}
            {["offered", "transferring"].includes(transfer.state) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void run(() => session.cancelFile(transfer.id))}
              >
                <X />
                {transfer.direction === "incoming" &&
                transfer.state === "offered"
                  ? "Decline"
                  : "Cancel transfer"}
              </Button>
            )}
            {transfer.state === "complete" && transfer.fileId && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void run(() => downloadLocalFile(transfer.fileId!))
                }
              >
                <Download />
                Download
              </Button>
            )}
          </div>
          {transfer.error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {transfer.error}
            </p>
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
