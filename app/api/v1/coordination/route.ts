import { handleCoordination } from "@/server/coordination-http"

export const runtime = "nodejs"
export async function POST(request: Request) {
  return handleCoordination(request)
}
