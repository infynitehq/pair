"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import { useTheme } from "next-themes"
import { QRCodeSVG } from "qrcode.react"
import {
  ArrowDownLeft,
  ArrowRight,
  Check,
  CheckCheck,
  CircleAlert,
  Copy,
  Fingerprint,
  Link2,
  Loader2,
  LockKeyhole,
  MessageSquare,
  Moon,
  Plus,
  Send,
  ShieldCheck,
  Sun,
  X,
} from "lucide-react"

import { usePairSession } from "@/hooks/use-pair-session"
import type { PairSessionHook, SessionStatus } from "@/lib/peer/types"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import {
  ConnectionDetails,
  ConnectionHealth,
  ConnectionModeSelect,
  failureGuidance,
} from "@/components/pair-connection"

const statusLabels: Record<SessionStatus, string> = {
  idle: "Not connected",
  creating: "Creating link",
  waiting: "Waiting for peer",
  connecting: "Connecting",
  verifying: "Approval needed",
  connected: "Connected",
  recovering: "Recovering connection",
  closed: "Session ended",
  error: "Connection issue",
}

function Expiry({ expiresAt }: { expiresAt: number | null }) {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  if (!expiresAt) return null
  const seconds =
    now === null ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return (
    <span className="font-mono text-xs text-muted-foreground tabular-nums">
      {seconds === null
        ? "Temporary pairing link"
        : seconds === 0
          ? "Pairing link expired"
          : `Link expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
    </span>
  )
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      aria-label="Toggle light or dark theme"
      title="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <Moon className="size-4 dark:hidden" aria-hidden="true" />
      <Sun className="hidden size-4 dark:block" aria-hidden="true" />
    </Button>
  )
}

function PeerIdentity({ session }: { session: PairSessionHook }) {
  return (
    <details className="rounded-lg border text-sm">
      <summary className="cursor-pointer rounded-lg px-4 py-3 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        View browser identities
      </summary>
      <dl className="space-y-4 px-4 pb-4 text-xs">
        <div>
          <dt className="mb-1 text-muted-foreground">
            Your browser · {session.deviceName}
          </dt>
          <dd className="font-mono break-all">
            {session.deviceId || "Initializing…"}
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-muted-foreground">
            Peer · {session.peerName || "Other browser"}
          </dt>
          <dd className="font-mono break-all">
            {session.peerId || "Not available yet"}
          </dd>
        </div>
      </dl>
    </details>
  )
}

function PairingInvite({ session }: { session: PairSessionHook }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle"
  )
  const input = useRef<HTMLInputElement>(null)
  async function copyLink() {
    if (!session.pairingLink) return
    try {
      await navigator.clipboard.writeText(session.pairingLink)
      setCopyState("copied")
    } catch {
      input.current?.focus()
      input.current?.select()
      setCopyState("failed")
    }
  }
  return (
    <Card>
      <CardHeader>
        <div className="mb-5 flex items-center justify-between">
          <Badge>
            <span className="size-1.5 rounded-full bg-foreground" />
            Invitation open
          </Badge>
          <Expiry expiresAt={session.expiresAt} />
        </div>
        <CardTitle>Meet on the other side.</CardTitle>
        <CardDescription>
          Scan with your other device, or send the link to the person you want
          to pair with.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center gap-8 sm:flex-row">
          <div className="shrink-0 rounded-xl border bg-white p-4">
            {session.pairingLink ? (
              <QRCodeSVG
                value={session.pairingLink}
                size={168}
                level="M"
                title="Scan to open this pairing invitation"
              />
            ) : (
              <Loader2
                className="m-16 size-8 animate-spin text-black"
                aria-label="Preparing QR code"
              />
            )}
          </div>
          <div className="w-full min-w-0 space-y-3">
            <label htmlFor="pairing-link" className="text-sm font-medium">
              Your one-time pairing link
            </label>
            <Input
              ref={input}
              id="pairing-link"
              readOnly
              value={session.pairingLink ?? ""}
              className="font-mono text-xs"
              onFocus={(event) => event.target.select()}
            />
            <Button
              variant="outline"
              className="h-10 w-full sm:w-auto"
              onClick={copyLink}
              disabled={!session.pairingLink}
            >
              {copyState === "copied" ? <Check /> : <Copy />}
              {copyState === "copied" ? "Link copied" : "Copy link"}
            </Button>
            <p
              role="status"
              className="text-xs leading-relaxed text-muted-foreground"
            >
              {copyState === "failed"
                ? "Clipboard unavailable. The link is selected—copy it manually."
                : "Keep this page open. You’ll both approve the connection before sending text."}
            </p>
          </div>
        </div>
        <Separator className="my-6" />
        <div className="flex items-center justify-between gap-4">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Waiting for the other browser
          </p>
          <Button variant="ghost" onClick={session.disconnect}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function Verification({ session }: { session: PairSessionHook }) {
  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <div className="mb-5 flex items-center justify-between">
          <div className="flex size-11 items-center justify-center rounded-xl border">
            <Fingerprint className="size-5" />
          </div>
          <Expiry expiresAt={session.expiresAt} />
        </div>
        <CardTitle>Is this your peer?</CardTitle>
        <CardDescription>
          <span className="font-medium text-foreground">
            {session.peerName || "Another browser"}
          </span>{" "}
          wants to connect. Compare this code on both screens or through a
          channel you trust before approving.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-xl border bg-muted/40 px-4 py-6 text-center">
          <p className="mb-3 text-xs text-muted-foreground">Connection check</p>
          <p className="font-mono text-3xl font-medium tracking-[0.15em] break-all sm:text-4xl">
            {session.verificationCode || "Preparing…"}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            A matching code checks the connection, not someone’s real-world
            identity.
          </p>
        </div>
        <PeerIdentity session={session} />
        <div className="space-y-2 text-sm" aria-live="polite">
          <ApprovalRow approved={session.approved} label="Your approval" />
          <ApprovalRow
            approved={session.peerApproved}
            label="Peer’s approval"
          />
        </div>
        <Button
          className="h-11 w-full"
          disabled={session.approved || !session.verificationCode}
          onClick={session.approvePeer}
        >
          {session.approved ? <Check /> : <ShieldCheck />}
          {session.approved
            ? "Approved — waiting for your peer"
            : "Codes match · approve peer"}
        </Button>
        <Button
          variant="ghost"
          className="h-10 w-full"
          onClick={session.disconnect}
        >
          <X />
          Cancel connection
        </Button>
      </CardContent>
    </Card>
  )
}

function ApprovalRow({
  approved,
  label,
}: {
  approved: boolean
  label: string
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5 text-xs">
        {approved && <Check className="size-3.5" />}
        {approved ? "Approved" : "Waiting"}
      </span>
    </div>
  )
}

function Chat({ session }: { session: PairSessionHook }) {
  const recovering = session.status === "recovering"
  const [draft, setDraft] = useState("")
  const [sendError, setSendError] = useState("")
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" })
  }, [session.messages.length])
  function send(event: FormEvent) {
    event.preventDefault()
    if (!draft.trim() || recovering) return
    try {
      session.sendMessage(draft.trim())
      setDraft("")
      setSendError("")
    } catch (error) {
      setSendError(
        error instanceof Error
          ? error.message
          : "Couldn’t send. Check the connection and try again."
      )
    }
  }
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4 sm:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
            <Link2 className="size-4" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium">
              {session.peerName || "Connected peer"}
            </h2>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <LockKeyhole className="size-3" />
              Encrypted ·{" "}
              {session.route === "direct"
                ? "Direct connection"
                : session.route === "relay"
                  ? "Relayed connection"
                  : "Checking route"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {session.signalingStatus !== "retired" && (
            <Button
              variant="outline"
              className="h-9"
              onClick={session.retryConnection}
              disabled={recovering}
            >
              Reconnect
            </Button>
          )}
          <Button
            variant="outline"
            className="h-9"
            onClick={session.disconnect}
          >
            Disconnect
          </Button>
        </div>
      </div>
      <ConnectionHealth session={session} />
      <div
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        aria-relevant="additions text"
        className="h-[min(48svh,440px)] min-h-64 space-y-5 overflow-y-auto overscroll-contain p-5 sm:p-7"
      >
        {session.messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border">
              <MessageSquare className="size-5" />
            </div>
            <p className="text-sm font-medium">You’re paired. Say something.</p>
            <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">
              Send a note, a link, or that bit of text you need on the other
              screen.
            </p>
          </div>
        ) : (
          session.messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "flex flex-col items-start gap-1.5",
                message.direction === "outgoing" && "items-end"
              )}
            >
              <p
                className={cn(
                  "max-w-[90%] rounded-2xl rounded-tl-sm bg-muted px-4 py-3 text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap sm:max-w-[80%]",
                  message.direction === "outgoing" &&
                    "rounded-tl-2xl rounded-tr-sm bg-primary text-primary-foreground"
                )}
              >
                {message.text}
              </p>
              <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                <span>
                  {message.direction === "outgoing"
                    ? "You"
                    : session.peerName || "Peer"}
                </span>
                <span aria-hidden="true">·</span>
                <time dateTime={new Date(message.timestamp).toISOString()}>
                  {new Date(message.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                {message.direction === "outgoing" && (
                  <>
                    <span aria-hidden="true">·</span>
                    {message.status === "delivered" ? (
                      <CheckCheck className="size-3" />
                    ) : (
                      <Check className="size-3" />
                    )}
                    <span>
                      {message.status === "delivered" ? "Delivered" : "Sent"}
                    </span>
                  </>
                )}
              </p>
            </div>
          ))
        )}
        <div ref={bottom} />
      </div>
      <form onSubmit={send} className="border-t p-4 sm:p-5">
        <label className="sr-only" htmlFor="message">
          Message to your peer
        </label>
        <Textarea
          id="message"
          disabled={recovering}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Write a message…"
          maxLength={4000}
          className="min-h-24 resize-y"
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {draft.length > 3500
              ? `${draft.length.toLocaleString()} / 4,000 characters`
              : "Text first. Files next."}
          </p>
          <Button
            type="submit"
            className="h-10 px-4"
            disabled={recovering || !draft.trim()}
          >
            <Send />
            Send text
          </Button>
        </div>
        {sendError && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {sendError}
          </p>
        )}
      </form>
      <div className="space-y-3 border-t px-4 py-3 sm:px-5">
        <ConnectionDetails session={session} />
        <PeerIdentity session={session} />
      </div>
    </Card>
  )
}

export function PairApp() {
  const session = usePairSession()
  const [joinLink, setJoinLink] = useState("")
  const [actionError, setActionError] = useState("")
  const isIdle = session.status === "idle"
  const hasChat =
    session.status === "connected" || session.status === "recovering"
  const failure = session.errorCode ? failureGuidance[session.errorCode] : null
  const isBusy =
    session.status === "creating" || session.status === "connecting"
  async function run(action: () => Promise<void>) {
    setActionError("")
    try {
      await action()
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Couldn’t connect. Please try again."
      )
    }
  }
  function join(event: FormEvent) {
    event.preventDefault()
    if (joinLink.trim()) void run(() => session.joinPairing(joinLink.trim()))
  }
  return (
    <div className="pair-background min-h-svh">
      <div className="mx-auto flex min-h-svh max-w-[1000px] flex-col px-5 sm:px-8">
        <header className="flex h-24 shrink-0 items-center justify-between gap-4 border-b sm:h-28">
          <div className="flex items-center gap-2.5" aria-label="pair">
            <span className="flex size-9 items-center justify-center rounded-xl bg-foreground text-background">
              <Link2 className="size-5 -rotate-45" strokeWidth={2} />
            </span>
            <span className="pb-1 text-3xl font-semibold tracking-[-0.08em]">
              pair
            </span>
          </div>
          <div className="flex items-center gap-2 sm:gap-4">
            <Badge
              className="border-transparent bg-muted/70 text-muted-foreground"
              aria-live="polite"
            >
              {isBusy || (!session.ready && isIdle) ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <span
                  className={cn(
                    "size-1.5 rounded-full bg-muted-foreground/50",
                    session.status === "connected" && "bg-foreground"
                  )}
                />
              )}
              {!session.ready && isIdle
                ? "Initializing"
                : statusLabels[session.status]}
            </Badge>
            <ThemeToggle />
          </div>
        </header>

        <main id="main" className="flex-1 py-12 sm:py-16">
          <div className={cn("mb-10 sm:mb-12", hasChat && "mb-7 sm:mb-8")}>
            <p className="mb-5 flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
              <span className="h-px w-6 bg-muted-foreground/50" />A direct line
              between browsers
            </p>
            <h1 className="max-w-2xl text-[clamp(2.5rem,6vw,4rem)] leading-[1.06] font-medium tracking-[-0.055em]">
              {hasChat ? (
                <>
                  Less distance.
                  <br />
                  <span className="text-muted-foreground">
                    More connection.
                  </span>
                </>
              ) : (
                <>
                  Two browsers.
                  <br />
                  <span className="text-muted-foreground">
                    One little connection.
                  </span>
                </>
              )}
            </h1>
            <p className="mt-5 max-w-md text-sm leading-7 text-muted-foreground sm:text-base">
              {hasChat
                ? "A shared space for the text you want to send. Just you and your peer."
                : "Share text from here to there. No account, no inbox, just a temporary connection with someone you choose."}
            </p>
          </div>

          {(session.error || actionError || failure) && (
            <div
              role="alert"
              className="mb-6 flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div>
                <p className="font-medium">
                  {failure?.title ?? "Something needs your attention."}
                </p>
                <p className="mt-1 leading-relaxed text-muted-foreground">
                  {session.error || actionError}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {failure?.help ??
                    (hasChat
                      ? "Check the connection status below before trying again."
                      : "Check the invitation and your network, then try again.")}
                </p>
              </div>
            </div>
          )}

          {isIdle && (
            <>
              <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                <label
                  htmlFor="device-name"
                  className="shrink-0 text-xs text-muted-foreground"
                >
                  You’ll appear as
                </label>
                <Input
                  id="device-name"
                  autoComplete="off"
                  maxLength={40}
                  key={session.ready ? "ready" : "initializing"}
                  defaultValue={session.deviceName}
                  onBlur={(event) => {
                    const name = event.target.value.trim() || "This device"
                    event.target.value = name
                    session.setDeviceName(name)
                  }}
                  disabled={!session.ready}
                  placeholder="Name this browser"
                  className="h-9 sm:max-w-56"
                />
              </div>
              <ConnectionModeSelect session={session} />
              <div className="grid gap-5 md:grid-cols-2">
                <Card className="flex flex-col">
                  <CardHeader>
                    <div className="mb-7 flex size-10 items-center justify-center rounded-xl border bg-muted/40">
                      <Plus className="size-5" />
                    </div>
                    <CardTitle>Start a pair</CardTitle>
                    <CardDescription>
                      Create a temporary link. Share it with your other browser
                      or someone you trust.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="mt-auto pt-7">
                    <Button
                      className="h-11 w-full justify-between px-4"
                      disabled={!session.ready}
                      onClick={() => void run(session.createPairing)}
                    >
                      <span>
                        {session.ready
                          ? "Create pairing link"
                          : "Getting your browser ready…"}
                      </span>
                      {session.ready ? (
                        <ArrowRight />
                      ) : (
                        <Loader2 className="animate-spin" />
                      )}
                    </Button>
                    <p className="mt-3 text-xs text-muted-foreground">
                      A QR code and a link. That’s all it takes.
                    </p>
                  </CardContent>
                </Card>
                <Card className="flex flex-col bg-card/70">
                  <CardHeader>
                    <div className="mb-7 flex size-10 items-center justify-center rounded-xl border bg-muted/40">
                      <ArrowDownLeft className="size-5" />
                    </div>
                    <CardTitle>Have a link?</CardTitle>
                    <CardDescription>
                      Someone started a pair for you. Paste their invitation
                      below to join them.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="mt-auto pt-7">
                    <form onSubmit={join} className="space-y-3">
                      <label htmlFor="join-link" className="sr-only">
                        Pairing invitation link
                      </label>
                      <Input
                        id="join-link"
                        type="url"
                        value={joinLink}
                        onChange={(event) => setJoinLink(event.target.value)}
                        placeholder="Paste a pairing link…"
                        autoComplete="off"
                        spellCheck={false}
                        required
                        disabled={!session.ready}
                      />
                      <Button
                        type="submit"
                        variant="outline"
                        className="h-11 w-full justify-between px-4"
                        disabled={!session.ready || !joinLink.trim()}
                      >
                        <span>Join a pair</span>
                        <ArrowRight />
                      </Button>
                    </form>
                  </CardContent>
                </Card>
              </div>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-2">
                  <LockKeyhole className="size-3.5" />
                  Encrypted in transit
                </span>
                <span className="flex items-center gap-2">
                  <ShieldCheck className="size-3.5" />
                  Both peers approve
                </span>
                <span className="md:ml-auto">Text first. Files next.</span>
              </div>
            </>
          )}

          {isBusy && (
            <Card className="mx-auto max-w-xl">
              <CardContent className="flex flex-col items-center py-12 text-center sm:py-14">
                <Loader2 className="mb-6 size-6 animate-spin" />
                <h2 className="text-xl font-medium tracking-tight">
                  {session.status === "creating"
                    ? "Making a little connection."
                    : "Finding your other browser."}
                </h2>
                <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
                  {session.status === "creating"
                    ? "Creating your temporary invitation. Your QR code and link will appear here."
                    : "Keep both pages open while the browsers connect. You’ll approve your peer next."}
                </p>
                <div className="mt-4">
                  <Expiry expiresAt={session.expiresAt} />
                </div>
                <Button
                  variant="outline"
                  className="mt-7 h-10"
                  onClick={session.disconnect}
                >
                  Cancel
                </Button>
              </CardContent>
            </Card>
          )}
          {session.status === "waiting" && <PairingInvite session={session} />}
          {session.status === "verifying" && <Verification session={session} />}
          {hasChat && <Chat session={session} />}
          {(session.status === "closed" || session.status === "error") && (
            <Card className="mx-auto max-w-xl">
              <CardContent className="py-10 text-center sm:py-12">
                <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-2xl border">
                  <Link2 className="size-5" />
                </div>
                <h2 className="text-xl font-medium tracking-tight">
                  {session.status === "closed"
                    ? "This connection has ended."
                    : "Let’s try a fresh connection."}
                </h2>
                <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
                  Create a new invitation or ask your peer for a fresh link.
                  Both browsers will need to approve again.
                </p>
                <Button
                  className="mt-6 h-11 px-5"
                  onClick={() => {
                    setActionError("")
                    window.location.reload()
                  }}
                >
                  Back to pairing
                  <ArrowRight />
                </Button>
              </CardContent>
            </Card>
          )}
        </main>

        <footer className="flex flex-col justify-between gap-4 border-t py-6 sm:flex-row sm:items-start sm:gap-10">
          <p className="flex shrink-0 items-center gap-2 text-xs font-medium">
            <Link2 className="size-3.5" />
            Small connection. Less friction.
          </p>
          <p className="max-w-lg text-xs leading-5 text-muted-foreground">
            Text travels over encrypted WebRTC, directly or through a TURN
            relay. Signaling handles connection metadata, including network
            addresses and timing, not your text. A relay can see network
            addresses, traffic volume, and timing, but not plaintext messages.
            Keep both pages open; history stays in memory.
          </p>
        </footer>
      </div>
    </div>
  )
}
