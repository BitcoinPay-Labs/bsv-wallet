import { useState, useCallback, useEffect, useRef } from 'react'
import { PrivateKey, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'
import './App.css'

type Network = 'mainnet' | 'testnet'

interface UTXO {
  tx_hash: string
  tx_pos: number
  value: number
  height: number
}

interface TxHistoryItem {
  tx_hash: string
  height: number
}

const WOC_BASE: Record<Network, string> = {
  mainnet: 'https://api.whatsonchain.com/v1/bsv/main',
  testnet: 'https://api.whatsonchain.com/v1/bsv/test',
}

const EXPLORER_BASE: Record<Network, string> = {
  mainnet: 'https://whatsonchain.com/tx',
  testnet: 'https://test.whatsonchain.com/tx',
}

async function fetchBalanceFromUTXOs(address: string, network: Network): Promise<{ total: number; confirmed: number; unconfirmed: number; utxos: UTXO[] }> {
  const utxos = await fetchUTXOs(address, network)
  let confirmed = 0
  let unconfirmed = 0
  for (const u of utxos) {
    if (u.height > 0) confirmed += u.value
    else unconfirmed += u.value
  }
  return { total: confirmed + unconfirmed, confirmed, unconfirmed, utxos }
}

async function fetchUTXOs(address: string, network: Network): Promise<UTXO[]> {
  const res = await fetch(`${WOC_BASE[network]}/address/${address}/unspent`)
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

async function fetchTxHistory(address: string, network: Network): Promise<TxHistoryItem[]> {
  const res = await fetch(`${WOC_BASE[network]}/address/${address}/history`)
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

async function fetchRawTx(txid: string, network: Network): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${WOC_BASE[network]}/tx/${txid}/hex`)
    if (res.ok) return res.text()
    if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
  }
  throw new Error(`Failed to fetch tx ${txid}`)
}

async function broadcastTx(rawHex: string, network: Network): Promise<string> {
  const res = await fetch(`${WOC_BASE[network]}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: rawHex }),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Broadcast failed: ${errText}`)
  }
  const txid = await res.text()
  return txid.replace(/"/g, '')
}

function satsToBsv(sats: number): string {
  return (sats / 1e8).toFixed(8)
}

function App() {
  const [network, setNetwork] = useState<Network>('mainnet')
  const [wifInput, setWifInput] = useState('')
  const [privateKey, setPrivateKey] = useState<PrivateKey | null>(null)
  const [address, setAddress] = useState('')
  const [totalSats, setTotalSats] = useState<number | null>(null)
  const [confirmedSats, setConfirmedSats] = useState(0)
  const [unconfirmedSats, setUnconfirmedSats] = useState(0)
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

  // Ref to track optimistic tx hashes that must survive API refreshes
  const pendingTxRef = useRef<Set<string>>(new Set())

  const loadWalletData = useCallback(async (addr: string, net: Network) => {
    setLoading(true)
    setError('')
    try {
      const [utxoData, hist] = await Promise.all([
        fetchBalanceFromUTXOs(addr, net),
        fetchTxHistory(addr, net),
      ])
      setTotalSats(utxoData.total)
      setConfirmedSats(utxoData.confirmed)
      setUnconfirmedSats(utxoData.unconfirmed)
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
      const pk = PrivateKey.fromWif(wifInput.trim())
      setPrivateKey(pk)
      const addr = pk.toPublicKey().toAddress(network === 'testnet' ? [0x6f] : [0x00])
      setAddress(addr)
      loadWalletData(addr, network)
    } catch {
      setError('Invalid WIF key. Please check your private key and network selection.')
    }
  }, [wifInput, network, loadWalletData])

  const handleGenerateKey = useCallback(() => {
    const pk = PrivateKey.fromRandom()
    const wif = pk.toWif()
    setGeneratedWif(wif)
    setWifInput(wif)
  }, [])

  const handleGenerateNewKey = useCallback(() => {
    const pk = PrivateKey.fromRandom()
    const wif = pk.toWif()
    const addr = pk.toPublicKey().toAddress(network === 'testnet' ? [0x6f] : [0x00])
    setNewKeyWif(wif)
    setNewKeyAddress(addr)
    setShowGenerate(true)
    setNewKeyCopied(null)
  }, [network])

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
      loadWalletData(address, network)
    }
  }, [address, network, loading, loadWalletData])

  const handleLogout = useCallback(() => {
    setPrivateKey(null)
    setAddress('')
    setTotalSats(null)
    setConfirmedSats(0)
    setUnconfirmedSats(0)
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

  const buildAndBroadcast = useCallback(async (
    pk: PrivateKey,
    addr: string,
    dest: string,
    satoshisToSend: number,
    utxos: UTXO[],
    net: Network,
  ): Promise<string> => {
    const tx = new Transaction()

    // Prefer unconfirmed UTXOs first (height=0) - they represent the latest chain state
    // and avoid mempool conflicts with already-spent confirmed UTXOs
    const sortedUtxos = [...utxos].sort((a, b) => {
      if (a.height === 0 && b.height !== 0) return -1
      if (a.height !== 0 && b.height === 0) return 1
      return b.value - a.value
    })

    let totalInput = 0
    const usedUtxos: UTXO[] = []

    for (const utxo of sortedUtxos) {
      usedUtxos.push(utxo)
      totalInput += utxo.value
      if (totalInput >= satoshisToSend + 500) break
    }

    if (totalInput < satoshisToSend + 200) {
      throw new Error(`Insufficient balance. Available: ${satsToBsv(totalInput)} BSV`)
    }

    for (const utxo of usedUtxos) {
      const rawHex = await fetchRawTx(utxo.tx_hash, net)
      const sourceTransaction = Transaction.fromHex(rawHex)
      tx.addInput({
        sourceTransaction,
        sourceOutputIndex: utxo.tx_pos,
        unlockingScriptTemplate: new P2PKH().unlock(pk),
      })
    }

    tx.addOutput({
      lockingScript: new P2PKH().lock(dest),
      satoshis: satoshisToSend,
    })

    tx.addOutput({
      lockingScript: new P2PKH().lock(addr),
      change: true,
    })

    await tx.fee(new SatoshisPerKilobyte(1))
    await tx.sign()

    return broadcastTx(tx.toHex(), net)
  }, [])

  const handleSend = useCallback(async () => {
    if (!privateKey || !sendTo || !sendAmount) return
    setSending(true)
    setStatusMsg(null)
    try {
      const satoshisToSend = Math.round(parseFloat(sendAmount) * 1e8)
      if (isNaN(satoshisToSend) || satoshisToSend <= 0) {
        throw new Error('Invalid amount')
      }

      const utxos = await fetchUTXOs(address, network)
      if (utxos.length === 0) {
        throw new Error('No UTXOs available')
      }

      let txid: string
      try {
        txid = await buildAndBroadcast(privateKey, address, sendTo, satoshisToSend, utxos, network)
      } catch (firstErr) {
        // On mempool-conflict, retry with only unconfirmed UTXOs
        const errMsg = firstErr instanceof Error ? firstErr.message : ''
        if (errMsg.includes('mempool-conflict') || errMsg.includes('Missing inputs')) {
          const unconfirmedOnly = utxos.filter(u => u.height === 0)
          if (unconfirmedOnly.length === 0) {
            throw new Error('Transaction conflict - please wait for confirmations and try again')
          }
          txid = await buildAndBroadcast(privateKey, address, sendTo, satoshisToSend, unconfirmedOnly, network)
        } else {
          throw firstErr
        }
      }

      setStatusMsg({ type: 'success', text: `Sent! TX:\n${txid}` })
      setShowSend(false)
      setSendTo('')
      setSendAmount('')

      // Track this tx in the ref so it survives any concurrent/future refreshes
      pendingTxRef.current.add(txid)

      // Optimistically add the new tx to history immediately
      setTxHistory(prev => {
        if (prev.some(t => t.tx_hash === txid)) return prev
        return [{ tx_hash: txid, height: 0 }, ...prev]
      })

      // Refresh after a short delay to let React render the optimistic entry first
      setTimeout(() => loadWalletData(address, network), 200)
      setTimeout(() => loadWalletData(address, network), 3000)
    } catch (e) {
      setStatusMsg({ type: 'error', text: e instanceof Error ? e.message : 'Send failed' })
    } finally {
      setSending(false)
    }
  }, [privateKey, sendTo, sendAmount, address, network, loadWalletData, buildAndBroadcast])

  useEffect(() => {
    if (!address) return
    const interval = setInterval(() => {
      loadWalletData(address, network)
    }, 15000)
    return () => clearInterval(interval)
  }, [address, network, loadWalletData])

  if (!privateKey) {
    return (
      <div className="wallet-container">
        <div className="wallet-header">
          <h1>BSV Wallet</h1>
        </div>
        <div className="login-screen">
          <div className="logo">&#8383;</div>
          <h2>BSV Wallet</h2>
          <p>秘密鍵（WIF形式）でログインしてください。<br />Testnet と Mainnet に対応しています。</p>

          <div className="network-selector">
            <button
              className={`network-btn ${network === 'mainnet' ? 'active' : ''}`}
              onClick={() => setNetwork('mainnet')}
            >
              Mainnet
            </button>
            <button
              className={`network-btn ${network === 'testnet' ? 'active' : ''}`}
              onClick={() => setNetwork('testnet')}
            >
              Testnet
            </button>
          </div>

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

          {error && <div className="error-msg">{error}</div>}

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
        </div>
      </div>
    )
  }

  const totalBalance = totalSats ?? 0

  return (
    <div className="wallet-container">
      <div className="wallet-header">
        <h1>BSV Wallet</h1>
        <span className={`network-badge ${network}`}>
          <span className="dot"></span>
          {network}
        </span>
      </div>

      <div className="balance-card">
        <div className="label">残高</div>
        {loading && totalSats === null ? (
          <div className="amount"><span className="spinner"></span></div>
        ) : (
          <>
            <div className="amount">
              {satsToBsv(totalBalance)}
              <span className="unit">BSV</span>
            </div>
            <div className="satoshis">
              {totalBalance.toLocaleString()} satoshis
              {utxoList.length > 0 && (
                <span> ({utxoList.length} UTXO{utxoList.length > 1 ? 's' : ''})</span>
              )}
            </div>
            {unconfirmedSats > 0 && (
              <div className="unconfirmed-badge">
                確認済: {confirmedSats.toLocaleString()} sat / 未確認: {unconfirmedSats.toLocaleString()} sat
              </div>
            )}
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
        <button className="action-btn generate" onClick={handleGenerateNewKey}>
          Generate Key
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
          <h3>新しい秘密鍵を生成しました</h3>
          <div className="generated-key-section">
            <div className="form-group">
              <label>秘密鍵 (WIF)</label>
              <div className="generated-key-row">
                <div className="generated-key-value">{newKeyWif}</div>
                <button
                  className={`copy-btn ${newKeyCopied === 'wif' ? 'copied' : ''}`}
                  onClick={() => handleCopyNewKey(newKeyWif, 'wif')}
                >
                  {newKeyCopied === 'wif' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="form-group">
              <label>アドレス ({network === 'testnet' ? 'Testnet' : 'Mainnet'})</label>
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
              Warning: この秘密鍵を安全な場所に保存してください。一度閉じると再表示できません。
            </div>
            <div className="form-buttons">
              <button className="cancel-btn" onClick={() => { setShowGenerate(false); setNewKeyWif(''); setNewKeyAddress(''); }}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {showSend && (
        <div className="send-form">
          <h3>BSV 送金</h3>
          <div className="form-group">
            <label>送信先アドレス</label>
            <input
              type="text"
              placeholder="BSVアドレスを入力..."
              value={sendTo}
              onChange={(e) => setSendTo(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>金額 (BSV)</label>
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
                href={`${EXPLORER_BASE[network]}/${tx.tx_hash}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {tx.tx_hash.slice(0, 8)}...{tx.tx_hash.slice(-8)}
              </a>
              <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
                {tx.height > 0 ? `Block #${tx.height}` : 'Unconfirmed'}
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
