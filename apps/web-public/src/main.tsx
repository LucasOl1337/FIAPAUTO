import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../frontend/layout/index.css'
import { PublicAppShell } from '../../../frontend/layout/PublicAppShell.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PublicAppShell />
  </StrictMode>,
)
