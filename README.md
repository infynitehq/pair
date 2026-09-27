# pair

A minimal, account-free browser-to-browser connection. Built with Next.js, shadcn-style components, TypeScript, WebRTC, and an ephemeral WebSocket signaling service.

## Current milestone: connectivity and recovery

- QR and link invitations with two-minute expiration.
- Local P-256 device identities stored in IndexedDB (non-extractable private keys).
- Encrypted signaling authenticated by a 256-bit invitation secret.
- Signed WebRTC descriptions binding device identities to DTLS fingerprints.
- Explicit approval on both devices before text exchange.
- Separate control and chat DataChannels, delivery receipts, bounded message history.
- Automatic, direct-only, and relay-only connection modes.
- Server-issued, short-lived TURN credentials; no shared relay secret in the browser.
- Resumable signaling with rotating role-scoped credentials and bounded ciphertext replay.
- Authenticated ICE restart and replacement transport, pinned to the approved peer identity.
- Live route/RTT diagnostics, redacted export, cancellation, categorized errors, light/dark themes.
- Origin-checked, rate-limited, in-memory signaling with cleanup and heartbeats.

This is a **development milestone**, not a security-audited release. Files, trusted-device discovery, durable history, and recovery after a page reload are not implemented yet. The connection-check code is a diagnostic; authentication relies on securely sharing the full invitation secret. Protocol v2 is intentionally incompatible with the first milestone: reload both peers after upgrading.

## Run locally

Requires Node.js 22+ and pnpm.

```sh
pnpm install
pnpm dev
```

Open **http://localhost:3000**. `pnpm dev` starts both Next.js and signaling on port 3001.

1. Create a pairing link.
2. Open it in another browser or private window, or paste it into “Have a link?”.
3. Confirm the connection on both screens.
4. Exchange text. Disconnect to end the session.

Two tabs share the same local identity; use separate browser profiles for distinct identities.

### Configuration

Copy `.env.example` to `.env.local` when overriding defaults. Both services read this file. Restart after changing environment variables; public browser variables are embedded at build time.

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SIGNALING_URL` | Current hostname, port 3001, `/signal` | Browser WebSocket endpoint |
| `STUN_URLS` | Empty | Server-issued, optional comma-separated STUN endpoints |
| `TURN_URLS` | Empty | Comma-separated TURN UDP/TCP/TLS endpoints |
| `TURN_SHARED_SECRET` | Empty | Server-only TURN REST authentication secret; at least 32 characters |
| `TURN_CREDENTIAL_TTL_SECONDS` | `600` when enabled | Credential lifetime, 60–3600 seconds |
| `SIGNALING_PORT` | `3001` | Signaling listen port |
| `SIGNALING_ORIGINS` | localhost and 127.0.0.1 on port 3000 | Exact comma-separated browser origins |

No third-party STUN or TURN service is contacted by default. Automatic mode uses configured relays when direct routes are unavailable. Direct-only excludes local and remote relay candidates. Relay-only fails clearly if TURN is not configured. A direct connection can expose network addresses to the other peer.

TURN uses the coturn-compatible REST credential convention, also offered by some managed providers. Providers using a different credential API need an `IceProvider` adapter. See [TURN setup and local testing](docs/turn.md).

### Recovery behavior

- Signaling loss preserves a working data channel and retries with bounded backoff.
- Server-side participant membership survives socket loss for 30 seconds.
- A disrupted peer connection pauses sending, retains displayed messages and drafts, and attempts recovery.
- The host coordinates an ICE restart, with a replacement transport as a bounded fallback. A replacement must prove the same identity; it does not silently approve a new device.
- Encrypted signaling counters and pending ciphertext survive socket reconnection. Resume tokens rotate with a lost-response fallback.
- Reconnect from the session toolbar exercises this path manually.
- Session retirement after two hours, a signaling-server restart, a long outage, or reloading the page can require a fresh pairing. Healthy peer data can continue after signaling retirement.
- Messages are not automatically retried after transport loss; a missing delivery receipt means delivery is uncertain.

### Test with a phone

Use a trusted **HTTPS** origin for the web app and a reachable **WSS** signaling endpoint, typically through a reverse proxy. Configure the browser endpoint and allow that exact HTTPS origin on signaling. Create the invite from the same public origin that the phone will open.

Plain `http://192.168.x.x:3000` is not a secure context and cannot initialize Web Crypto. A localhost invitation points to the phone itself when opened on a phone. Scan with the phone’s camera app; in-app camera scanning is not included.

Keep both apps in the foreground. Browser background suspension and screen locking can interrupt a session.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
```

For actual TURN integration, start the loopback-only fixture separately:

```sh
docker compose -f compose.turn.yaml --profile integration up -d
pnpm test:turn
docker compose -f compose.turn.yaml --profile integration down
```

The TURN tests create an isolated signaling instance with temporary credentials, force both browsers to relay, exchange text, recover the relay session, and check that expired credentials cannot allocate a relay candidate. These tests are opt-in; normal browser tests explicitly skip them.

The browser suite starts the services automatically. It verifies independent identities, mutual approval, delivery receipts, modified-secret rejection, signaling resumption, ICE restart, transport replacement, connection modes, and preservation of chat through recovery. It also checks that chat plaintext, public identity keys, SDP, and the invitation secret do not appear in signaling frames. A derived admission token is deliberately shared with signaling and cannot derive the encryption keys.

Real-device Safari/iOS and cross-network validation remain release gates. Chromium automation is not evidence of those environments working.

ESLint is pinned to the 9.x line because the supplied Next.js React lint plugin is incompatible with ESLint 10’s removed APIs.

## Deployment

```sh
pnpm build
pnpm start
# Separate long-running process:
pnpm start:signal
```

Set `NODE_ENV=production` and explicit `SIGNALING_ORIGINS` for signaling. Terminate TLS at the reverse proxy and support WebSocket upgrades for `/signal`. Do not deploy the signaling process as a short-lived serverless route. The signal health endpoint is `GET /health`.

The service deliberately uses the socket’s remote IP, not untrusted forwarded headers. Behind a proxy, configure upstream per-client limits and account for the server’s shared-proxy-IP limits. Do not enable payload, invitation-URL, or raw WebSocket logging. Established data channels do not require an operational signaling connection; pairing and recovery do.

## Structure

```text
app/                       Next.js shell
components/pair-app.tsx     Pairing, approval and chat interface
components/ui/             Minimal shadcn primitives
hooks/use-pair-session.ts   React adapter
lib/peer/crypto.ts         Signing and signaling encryption
lib/peer/identity.ts       Local identity lifecycle
lib/peer/session.ts        Connection state and DataChannels
lib/peer/connectivity.ts   ICE policies, validation, redacted diagnostics
lib/peer/types.ts          UI-facing contract
server/signaling.ts       Ephemeral rendezvous and signaling
server/index.ts           Standalone server entry
server/ice.ts             Temporary TURN REST credential provider
compose.turn.yaml         Loopback-only Linux relay test fixture
tests/browser/            Two-browser integration checks
docs/protocol.md          Protocol and current trust boundary
```

## Privacy boundary

Text is sent only through WebRTC. Messages are held in page memory, capped at 500, and are not written to IndexedDB or the server. Device identity is persistent locally; its name is saved in localStorage. Clearing browser storage creates a new identity.

The server sees IP addresses, timing, random session IDs, a derived admission proof, temporary relay credentials, and encrypted signaling sizes. TURN relays encrypted traffic and sees its metadata. An invitation is a bearer secret: share it only with the intended peer. Anyone possessing it can attempt to pair. Knowing only the session locator no longer grants admission. Device names are not verified real-world identities.

The frontend delivery origin is trusted. A compromised application bundle can access plaintext and invoke local keys, even if those keys are non-extractable. The initial custom protocol composition needs independent review before public security claims.

## Next milestones

1. Independent pairing review and real Safari/iPhone tests.
2. Accepted, chunked file transfers with receiver credits and incremental hashing.
3. Remembered-device trust and private rendezvous.
4. Optional history, resumable files, and a PWA shell.
