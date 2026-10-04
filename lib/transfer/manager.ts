import { content, type Scope, type StoredFile } from "../storage/content"
import { FileHash } from "./integrity"
import {
  CHUNK_SIZE,
  MAX_FILE_SIZE,
  MAX_TRANSFERS,
  decodeChunk,
  encodeChunk,
  validateOffer,
  validTransferId,
} from "./protocol"

export interface TransferView {
  id: string
  name: string
  size: number
  direction: "incoming" | "outgoing"
  state: "offered" | "transferring" | "complete" | "cancelled" | "failed"
  progress: number
  error?: string
  fileId?: string
}
interface Transfer extends TransferView {
  source?: File
  stored?: StoredFile
  offset: number
  hashed: number
  hash?: FileHash
  digest?: string
  busy: boolean
  timer?: ReturnType<typeof setTimeout>
}

/** A one-chunk receiver credit window bounds both network and disk queues. */
export class TransferManager {
  private channel: RTCDataChannel | null = null
  private active = false
  private peerReady = false
  private transfers = new Map<string, Transfer>()
  private queue = Promise.resolve()
  private queuedBytes = 0
  private disposed = false
  private helloSent = false
  constructor(
    private scope: () => Promise<Scope>,
    private changed: (files: TransferView[], available: boolean) => void,
    private error: (message: string) => void
  ) {}
  private publish() {
    this.changed(
      Array.from(
        this.transfers.values(),
        ({ id, name, size, direction, state, progress, error, fileId }) => ({
          id,
          name,
          size,
          direction,
          state,
          progress,
          error,
          fileId,
        })
      ),
      this.active && this.peerReady && this.channel?.readyState === "open"
    )
  }
  attach(channel: RTCDataChannel) {
    this.channel = channel
    this.peerReady = false
    this.helloSent = false
    channel.binaryType = "arraybuffer"
    channel.onopen = () => {
      if (this.channel === channel) this.activate(this.active)
    }
    channel.onmessage = (event) => {
      if (this.channel !== channel || this.disposed) return
      const data: unknown = event.data
      const size =
        typeof data === "string"
          ? data.length * 2
          : data instanceof ArrayBuffer
            ? data.byteLength
            : Infinity
      if (
        !Number.isFinite(size) ||
        size > CHUNK_SIZE + 512 ||
        this.queuedBytes + size > 128 * 1024
      ) {
        channel.close()
        this.error("Peer exceeded the file receive limit.")
        return
      }
      this.queuedBytes += size
      this.queue = this.queue.then(async () => {
        try {
          if (this.channel === channel && !this.disposed)
            await this.receive(data)
        } catch (error) {
          this.error(
            error instanceof Error ? error.message : "File transfer failed"
          )
          channel.close()
        } finally {
          this.queuedBytes -= size
        }
      })
    }
    channel.onclose = () => {
      if (this.channel === channel) {
        this.peerReady = false
        this.publish()
      }
    }
    this.activate(this.active)
  }
  activate(active: boolean) {
    this.active = active
    if (active && this.channel?.readyState === "open" && !this.helloSent) {
      this.helloSent = true
      this.send({ type: "hello" })
    }
    if (active && this.peerReady) {
      for (const transfer of this.transfers.values()) {
        if (
          ["offered", "transferring"].includes(transfer.state) &&
          transfer.direction === "outgoing"
        )
          this.send({ type: "resume", id: transfer.id })
      }
    }
    this.publish()
  }
  private send(message: Record<string, unknown>) {
    // A disk/hash operation started on an old transport can finish during recovery.
    // Suppress its response until both endpoints have authenticated readiness again;
    // the sender's resume query retrieves the receiver's current offset/result.
    if (
      message.type !== "hello" &&
      (!this.active || !this.peerReady || this.channel?.readyState !== "open")
    )
      return
    if (
      this.channel?.readyState !== "open" ||
      this.channel.bufferedAmount > 64 * 1024
    )
      throw new Error("File connection is unavailable or busy")
    this.channel.send(JSON.stringify({ v: 1, ...message }))
  }
  offer(source: File) {
    if (!this.active || !this.peerReady || this.channel?.readyState !== "open")
      throw new Error("Wait for the peer’s file channel to be ready.")
    if (source.size > MAX_FILE_SIZE)
      throw new Error("Files are limited to 2 GiB each.")
    if (this.liveCount() >= MAX_TRANSFERS || this.transfers.size >= 100)
      throw new Error(
        "Finish or cancel a transfer first (maximum four). After 100 files, start a fresh connection."
      )
    const id = crypto.randomUUID()
    const offer = validateOffer({
      id,
      name: source.name,
      size: source.size,
      mime: source.type,
    })
    const transfer: Transfer = {
      ...offer,
      direction: "outgoing",
      state: "offered",
      progress: 0,
      source,
      offset: 0,
      hashed: 0,
      busy: false,
    }
    this.send({
      type: "offer",
      id,
      name: offer.name,
      size: offer.size,
      mime: offer.type,
    })
    this.transfers.set(id, transfer)
    this.arm(transfer)
    this.publish()
  }
  private liveCount() {
    return Array.from(this.transfers.values()).filter((item) =>
      ["offered", "transferring"].includes(item.state)
    ).length
  }
  async accept(id: string) {
    const transfer = this.transfers.get(id)
    if (
      !transfer ||
      transfer.direction !== "incoming" ||
      transfer.state !== "offered" ||
      transfer.busy ||
      !this.active ||
      !this.peerReady
    )
      return
    transfer.busy = true
    try {
      transfer.stored = await content.createFile(await this.scope(), {
        name: transfer.name,
        size: transfer.size,
        type: "application/octet-stream",
      })
      if (this.disposed || transfer.state !== "offered") {
        await content.deleteFile(transfer.stored.id)
        return
      }
      transfer.fileId = transfer.stored.id
      transfer.hash = new FileHash()
      transfer.state = "transferring"
      this.send({ type: "credit", id, offset: 0 })
      this.arm(transfer)
    } catch (error) {
      await this.failTransfer(transfer, error)
    } finally {
      transfer.busy = false
      this.publish()
    }
  }
  async cancel(id: string) {
    const transfer = this.transfers.get(id)
    if (
      !transfer ||
      ["complete", "cancelled", "failed"].includes(transfer.state)
    )
      return
    transfer.state = "cancelled"
    clearTimeout(transfer.timer)
    transfer.hash?.dispose()
    try {
      this.send({ type: "cancel", id })
    } catch {}
    if (transfer.stored) await content.deleteFile(transfer.stored.id)
    this.publish()
  }
  private arm(transfer: Transfer) {
    clearTimeout(transfer.timer)
    transfer.timer = setTimeout(() => {
      if (!this.active) {
        this.arm(transfer)
        return
      }
      void this.failTransfer(
        transfer,
        new Error("Transfer timed out. Cancel and send the file again.")
      )
    }, 60_000)
  }
  private async failTransfer(transfer: Transfer, error: unknown) {
    if (transfer.state === "cancelled" || transfer.state === "complete") return
    transfer.state = "failed"
    transfer.error =
      error instanceof Error ? error.message : "File transfer failed"
    clearTimeout(transfer.timer)
    transfer.hash?.dispose()
    try {
      this.send({ type: "cancel", id: transfer.id })
    } catch {}
    if (transfer.stored) await content.deleteFile(transfer.stored.id)
    this.publish()
  }
  private async receive(data: unknown) {
    if (data instanceof ArrayBuffer) {
      const { id, offset, bytes } = decodeChunk(data)
      const transfer = this.transfers.get(id)
      if (!transfer || transfer.direction !== "incoming")
        throw new Error("Unaccepted file bytes")
      if (["cancelled", "failed"].includes(transfer.state)) return // Ignore already in-flight chunks after cancellation.
      if (
        transfer.state !== "transferring" ||
        !transfer.stored ||
        !transfer.hash
      )
        throw new Error("Unaccepted file bytes")
      if (offset < transfer.offset) {
        this.send({ type: "credit", id, offset: transfer.offset })
        return
      }
      if (offset !== transfer.offset || bytes.length > transfer.size - offset)
        throw new Error("Invalid file offset")
      try {
        await content.append(await this.scope(), transfer.stored, offset, bytes)
        if (transfer.state !== "transferring" || this.disposed) return
        await transfer.hash.update(bytes)
        transfer.offset += bytes.length
        transfer.progress = transfer.offset
        this.arm(transfer)
        this.send({ type: "credit", id, offset: transfer.offset })
        this.publish()
      } catch (error) {
        await this.failTransfer(transfer, error)
      }
      return
    }
    if (typeof data !== "string" || data.length > 2048)
      throw new Error("Invalid file control frame")
    const message = JSON.parse(data)
    if (!message || message.v !== 1 || typeof message.type !== "string")
      throw new Error("Unsupported file protocol")
    if (message.type === "hello") {
      this.peerReady = true
      this.activate(this.active)
      return
    }
    if (!this.helloSent || !this.peerReady)
      throw new Error("Files arrived before approval")
    if (!validTransferId(message.id)) throw new Error("Invalid transfer ID")
    if (message.type === "offer") {
      const offer = validateOffer(message)
      if (this.transfers.has(offer.id)) throw new Error("Duplicate file offer")
      if (this.transfers.size >= 100 || this.liveCount() >= MAX_TRANSFERS) {
        this.send({ type: "cancel", id: offer.id })
        return
      }
      const incoming: Transfer = {
        ...offer,
        direction: "incoming",
        state: "offered",
        progress: 0,
        offset: 0,
        hashed: 0,
        busy: false,
      }
      this.transfers.set(offer.id, incoming)
      this.arm(incoming)
      this.publish()
      return
    }
    const transfer = this.transfers.get(message.id)
    if (!transfer) {
      if (message.type === "resume") {
        this.send({ type: "cancel", id: message.id })
        return
      }
      throw new Error("Unknown transfer")
    }
    if (transfer.state === "complete") {
      if (
        transfer.direction === "incoming" &&
        ["resume", "finish"].includes(message.type)
      )
        this.send({ type: "saved", id: transfer.id })
      else if (message.type !== "saved" && message.type !== "cancel")
        throw new Error("Data arrived after file completion")
      return
    }
    if (message.type === "cancel") {
      await this.cancel(message.id)
      return
    }
    if (message.type === "resume") {
      if (transfer.direction !== "incoming")
        throw new Error("Invalid transfer resume")
      if (transfer.state === "transferring")
        this.send({ type: "credit", id: transfer.id, offset: transfer.offset })
      else if (transfer.state === "offered")
        this.send({ type: "waiting", id: transfer.id })
      else this.send({ type: "cancel", id: transfer.id })
      return
    }
    if (["cancelled", "failed"].includes(transfer.state)) return
    if (message.type === "waiting") {
      if (transfer.direction !== "outgoing" || transfer.state !== "offered")
        throw new Error("Invalid acceptance state")
      return
    }
    if (message.type === "credit") {
      if (
        transfer.direction !== "outgoing" ||
        !Number.isSafeInteger(message.offset) ||
        message.offset < 0 ||
        message.offset > transfer.hashed
      )
        throw new Error("Invalid receiver credit")
      if (!this.active || transfer.busy) return
      transfer.offset = message.offset
      transfer.progress = message.offset
      transfer.state = "transferring"
      this.arm(transfer)
      await this.pump(transfer)
    } else if (message.type === "finish") {
      if (
        transfer.direction !== "incoming" ||
        transfer.state !== "transferring" ||
        transfer.offset !== transfer.size ||
        typeof message.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(message.digest)
      )
        throw new Error("Invalid file completion")
      try {
        const digest = await transfer.hash!.digest()
        transfer.hash!.dispose()
        if (digest !== message.digest)
          throw new Error("File integrity check failed")
        await content.finish(await this.scope(), transfer.stored!, digest)
        transfer.state = "complete"
        clearTimeout(transfer.timer)
        this.send({ type: "saved", id: transfer.id })
      } catch (error) {
        await this.failTransfer(transfer, error)
      }
    } else if (message.type === "saved") {
      if (
        transfer.direction !== "outgoing" ||
        !transfer.digest ||
        transfer.offset !== transfer.size
      )
        throw new Error("Invalid save receipt")
      transfer.state = "complete"
      transfer.progress = transfer.size
      transfer.source = undefined
      transfer.hash?.dispose()
      clearTimeout(transfer.timer)
    } else throw new Error("Unknown file command")
    this.publish()
  }
  private async pump(transfer: Transfer) {
    transfer.busy = true
    try {
      if (transfer.offset === transfer.size) {
        transfer.hash ??= new FileHash()
        transfer.digest ??= await transfer.hash.digest()
        if (this.active && transfer.state === "transferring")
          this.send({
            type: "finish",
            id: transfer.id,
            digest: transfer.digest,
          })
        return
      }
      const bytes = new Uint8Array(
        await transfer
          .source!.slice(transfer.offset, transfer.offset + CHUNK_SIZE)
          .arrayBuffer()
      )
      transfer.hash ??= new FileHash()
      if (transfer.offset === transfer.hashed) {
        await transfer.hash.update(bytes)
        transfer.hashed += bytes.length
      }
      if (
        this.active &&
        this.peerReady &&
        transfer.state === "transferring" &&
        this.channel?.readyState === "open"
      )
        this.channel.send(encodeChunk(transfer.id, transfer.offset, bytes))
    } catch (error) {
      await this.failTransfer(transfer, error)
    } finally {
      transfer.busy = false
    }
  }
  dispose() {
    this.disposed = true
    this.active = false
    for (const transfer of this.transfers.values()) {
      clearTimeout(transfer.timer)
      transfer.hash?.dispose()
      if (["offered", "transferring"].includes(transfer.state)) {
        transfer.state = "failed"
        transfer.error = "Connection ended. Send this file again after pairing."
        if (transfer.stored)
          void content.deleteFile(transfer.stored.id).catch(() => {})
      }
    }
    this.publish()
  }
}
