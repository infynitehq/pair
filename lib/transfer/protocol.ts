export const CHUNK_SIZE = 16 * 1024
export const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024
export const MAX_TRANSFERS = 4
export const HEADER_SIZE = 44
export const validTransferId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    id
  )
export function validateOffer(value: Record<string, unknown>) {
  if (
    !validTransferId(value.id) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 255 ||
    typeof value.mime !== "string" ||
    value.mime.length > 127 ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    (value.size as number) > MAX_FILE_SIZE
  )
    throw new Error("Invalid file offer")
  return {
    id: value.id,
    name: value.name.replace(/[\u0000-\u001f\u007f/\\]/g, "_"),
    size: value.size as number,
    type: value.mime,
  }
}
export function encodeChunk(
  id: string,
  offset: number,
  bytes: Uint8Array<ArrayBuffer>
) {
  if (
    !validTransferId(id) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    bytes.length < 1 ||
    bytes.length > CHUNK_SIZE
  )
    throw new Error("Invalid file chunk")
  const frame = new Uint8Array(HEADER_SIZE + bytes.length)
  frame.set(new TextEncoder().encode(id))
  new DataView(frame.buffer).setFloat64(36, offset)
  frame.set(bytes, HEADER_SIZE)
  return frame.buffer
}
export function decodeChunk(buffer: ArrayBuffer) {
  if (
    buffer.byteLength <= HEADER_SIZE ||
    buffer.byteLength > HEADER_SIZE + CHUNK_SIZE
  )
    throw new Error("Invalid chunk size")
  const id = new TextDecoder().decode(new Uint8Array(buffer, 0, 36))
  const offset = new DataView(buffer).getFloat64(36)
  if (!validTransferId(id) || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid chunk header")
  return { id, offset, bytes: new Uint8Array(buffer, HEADER_SIZE) }
}
