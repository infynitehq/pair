import { createSignalingServer } from "./signaling"
import { existsSync } from "node:fs"
import { loadEnvFile } from "node:process"

if (existsSync(".env.local")) loadEnvFile(".env.local")

const port = Number(process.env.SIGNALING_PORT ?? 3001)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("SIGNALING_PORT must be an integer between 1 and 65535")
}

const server = createSignalingServer()
server
  .listen(port, "0.0.0.0")
  .then(() => {
    console.info(`Signaling server listening on port ${port}`)
  })
  .catch(async () => {
    console.error("Signaling server failed to listen")
    await server.close()
    process.exitCode = 1
  })

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().catch(() => {
      process.exitCode = 1
    })
  })
}
