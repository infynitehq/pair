# Pair

Account-free browser-to-browser text and file sharing. One Next.js/Vercel project serves the UI and coordination APIs. Managed Redis holds expiring coordination records; `nostr.infynite.in` carries encrypted negotiation; `turn.infynite.in` can relay encrypted WebRTC traffic. **Text and files never enter Redis, Nostr or the APIs.**

## Features and security

- Two-minute QR/link invitations with 256-bit secrets in URL fragments.
- Atomic, single-use guest admission and retry-safe, session-scoped authorization.
- Direction-specific encrypted signaling and authenticated ephemeral Nostr events.
- Local P-256 identities, signed WebRTC descriptions, explicit approval on both devices and identity-pinned recovery.
- Automatic, direct-only and relay-only connectivity; protected temporary TURN credentials.
- Local text history, delivery receipts and explicitly accepted, integrity-checked file transfers.
- In-app QR scanning, optional server-assisted pairing codes and approximate public-IP discovery.
- User-controlled local deletion, redacted diagnostics and light/dark themes.

This is not a security-audited release. Both pages must stay open. Completed content remains locally after reload; current pairing and unfinished transfers do not resume after reload. Background suspension, private browsing and browser eviction can interrupt sessions or remove local content. Names and public-IP grouping do not prove identity or proximity.

## Local development

Requires Node.js 22+ and pnpm.

```sh
pnpm install
# Copy .env.example to .env.local and generate PAIR_RENDEZVOUS_KEY as described there.
pnpm dev
```

Open **http://localhost:3000**. Only Next.js runs. Redis credentials are required in every environment, including local development. Codes and accepted discovery invitations need the dedicated encryption key.

Create a link, open it on the other device, compare the connection-check code, and approve on both screens. Two tabs share a device identity; use separate browser profiles for distinct identities. Use **On this device** for local history, downloads and deletion.

Phones need the same trusted **HTTPS** origin as the invite. LAN HTTP is not a secure context; localhost on a phone points to that phone. Keep both apps in the foreground.

## Configuration

Public browser variables are embedded at build time. All other configuration below is server-only. Restart after changing `.env.local`.

| Variable | Purpose |
|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Managed Redis REST integration; required in production |
| `PAIR_RENDEZVOUS_KEY` | Dedicated 32-byte base64url AES-GCM key for temporary code/discovery invitations |
| `NEXT_PUBLIC_NOSTR_RELAY_URLS` | Explicit Nostr relays; defaults to `wss://nostr.infynite.in` when unset; empty is an error |
| `STUN_URLS` | Optional comma-separated STUN endpoints |
| `TURN_URLS`, `TURN_SHARED_SECRET` | TURN REST endpoints and private shared secret, configured together |

The existing TURN service uses UDP/TCP on 3478. **TURN TLS requires infrastructure support**, not merely a `turns:` URL. Direct connectivity can expose network addresses to the peer.

## Coordination and recovery

HTTP operations require participant authorization, not a session locator alone. Redis atomically coordinates admission, session transitions, code claims and shared rate limits. Invitations expire after two minutes; both devices must record establishment before expiry. Authorization remains bounded to two hours.

Nostr readiness, policies, descriptions, candidates and recovery use authenticated, encrypted, acknowledged frames. Reconnection retries identical ciphertext without resetting counters. No alternative signaling provider is selected silently.

**Healthy WebRTC continues during API, Redis or Nostr outages**, including after authorization retirement. Established connections do not poll the backend or refresh TURN on a timer. Recovery may need new credentials; if authorization has expired, create a new pair. Failed transfers can resume within the same open page, but text without a delivery receipt has uncertain delivery and is not automatically resent.

Discovery has its own unavailable state and does not disable QR/link pairing. Presence expires after 45 seconds; connection requests expire after 60 seconds and require explicit acceptance. Only Vercel's overwritten client-IP header is trusted in production; unsupported hosts have discovery disabled.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm build
```

Vercel Preview/managed Redis, forced-TURN transfers, physical Safari/iPhone and cross-network validation remain release gates. This repository no longer includes automated tests; lint, typecheck and build do not verify runtime behavior.

## Privacy boundary

Vercel sees admission proofs, authorization and temporary credentials; Redis stores credential hashes and expiring coordination state. QR/link secrets stay in browsers. Typed codes and discovery are explicitly **server-assisted**: the API handles their invitation material and encrypts it before Redis storage. They are not server-blind PAKE.

Nostr and TURN can observe network metadata, timing and traffic sizes, not application plaintext. Local content is not application-encrypted at rest. Same-origin scripts, the frontend delivery origin and access to the browser profile are inside the trust boundary. Deleting local content does not delete peer copies or downloaded files, and deliberately preserves device identity.
