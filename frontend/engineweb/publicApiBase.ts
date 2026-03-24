const PUBLIC_API_TUNNEL = import.meta.env.VITE_PUBLIC_API_TUNNEL?.trim() || ''
const PUBLIC_API_PORT = (import.meta.env.VITE_PUBLIC_API_PORT?.trim() || '')

export function resolvePublicApiBase() {
  const runtimeLocalBase = resolveRuntimeLocalApiBase()
  const explicitCandidates = [
    import.meta.env.VITE_PUBLIC_API_BASE_URL,
    import.meta.env.VITE_API_BASE_URL,
  ]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean)

  const explicitBase = explicitCandidates.find((value) => !shouldIgnoreExplicitApiBase(value))
  const tunnelBase = shouldIgnoreExplicitApiBase(PUBLIC_API_TUNNEL) ? '' : PUBLIC_API_TUNNEL
  const sameOriginBase = resolveSameOriginApiBase()
  return (runtimeLocalBase || explicitBase || tunnelBase || sameOriginBase).replace(/\/+$/, '')
}

function shouldIgnoreExplicitApiBase(value: string) {
  try {
    const hostname = new URL(value).hostname
    const currentHostname = typeof window === 'undefined' ? '' : window.location.hostname
    if (/^(127\.0\.0\.1|localhost)$/i.test(hostname) && !/^(127\.0\.0\.1|localhost)$/i.test(currentHostname)) {
      return true
    }

    if (isEphemeralTunnelHost(hostname) && !isSafeLocalHost(currentHostname)) {
      return true
    }

    return false
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

function resolveSameOriginApiBase() {
  if (typeof window === 'undefined') {
    return ''
  }

  const hostname = window.location.hostname?.trim()
  if (!hostname) {
    return ''
  }

  if (isLoopbackHost(hostname) || isPrivateLanHost(hostname) || isEphemeralTunnelHost(hostname)) {
    return ''
  }

  return window.location.origin
}

function isLoopbackHost(hostname: string) {
  return /^(127\.0\.0\.1|localhost)$/i.test(hostname)
}

function isPrivateLanHost(hostname: string) {
  return /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})$/i.test(hostname)
}

function isEphemeralTunnelHost(hostname: string) {
  return /\.(trycloudflare\.com|loca\.lt|localtunnel\.me)$/i.test(hostname)
}

function isSafeLocalHost(hostname: string) {
  return isLoopbackHost(hostname) || isPrivateLanHost(hostname)
}
