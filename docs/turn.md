# TURN REST credentials

`server/ice.ts` exposes `createIceProvider(env?)` and the `IceProvider`,
`IceConfiguration`, and `IceServer` types. Construct a provider once on the
server and call `issue(participantId)` for each authorized participant.
No network or paid API calls are made. Managed TURN works when the service
supports the coturn TURN REST shared-secret standard (HMAC-SHA1).

## Server configuration

```sh
STUN_URLS=stun:stun.example.net:3478
TURN_URLS=turn:turn.example.net:3478?transport=udp,turn:turn.example.net:3478?transport=tcp,turns:turn.example.net:5349?transport=tcp
TURN_SHARED_SECRET=<generate-a-private-random-secret-of-at-least-32-characters>
TURN_CREDENTIAL_TTL_SECONDS=600
```

Set the same private secret in coturn's `static-auth-secret` with
`use-auth-secret`, or in a managed provider's REST-auth configuration.
Never expose this secret through public environment variables, browser
bundles, logs, or signaling messages. Only send issued temporary credentials
to the authorized participant, over authenticated HTTPS/WSS. Do not log them.

Both URL lists are optional and comma-separated. TURN URLs and its secret
must be configured together; a TTL alone is also incomplete TURN configuration.
Blank URL lists are treated as absent. TTL defaults to 600 seconds and must be
an integer from 60 through 3600. Invalid configuration fails at construction
without including supplied values in error messages. URI userinfo, paths,
fragments, invalid hosts/ports and unsupported transport queries are rejected.
Secure TURN uses TCP/TLS; `turns:...?transport=udp` is rejected.

With no configuration, issuance returns `iceServers: []`, `expiresAt: null`,
and `relayAvailable: false`. STUN-only configuration also has no relay or expiry.
With TURN configured, `relayAvailable: true` means configured, not health-checked.
`expiresAt` is Unix milliseconds, matching the whole-second expiry in the REST
username. Credentials are standard base64 HMAC-SHA1 of
`<unix-expiry>:<randomized-opaque-participant-binding>`. Participant IDs are
never embedded in clear text. Credentials are bearer credentials, not an
identity check performed by coturn. Authorize issuance and refresh before
expiry; existing allocations and refresh behavior also depend on coturn.

## Local Linux integration fixture

This fixture is **development only**, with a public development secret, no
TLS, and `allow-loopback-peers` enabled solely for local Chromium integration.
It uses Linux host networking, binds listener and relay to `127.0.0.1`, and
uses port 3478 TCP/UDP plus UDP relay ports 50000–50050. Run Chromium on the
same Linux host/network namespace. It is not a remote-device configuration.

```sh
docker compose -f compose.turn.yaml --profile integration up -d

pnpm test:turn
# Test TURN over TCP separately:
PAIR_TEST_TURN_URL='turn:127.0.0.1:3478?transport=tcp' pnpm test:turn

docker compose -f compose.turn.yaml --profile integration down
```

The configuration limits each temporary username to four allocations and
the server to 32 allocations, with bandwidth quotas. TCP client-to-TURN
transport is supported; TCP peer relay allocations are disabled.

For actual relay verification, create both peers with
`iceTransportPolicy: "relay"`, transfer data, and inspect `getStats()` for a
selected/nominated successful candidate pair with relay candidates. Repeat
with only the UDP URL and only the TCP URL. A successful connection with
default ICE policy does not establish that TURN worked. Provider unit tests
verify credential construction, not a working relay.

## Production and managed deployments

Use a public DNS hostname and trusted TLS certificate for TURN-over-TLS on
5349/TCP (or a deliberately configured 443/TCP listener). Expose 3478/UDP and
3478/TCP and the configured UDP relay range through host and cloud firewalls.
If coturn sits behind NAT, configure its external/public IP mapping and
forward the entire relay range. Allow outbound peer traffic and synchronize
clocks on credential issuer and TURN servers. A managed service must supply
REST-compatible URLs and a shared secret; API-key-only services need a
different provider implementation behind `IceProvider`.

Replace the development secret, choose deployment-appropriate quotas, enable
TLS, remove `allow-loopback-peers`, and restrict private/internal peer ranges
in production. Do not reuse the loopback fixture for public service. Limit
credential issuance per authorized participant as well as overall traffic;
per-username coturn quotas reset when a new temporary username is issued.

## Real-device verification record

Loopback Chromium checks below used coturn 4.6.1 on Linux. They do not validate
public hosting, NAT traversal across real networks, TLS, or physical mobile devices.
Fill in remaining evidence after performing each test.

| Scenario                                       | Status     | Date / devices | Selected pair / evidence |
| ---------------------------------------------- | ---------- | -------------- | ------------------------ |
| Local Chromium, forced relay, UDP              | PASSED | 2026-09-28, automated Chromium | `pnpm test:turn`: relay route, text delivery, recovery |
| Local Chromium, forced relay, TCP              | PASSED | 2026-09-28, automated Chromium | TCP-only TURN URL: relay route, text delivery, recovery |
| Two devices on separate home networks          | UNVERIFIED |                |                          |
| Wi-Fi to cellular / carrier NAT                | UNVERIFIED |                |                          |
| UDP-blocked network, TURN TCP                  | UNVERIFIED |                |                          |
| Restricted network, TURN TLS                   | UNVERIFIED |                |                          |
| Mobile Safari to desktop Chromium              | UNVERIFIED |                |                          |
| Expired credentials rejected on new allocation | PASSED | 2026-09-28, automated Chromium | No relay candidate with expired REST credentials over UDP or TCP |
| Credential refresh before expiry               | UNVERIFIED |                |                          |
