/** JSON records with absolute expiry; all mutations compare every read atomically. */
export interface StoredRecord {
  expiresAt: number
  [key: string]: unknown
}
export interface CoordinationStore {
  transact<T>(
    keys: string[],
    change: (records: Map<string, StoredRecord | null>) => T
  ): Promise<T>
}

export class StoreUnavailable extends Error {
  constructor() {
    super("Coordination storage unavailable")
  }
}

export const COMMIT_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
for i, key in ipairs(KEYS) do
  local current = redis.call('GET', key)
  if (current or '') ~= ARGV[(i-1)*3+1] then return 0 end
  if current then
    local record = cjson.decode(current)
    if record.expiresAt <= now then return 0 end
    if record.pairingExpiresAt and not record.closed and
      (not record.host.established or not record.guest or not record.guest.established) and
      record.pairingExpiresAt <= now then return 0 end
  end
end
for i, key in ipairs(KEYS) do
  local value = ARGV[(i-1)*3+2]
  if value == '' then redis.call('DEL', key)
  else redis.call('SET', key, value, 'PXAT', ARGV[(i-1)*3+3]) end
end
return 1`

const CHECK_SCRIPT = `
for i, key in ipairs(KEYS) do
  if (redis.call('GET', key) or '') ~= ARGV[i] then return 0 end
end
return 1`

/** Upstash REST API. No sockets or per-instance locks are required. */
export class RedisCoordinationStore implements CoordinationStore {
  constructor(
    private url: string,
    private token: string,
    private prefix: string
  ) {
    const endpoint = new URL(url)
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new StoreUnavailable()
    if (!token || !/^[a-zA-Z0-9:_-]{1,100}$/.test(prefix))
      throw new StoreUnavailable()
  }
  private async command(command: (string | number)[]): Promise<unknown> {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
        cache: "no-store",
        signal: AbortSignal.timeout(4_000),
      })
      if (!response.ok) throw new StoreUnavailable()
      const body = await response.json()
      if (body.error) throw new StoreUnavailable()
      return body.result
    } catch {
      throw new StoreUnavailable()
    }
  }
  async transact<T>(
    keys: string[],
    change: (records: Map<string, StoredRecord | null>) => T
  ): Promise<T> {
    const names = keys.map((key) => `${this.prefix}:${key}`)
    for (let attempt = 0; attempt < 8; attempt++) {
      const raw = (await this.command(["MGET", ...names])) as Array<
        string | null
      >
      if (!Array.isArray(raw) || raw.length !== keys.length)
        throw new StoreUnavailable()
      const records = new Map(
        keys.map((key, i) => {
          const value = raw[i] ? (JSON.parse(raw[i]!) as StoredRecord) : null
          return [
            key,
            value && value.expiresAt > Date.now() ? value : null,
          ] as const
        })
      )
      // The reducer must be synchronous and free of external side effects: CAS may retry it.
      let result: T
      try {
        result = change(records)
      } catch (error) {
        // A reducer may reject a stale snapshot that changed during this read.
        // Re-read through a no-op compare-and-swap before exposing the rejection.
        if (
          (await this.command([
            "EVAL",
            CHECK_SCRIPT,
            names.length,
            ...names,
            ...raw.map((value) => value ?? ""),
          ])) === 1
        )
          throw error
        continue
      }
      const args = keys.flatMap((key, i) => {
        const value = records.get(key)
        return [
          raw[i] ?? "",
          value ? JSON.stringify(value) : "",
          String(value?.expiresAt ?? 0),
        ]
      })
      if (
        (await this.command([
          "EVAL",
          COMMIT_SCRIPT,
          names.length,
          ...names,
          ...args,
        ])) === 1
      )
        return result
      await new Promise((resolve) =>
        setTimeout(resolve, 10 + Math.random() * 30)
      )
    }
    throw new StoreUnavailable()
  }
}
