import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivyProvider } from '@privy-io/react-auth'
import './index.css'
import App from './App.tsx'

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID || 'missing-privy-app-id'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['email'],
        appearance: {
          theme: 'dark',
          accentColor: '#F7931A',
        },
        embeddedWallets: {
          ethereum: {
            createOnLogin: 'off',
          },
        },
      }}
    >
      <App />
    </PrivyProvider>
  </StrictMode>,
)
