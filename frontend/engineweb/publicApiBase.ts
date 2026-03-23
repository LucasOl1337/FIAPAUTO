const PUBLIC_API_PORT = (import.meta.env.VITE_PUBLIC_API_PORT?.trim() || import.meta.env.VITE_API_PORT?.trim() || '')

export function resolvePublicApiBase() {
  const runtimeLocalBase = resolveRuntimeLocalApiBase()
  const explicitCandidates = [
    import.meta.env.VITE_PUBLIC_API_BASE_URL,
    import.meta.env.VITE_API_BASE_URL,
  ]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean)

  const explicitBase = explicitCandidates.find((value) => !shouldIgnoreExplicitApiBase(value))
  const productionBase = typeof window === 'undefined' ? '' : window.location.origin
  return (runtimeLocalBase || explicitBase || productionBase).replace(/\/+$/, '')
}

function shouldIgnoreExplicitApiBase(value: string) {
  try {
    const hostname = new URL(value).hostname
    const currentHostname = typeof window === 'undefined' ? '' : window.location.hostname
    return /^(127\.0\.0\.1|localhost)$/i.test(hostname) && !/^(127\.0\.0\.1|localhost)$/i.test(currentHostname)
  } catch {
    return false
  }
}

function resolveRuntimeLocalApiBase() {
  if (typeof window === 'undefined' || !PUBLIC_API_PORT) {
    return ''
  }

  const hostname = window.location.hostname?.trim()
  if (!hostname) {
    return ''
  }

  if (!isLoopbackHost(hostname) && !isPrivateLanHost(hostname)) {
    return ''
  }

  return `${window.location.protocol}//${hostname}:${PUBLIC_API_PORT}`
}

function isLoopbackHost(hostname: string) {
  return /^(127\.0\.0\.1|localhost)$/i.test(hostname)
}

function isPrivateLanHost(hostname: string) {
  return /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})$/i.test(hostname)
}
