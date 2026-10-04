export class FileHash {
  private worker = new Worker(new URL("./hash.worker.ts", import.meta.url))
  private sequence = 0
  private disposed = false
  private waiting = new Map<
    number,
    { resolve: (value: string) => void; reject: (error: Error) => void }
  >()
  constructor() {
    this.worker.onmessage = (
      event: MessageEvent<{ id: number; digest?: string }>
    ) => {
      this.waiting.get(event.data.id)?.resolve(event.data.digest ?? "")
      this.waiting.delete(event.data.id)
    }
    this.worker.onerror = () => this.dispose()
  }
  private call(bytes?: ArrayBuffer, finish = false): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("File hashing stopped"))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.worker.postMessage({ id, bytes, finish }, bytes ? [bytes] : [])
    })
  }
  async update(bytes: Uint8Array) {
    await this.call(bytes.slice().buffer)
  }
  digest() {
    return this.call(undefined, true)
  }
  dispose() {
    this.disposed = true
    this.worker.terminate()
    for (const pending of this.waiting.values())
      pending.reject(new Error("File hashing stopped"))
    this.waiting.clear()
  }
}
