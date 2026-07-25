import { useState, useCallback, useEffect, useRef } from 'react'
import './App.css'
import {
  CHAINS,
  type ChainId,
  type AddressFormat,
  type UTXO,
  type TxHistoryItem,
  deriveAddress,
  privateKeyHexFromWif,
  privateKeyHexToWif,
  generatePrivateKeyHex,
  fetchBalanceFromUTXOs,
  fetchUTXOs,
  fetchTxHistory,
  buildAndBroadcastTx,
  explorerTxUrl,
} from './chains'
import { subscribeToAddress, chainSupportsRealtime } from './realtime'

function satsToCoin(sats: number): string {
  return (sats / 1e8).toFixed(8)
}

const STORAGE_KEY_WIF = 'bsv-wallet:wif'
const STORAGE_KEY_NETWORK = 'bsv-wallet:network' // legacy: 'mainnet' | 'testnet'
const STORAGE_KEY_CHAIN = 'bsv-wallet:chain'     // new: ChainId
const STORAGE_KEY_ADDR_FORMAT = 'bsv-wallet:addrFormat' // new: AddressFormat

function isChainId(v: string | null): v is ChainId {
  return !!v && v in CHAINS
}

function loadStoredSession(): { wif: string; chain: ChainId; addressFormat: AddressFormat } | null {
  try {
    const wif = localStorage.getItem(STORAGE_KEY_WIF)
    if (!wif) return null
    const chainRaw = localStorage.getItem(STORAGE_KEY_CHAIN)
    const legacyNet = localStorage.getItem(STORAGE_KEY_NETWORK)
    const chain: ChainId = isChainId(chainRaw)
      ? chainRaw
      : legacyNet === 'testnet' ? 'bsv-testnet' : 'bsv-mainnet'
    const addrRaw = localStorage.getItem(STORAGE_KEY_ADDR_FORMAT)
    const addressFormat: AddressFormat = addrRaw === 'segwit' ? 'segwit' : 'legacy'
    return { wif, chain, addressFormat }
  } catch {
    return null
  }
}

function saveSession(wif: string, chain: ChainId, addressFormat: AddressFormat) {
  try {
    localStorage.setItem(STORAGE_KEY_WIF, wif)
    localStorage.setItem(STORAGE_KEY_CHAIN, chain)
    localStorage.setItem(STORAGE_KEY_ADDR_FORMAT, addressFormat)
    // Keep legacy key in sync for backward compatibility
    localStorage.setItem(STORAGE_KEY_NETWORK, CHAINS[chain].isTestnet ? 'testnet' : 'mainnet')
  } catch {
    /* localStorage may be unavailable (private mode, etc.) */
  }
}

function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY_WIF)
    localStorage.removeItem(STORAGE_KEY_NETWORK)
    localStorage.removeItem(STORAGE_KEY_CHAIN)
    localStorage.removeItem(STORAGE_KEY_ADDR_FORMAT)
  } catch {
    /* ignore */
  }
}

function App() {
  const [chain, setChain] = useState<ChainId>('bsv-teratestnet')
  const [addressFormat, setAddressFormat] = useState<AddressFormat>('legacy')
  const [wifInput, setWifInput] = useState('')
  const [privateKeyHex, setPrivateKeyHex] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [totalSats, setTotalSats] = useState<number | null>(null)
  const [utxoList, setUtxoList] = useState<UTXO[]>([])
  const [txHistory, setTxHistory] = useState<TxHistoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [showSend, setShowSend] = useState(false)
  const [sendTo, setSendTo] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  const [sending, setSending] = useState(false)
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [generatedWif, setGeneratedWif] = useState('')
  const [showGenerate, setShowGenerate] = useState(false)
  const [newKeyWif, setNewKeyWif] = useState('')
  const [newKeyAddress, setNewKeyAddress] = useState('')
  const [newKeyCopied, setNewKeyCopied] = useState<'wif' | 'addr' | null>(null)
  const [keyRevealed, setKeyRevealed] = useState(false)
  const keyPanelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Ref to track optimistic tx hashes that must survive API refreshes
  const pendingTxRef = useRef<Set<string>>(new Set())
  // Whether the realtime push channel is currently connected (drives polling cadence)
  const [realtimeConnected, setRealtimeConnected] = useState(false)
  const realtimeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Incoming-payment popup: shown the moment funds arrive (via the realtime
  // lock-address event). Deduped by txid so we notify once per incoming tx.
  const [incomingToast, setIncomingToast] = useState<{ amount: number; unconfirmed: boolean } | null>(null)
  const notifiedTxRef = useRef<Set<string>>(new Set())
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadWalletData = useCallback(async (addr: string, c: ChainId) => {
    setLoading(true)
    setError('')
    try {
      const [utxoData, hist] = await Promise.all([
        fetchBalanceFromUTXOs(addr, c),
        fetchTxHistory(addr, c),
      ])
      setTotalSats(utxoData.total)
      setUtxoList(utxoData.utxos)
      // Build history from UTXOs if the history endpoint returned nothing
      let apiHistory: TxHistoryItem[]
      if (hist.length === 0 && utxoData.utxos.length > 0) {
        const utxoHistory: TxHistoryItem[] = utxoData.utxos.map(u => ({
          tx_hash: u.tx_hash,
          height: u.height,
        }))
        const seen = new Set<string>()
        apiHistory = utxoHistory.filter(t => {
          if (seen.has(t.tx_hash)) return false
          seen.add(t.tx_hash)
          return true
        })
      } else {
        apiHistory = hist
      }
      // Merge: always re-add pending optimistic entries from ref
      const apiHashes = new Set(apiHistory.map(t => t.tx_hash))
      // Remove from pending ref any entries now confirmed by API
      for (const h of pendingTxRef.current) {
        if (apiHashes.has(h)) pendingTxRef.current.delete(h)
      }
      // Build optimistic entries from ref (guaranteed source of truth)
      const optimisticEntries: TxHistoryItem[] = []
      for (const h of pendingTxRef.current) {
        optimisticEntries.push({ tx_hash: h, height: 0 })
      }
      const merged = [...optimisticEntries, ...apiHistory]
      setTxHistory(merged.slice(0, 20))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load wallet data')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleLogin = useCallback(() => {
    setError('')
    setStatusMsg(null)
    try {
      const trimmed = wifInput.trim()
      const hex = privateKeyHexFromWif(trimmed)
      const fmt: AddressFormat = CHAINS[chain].isBtc ? addressFormat : 'legacy'
      const addr = deriveAddress(hex, chain, fmt)
      setPrivateKeyHex(hex)
      setAddress(addr)
      saveSession(trimmed, chain, fmt)
      loadWalletData(addr, chain)
    } catch {
      setError('Invalid WIF key. Please check your private key and network selection.')
    }
  }, [wifInput, chain, addressFormat, loadWalletData])

  // Auto-login on mount if a previous session is stored
  useEffect(() => {
    const stored = loadStoredSession()
    if (!stored) return
    try {
      const hex = privateKeyHexFromWif(stored.wif)
      const addr = deriveAddress(hex, stored.chain, stored.addressFormat)
      setChain(stored.chain)
      setAddressFormat(stored.addressFormat)
      setPrivateKeyHex(hex)
      setAddress(addr)
      loadWalletData(addr, stored.chain)
    } catch {
      clearSession()
    }
    // Run only once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleGenerateKey = useCallback(() => {
    const hex = generatePrivateKeyHex()
    const wif = privateKeyHexToWif(hex, chain)
    setGeneratedWif(wif)
    setWifInput(wif)
  }, [chain])

  // Show the WIF of the wallet currently logged in (not a new key). The WIF
  // is derived on demand, rendered masked until explicitly revealed, and the
  // panel auto-closes after 30 seconds so the key isn't left on screen.
  const closeKeyPanel = useCallback(() => {
    if (keyPanelTimerRef.current) clearTimeout(keyPanelTimerRef.current)
    keyPanelTimerRef.current = null
    setShowGenerate(false)
    setNewKeyWif('')
    setNewKeyAddress('')
    setKeyRevealed(false)
  }, [])

  const handleShowCurrentKey = useCallback(() => {
    if (!privateKeyHex) return
    const wif = privateKeyHexToWif(privateKeyHex, chain)
    setNewKeyWif(wif)
    setNewKeyAddress(address)
    setShowGenerate(true)
    setNewKeyCopied(null)
    setKeyRevealed(false)
    if (keyPanelTimerRef.current) clearTimeout(keyPanelTimerRef.current)
    keyPanelTimerRef.current = setTimeout(closeKeyPanel, 30000)
  }, [privateKeyHex, chain, address, closeKeyPanel])

  const handleCopyNewKey = useCallback(async (text: string, type: 'wif' | 'addr') => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const el = document.createElement('textarea')
      el.value = text
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
    }
    setNewKeyCopied(type)
    setTimeout(() => setNewKeyCopied(null), 2000)
  }, [])

  const handleCopyAddress = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const el = document.createElement('textarea')
      el.value = address
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [address])

  const handleRefresh = useCallback(() => {
    if (address && !loading) {
      loadWalletData(address, chain)
    }
  }, [address, chain, loading, loadWalletData])

  const handleLogout = useCallback(async () => {
    clearSession()
    pendingTxRef.current.clear()
    setPrivateKeyHex(null)
    setAddress('')
    setTotalSats(null)
    setUtxoList([])
    setTxHistory([])
    setWifInput('')
    setError('')
    setStatusMsg(null)
    setShowSend(false)
    setGeneratedWif('')
    setShowGenerate(false)
    setNewKeyWif('')
    setNewKeyAddress('')
  }, [])

  const handleSend = useCallback(async () => {
    if (!privateKeyHex || !sendTo || !sendAmount) return
    setSending(true)
    setStatusMsg(null)
    try {
      const satoshisToSend = Math.round(parseFloat(sendAmount) * 1e8)
      if (isNaN(satoshisToSend) || satoshisToSend <= 0) {
        throw new Error('Invalid amount')
      }

      const utxos = await fetchUTXOs(address, chain)
      if (utxos.length === 0) {
        throw new Error('No UTXOs available')
      }

      const fmt: AddressFormat = CHAINS[chain].isBtc ? addressFormat : 'legacy'
      // Register the txid BEFORE broadcasting: the indexer's realtime push for
      // our own change output can beat the broadcast HTTP response, so adding
      // it only after the await would let the change pop up as a fake receipt.
      const registerTxid = (id: string) => {
        pendingTxRef.current.add(id)
        notifiedTxRef.current.add(id)
      }
      let txid: string
      let feeSats: number
      try {
        ({ txid, feeSats } = await buildAndBroadcastTx({
          privateKeyHex, fromAddress: address, toAddress: sendTo,
          satoshisToSend, utxos, chain, addressFormat: fmt,
          onTxidReady: registerTxid,
        }))
      } catch (firstErr) {
        // On mempool-conflict, retry with only unconfirmed UTXOs
        const errMsg = firstErr instanceof Error ? firstErr.message : ''
        if (errMsg.includes('mempool-conflict') || errMsg.includes('Missing inputs')) {
          const unconfirmedOnly = utxos.filter(u => u.height === 0)
          if (unconfirmedOnly.length === 0) {
            throw new Error('Transaction conflict - please wait for confirmations and try again')
          }
          ;({ txid, feeSats } = await buildAndBroadcastTx({
            privateKeyHex, fromAddress: address, toAddress: sendTo,
            satoshisToSend, utxos: unconfirmedOnly, chain, addressFormat: fmt,
            onTxidReady: registerTxid,
          }))
        } else {
          throw firstErr
        }
      }

      setStatusMsg({ type: 'success', text: `Sent! TX:\n${txid}` })
      setShowSend(false)
      setSendTo('')
      setSendAmount('')

      // Sender-side popup: the total deducted from this wallet (amount + fee)
      // as one negative number.
      const totalDeducted = satoshisToSend + feeSats
      setIncomingToast({ amount: -totalDeducted / 1e8, unconfirmed: true })
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      toastTimerRef.current = setTimeout(() => setIncomingToast(null), 10000)
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('送金しました', {
            body: `-${(totalDeducted / 1e8).toFixed(8)} ${CHAINS[chain].symbol}`,
          })
        }
      } catch { /* ignore */ }

      pendingTxRef.current.add(txid)
      setTxHistory(prev => {
        if (prev.some(t => t.tx_hash === txid)) return prev
        return [{ tx_hash: txid, height: 0 }, ...prev]
      })
      setTimeout(() => loadWalletData(address, chain), 200)
      setTimeout(() => loadWalletData(address, chain), 3000)
    } catch (e) {
      setStatusMsg({ type: 'error', text: e instanceof Error ? e.message : 'Send failed' })
    } finally {
      setSending(false)
    }
  }, [privateKeyHex, sendTo, sendAmount, address, chain, addressFormat, loadWalletData])

  // Realtime push subscription (Teratestnet only). On any incoming/outgoing
  // change the indexer notifies us; we debounce and refetch. Falls back to
  // polling (below) whenever the socket is not connected.
  useEffect(() => {
    if (!address || !chainSupportsRealtime(chain)) {
      setRealtimeConnected(false)
      return
    }
    // Reset per-address notification dedup when switching accounts/networks.
    notifiedTxRef.current = new Set()
    const symbol = CHAINS[chain].symbol
    const sub = subscribeToAddress({
      address,
      onEvent: (event) => {
        // Any change triggers a debounced refetch.
        if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current)
        realtimeDebounceRef.current = setTimeout(() => loadWalletData(address, chain), 200)

        // Popup only for genuine incoming payments: 'lock' events whose txid is
        // not one we just broadcast ourselves (our own change output also emits
        // a lock event with the send txid). Dedup so each incoming tx pops once.
        if (event.type !== 'lock') return
        const txid = event.txid
        if (txid && pendingTxRef.current.has(txid)) return
        if (txid && notifiedTxRef.current.has(txid)) return
        if (txid) notifiedTxRef.current.add(txid)

        const amount = (event.value ?? 0) / 1e8
        setIncomingToast({ amount, unconfirmed: event.unconfirmed !== false })
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
        toastTimerRef.current = setTimeout(() => setIncomingToast(null), 10000)

        // System-level popup (works in PWA / background) when permitted.
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification('着金しました', {
              body: `+${amount.toFixed(8)} ${symbol}`,
            })
          }
        } catch { /* ignore */ }
      },
      onConnectionChange: (connected) => {
        setRealtimeConnected(connected)
        if (connected) {
          loadWalletData(address, chain)
          // Ask for OS notification permission once so background popups can fire.
          try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
              Notification.requestPermission().catch(() => {})
            }
          } catch { /* ignore */ }
        }
      },
    })
    return () => {
      if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current)
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      sub.close()
    }
  }, [address, chain, loadWalletData])

  // Polling fallback: fast (15s) when there is no realtime channel, slow (60s)
  // as a safety net while the push channel is connected.
  useEffect(() => {
    if (!address) return
    const intervalMs = realtimeConnected ? 60000 : 15000
    const interval = setInterval(() => {
      loadWalletData(address, chain)
    }, intervalMs)
    return () => clearInterval(interval)
  }, [address, chain, loadWalletData, realtimeConnected])

  if (!privateKeyHex) {
    return (
      <div className="wallet-container">
        <div className="wallet-header">
          <h1>Bitcoin Wallet</h1>
        </div>
        <div className="login-screen">
          <div className="logo">&#8383;</div>
          <h2>Bitcoin Wallet</h2>
          <p>WIF形式の秘密鍵でログインしてください。</p>

          <div className="wif-input-group">
            <label>ネットワーク</label>
            <div className="network-selector network-selector-grid">
              {(Object.keys(CHAINS) as ChainId[]).map((c) => (
                <button
                  key={c}
                  className={`network-btn ${chain === c ? 'active' : ''}`}
                  onClick={() => setChain(c)}
                >
                  {CHAINS[c].label}
                </button>
              ))}
            </div>
          </div>

          {CHAINS[chain].isBtc && (
            <div className="wif-input-group">
              <label>アドレス形式</label>
              <div className="network-selector">
                <button
                  className={`network-btn ${addressFormat === 'legacy' ? 'active' : ''}`}
                  onClick={() => setAddressFormat('legacy')}
                >
                  Legacy (P2PKH)
                </button>
                <button
                  className={`network-btn ${addressFormat === 'segwit' ? 'active' : ''}`}
                  onClick={() => setAddressFormat('segwit')}
                >
                  SegWit (Bech32)
                </button>
              </div>
            </div>
          )}

          <div className="wif-input-group">
            <label>秘密鍵 (WIF)</label>
            <input
              type="password"
              placeholder="WIF形式の秘密鍵を入力..."
              value={wifInput}
              onChange={(e) => setWifInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && wifInput.trim() && handleLogin()}
            />
          </div>

          <button
            className="login-btn"
            onClick={handleLogin}
            disabled={!wifInput.trim()}
          >
            ログイン
          </button>

          <button className="generate-btn" onClick={handleGenerateKey}>
            新しい鍵を生成する
          </button>

          {generatedWif && (
            <div className="status-msg info" style={{ wordBreak: 'break-all', fontSize: '11px', fontFamily: 'var(--mono)' }}>
              Warning: この秘密鍵を安全な場所に保存してください：<br />{generatedWif}
            </div>
          )}

          {error && <div className="error-msg">{error}</div>}
        </div>
      </div>
    )
  }

  const totalBalance = totalSats ?? 0
  const info = CHAINS[chain]

  return (
    <div className="wallet-container">
      {incomingToast && (
        <div className="incoming-toast" role="status" onClick={() => setIncomingToast(null)}>
          <span className="incoming-toast-icon">{incomingToast.amount < 0 ? '↑' : '↓'}</span>
          <div className="incoming-toast-body">
            <div className="incoming-toast-title">{incomingToast.amount < 0 ? '送金しました' : '着金しました'}</div>
            <div className="incoming-toast-amount">
              {incomingToast.amount < 0 ? '' : '+'}{incomingToast.amount.toFixed(8)} {info.symbol}
            </div>
          </div>
        </div>
      )}
      <div className="wallet-header">
        <h1>{info.symbol} Wallet</h1>
        <span className={`network-badge ${info.isTestnet ? 'testnet' : 'mainnet'}`}>
          <span className="dot"></span>
          {info.label}
        </span>
      </div>

      <div className="chain-switcher">
        <select
          className="chain-select"
          value={chain}
          onChange={(e) => {
            const next = e.target.value as ChainId
            if (!privateKeyHex) { setChain(next); return }
            try {
              const fmt: AddressFormat = CHAINS[next].isBtc ? addressFormat : 'legacy'
              const addr = deriveAddress(privateKeyHex, next, fmt)
              setChain(next)
              setAddress(addr)
              setTotalSats(null)
              setUtxoList([]); setTxHistory([])
              pendingTxRef.current.clear()
              // Persist new chain selection (keep wif from current session)
              const wif = localStorage.getItem(STORAGE_KEY_WIF)
              if (wif) saveSession(wif, next, fmt)
              loadWalletData(addr, next)
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Failed to switch network')
            }
          }}
        >
          {(Object.keys(CHAINS) as ChainId[]).map((c) => (
            <option key={c} value={c}>{CHAINS[c].label}</option>
          ))}
        </select>
        {info.isBtc && (
          <select
            className="chain-select"
            value={addressFormat}
            onChange={(e) => {
              const fmt = e.target.value as AddressFormat
              if (!privateKeyHex) { setAddressFormat(fmt); return }
              try {
                const addr = deriveAddress(privateKeyHex, chain, fmt)
                setAddressFormat(fmt)
                setAddress(addr)
                setTotalSats(null)
                setUtxoList([]); setTxHistory([])
                pendingTxRef.current.clear()
                const wif = localStorage.getItem(STORAGE_KEY_WIF)
                if (wif) saveSession(wif, chain, fmt)
                loadWalletData(addr, chain)
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to switch address format')
              }
            }}
          >
            <option value="legacy">Legacy (P2PKH)</option>
            <option value="segwit">SegWit (Bech32)</option>
          </select>
        )}
      </div>

      <div className="balance-card">
        <div className="label">残高</div>
        {loading && totalSats === null ? (
          <div className="amount"><span className="spinner"></span></div>
        ) : (
          <>
            <div className="amount">
              {satsToCoin(totalBalance)}
              <span className="unit">{info.symbol}</span>
            </div>
            <div className="satoshis">
              {totalBalance.toLocaleString()} satoshis
              {utxoList.length > 0 && (
                <span> ({utxoList.length} UTXO{utxoList.length > 1 ? 's' : ''})</span>
              )}
            </div>
          </>
        )}
      </div>

      <div className="address-card">
        <div className="label">アドレス</div>
        <div className="address-row">
          <div className="addr">{address}</div>
          <button
            className={`copy-btn ${copied ? 'copied' : ''}`}
            onClick={handleCopyAddress}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="action-buttons">
        <button className="action-btn send" onClick={() => setShowSend(!showSend)}>
          {showSend ? 'X Close' : 'Send'}
        </button>
        <button className="action-btn generate" onClick={showGenerate ? closeKeyPanel : handleShowCurrentKey}>
          {showGenerate ? 'X Close' : 'Show Key'}
        </button>
        <button className="action-btn refresh" onClick={handleRefresh} disabled={loading}>
          {loading ? <span className="spinner"></span> : null} Refresh
        </button>
        <button className="action-btn logout" onClick={handleLogout}>
          Logout
        </button>
      </div>

      {statusMsg && (
        <div className={`status-msg ${statusMsg.type}`}>
          {statusMsg.text}
        </div>
      )}

      {showGenerate && newKeyWif && (
        <div className="send-form">
          <h3>ログイン中のウォレットの秘密鍵</h3>
          <div className="generated-key-section">
            <div className="form-group">
              <label>秘密鍵 (WIF)</label>
              <div className="generated-key-row">
                <div className="generated-key-value">
                  {keyRevealed ? newKeyWif : '•'.repeat(24)}
                </div>
                <button
                  className="copy-btn"
                  onClick={() => setKeyRevealed(!keyRevealed)}
                >
                  {keyRevealed ? '隠す' : '表示'}
                </button>
                <button
                  className={`copy-btn ${newKeyCopied === 'wif' ? 'copied' : ''}`}
                  onClick={() => handleCopyNewKey(newKeyWif, 'wif')}
                >
                  {newKeyCopied === 'wif' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="form-group">
              <label>アドレス ({CHAINS[chain].label})</label>
              <div className="generated-key-row">
                <div className="generated-key-value">{newKeyAddress}</div>
                <button
                  className={`copy-btn ${newKeyCopied === 'addr' ? 'copied' : ''}`}
                  onClick={() => handleCopyNewKey(newKeyAddress, 'addr')}
                >
                  {newKeyCopied === 'addr' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="status-msg info" style={{ marginTop: '12px' }}>
              Warning: この秘密鍵はこのウォレットの全資産にアクセスできます。誰にも共有せず、画面を覗かれない場所で扱ってください。
            </div>
            <div className="form-buttons">
              <button className="cancel-btn" onClick={closeKeyPanel}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {showSend && (
        <div className="send-form">
          <h3>{info.symbol} 送金</h3>
          <div className="form-group">
            <label>送信先アドレス</label>
            <input
              type="text"
              placeholder={`${info.symbol}アドレスを入力...`}
              value={sendTo}
              onChange={(e) => setSendTo(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>金額 ({info.symbol})</label>
            <input
              type="number"
              step="0.00000001"
              min="0"
              placeholder="0.00000000"
              value={sendAmount}
              onChange={(e) => setSendAmount(e.target.value)}
            />
          </div>
          <div className="form-buttons">
            <button className="cancel-btn" onClick={() => setShowSend(false)}>
              キャンセル
            </button>
            <button
              className="submit-btn"
              onClick={handleSend}
              disabled={sending || !sendTo || !sendAmount}
            >
              {sending ? <><span className="spinner"></span> 送金中...</> : '送金する'}
            </button>
          </div>
        </div>
      )}

      <div className="tx-list">
        <h3>取引履歴 {loading && <span className="spinner"></span>}</h3>
        {txHistory.length === 0 ? (
          <div className="tx-empty">取引履歴がありません</div>
        ) : (
          txHistory.map((tx) => (
            <div key={tx.tx_hash} className="tx-item">
              <a
                className="tx-hash"
                href={explorerTxUrl(chain, tx.tx_hash)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {tx.tx_hash.slice(0, 8)}...{tx.tx_hash.slice(-8)}
              </a>
              <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
                {tx.height > 0 ? `Block #${tx.height}` : ''}
              </span>
            </div>
          ))
        )}
      </div>

      {error && <div className="status-msg error">{error}</div>}
    </div>
  )
}

export default App
