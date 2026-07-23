import { io, type Socket } from 'socket.io-client'
import type { ChainId } from './chains'

// Realtime push for the Teratestnet indexer, modeled on Bitails' Socket.IO API.
// The indexer exposes a Socket.IO server (namespace `/global`, websocket
// transport) over TLS at `wss://ttn.btcp.io` so the HTTPS app can connect
// without mixed-content blocking. Overridable at build time.
//
// Subscription model (per address):
//   emit  'subscribe' 'lock-address-{addr}'   -> incoming (address in a tx output)
//   emit  'subscribe' 'spent-address-{addr}'  -> outgoing (a UTXO of the address is spent)
//   on    'lock-address-{addr}'  / 'spent-address-{addr}'  -> change notifications
// Notifications are mere triggers ("something changed"); the wallet reconciles
// the real amounts by refetching /balance and /unspent.
const TERA_WS_URL: string =
  (import.meta.env.VITE_TERA_WS_BASE as string | undefined) || 'wss://ttn.btcp.io'
const TERA_WS_NAMESPACE = '/global'

// Only Teratestnet has a push channel; other chains keep polling.
export function chainSupportsRealtime(chain: ChainId): boolean {
  return chain === 'bsv-teratestnet'
}

export interface SubscriptionHandle {
  close: () => void
}

interface SubscribeOptions {
  address: string
  // Called whenever the subscribed address changes on-chain (incoming/outgoing).
  onUpdate: () => void
  // Called when the socket connects / disconnects, so callers can adjust
  // their polling fallback cadence.
  onConnectionChange?: (connected: boolean) => void
}

// Opens a resilient Socket.IO subscription for a single address. socket.io-client
// handles reconnection with backoff internally. Returns a handle whose close()
// tears everything down. Never throws: on any failure the caller's polling
// fallback keeps the wallet working.
export function subscribeToAddress(opts: SubscribeOptions): SubscriptionHandle {
  const { address, onUpdate, onConnectionChange } = opts
  const topics = [`lock-address-${address}`, `spent-address-${address}`]

  let socket: Socket | null = null
  try {
    socket = io(`${TERA_WS_URL}${TERA_WS_NAMESPACE}`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
    })
  } catch {
    onConnectionChange?.(false)
    return { close: () => {} }
  }

  const s = socket

  s.on('connect', () => {
    onConnectionChange?.(true)
    for (const t of topics) {
      s.emit('subscribe', t)
      s.on(t, onUpdate)
    }
  })

  s.on('disconnect', () => onConnectionChange?.(false))
  s.on('connect_error', () => onConnectionChange?.(false))

  return {
    close: () => {
      onConnectionChange?.(false)
      try {
        for (const t of topics) {
          s.emit('unsubscribe', t)
          s.off(t)
        }
        s.removeAllListeners()
        s.disconnect()
      } catch { /* ignore */ }
    },
  }
}
