import { expect, test } from "@playwright/test"

test("two browsers authenticate, require mutual approval, and exchange text only over WebRTC", async ({
  browser,
}) => {
  const hostContext = await browser.newContext()
  const guestContext = await browser.newContext()
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  const signalingFrames: string[] = []
  for (const page of [host, guest]) {
    await page.addInitScript(() => {
      const sockets: WebSocket[] = []
      Object.defineProperty(window, "testSignalSockets", { value: sockets })
      const NativeWebSocket = window.WebSocket
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          if (String(url).endsWith("/signal")) sockets.push(this)
        }
      }
    })
    page.on("websocket", (socket) => {
      if (!socket.url().endsWith("/signal")) return
      socket.on("framesent", ({ payload }) =>
        signalingFrames.push(String(payload))
      )
      socket.on("framereceived", ({ payload }) =>
        signalingFrames.push(String(payload))
      )
    })
  }
  try {
    await host.goto("/")
    await host.getByRole("button", { name: "Create pairing link" }).click()
    const invite = host.getByLabel("Your one-time pairing link")
    await expect(invite).toHaveValue(/#.{43}$/)
    const link = await invite.inputValue()
    const secret = new URL(link).hash.slice(1)
    await guest.goto(link)
    await expect(guest).toHaveURL("http://localhost:3000/")
    await expect(
      host.getByRole("heading", { name: "Is this your peer?" })
    ).toBeVisible()
    await expect(
      guest.getByRole("heading", { name: "Is this your peer?" })
    ).toBeVisible()
    const codePattern = /^[A-F0-9]{4} [A-F0-9]{4} [A-F0-9]{4}$/
    const hostCode = await host.getByText(codePattern).textContent()
    expect(await guest.getByText(codePattern).textContent()).toBe(hostCode)
    await host
      .getByRole("button", { name: "Codes match · approve peer" })
      .click()
    await expect(host.getByLabel("Message to your peer")).toHaveCount(0)
    await expect(guest.getByLabel("Message to your peer")).toHaveCount(0)
    await guest
      .getByRole("button", { name: "Codes match · approve peer" })
      .click()
    await expect(host.getByLabel("Message to your peer")).toBeVisible()
    await expect(guest.getByLabel("Message to your peer")).toBeVisible()
    const text = "Private hello <script>never execute</script> 👋"
    await host.getByLabel("Message to your peer").fill(text)
    await host.getByRole("button", { name: "Send text" }).click()
    await expect(guest.getByRole("log")).toContainText(text)
    await expect(host.getByRole("log")).toContainText("Delivered")
    // Interrupt signaling after establishment: peer data must continue independently.
    await host.evaluate(() => {
      const sockets = (window as unknown as { testSignalSockets: WebSocket[] })
        .testSignalSockets
      for (const socket of sockets) socket.close()
    })
    await guest
      .getByLabel("Message to your peer")
      .fill("Hello back from the other browser")
    await guest.getByRole("button", { name: "Send text" }).click()
    await expect(host.getByRole("log")).toContainText(
      "Hello back from the other browser"
    )
    const transcript = signalingFrames.join("\n")
    expect(transcript).not.toContain(secret)
    expect(transcript).not.toContain("Private hello")
    expect(transcript).not.toContain("Hello back")
    expect(transcript).not.toContain("a=fingerprint")
    expect(transcript).not.toContain('"publicKey"')
    await host.getByRole("button", { name: "Disconnect", exact: true }).click()
    await expect(
      guest.getByRole("heading", { name: "This connection has ended." })
    ).toBeVisible()
    await host.getByRole("button", { name: "Back to pairing" }).click()
    await host.getByRole("button", { name: "Create pairing link" }).click()
    await expect(host.getByLabel("Your one-time pairing link")).toHaveValue(
      /#.{43}$/
    )
  } finally {
    await hostContext.close()
    await guestContext.close()
  }
})

test("a modified invitation secret cannot authenticate", async ({
  browser,
}) => {
  const a = await browser.newContext()
  const b = await browser.newContext()
  try {
    const host = await a.newPage()
    const guest = await b.newPage()
    await host.goto("/")
    await host.getByRole("button", { name: "Create pairing link" }).click()
    await expect(host.getByLabel("Your one-time pairing link")).toHaveValue(
      /#.{43}$/
    )
    const original = await host
      .getByLabel("Your one-time pairing link")
      .inputValue()
    const link = new URL(original)
    link.hash = "A".repeat(43)
    await guest.goto(link.toString())
    await expect(guest.getByRole("main").getByRole("alert")).toBeVisible()
    await expect(guest.getByLabel("Message to your peer")).toHaveCount(0)
    await expect(host.getByLabel("Message to your peer")).toHaveCount(0)
    // A locator-only attempt must not consume the host's invitation.
    await expect(host.getByLabel("Your one-time pairing link")).toHaveValue(
      original
    )
    await guest.goto(original)
    await expect(
      guest.getByRole("heading", { name: "Is this your peer?" })
    ).toBeVisible()
    await expect(
      host.getByRole("heading", { name: "Is this your peer?" })
    ).toBeVisible()
  } finally {
    await a.close()
    await b.close()
  }
})
