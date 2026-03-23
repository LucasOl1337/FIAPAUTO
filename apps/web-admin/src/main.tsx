import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../frontend/layout/index.css'
import { AdminAppShell } from '../../../frontend/layout/AdminAppShell.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdminAppShell />
  </StrictMode>,
)
