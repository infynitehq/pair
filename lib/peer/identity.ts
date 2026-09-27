import { generateIdentity, type DeviceIdentity } from "./crypto"

let pending: Promise<DeviceIdentity> | undefined

export function loadIdentity(): Promise<DeviceIdentity> {
  pending ??= load().catch((error) => {
    pending = undefined
    throw error
  })
  return pending
}

async function load(): Promise<DeviceIdentity> {
  if (!globalThis.isSecureContext || !crypto.subtle)
    throw new Error(
      "Open Pair over HTTPS (or localhost) to enable secure connections."
    )
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("pair-local", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("identity")
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(
        new Error(
          "Local identity storage is unavailable. Check your browser storage settings."
        )
      )
  })
  try {
    const saved = await new Promise<DeviceIdentity | undefined>(
      (resolve, reject) => {
        const request = db
          .transaction("identity")
          .objectStore("identity")
          .get("device")
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }
    )
    if (saved) return saved
    const candidate = await generateIdentity()
    // Read again in the writing transaction so simultaneous tabs use the same identity.
    return await new Promise<DeviceIdentity>((resolve, reject) => {
      const transaction = db.transaction("identity", "readwrite")
      const store = transaction.objectStore("identity")
      const request = store.get("device")
      let identity = candidate
      request.onsuccess = () => {
        if (request.result) identity = request.result
        else store.put(candidate, "device")
      }
      transaction.oncomplete = () => resolve(identity)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () =>
        reject(new Error("Unable to save this device identity."))
    })
  } finally {
    db.close()
  }
}
