import { sha256 } from "@noble/hashes/sha2.js"

const hash = sha256.create()
self.onmessage = (
  event: MessageEvent<{ id: number; bytes?: ArrayBuffer; finish?: boolean }>
) => {
  const { id, bytes, finish } = event.data
  if (bytes) hash.update(new Uint8Array(bytes))
  self.postMessage({
    id,
    digest: finish
      ? Array.from(hash.digest(), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("")
      : undefined,
  })
}
