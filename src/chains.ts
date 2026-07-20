import { PrivateKey as BsvPrivateKey, P2PKH, Transaction as BsvTransaction, SatoshisPerKilobyte } from '@bsv/sdk'
import * as bitcoin from 'bitcoinjs-lib'
import { ECPairFactory } from 'ecpair'
import * as ecc from '@bitcoinerlab/secp256k1'

const ECPair = ECPairFactory(ecc)

export type ChainId = 'bsv-mainnet' | 'bsv-testnet' | 'bsv-teratestnet' | 'btc-mainnet' | 'btc-testnet3'
export type AddressFormat = 'legacy' | 'segwit'

type BsvChainId = 'bsv-mainnet' | 'bsv-testnet' | 'bsv-teratestnet'
type BtcChainId = 'btc-mainnet' | 'btc-testnet3'

export interface ChainInfo {
  id: ChainId
  label: string
  symbol: 'BSV' | 'BTC'
  isBtc: boolean
  isTestnet: boolean
}

export const CHAINS: Record<ChainId, ChainInfo> = {
  'bsv-mainnet':     { id: 'bsv-mainnet',     label: 'BSV Mainnet',  symbol: 'BSV', isBtc: false, isTestnet: false },
  'bsv-testnet':     { id: 'bsv-testnet',     label: 'BSV Testnet',  symbol: 'BSV', isBtc: false, isTestnet: true  },
  'bsv-teratestnet': { id: 'bsv-teratestnet', label: 'Teratestnet',  symbol: 'BSV', isBtc: false, isTestnet: true  },
  'btc-mainnet':     { id: 'btc-mainnet',     label: 'BTC Mainnet',  symbol: 'BTC', isBtc: true,  isTestnet: false },
  'btc-testnet3':    { id: 'btc-testnet3',    label: 'BTC Testnet3', symbol: 'BTC', isBtc: true,  isTestnet: true  },
}

export interface UTXO {
  tx_hash: string
  tx_pos: number
  value: number
  height: number
}

export interface TxHistoryItem {
  tx_hash: string
  height: number
}

// Teratestnet is a BSV-family shared PoW test network served by a custom
// indexer that speaks the WhatsOnChain-compatible endpoint shape
// (/address/{a}/unspent, /address/{a}/history, /tx/{txid}/hex, POST /tx/raw).
// The indexer is only reachable over plain HTTP, so API calls from the
// (HTTPS) app go through a same-origin proxy (`/tera` -> indexer) configured
// in vercel.json for production and vite.config.ts for local dev, avoiding
// mixed-content blocking. Explorer links use the absolute URL since a
// top-level navigation to HTTP is not blocked.
const TERATESTNET_INDEXER = 'http://162.43.7.61:18101'
const TERATESTNET_API_BASE = '/tera'

const BSV_BASE: Record<BsvChainId, string> = {
  'bsv-mainnet':     'https://api.whatsonchain.com/v1/bsv/main',
  'bsv-testnet':     'https://api.whatsonchain.com/v1/bsv/test',
  'bsv-teratestnet': TERATESTNET_API_BASE,
}

const MEMPOOL_BASE: Record<BtcChainId, string> = {
  'btc-mainnet':  'https://mempool.space/api',
  'btc-testnet3': 'https://mempool.space/testnet/api',
}

const EXPLORER_TX: Record<ChainId, string> = {
  'bsv-mainnet':     'https://whatsonchain.com/tx',
  'bsv-testnet':     'https://test.whatsonchain.com/tx',
  'bsv-teratestnet': `${TERATESTNET_INDEXER}/tx`,
  'btc-mainnet':     'https://mempool.space/tx',
  'btc-testnet3':    'https://mempool.space/testnet/tx',
}

export function explorerTxUrl(chain: ChainId, txid: string): string {
  return `${EXPLORER_TX[chain]}/${txid}`
}

function btcNetwork(chain: ChainId): bitcoin.Network {
  return CHAINS[chain].isTestnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin
}

// ---------- Address derivation ----------

export function deriveAddress(privateKeyHex: string, chain: ChainId, format: AddressFormat): string {
  if (CHAINS[chain].isBtc) {
    const net = btcNetwork(chain)
    const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKeyHex, 'hex'), { network: net })
    const pubkey = Buffer.from(keyPair.publicKey)
    if (format === 'segwit') {
      const { address } = bitcoin.payments.p2wpkh({ pubkey, network: net })
      if (!address) throw new Error('Failed to derive segwit address')
      return address
    }
    const { address } = bitcoin.payments.p2pkh({ pubkey, network: net })
    if (!address) throw new Error('Failed to derive legacy address')
    return address
  }
  // BSV
  const pk = new BsvPrivateKey(privateKeyHex, 16)
  return pk.toPublicKey().toAddress(CHAINS[chain].isTestnet ? [0x6f] : [0x00])
}

// Try to parse a WIF as either chain. Returns 32-byte hex of the private key.
export function privateKeyHexFromWif(wif: string): string {
  // Pass both networks so testnet WIFs (`c...` prefix, version 0xEF) decode too.
  // BSV uses the same version bytes as BTC, so this covers all four chains.
  try {
    const kp = ECPair.fromWIF(wif, [bitcoin.networks.bitcoin, bitcoin.networks.testnet])
    return Buffer.from(kp.privateKey!).toString('hex')
  } catch {
    const pk = BsvPrivateKey.fromWif(wif)
    return pk.toString()
  }
}

export function privateKeyHexToWif(privateKeyHex: string, chain: ChainId): string {
  if (CHAINS[chain].isBtc) {
    const net = btcNetwork(chain)
    const kp = ECPair.fromPrivateKey(Buffer.from(privateKeyHex, 'hex'), { network: net, compressed: true })
    return kp.toWIF()
  }
  const pk = new BsvPrivateKey(privateKeyHex, 16)
  return pk.toWif()
}

export function generatePrivateKeyHex(): string {
  const pk = BsvPrivateKey.fromRandom()
  return pk.toString()
}

// ---------- Fetch helpers ----------

export async function fetchUTXOs(address: string, chain: ChainId): Promise<UTXO[]> {
  if (CHAINS[chain].isBtc) {
    const base = MEMPOOL_BASE[chain as BtcChainId]
    const res = await fetch(`${base}/address/${address}/utxo`)
    if (!res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data)) return []
    return data.map((u: { txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }) => ({
      tx_hash: u.txid,
      tx_pos: u.vout,
      value: u.value,
      height: u.status?.confirmed ? (u.status.block_height ?? 1) : 0,
    }))
  }
  const base = BSV_BASE[chain as BsvChainId]
  const res = await fetch(`${base}/address/${address}/unspent`)
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

export async function fetchBalanceFromUTXOs(address: string, chain: ChainId): Promise<{ total: number; confirmed: number; unconfirmed: number; utxos: UTXO[] }> {
  const utxos = await fetchUTXOs(address, chain)
  let confirmed = 0
  let unconfirmed = 0
  for (const u of utxos) {
    if (u.height > 0) confirmed += u.value
    else unconfirmed += u.value
  }
  return { total: confirmed + unconfirmed, confirmed, unconfirmed, utxos }
}

export async function fetchTxHistory(address: string, chain: ChainId): Promise<TxHistoryItem[]> {
  if (CHAINS[chain].isBtc) {
    const base = MEMPOOL_BASE[chain as BtcChainId]
    const res = await fetch(`${base}/address/${address}/txs`)
    if (!res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data)) return []
    return data.map((t: { txid: string; status?: { confirmed?: boolean; block_height?: number } }) => ({
      tx_hash: t.txid,
      height: t.status?.confirmed ? (t.status.block_height ?? 1) : 0,
    }))
  }
  const base = BSV_BASE[chain as BsvChainId]
  const res = await fetch(`${base}/address/${address}/history`)
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

export async function fetchRawTx(txid: string, chain: ChainId): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = CHAINS[chain].isBtc
      ? `${MEMPOOL_BASE[chain as BtcChainId]}/tx/${txid}/hex`
      : `${BSV_BASE[chain as BsvChainId]}/tx/${txid}/hex`
    const res = await fetch(url)
    if (res.ok) {
      const t = await res.text()
      return t.replace(/"/g, '').trim()
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
  }
  throw new Error(`Failed to fetch tx ${txid}`)
}

export async function broadcastTx(rawHex: string, chain: ChainId): Promise<string> {
  if (CHAINS[chain].isBtc) {
    const base = MEMPOOL_BASE[chain as BtcChainId]
    const res = await fetch(`${base}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: rawHex,
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Broadcast failed: ${errText}`)
    }
    const txid = (await res.text()).trim()
    return txid.replace(/"/g, '')
  }
  const base = BSV_BASE[chain as BsvChainId]
  const res = await fetch(`${base}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: rawHex }),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Broadcast failed: ${errText}`)
  }
  // WhatsOnChain returns the plain-text txid; the teratestnet indexer returns
  // JSON `{ "txid": "..." }`. Handle both.
  const body = (await res.text()).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = undefined // not JSON — treat body as the plain-text txid
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { txid?: unknown; error?: unknown }
    if (typeof obj.txid === 'string') return obj.txid
    if (typeof obj.error === 'string') throw new Error(`Broadcast failed: ${obj.error}`)
  }
  return body.replace(/"/g, '').trim()
}

// ---------- Fee rate (sats/vB for BTC, sats/KB for BSV) ----------

async function recommendedBtcFeeRate(chain: ChainId): Promise<number> {
  try {
    const base = MEMPOOL_BASE[chain as BtcChainId]
    const res = await fetch(`${base}/v1/fees/recommended`)
    if (!res.ok) throw new Error('fee fetch failed')
    const data = await res.json()
    // Use halfHourFee as a reasonable default. Testnet often returns 1 sat/vB.
    const rate = Number(data?.halfHourFee ?? data?.hourFee ?? 1)
    return Math.max(1, Math.ceil(rate))
  } catch {
    return CHAINS[chain].isTestnet ? 1 : 5
  }
}

// ---------- Tx build + sign ----------

export async function buildAndBroadcastTx(opts: {
  privateKeyHex: string
  fromAddress: string
  toAddress: string
  satoshisToSend: number
  utxos: UTXO[]
  chain: ChainId
  addressFormat: AddressFormat
}): Promise<string> {
  const { privateKeyHex, fromAddress, toAddress, satoshisToSend, utxos, chain, addressFormat } = opts

  if (CHAINS[chain].isBtc) {
    return buildAndBroadcastBtc({ privateKeyHex, fromAddress, toAddress, satoshisToSend, utxos, chain, addressFormat })
  }
  return buildAndBroadcastBsv({ privateKeyHex, fromAddress, toAddress, satoshisToSend, utxos, chain })
}

async function buildAndBroadcastBsv(opts: {
  privateKeyHex: string
  fromAddress: string
  toAddress: string
  satoshisToSend: number
  utxos: UTXO[]
  chain: ChainId
}): Promise<string> {
  const { privateKeyHex, fromAddress, toAddress, satoshisToSend, utxos, chain } = opts
  const pk = new BsvPrivateKey(privateKeyHex, 16)
  const tx = new BsvTransaction()

  const sortedUtxos = [...utxos].sort((a, b) => {
    if (a.height === 0 && b.height !== 0) return -1
    if (a.height !== 0 && b.height === 0) return 1
    return b.value - a.value
  })

  let totalInput = 0
  const used: UTXO[] = []
  for (const u of sortedUtxos) {
    used.push(u); totalInput += u.value
    if (totalInput >= satoshisToSend + 500) break
  }
  if (totalInput < satoshisToSend + 200) {
    throw new Error(`Insufficient balance. Available: ${totalInput} sat`)
  }

  for (const u of used) {
    const rawHex = await fetchRawTx(u.tx_hash, chain)
    const sourceTransaction = BsvTransaction.fromHex(rawHex)
    tx.addInput({
      sourceTransaction,
      sourceOutputIndex: u.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(pk),
    })
  }

  tx.addOutput({
    lockingScript: new P2PKH().lock(toAddress),
    satoshis: satoshisToSend,
  })
  tx.addOutput({
    lockingScript: new P2PKH().lock(fromAddress),
    change: true,
  })

  await tx.fee(new SatoshisPerKilobyte(1))
  await tx.sign()
  return broadcastTx(tx.toHex(), chain)
}

async function buildAndBroadcastBtc(opts: {
  privateKeyHex: string
  fromAddress: string
  toAddress: string
  satoshisToSend: number
  utxos: UTXO[]
  chain: ChainId
  addressFormat: AddressFormat
}): Promise<string> {
  const { privateKeyHex, fromAddress, toAddress, satoshisToSend, utxos, chain, addressFormat } = opts
  const network = btcNetwork(chain)
  const keyPair = ECPair.fromPrivateKey(Buffer.from(privateKeyHex, 'hex'), { network, compressed: true })
  const pubkey = Buffer.from(keyPair.publicKey)
  const feeRate = await recommendedBtcFeeRate(chain) // sats/vB

  // Sort: unconfirmed first, then largest first
  const sortedUtxos = [...utxos].sort((a, b) => {
    if (a.height === 0 && b.height !== 0) return -1
    if (a.height !== 0 && b.height === 0) return 1
    return b.value - a.value
  })

  // Rough vsize estimator: header + each input + each output.
  // P2WPKH input ~ 68 vB, P2PKH input ~ 148 vB. Outputs ~31-34 vB each.
  const inputVbytes = addressFormat === 'segwit' ? 68 : 148
  const outputVbytes = 34
  const headerVbytes = 11

  function estimateFee(numInputs: number, numOutputs: number): number {
    return Math.ceil((headerVbytes + numInputs * inputVbytes + numOutputs * outputVbytes) * feeRate)
  }

  // Select inputs to cover send + estimated fee with change
  let totalInput = 0
  const used: UTXO[] = []
  for (const u of sortedUtxos) {
    used.push(u); totalInput += u.value
    const fee = estimateFee(used.length, 2)
    if (totalInput >= satoshisToSend + fee) break
  }
  let fee = estimateFee(used.length, 2)
  if (totalInput < satoshisToSend + fee) {
    throw new Error(`Insufficient balance. Available: ${totalInput} sat, need ~${satoshisToSend + fee} sat`)
  }

  const change = totalInput - satoshisToSend - fee
  const psbt = new bitcoin.Psbt({ network })

  for (const u of used) {
    if (addressFormat === 'segwit') {
      const { output } = bitcoin.payments.p2wpkh({ pubkey, network })
      if (!output) throw new Error('Failed to build P2WPKH script')
      psbt.addInput({
        hash: u.tx_hash,
        index: u.tx_pos,
        witnessUtxo: { script: output, value: BigInt(u.value) },
      })
    } else {
      const rawHex = await fetchRawTx(u.tx_hash, chain)
      psbt.addInput({
        hash: u.tx_hash,
        index: u.tx_pos,
        nonWitnessUtxo: Buffer.from(rawHex, 'hex'),
      })
    }
  }

  psbt.addOutput({ address: toAddress, value: BigInt(satoshisToSend) })
  // Only include change if it's above dust (546 for P2PKH/P2WPKH-ish threshold)
  const DUST = 546
  if (change >= DUST) {
    psbt.addOutput({ address: fromAddress, value: BigInt(change) })
  } else {
    // Roll dust into the fee; recompute fee assuming 1 output
    fee = estimateFee(used.length, 1)
    if (totalInput - satoshisToSend < fee) {
      throw new Error('Insufficient balance for fee')
    }
  }

  // bitcoinjs-lib expects a `Signer` shape — adapt ECPair to it.
  const signer = {
    publicKey: pubkey,
    sign: (hash: Buffer) => Buffer.from(keyPair.sign(hash)),
  }
  for (let i = 0; i < used.length; i++) {
    psbt.signInput(i, signer)
  }
  psbt.finalizeAllInputs()
  const rawHex = psbt.extractTransaction().toHex()
  return broadcastTx(rawHex, chain)
}
