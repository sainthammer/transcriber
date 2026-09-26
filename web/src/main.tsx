import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Tooltip from '@radix-ui/react-tooltip'
import './styles/tokens.css'
import './styles/global.css'
import { Root } from './Root'
import { AuthGate } from './state/auth'
import { ToastProvider } from './state/toast'

async function start() {
  // Dev-only fixtures for states that are hard to reproduce (?mock=<scenario>).
  // The branch is removed from production builds together with the fixtures.
  if (import.meta.env.DEV) {
    const { installMocks } = await import('./dev/mock')
    installMocks()
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Tooltip.Provider delayDuration={350} skipDelayDuration={150}>
        <ToastProvider>
          <AuthGate>
            <Root />
          </AuthGate>
        </ToastProvider>
      </Tooltip.Provider>
    </StrictMode>,
  )
}

void start()
