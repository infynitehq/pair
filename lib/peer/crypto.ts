const encoder = new TextEncoder()

export function encode(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

export function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 100_000)
    throw new Error("Invalid encoded value")
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0)
  )
}

export async function fingerprint(publicKey: string): Promise<string> {
  return encode(await crypto.subtle.digest("SHA-256", decode(publicKey)))
}

export interface DeviceIdentity {
  privateKey: CryptoKey
  publicKey: string
  deviceId: string
}

export async function generateIdentity(): Promise<DeviceIdentity> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"]
  )
  const publicKey = encode(
    await crypto.subtle.exportKey("spki", pair.publicKey)
  )
  return {
    privateKey: pair.privateKey,
    publicKey,
    deviceId: await fingerprint(publicKey),
  }
}

export interface SignedDescription {
  kind: "description"
  v: 2
  sessionId: string
  role: "host" | "guest"
  name: string
  publicKey: string
  sdp: string
  negotiation: number
  transport: "initial" | "restart" | "replace"
  mode: "automatic" | "direct" | "relay"
  signature: string
}

function transcript(
  value: Omit<SignedDescription, "signature">
): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify([
      "pair.description.v2",
      value.sessionId,
      value.role,
      value.name,
      value.publicKey,
      value.sdp,
      value.negotiation,
      value.transport,
      value.mode,
    ])
  )
}

export async function signDescription(
  identity: DeviceIdentity,
  value: Omit<SignedDescription, "signature">
): Promise<SignedDescription> {
  const signature = encode(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.privateKey,
      transcript(value)
    )
  )
  return { ...value, signature }
}

export async function verifyDescription(
  value: SignedDescription
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "spki",
    decode(value.publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  )
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    decode(value.signature),
    transcript(value)
  )
}

export interface SealedSignal {
  seq: number
  iv: string
  ciphertext: string
}

// Direction-specific keys and a strictly increasing sequence reject reflection and replay.
export class SignalCipher {
  private outgoing = 0
  private incoming = 0
  get receivedCount() {
    return this.incoming
  }
  private constructor(
    private sessionId: string,
    private role: "host" | "guest",
    private sendKey: CryptoKey,
    private receiveKey: CryptoKey
  ) {}

  static async create(
    secret: string,
    sessionId: string,
    role: "host" | "guest"
  ) {
    const bytes = decode(secret)
    if (bytes.length !== 32) throw new Error("Invalid pairing secret")
    const material = await crypto.subtle.importKey(
      "raw",
      bytes,
      "HKDF",
      false,
      ["deriveKey"]
    )
    const derive = (direction: string) =>
      crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: encoder.encode(sessionId),
          info: encoder.encode(`pair.signal.v2.${direction}`),
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      )
    const [host, guest] = await Promise.all([derive("host"), derive("guest")])
    return new SignalCipher(
      sessionId,
      role,
      role === "host" ? host : guest,
      role === "host" ? guest : host
    )
  }

  async seal(value: unknown): Promise<SealedSignal> {
    if (!Number.isSafeInteger(this.outgoing))
      throw new Error("Signal sequence exhausted")
    const seq = this.outgoing++
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(
          `v2:${this.sessionId}:${this.role}:${seq}`
        ),
      },
      this.sendKey,
      encoder.encode(JSON.stringify(value))
    )
    return { seq, iv: encode(iv), ciphertext: encode(ciphertext) }
  }

  async open(value: SealedSignal): Promise<unknown> {
    if (
      !value ||
      value.seq !== this.incoming ||
      typeof value.iv !== "string" ||
      typeof value.ciphertext !== "string"
    )
      throw new Error("Invalid or replayed signaling message")
    const role = this.role === "host" ? "guest" : "host"
    const iv = decode(value.iv)
    if (iv.length !== 12) throw new Error("Invalid signal nonce")
    const bytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(
          `v2:${this.sessionId}:${role}:${value.seq}`
        ),
      },
      this.receiveKey,
      decode(value.ciphertext)
    )
    this.incoming++
    return JSON.parse(new TextDecoder().decode(bytes))
  }
}

// Admission is separate from the encryption key: the server stores only its hash.
export async function admissionProof(secret: string) {
  const bytes = decode(secret)
  if (bytes.length !== 32) throw new Error("Invalid pairing secret")
  const key = await crypto.subtle.importKey("raw", bytes, "HKDF", false, [
    "deriveBits",
  ])
  const token = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: encoder.encode("pair.admission.v2"),
    },
    key,
    256
  )
  const joinToken = encode(token)
  return {
    joinToken,
    joinVerifier: encode(
      await crypto.subtle.digest("SHA-256", encoder.encode(joinToken))
    ),
  }
}

export async function connectionCode(
  sessionId: string,
  hostSdp: string,
  guestSdp: string
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(
        JSON.stringify(["pair.check.v1", sessionId, hostSdp, guestSdp])
      )
    )
  )
  return Array.from(digest.slice(0, 6), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
    .match(/.{4}/g)!
    .join(" ")
}
