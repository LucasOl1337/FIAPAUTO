import { handlePublicApiRequest, type PublicApiEnv } from '../_shared/public-api.ts'

export async function onRequest(context: { request: Request; env: PublicApiEnv }) {
  return await handlePublicApiRequest(context.request, context.env)
}
