/** Never silently fall back to public relays: configuration defines the privacy boundary. */
export function nostrRelayUrls(value: string | undefined): string[] {
  const urls =
    value
      ?.split(",")
      .map((url) => url.trim())
      .filter(Boolean) ?? []
  if (urls.length > 3)
    throw new Error("Configure at most three Nostr signaling relays.")
  for (const input of urls) {
    const url = new URL(input)
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if (
      (url.protocol !== "wss:" &&
        !(
          url.protocol === "ws:" &&
          local &&
          process.env.NODE_ENV !== "production"
        )) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error(
        "Nostr signaling requires public wss:// URLs without credentials, queries, or fragments."
      )
  }
  return [...new Set(urls)]
}
