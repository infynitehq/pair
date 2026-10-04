"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Database, Download, Trash2 } from "lucide-react"
import {
  content,
  hasFileStorage,
  subscribeContent,
  type Conversation,
  type StoredFile,
  type StoredMessage,
} from "@/lib/storage/content"
import { Button } from "@/components/ui/button"
import { downloadLocalFile, formatBytes } from "./pair-files"

export function PairLibrary() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [files, setFiles] = useState<StoredFile[]>([])
  const [before, setBefore] = useState<Pick<
    StoredMessage,
    "timestamp" | "key"
  > | null>(null)
  const [pages, setPages] = useState<
    Array<Pick<StoredMessage, "timestamp" | "key"> | null>
  >([])
  const refreshGeneration = useRef(0)
  const invalidate = useCallback(() => {
    ++refreshGeneration.current
  }, [])
  const [fileStorage, setFileStorage] = useState<boolean | null>(null)
  const [error, setError] = useState("")
  const [usage, setUsage] = useState(0)
  const [persistent, setPersistent] = useState(false)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current
    const [rows, text, received, estimate, persisted] = await Promise.all([
      content.conversations(),
      selected
        ? content.messages(selected, before ?? Infinity, 100)
        : Promise.resolve([]),
      selected ? content.files(selected) : Promise.resolve([]),
      navigator.storage?.estimate?.(),
      content.persisted(),
    ])
    if (generation !== refreshGeneration.current) return
    setConversations(rows)
    setMessages(text)
    setFiles(received)
    setUsage(estimate?.usage ?? 0)
    setPersistent(!!persisted)
    setFileStorage(hasFileStorage())
  }, [selected, before])
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const update = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!disposed)
          void refresh().catch((error) =>
            setError(
              error instanceof Error
                ? error.message
                : "Local storage unavailable"
            )
          )
      }, 150)
    }
    update()
    const unsubscribe = subscribeContent(update)
    return () => {
      disposed = true
      invalidate()
      clearTimeout(timer)
      unsubscribe()
    }
  }, [refresh, invalidate])
  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError("")
    try {
      await action()
      await refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : "Local action failed")
    } finally {
      setBusy(false)
    }
  }
  return (
    <details
      className="mt-6 border-y"
      onToggle={() => {
        void refresh().catch(() => {})
      }}
    >
      <summary className="cursor-pointer py-4 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Database className="mr-2 inline size-4" />
        On this device{" "}
        <span className="mt-1 ml-6 block text-[11px] font-normal text-muted-foreground sm:mt-0 sm:ml-2 sm:inline">
          {conversations.length} conversations · {formatBytes(usage)}
        </span>
      </summary>
      <div className="space-y-5 border-t p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-lg text-xs leading-6 text-muted-foreground">
            Messages and accepted files stay here until you delete them. Nothing
            is backed up to our servers.{" "}
            {persistent
              ? "Persistent storage is enabled."
              : "Your browser may evict site storage."}{" "}
            Deleting here does not delete peer or downloaded copies.
          </p>
          {!persistent && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!navigator.storage?.persist || !(await content.protect()))
                    throw new Error(
                      "Persistent storage was not granted for all local content. You can still use Pair, but keep copies of important files."
                    )
                })
              }
            >
              Protect local storage
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {fileStorage === null
            ? "Checking file storage support…"
            : fileStorage
              ? "Disk-backed file storage available. Files up to 2 GiB."
              : "Compatibility storage: received files up to 32 MiB."}{" "}
          Closing a page interrupts unfinished transfers; completed content
          remains.
        </p>
        {conversations.length === 0 ? (
          <p className="py-5 text-sm text-muted-foreground">
            Your saved conversations will appear here.
          </p>
        ) : (
          <>
            <label
              className="block text-xs text-muted-foreground"
              htmlFor="saved-conversation"
            >
              Saved conversation
            </label>
            <select
              id="saved-conversation"
              className="h-10 w-full rounded-lg border bg-background px-3 text-sm"
              value={selected ?? ""}
              onChange={(event) => {
                ++refreshGeneration.current
                setSelected(event.target.value || null)
                setBefore(null)
                setPages([])
              }}
            >
              <option value="">Choose a conversation…</option>
              {conversations.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} · {new Date(row.updatedAt).toLocaleDateString()}
                </option>
              ))}
            </select>
            {selected && (
              <div className="space-y-4">
                <div
                  className="max-h-96 space-y-3 overflow-y-auto"
                  aria-label="Saved messages"
                >
                  <div className="flex gap-2">
                    {messages.length === 100 && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setPages((value) => [...value, before])
                          setBefore({
                            timestamp: messages[0].timestamp,
                            key: messages[0].key,
                          })
                        }}
                      >
                        Older messages
                      </Button>
                    )}
                    {pages.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setBefore(pages.at(-1) ?? null)
                          setPages((value) => value.slice(0, -1))
                        }}
                      >
                        Newer messages
                      </Button>
                    )}
                  </div>
                  {messages.map((message) => (
                    <div
                      key={message.key}
                      className="flex items-start justify-between gap-3 rounded-lg bg-muted/40 p-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm break-words whitespace-pre-wrap">
                          {message.text}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {message.direction === "outgoing" ? "You" : "Peer"} ·{" "}
                          {new Date(message.timestamp).toLocaleString()} ·{" "}
                          {message.status}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        aria-label="Delete message"
                        onClick={() =>
                          void run(() => content.deleteMessage(message.key))
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                </div>
                {files.map((file) => (
                  <div
                    key={file.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm break-all">{file.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatBytes(file.size)} ·{" "}
                        {file.status === "complete"
                          ? "Saved locally · integrity verified"
                          : "Incomplete · send again after pairing"}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {file.status === "complete" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void run(() => downloadLocalFile(file.id))
                          }
                        >
                          <Download />
                          Download
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        aria-label={`Delete ${file.name}`}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete ${file.name} from this device? Downloaded and peer copies will remain.`
                            )
                          )
                            void run(() => content.deleteFile(file.id))
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                ))}
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Delete this conversation and its received files from this device? Active saving to this conversation will stop."
                      )
                    )
                      void run(async () => {
                        await content.deleteConversation(selected)
                        setSelected(null)
                      })
                  }}
                >
                  <Trash2 />
                  Delete conversation
                </Button>
              </div>
            )}
            <div className="border-t pt-4">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Delete ALL messages and received files on this device? Your device identity and downloaded copies will remain."
                    )
                  )
                    void run(async () => {
                      await content.clear()
                      setSelected(null)
                    })
                }}
              >
                <Trash2 />
                Clear all shared content
              </Button>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </details>
  )
}
