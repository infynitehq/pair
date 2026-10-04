import type { ChatMessage } from "../peer/types"

export interface Conversation {
  id: string
  name: string
  updatedAt: number
  revision: number
  deleted: boolean
}
export type Scope = Pick<Conversation, "id" | "revision">
export interface StoredMessage extends ChatMessage {
  key: string
  conversationId: string
  deleted?: boolean
}
export interface StoredFile {
  id: string
  conversationId: string
  name: string
  size: number
  type: string
  timestamp: number
  backend: "opfs" | "indexeddb"
  status: "receiving" | "complete" | "interrupted" | "deleting"
  received: number
  digest?: string
  bucket?: string
}

const DB_NAME = "pair-content"
export const FALLBACK_FILE_LIMIT = 32 * 1024 * 1024
const listeners = new Set<() => void>()
let broadcast: BroadcastChannel | undefined
function notify() {
  for (const listener of listeners) listener()
  broadcast?.postMessage("changed")
}
export function subscribeContent(listener: () => void) {
  if (typeof BroadcastChannel !== "undefined" && !broadcast) {
    broadcast = new BroadcastChannel("pair-content")
    broadcast.onmessage = () => {
      for (const subscriber of listeners) subscriber()
    }
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () =>
      reject(value.error ?? new Error("Local storage failed"))
  })
}
function completed(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error("Local storage transaction failed"))
  })
}
let database: Promise<IDBDatabase> | undefined
function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, 1)
    opening.onupgradeneeded = () => {
      const db = opening.result
      db.createObjectStore("conversations", { keyPath: "id" })
      for (const name of ["messages", "files"]) {
        const store = db.createObjectStore(name, {
          keyPath: name === "messages" ? "key" : "id",
        })
        store.createIndex("conversation", "conversationId")
        if (name === "messages")
          store.createIndex("timeline", ["conversationId", "timestamp", "key"])
      }
      db.createObjectStore("chunks", {
        keyPath: ["fileId", "offset"],
      }).createIndex("file", "fileId")
    }
    opening.onsuccess = () => {
      opening.result.onversionchange = () => {
        opening.result.close()
        database = undefined
      }
      resolve(opening.result)
    }
    opening.onerror = () => {
      database = undefined
      reject(opening.error)
    }
    opening.onblocked = () =>
      reject(new Error("Close other Pair tabs to upgrade local storage."))
  })
  return database
}
async function lock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks)
    return navigator.locks.request("pair-content", operation)
  return operation()
}
interface StorageBucket {
  getDirectory(): Promise<FileSystemDirectoryHandle>
  persist(): Promise<boolean>
  persisted(): Promise<boolean>
}
function bucketManager() {
  return (
    navigator as Navigator & {
      storageBuckets?: {
        open(
          name: string,
          options?: { persisted?: boolean }
        ): Promise<StorageBucket>
      }
    }
  ).storageBuckets
}
async function root(bucket?: string) {
  const directory = bucket
    ? await (await bucketManager()!.open(bucket)).getDirectory()
    : await navigator.storage.getDirectory()
  return directory.getDirectoryHandle("pair-files", { create: true })
}
export function hasFileStorage() {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.storage?.getDirectory &&
    !!navigator.locks
  )
}
async function assertScope(tx: IDBTransaction, scope: Scope) {
  const conversation = await request<Conversation | undefined>(
    tx.objectStore("conversations").get(scope.id)
  )
  if (
    !conversation ||
    conversation.deleted ||
    conversation.revision !== scope.revision
  )
    throw new Error(
      "This local conversation was deleted. Pair again to save new content."
    )
}
const writers = new Map<string, FileSystemWritableFileStream>()

export const content = {
  async ensureConversation(id: string, name: string): Promise<Scope> {
    return lock(async () => {
      const db = await openDatabase()
      const tx = db.transaction("conversations", "readwrite")
      const done = completed(tx)
      const previous = await request<Conversation | undefined>(
        tx.objectStore("conversations").get(id)
      )
      const conversation: Conversation = {
        id,
        name,
        updatedAt: Date.now(),
        revision: (previous?.revision ?? 0) + (previous?.deleted ? 1 : 0),
        deleted: false,
      }
      tx.objectStore("conversations").put(conversation)
      await done
      notify()
      return { id, revision: conversation.revision }
    })
  },
  async conversations(): Promise<Conversation[]> {
    const db = await openDatabase()
    const items = await request<Conversation[]>(
      db.transaction("conversations").objectStore("conversations").getAll()
    )
    return items
      .filter((item) => !item.deleted)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  },
  async messages(
    id: string,
    before: number | Pick<StoredMessage, "timestamp" | "key"> = Infinity,
    limit = 100
  ): Promise<StoredMessage[]> {
    const db = await openDatabase()
    const index = db
      .transaction("messages")
      .objectStore("messages")
      .index("timeline")
    const range =
      typeof before === "number"
        ? IDBKeyRange.bound([id, 0, ""], [id, before, "\uffff"])
        : IDBKeyRange.bound(
            [id, 0, ""],
            [id, before.timestamp, before.key],
            false,
            true
          )
    return new Promise((resolve, reject) => {
      const rows: StoredMessage[] = []
      const cursor = index.openCursor(range, "prev")
      cursor.onerror = () => reject(cursor.error)
      cursor.onsuccess = () => {
        if (!cursor.result || rows.length >= limit)
          return resolve(rows.reverse())
        if (!cursor.result.value.deleted) rows.push(cursor.result.value)
        cursor.result.continue()
      }
    })
  },
  async saveMessage(scope: Scope, message: ChatMessage) {
    const db = await openDatabase()
    const tx = db.transaction(["conversations", "messages"], "readwrite")
    const done = completed(tx)
    // Attach rejection before async validation, including manually aborted transactions.
    void done.catch(() => {})
    try {
      await assertScope(tx, scope)
      const key = `${scope.id}:${message.direction}:${message.id}`
      const existing = await request<StoredMessage | undefined>(
        tx.objectStore("messages").get(key)
      )
      if (!existing?.deleted)
        tx.objectStore("messages").put({
          ...message,
          timestamp: existing?.timestamp ?? message.timestamp,
          key,
          conversationId: scope.id,
        })
      await done
      notify()
      return !existing?.deleted
    } catch (error) {
      try {
        tx.abort()
      } catch {}
      throw error
    }
  },
  async receipt(scope: Scope, id: string) {
    const db = await openDatabase()
    const tx = db.transaction(["conversations", "messages"], "readwrite")
    const done = completed(tx)
    void done.catch(() => {})
    try {
      await assertScope(tx, scope)
      const store = tx.objectStore("messages")
      const message = await request<StoredMessage | undefined>(
        store.get(`${scope.id}:outgoing:${id}`)
      )
      if (message && !message.deleted)
        store.put({ ...message, status: "delivered" })
      await done
      notify()
    } catch (error) {
      try {
        tx.abort()
      } catch {}
      throw error
    }
  },
  async files(id?: string): Promise<StoredFile[]> {
    const db = await openDatabase()
    const store = db.transaction("files").objectStore("files")
    const rows = await request<StoredFile[]>(
      id ? store.index("conversation").getAll(id) : store.getAll()
    )
    return rows
      .filter((file) => file.status !== "deleting")
      .sort((a, b) => b.timestamp - a.timestamp)
  },
  async createFile(
    scope: Scope,
    offer: { name: string; size: number; type: string }
  ): Promise<StoredFile> {
    const estimate = await navigator.storage?.estimate?.()
    if (
      estimate?.quota &&
      offer.size > Math.max(0, estimate.quota - (estimate.usage ?? 0)) * 0.9
    )
      throw new Error(
        "Not enough local storage for this file. Delete some content first."
      )
    const backend = hasFileStorage() ? "opfs" : "indexeddb"
    if (backend === "indexeddb" && offer.size > FALLBACK_FILE_LIMIT)
      throw new Error(
        "This browser supports received files up to 32 MiB. Try a browser with OPFS support for larger files."
      )
    return lock(async () => {
      const file: StoredFile = {
        ...offer,
        id: crypto.randomUUID(),
        conversationId: scope.id,
        timestamp: Date.now(),
        backend,
        status: "receiving",
        received: 0,
      }
      if (backend === "opfs" && bucketManager()) {
        const hash = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(scope.id)
        )
        const bucket = `pair-${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
        try {
          const storageBucket = await bucketManager()!.open(bucket, {
            persisted: await navigator.storage.persisted(),
          })
          await storageBucket.getDirectory()
          file.bucket = bucket
        } catch {
          /* Storage Buckets are optional; default OPFS remains usable. */
        }
      }
      const db = await openDatabase()
      const tx = db.transaction(["conversations", "files"], "readwrite")
      const done = completed(tx)
      void done.catch(() => {})
      try {
        await assertScope(tx, scope)
        tx.objectStore("files").add(file)
        await done
        if (backend === "opfs") {
          const handle = await (
            await root(file.bucket)
          ).getFileHandle(file.id, { create: true })
          writers.set(file.id, await handle.createWritable())
        }
      } catch (error) {
        try {
          tx.abort()
        } catch {}
        throw error
      }
      notify()
      return file
    })
  },
  async append(
    scope: Scope,
    file: StoredFile,
    offset: number,
    bytes: Uint8Array<ArrayBuffer>
  ) {
    await lock(async () => {
      const db = await openDatabase()
      // OPFS writes are guarded by the same cross-tab lock as deletion.
      if (file.backend === "opfs") {
        const tx = db.transaction(["conversations", "files"])
        await assertScope(tx, scope)
        const record = await request<StoredFile | undefined>(
          tx.objectStore("files").get(file.id)
        )
        if (record?.status !== "receiving")
          throw new Error("File was deleted or cancelled")
        const writer = writers.get(file.id)
        if (!writer) throw new Error("File writer is no longer available")
        await writer.write({ type: "write", position: offset, data: bytes })
      } else {
        const tx = db.transaction(
          ["conversations", "files", "chunks"],
          "readwrite"
        )
        const done = completed(tx)
        void done.catch(() => {})
        try {
          await assertScope(tx, scope)
          const record = await request<StoredFile | undefined>(
            tx.objectStore("files").get(file.id)
          )
          if (record?.status !== "receiving")
            throw new Error("File was deleted or cancelled")
          tx.objectStore("chunks").put({
            fileId: file.id,
            offset,
            bytes: new Blob([bytes]),
          })
          await done
        } catch (error) {
          try {
            tx.abort()
          } catch {}
          throw error
        }
      }
    })
  },
  async finish(scope: Scope, file: StoredFile, digest: string) {
    await lock(async () => {
      if (writers.has(file.id)) {
        await writers.get(file.id)!.close()
        writers.delete(file.id)
      }
      const db = await openDatabase()
      const tx = db.transaction(["conversations", "files"], "readwrite")
      const done = completed(tx)
      void done.catch(() => {})
      try {
        await assertScope(tx, scope)
        const current = await request<StoredFile | undefined>(
          tx.objectStore("files").get(file.id)
        )
        if (current?.status !== "receiving")
          throw new Error("File was deleted or cancelled")
        tx.objectStore("files").put({
          ...current,
          digest,
          received: file.size,
          status: "complete",
        })
        await done
      } catch (error) {
        try {
          tx.abort()
        } catch {}
        throw error
      }
      notify()
    })
  },
  async download(file: StoredFile): Promise<Blob> {
    const db = await openDatabase()
    const current = await request<StoredFile | undefined>(
      db.transaction("files").objectStore("files").get(file.id)
    )
    if (current?.status !== "complete")
      throw new Error("This file is not available")
    if (file.backend === "opfs")
      return (await (await root(file.bucket)).getFileHandle(file.id)).getFile()
    const chunks = await request<Array<{ offset: number; bytes: Blob }>>(
      db
        .transaction("chunks")
        .objectStore("chunks")
        .index("file")
        .getAll(file.id)
    )
    const blob = new Blob(
      chunks.sort((a, b) => a.offset - b.offset).map((chunk) => chunk.bytes),
      { type: "application/octet-stream" }
    )
    if (blob.size !== file.size)
      throw new Error("Local file data is incomplete")
    return blob
  },
  async deleteMessage(key: string) {
    const db = await openDatabase()
    const tx = db.transaction("messages", "readwrite")
    const done = completed(tx)
    const store = tx.objectStore("messages")
    const message = await request<StoredMessage | undefined>(store.get(key))
    // Retain only a deduplication tombstone so a retransmission cannot restore deleted text.
    if (message) store.put({ ...message, text: "", deleted: true })
    await done
    notify()
  },
  async deleteFile(id: string) {
    await lock(() => deleteFileUnlocked(id))
    notify()
  },
  async deleteConversation(id: string) {
    await lock(async () => {
      const db = await openDatabase()
      const tx = db.transaction(
        ["conversations", "messages", "files"],
        "readwrite"
      )
      const done = completed(tx)
      const store = tx.objectStore("conversations")
      const conversation = await request<Conversation | undefined>(
        store.get(id)
      )
      if (conversation) store.put({ ...conversation, deleted: true })
      const cursor = tx
        .objectStore("messages")
        .index("conversation")
        .openCursor(id)
      cursor.onsuccess = () => {
        if (cursor.result) {
          cursor.result.delete()
          cursor.result.continue()
        }
      }
      const files = await request<StoredFile[]>(
        tx.objectStore("files").index("conversation").getAll(id)
      )
      for (const file of files)
        tx.objectStore("files").put({ ...file, status: "deleting" })
      await done
      for (const file of files) await deleteFileUnlocked(file.id)
    })
    notify()
  },
  async clear() {
    for (const conversation of await this.conversations())
      await this.deleteConversation(conversation.id)
  },
  async protect() {
    const persisted = await navigator.storage.persist()
    const files = await this.files()
    const buckets = new Set(
      files
        .map((file) => file.bucket)
        .filter((bucket): bucket is string => !!bucket)
    )
    let bucketsPersisted = true
    for (const bucket of buckets)
      if (!(await (await bucketManager()!.open(bucket)).persist()))
        bucketsPersisted = false
    return persisted && bucketsPersisted
  },
  async persisted() {
    if (!(await navigator.storage?.persisted?.())) return false
    const buckets = new Set(
      (await this.files())
        .map((file) => file.bucket)
        .filter((bucket): bucket is string => !!bucket)
    )
    for (const bucket of buckets)
      if (
        !bucketManager() ||
        !(await (await bucketManager()!.open(bucket)).persisted())
      )
        return false
    return true
  },
  async initialize() {
    await openDatabase()
    // Do not discard partial files owned by another live tab. A page owns its writer lock.
    const db = await openDatabase()
    const all = await request<StoredFile[]>(
      db.transaction("files").objectStore("files").getAll()
    )
    for (const file of all)
      if (file.status === "deleting") await this.deleteFile(file.id)
  },
}

async function deleteFileUnlocked(id: string) {
  const db = await openDatabase()
  const tx = db.transaction("files", "readwrite")
  const done = completed(tx)
  const file = await request<StoredFile | undefined>(
    tx.objectStore("files").get(id)
  )
  if (!file) {
    await done
    return
  }
  tx.objectStore("files").put({ ...file, status: "deleting" })
  await done
  const writer = writers.get(id)
  writers.delete(id)
  await writer?.abort().catch(() => {})
  if (file.backend === "opfs") {
    try {
      await (await root(file.bucket)).removeEntry(id)
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotFoundError")
        return // Retain tombstone and retry next launch.
    }
  }
  const cleanup = db.transaction(["files", "chunks"], "readwrite")
  const cleanupDone = completed(cleanup)
  cleanup.objectStore("files").delete(id)
  const cursor = cleanup.objectStore("chunks").index("file").openCursor(id)
  cursor.onsuccess = () => {
    if (cursor.result) {
      cursor.result.delete()
      cursor.result.continue()
    }
  }
  await cleanupDone
}
