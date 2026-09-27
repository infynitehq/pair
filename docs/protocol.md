# Pair protocol v2 — connectivity and recovery

This breaking development protocol requires both peers to reload after a v1 upgrade. It is a custom composition of standard primitives, pending independent cryptographic review.

## First contact and admission

The creator generates a 32-byte browser-CSPRNG secret. The server creates a separate 128-bit random session locator. `/?pair=<id>#<secret>` is the invitation; the fragment is consumed locally and removed from browser history when joining.

HKDF-SHA-256 derives a 32-byte admission token from the secret with empty salt and info `pair.admission.v2`. Its base64url representation is `joinToken`. The creator supplies only `base64url(SHA-256(UTF-8(joinToken)))` as `joinVerifier`. A joiner supplies `joinToken`; signaling compares the hash in constant time **before** reserving the guest slot or issuing guest ICE credentials. The derived admission token does not reveal the secret or the separately derived signaling keys. A locator-only attacker cannot consume the invitation. Link holders and the signaling service can still deny service.

The identity is ECDSA P-256. A non-extractable private `CryptoKey` is persisted in IndexedDB; the public key is base64url SPKI. Device ID is base64url SHA-256 of decoded SPKI. Device names are unverified labels.

## Encrypted negotiation

HKDF-SHA-256 derives AES-256-GCM keys from the invitation secret using the session locator as salt and direction-specific info `pair.signal.v2.host` / `pair.signal.v2.guest`. Each ciphertext uses a random 96-bit IV and authenticated data:

```text
v2:<sessionId>:<sendingRole>:<sequence>
```

Strictly increasing sequence numbers are maintained for the entire session. Socket resumption **does not reset or rederive the cipher**. Retries resend the identical stored ciphertext. A previously authenticated duplicate is acknowledged without being processed again; gaps are rejected. AES-GCM authentication failure terminates pairing.

Descriptions sign this fixed JSON array:

```text
["pair.description.v2", sessionId, role, name, publicKey, sdp, negotiation, transport, mode]
```

`negotiation` is a monotonically increasing integer starting at zero; `transport` is `initial`, `restart`, or `replace`. The complete SDP binds DTLS fingerprints to the presented identity. Both descriptions are verified before use. The host is always offerer and coordinates recovery, avoiding offer glare.

The displayed 48-bit transcript check is informational. It does not replace secure delivery of the invitation secret. The frontend origin and endpoints remain trusted.

## ICE configuration

Admitted participants receive:

```ts
{
  iceServers: Array<{ urls: string[]; username?: string; credential?: string }>,
  expiresAt: number | null,
  relayAvailable: boolean
}
```

TURN REST usernames contain a Unix expiry and a randomized opaque participant binding; credentials are standard-base64 HMAC-SHA1 of the username with the server-only shared secret. Credential lifetime defaults to ten minutes. New negotiations refresh credentials near expiry; expired cached credentials are renewed on signaling resumption. Refresh requests are participant-authorized and rate-limited. Provider exceptions do not echo secrets.

Before creating either peer connection, the browsers exchange authenticated encrypted `policy` messages. A direct-only preference makes both cooperating clients exclude TURN; direct-only versus relay-only is rejected before ICE starts. Preferences are also bound into signed descriptions. This matters because simply filtering remote relay candidates does not prevent peer-reflexive connectivity through the other side’s relay. Direct-only additionally removes remote relay candidates, including candidates embedded in signed SDP (after signature verification). No browser protocol can prove a malicious remote client is not forwarding its own traffic elsewhere. Relay-only sets `iceTransportPolicy: "relay"` and requires TURN. Configured credentials are not evidence that a relay is reachable.

## Socket and participant lifecycles

All signaling envelopes have `v: 2`. The original creating socket owns the host role. Each participant receives an independent random reconnect token held only in page memory. A session locator cannot assume host authority.

Socket disconnection retains the participant for a 30-second grace period. A resuming socket sends the session ID, role, current token and a freshly generated `nextResumeToken`. The server rejects live-role takeover and atomically rotates/binds on success. The client retains both token possibilities until acknowledgement, so losing the successful resume response does not inherently strand the role. Tokens from other roles or sessions cannot authorize it.

Socket generations prevent stale events mutating the current client or server binding. Resume attempts, connection counts, room creation and frame sizes are bounded. Explicit leave removes the session; transient disconnection does not.

Pairing expires after two minutes unless both participants report establishment. Server resources retire after two hours. Retirement does not shut down an otherwise healthy WebRTC transport, but new recovery needs a fresh pair. Server restarts lose all rendezvous state.

## Reliable signaling over reconnects

For each sending participant, the server tracks its next accepted signal sequence. Accepted ciphertext is queued for the recipient until acknowledged, bounded to 128 frames and 1 MiB per recipient.

1. Client stores sealed payload before transmission.
2. Server accepts the next sequence, queues it, forwards when online, and replies `signal-ack`.
3. Sender removes its pending copy after this acknowledgement.
4. Recipient authenticates and processes the frame, then sends `signal-received`.
5. Server prunes acknowledged recipient frames.
6. Resume replays still-queued frames; the sender also retransmits unacknowledged ciphertext.

Signaling never decrypts these frames. Queue overflow fails cleanly rather than dropping a frame and silently desynchronizing the cipher.

## Signaling messages

| Message | Key fields |
|---|---|
| `create` | `joinVerifier` |
| `created` / `joined` | `sessionId`, `expiresAt`, `resumeToken`, `iceConfig` |
| `join` | `sessionId`, `joinToken` |
| `peer-ready` | Initial peer is admitted |
| `resume` | `sessionId`, `role`, `resumeToken`, `nextResumeToken` |
| `resumed` | `sessionId`, `role`, `expiresAt`, `iceConfig`, `peerOnline` |
| `peer-offline` / `peer-online` | Peer signaling availability, not data-plane presence |
| `signal` | `payload: { seq, iv, ciphertext }` |
| `signal-ack` / `signal-received` | `seq` |
| `ice-refresh` | `requestId` |
| `ice-config` | `requestId` plus ICE configuration fields |
| `established` / `leave` | Participant lifecycle |
| `peer-left` / `session-retired` | Rendezvous ended |
| `error` | `code`, optional `message` / `requestId` |

## Recovery and identity continuity

Signaling availability and peer connection status are independent. Healthy channels continue during signaling retries (bounded exponential backoff plus jitter). A peer disruption pauses sending and preserves page-memory history and the draft.

The host coordinates at most two transport attempts per recovery incident: ICE restart when the existing channels are reusable, then replacement if needed. Guests request recovery through authenticated signaling. Each attempt refreshes ICE credentials when necessary and advances the signed negotiation generation. Candidates carry that generation; old ICE-ufrag candidates are ignored.

Every replacement/restart description must verify under the **same peer identity** approved during first contact. A changed key is a fatal authentication error. Old descriptions cannot advance recovery and future generations cannot skip ahead. User approval is scoped to this in-memory session, not permanent device trust.

Recovery uses generation-tagged `session.ready` messages on the ordered application stream. Both sides authenticate the current negotiation and open transport before resuming sends. Limited in-flight data may be buffered during recovery, never displayed before it completes. Failed or cancelled recovery cleans up timers, channels and credentials. Reload recovery, durable queues and automatic text retransmission are not implemented.

## DataChannels and UI

- `control`: `session.close`, `chat.receipt { id }`.
- `chat`: `session.approve`, `session.ready { negotiation }`, `chat.message { id, text }`.

All peer frames have `v: 2`. Approval shares the application stream so a chat message cannot overtake it. Initial text is blocked until both users approve. Text is limited to 4,000 characters, frames to 20,000 JS string units, and receive history to 500 messages. Up to 2,000 message IDs suppress duplicates. Delivery receipts mean receiver processing, not human reading. Text is never sent through signaling.

Diagnostics are an explicit allowlist: state, mode, selected direct/relay route, signaling status, RTT, duration, retry count, and error category. Exports exclude names, identity keys, session IDs, SDP, ICE addresses, credentials and message contents.

## Remaining release gates

- Independent pairing/recovery protocol review.
- Physical Safari/iPhone and restrictive-network validation.
- Production TURN quotas, TLS and operational bandwidth limits.
- Frontend delivery hardening; malicious same-origin code can access plaintext and use local keys.
- Browser suspension and storage eviction remain platform limitations.
