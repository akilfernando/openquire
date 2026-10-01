import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { isDesktop } from './native'

// Offline support for the web app; the desktop app has its files locally.
if (!isDesktop) void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
