import { expect, test, type Browser, type Page } from "@playwright/test"

type Mode = "automatic" | "direct" | "relay"
type Probe = {
  sockets: WebSocket[]
  peers: RTCPeerConnection[]
  channels: RTCDataChannel[][]
  offers: number
  approvalPrompts: number
}

declare global {
  interface Window {
    recoveryProbe: Probe
  }
}

test.setTimeout(60_000)

async function contexts(browser: Browser, mode: Mode = "automatic") {
  const hostContext = await browser.newContext()
  const guestContext = await browser.newContext()
  for (const context of [hostContext, guestContext]) {
    await context.addInitScript((initialMode) => {
      if (!localStorage.getItem("pair-connection-mode")) {
        localStorage.setItem("pair-connection-mode", initialMode)
      }
      const probe: Probe = {
        sockets: [],
        peers: [],
        channels: [],
        offers: 0,
        approvalPrompts: 0,
      }
      window.recoveryProbe = probe
      const NativeSocket = window.WebSocket
      window.WebSocket = class extends NativeSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          if (new URL(String(url)).pathname === "/signal")
            probe.sockets.push(this)
        }
      }
      const NativePeer = window.RTCPeerConnection
      window.RTCPeerConnection = class extends NativePeer {
        private testChannels: RTCDataChannel[] = []
        constructor(configuration?: RTCConfiguration) {
          super(configuration)
          probe.peers.push(this)
          probe.channels.push(this.testChannels)
          this.addEventListener("datachannel", ({ channel }) =>
            this.testChannels.push(channel)
          )
          this.addEventListener("signalingstatechange", () => {
            if (this.signalingState === "have-local-offer") probe.offers++
          })
        }
        override createDataChannel(
          label: string,
          options?: RTCDataChannelInit
        ) {
          const channel = super.createDataChannel(label, options)
          this.testChannels.push(channel)
          return channel
        }
      }
    }, mode)
  }
  return {
    host: await hostContext.newPage(),
    guest: await guestContext.newPage(),
    close: () => Promise.all([hostContext.close(), guestContext.close()]),
  }
}

function detail(page: Page, label: string) {
  return page
    .locator("dt")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator("+ dd")
}

async function invite(host: Page, guest: Page) {
  await host.getByRole("button", { name: "Create pairing link" }).click()
  const input = host.getByLabel("Your one-time pairing link")
  await expect(input).toHaveValue(/#.{43}$/)
  await guest.goto(await input.inputValue())
}

async function approve(host: Page, guest: Page) {
  const codePattern = /^[A-F0-9]{4} [A-F0-9]{4} [A-F0-9]{4}$/
  for (const page of [host, guest]) {
    await expect(
      page.getByRole("heading", { name: "Is this your peer?" })
    ).toBeVisible()
    await expect(page.getByText(codePattern)).toBeVisible()
  }
  expect(await host.getByText(codePattern).textContent()).toBe(
    await guest.getByText(codePattern).textContent()
  )
  await host.getByRole("button", { name: "Codes match · approve peer" }).click()
  await guest
    .getByRole("button", { name: "Codes match · approve peer" })
    .click()
  for (const page of [host, guest]) {
    await expect(page.getByLabel("Message to your peer")).toBeEnabled()
    await page.getByText("Connection details", { exact: true }).click()
    await expect(detail(page, "Signaling")).toHaveText("available")
    await expect(detail(page, "Route")).toHaveText(/^(Direct|TURN relay)$/)
    await page.evaluate(() => {
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.textContent?.includes("Is this your peer?"))
              window.recoveryProbe.approvalPrompts++
          }
        }
      }).observe(document.body, { childList: true, subtree: true })
    })
  }
}

async function send(from: Page, to: Page, text: string) {
  await from.getByLabel("Message to your peer").fill(text)
  await from.getByRole("button", { name: "Send text", exact: true }).click()
  await expect(to.getByRole("log")).toContainText(text)
  await expect(from.getByRole("log")).toContainText(text)
}

async function recovered(host: Page, guest: Page) {
  for (const page of [host, guest]) {
    await expect(
      page.getByRole("button", { name: "Reconnect", exact: true })
    ).toBeEnabled({ timeout: 35_000 })
    await expect(page.getByLabel("Message to your peer")).toBeEnabled()
    await expect(detail(page, "Signaling")).toHaveText("available")
    await expect(detail(page, "Route")).toHaveText(/^(Direct|TURN relay)$/)
    await expect(
      page.getByRole("heading", { name: "Is this your peer?" })
    ).toHaveCount(0)
    expect(
      await page.evaluate(() => window.recoveryProbe.approvalPrompts)
    ).toBe(0)
  }
}

test("both signaling sockets resume while the established chat stays usable", async ({
  browser,
}) => {
  const pair = await contexts(browser)
  const { host, guest } = pair
  try {
    await host.goto("/")
    await invite(host, guest)
    await approve(host, guest)
    await send(host, guest, "Before signaling interruption")
    const counts = await Promise.all(
      [host, guest].map((page) =>
        page.evaluate(() => {
          const sockets = window.recoveryProbe.sockets
          for (const socket of sockets) socket.close()
          return sockets.length
        })
      )
    )
    await send(guest, host, "Chat during signaling recovery")
    for (const [index, page] of [host, guest].entries()) {
      await expect
        .poll(() => page.evaluate(() => window.recoveryProbe.sockets.length))
        .toBeGreaterThan(counts[index])
      await expect
        .poll(() =>
          page.evaluate(() => window.recoveryProbe.sockets.at(-1)?.readyState)
        )
        .toBe(1)
      expect(await page.evaluate(() => window.recoveryProbe.peers.length)).toBe(
        1
      )
    }
    await recovered(host, guest)
    await send(host, guest, "Chat after signaling resumed")
  } finally {
    await pair.close()
  }
})

test("host and guest Reconnect preserve approval and conversation history", async ({
  browser,
}) => {
  const pair = await contexts(browser)
  const { host, guest } = pair
  try {
    await host.goto("/")
    await invite(host, guest)
    await approve(host, guest)
    const history = ["Message before reconnect"]
    await send(host, guest, history[0])
    for (const [index, initiator] of [host, guest].entries()) {
      const offers = await host.evaluate(() => window.recoveryProbe.offers)
      await initiator
        .getByRole("button", { name: "Reconnect", exact: true })
        .click()
      await expect
        .poll(() => host.evaluate(() => window.recoveryProbe.offers))
        .toBeGreaterThan(offers)
      await recovered(host, guest)
      const message = `Message after reconnect ${index + 1}`
      await send(initiator, initiator === host ? guest : host, message)
      history.push(message)
      for (const page of [host, guest]) {
        for (const previous of history)
          await expect(page.getByRole("log")).toContainText(previous)
      }
    }
  } finally {
    await pair.close()
  }
})

test("Reconnect replaces a closed transport with authenticated channels without approval", async ({
  browser,
}) => {
  const pair = await contexts(browser)
  const { host, guest } = pair
  try {
    await host.goto("/")
    await invite(host, guest)
    await approve(host, guest)
    await send(host, guest, "History before transport replacement")
    await host.evaluate(() => window.recoveryProbe.peers.at(-1)!.close())
    await host.getByRole("button", { name: "Reconnect", exact: true }).click()
    for (const page of [host, guest]) {
      await expect
        .poll(() => page.evaluate(() => window.recoveryProbe.peers.length))
        .toBeGreaterThan(1)
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.recoveryProbe.channels
              .at(-1)!
              .filter((channel) => channel.readyState === "open")
              .map((channel) => channel.label)
              .sort()
          )
        )
        .toEqual(["chat", "control"])
      expect(
        await page.evaluate(() => window.recoveryProbe.peers[0].connectionState)
      ).toBe("closed")
    }
    await recovered(host, guest)
    await send(host, guest, "Authenticated replacement host message")
    await send(guest, host, "Authenticated replacement guest message")
    for (const page of [host, guest])
      await expect(page.getByRole("log")).toContainText(
        "History before transport replacement"
      )
  } finally {
    await pair.close()
  }
})

test("relay-only mode reports an actionable error when TURN is not configured", async ({
  browser,
}) => {
  test.skip(Boolean(process.env.TURN_URLS), "TURN is configured")
  const pair = await contexts(browser, "relay")
  const { host } = pair
  try {
    await host.goto("/")
    await expect(
      host.getByLabel("Connection mode", { exact: true })
    ).toHaveValue("relay")
    await host.getByRole("button", { name: "Create pairing link" }).click()
    const error = host
      .getByRole("alert")
      .filter({ hasText: "The relay is unavailable." })
    await expect(error).toBeVisible()
    await expect(error).toContainText(
      "Relay-only mode needs a configured TURN server."
    )
    await expect(
      host.getByText(/Try again, or choose Automatic or Direct/)
    ).toBeVisible()
    await expect(host.getByLabel("Message to your peer")).toHaveCount(0)
  } finally {
    await pair.close()
  }
})

test("direct-only preference survives reload and excludes TURN from RTC configuration", async ({
  browser,
}) => {
  const pair = await contexts(browser, "direct")
  const { host, guest } = pair
  try {
    await host.goto("/")
    await host
      .getByLabel("Connection mode", { exact: true })
      .selectOption("automatic")
    await host
      .getByLabel("Connection mode", { exact: true })
      .selectOption("direct")
    await host.reload()
    await expect(
      host.getByLabel("Connection mode", { exact: true })
    ).toHaveValue("direct")
    await invite(host, guest)
    await approve(host, guest)
    for (const page of [host, guest]) {
      await expect(detail(page, "Mode")).toHaveText("direct")
      await expect(detail(page, "Route")).toHaveText("Direct")
      const configs = await page.evaluate(() =>
        window.recoveryProbe.peers.map((peer) => {
          const config = peer.getConfiguration()
          return {
            policy: config.iceTransportPolicy,
            urls: (config.iceServers ?? []).flatMap((server) => server.urls),
          }
        })
      )
      expect(configs.length).toBeGreaterThan(0)
      for (const config of configs) {
        expect(config.policy).toBe("all")
        expect(config.urls.some((url) => /^turns?:/i.test(url))).toBe(false)
      }
    }
    await send(host, guest, "Direct-only chat works")
  } finally {
    await pair.close()
  }
})
