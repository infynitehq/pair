import { expect, test } from "@playwright/test"
import { createHmac } from "node:crypto"
import { createSignalingServer } from "../../server/signaling"
import { createIceProvider } from "../../server/ice"

const secret = "pair-development-only-turn-secret-never-use-in-production"
const turnUrl =
  process.env.PAIR_TEST_TURN_URL || "turn:127.0.0.1:3478?transport=udp"
test.skip(
  process.env.PAIR_TEST_TURN !== "1",
  "Opt in with pnpm test:turn and a running local coturn fixture"
)

test("forced TURN route exchanges text using temporary credentials", async ({
  browser,
}) => {
  const server = createSignalingServer({
    iceProvider: createIceProvider({
      TURN_URLS: turnUrl,
      TURN_SHARED_SECRET: secret,
    }),
  })
  const address = await server.listen()
  const hostContext = await browser.newContext()
  const guestContext = await browser.newContext()
  try {
    for (const context of [hostContext, guestContext]) {
      await context.addInitScript(
        ({ port }) => {
          try { localStorage.setItem("pair-connection-mode", "relay") } catch { /* about:blank has no storage */ }
          const NativeSocket = window.WebSocket
          window.WebSocket = class extends NativeSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
              super(
                String(url).endsWith("/signal")
                  ? `ws://localhost:${port}/signal`
                  : url,
                protocols
              )
            }
          }
        },
        { port: address.port }
      )
    }
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()
    await host.goto("/")
    await host.getByRole("button", { name: "Create pairing link" }).click()
    await expect(host.getByLabel("Your one-time pairing link")).toHaveValue(
      /#.{43}$/
    )
    await guest.goto(
      await host.getByLabel("Your one-time pairing link").inputValue()
    )
    await host
      .getByRole("button", { name: "Codes match · approve peer" })
      .click()
    await guest
      .getByRole("button", { name: "Codes match · approve peer" })
      .click()
    await expect(
      host.getByText("Relayed connection", { exact: false })
    ).toBeVisible({ timeout: 20_000 })
    await expect(
      guest.getByText("Relayed connection", { exact: false })
    ).toBeVisible()
    await host
      .getByLabel("Message to your peer")
      .fill("Through an encrypted TURN relay")
    await host.getByRole("button", { name: "Send text" }).click()
    await expect(guest.getByRole("log")).toContainText(
      "Through an encrypted TURN relay"
    )
    await expect(host.getByRole("log")).toContainText("Delivered")
    await host.getByRole("button", { name: "Reconnect", exact: true }).click()
    await expect(host.getByLabel("Message to your peer")).toBeEnabled({
      timeout: 30_000,
    })
    await expect(guest.getByLabel("Message to your peer")).toBeEnabled()
    await guest
      .getByLabel("Message to your peer")
      .fill("Relay session recovered")
    await guest.getByRole("button", { name: "Send text" }).click()
    await expect(host.getByRole("log")).toContainText("Relay session recovered")
  } finally {
    await hostContext.close()
    await guestContext.close()
    await server.close()
  }
})

test("expired TURN credentials cannot allocate a relay candidate", async ({
  page,
}) => {
  const username = `${Math.floor(Date.now() / 1000) - 60}:expired-fixture`
  const credential = createHmac("sha1", secret)
    .update(username)
    .digest("base64")
  await page.goto("/")
  const result = await page.evaluate(
    async ({ url, username, credential }) => {
      const peer = new RTCPeerConnection({
        iceTransportPolicy: "relay",
        iceServers: [{ urls: url, username, credential }],
      })
      const candidates: string[] = []
      peer.createDataChannel("probe")
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("ICE gathering did not complete")),
            15_000
          )
          peer.onicecandidate = ({ candidate }) => {
            if (candidate) candidates.push(candidate.type ?? "")
          }
          peer.onicegatheringstatechange = () => {
            if (peer.iceGatheringState === "complete") {
              clearTimeout(timer)
              resolve()
            }
          }
          void peer
            .createOffer()
            .then((offer) => peer.setLocalDescription(offer))
            .catch((error) => {
              clearTimeout(timer)
              reject(error)
            })
        })
        return candidates
      } finally {
        peer.close()
      }
    },
    { url: turnUrl, username, credential }
  )
  expect(result).not.toContain("relay")
})

test("direct-only and relay-only peers reject incompatible policies before creating ICE transports", async ({
  browser,
}) => {
  const server = createSignalingServer({
    iceProvider: createIceProvider({
      TURN_URLS: turnUrl,
      TURN_SHARED_SECRET: secret,
    }),
  })
  const address = await server.listen()
  const hostContext = await browser.newContext()
  const guestContext = await browser.newContext()
  try {
    for (const [context, mode] of [
      [hostContext, "direct"],
      [guestContext, "relay"],
    ] as const) {
      await context.addInitScript(
        ({ port, mode }) => {
          try { localStorage.setItem("pair-connection-mode", mode) } catch { /* about:blank has no storage */ }
          const NativeSocket = window.WebSocket
          window.WebSocket = class extends NativeSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
              super(
                String(url).endsWith("/signal")
                  ? `ws://localhost:${port}/signal`
                  : url,
                protocols
              )
            }
          }
          const peers: RTCPeerConnection[] = []
          Object.defineProperty(window, "testPolicyPeers", { value: peers })
          const NativePeer = window.RTCPeerConnection
          window.RTCPeerConnection = class extends NativePeer {
            constructor(config?: RTCConfiguration) {
              super(config)
              peers.push(this)
            }
          }
        },
        { port: address.port, mode }
      )
    }
    const host = await hostContext.newPage()
    const guest = await guestContext.newPage()
    await host.goto("/")
    await host.getByRole("button", { name: "Create pairing link" }).click()
    await expect(host.getByLabel("Your one-time pairing link")).toHaveValue(
      /#.{43}$/
    )
    await guest.goto(
      await host.getByLabel("Your one-time pairing link").inputValue()
    )
    await expect(host.getByRole("main").getByRole("alert")).toBeVisible()
    await expect(guest.getByRole("main").getByRole("alert")).toBeVisible()
    expect(
      ((await host.getByRole("main").getByRole("alert").textContent()) ?? "") +
        ((await guest.getByRole("main").getByRole("alert").textContent()) ?? "")
    ).toContain("Connection modes conflict")
    for (const page of [host, guest]) {
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { testPolicyPeers: unknown[] })
              .testPolicyPeers.length
        )
      ).toBe(0)
    }
  } finally {
    await hostContext.close()
    await guestContext.close()
    await server.close()
  }
})
