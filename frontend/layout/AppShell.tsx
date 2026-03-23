import { AdminAppShell } from './AdminAppShell.tsx'
import { PublicAppShell } from './PublicAppShell.tsx'

export default function AppShell() {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/'
  return pathname === '/admin' ? <AdminAppShell /> : <PublicAppShell />
}
