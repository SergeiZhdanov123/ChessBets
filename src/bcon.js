// Bcon Global (bcon.global): non-custodial crypto payments. Bcon watches the
// chains and tells us when a payment reaches one of our wallets; the coins
// themselves go straight to those wallets. Bcon has no payout API, so
// withdrawals are sent by staff and recorded in Admin.
//
// Bcon's own notification is only protected by a secret in its URL, so a
// callback is treated as a hint: every payment is looked up again through
// the API with our key before anything is credited.

const EVM = /^0x[a-fA-F0-9]{40}$/;
const TRON = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BITCOIN = /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;

// `id` is Bcon's currency id (GET /api/v1/currencies). A reported payment
// must carry the id of the coin the deposit was opened for.
export const BCON_COINS = {
  BTC: { label: 'BTC', ticker: 'BTC', name: 'Bitcoin', network: 'Bitcoin', chain: 'bitcoin', id: 1, decimals: 8, re: BITCOIN },
  'USDT-TRC20': { label: 'USDT', ticker: 'USDT', name: 'Tether', network: 'Tron (TRC-20)', chain: 'tron', id: 19, decimals: 2, stable: true, re: TRON },
  'USDC-TRC20': { label: 'USDC', ticker: 'USDC', name: 'USD Coin', network: 'Tron (TRC-20)', chain: 'tron', id: 20, decimals: 2, stable: true, re: TRON },
  TRX: { label: 'TRX', ticker: 'TRX', name: 'Tron', network: 'Tron', chain: 'tron', id: 18, decimals: 2, re: TRON },
  ETH: { label: 'ETH', ticker: 'ETH', name: 'Ethereum', network: 'Ethereum', chain: 'ethereum', id: 3, decimals: 6, re: EVM },
  'USDT-ERC20': { label: 'USDT', ticker: 'USDT', name: 'Tether', network: 'Ethereum (ERC-20)', chain: 'ethereum', id: 4, decimals: 2, stable: true, re: EVM },
  'USDC-ERC20': { label: 'USDC', ticker: 'USDC', name: 'USD Coin', network: 'Ethereum (ERC-20)', chain: 'ethereum', id: 5, decimals: 2, stable: true, re: EVM },
  BNB: { label: 'BNB', ticker: 'BNB', name: 'BNB', network: 'BNB Smart Chain', chain: 'binance', id: 2, decimals: 5, re: EVM },
  'USDT-BEP20': { label: 'USDT', ticker: 'USDT', name: 'Tether', network: 'BNB Smart Chain (BEP-20)', chain: 'binance', id: 10, decimals: 2, stable: true, re: EVM },
  SOL: { label: 'SOL', ticker: 'SOL', name: 'Solana', network: 'Solana', chain: 'solana', id: 12, decimals: 4, re: SOLANA },
  'USDT-SPL': { label: 'USDT', ticker: 'USDT', name: 'Tether', network: 'Solana (SPL)', chain: 'solana', id: 13, decimals: 2, stable: true, re: SOLANA },
  'USDC-SPL': { label: 'USDC', ticker: 'USDC', name: 'USD Coin', network: 'Solana (SPL)', chain: 'solana', id: 14, decimals: 2, stable: true, re: SOLANA },
};
export const coinById = (id) => Object.keys(BCON_COINS).find((k) => BCON_COINS[k].id === Number(id)) || null;

// Bitcoin gets a fresh address per deposit. Every other chain pays into the
// store's one wallet, and Bcon tells deposits apart by exact amount.
export const ownAddress = (code) => BCON_COINS[code]?.chain === 'bitcoin';

export const sameAddress = (code, a, b) => {
  if (!a || !b) return false;
  return BCON_COINS[code]?.re === EVM ? a.toLowerCase() === b.toLowerCase() : a === b;
};

export class BconError extends Error {
  constructor(message, { status = 0, body = null } = {}) { super(message); this.status = status; this.body = body; }
}

// Decimal strings to scaled integers, so amounts compare exactly.
const SCALE = 18;
export function units(s) {
  const m = /^\s*(\d*)(?:\.(\d*))?\s*$/.exec(String(s ?? ''));
  if (!m || (!m[1] && !m[2])) return null;
  return BigInt(m[1] || '0') * 10n ** BigInt(SCALE) + BigInt(((m[2] || '') + '0'.repeat(SCALE)).slice(0, SCALE));
}

export function createBcon({ key, base, storeId = '', chains: forced = [], timeoutMs = 15_000 }) {
  let store = null;           // { id, name, chains: { bitcoin: { key, address, xpub, callback } } }
  let storeAt = 0;
  const rates = new Map();    // ticker -> { usd, at }

  async function call(method, path, { body, apiKey = key } = {}) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new BconError(`Bcon unreachable: ${e.message}`);
    }
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new BconError(`Bcon HTTP ${res.status}: ${text.slice(0, 160)}`, { status: res.status }); }
    if (!res.ok || j.errorMessage || (j.status && j.status !== 'Ok')) {
      throw new BconError(`Bcon: ${j.errorMessage || j.message || j.status || `HTTP ${res.status}`}`, { status: res.status, body: j });
    }
    return j.data ?? {};
  }

  // Which chains the store has a wallet on, and the key Bcon issued for
  // each. Older store records only carry the BTC and BNB fields.
  function readStore(s) {
    const chains = {};
    for (const c of s.chains || []) {
      if (c.address || c.xpub) chains[c.chain] = { key: c.api_key || key, address: c.address || null, xpub: c.xpub || null, callback: c.callback_url || null };
    }
    if (!s.chains) {
      if (s.xpub) chains.bitcoin = { key: s.api_key || key, address: null, xpub: s.xpub, callback: s.callback_url || null };
      if (s.binance_address) chains.binance = { key: s.api_key_bnb || key, address: s.binance_address, xpub: null, callback: s.callback_url_bnb || null };
    }
    for (const ch of forced) chains[ch] ??= { key, address: null, xpub: null, callback: null };
    return { id: s.id, name: s.name, chains };
  }

  async function refreshStore() {
    const data = await call('GET', '/api/v1/stores/');
    const list = data.addresses || data.stores || [];
    const s = storeId ? list.find((x) => String(x.id) === String(storeId)) : list[0];
    if (!s) {
      if (!forced.length) throw new BconError(storeId ? `Bcon store ${storeId} not found` : 'The Bcon account has no store yet');
      store = { id: null, name: null, chains: Object.fromEntries(forced.map((ch) => [ch, { key, address: null, xpub: null, callback: null }])) };
    } else {
      store = readStore(s);
    }
    storeAt = Date.now();
    return store;
  }

  const chainKey = (chain) => store?.chains[chain]?.key || key;

  // Dollar price of a coin, cached for five minutes for display; `fresh`
  // skips the cache when the price decides how much to credit.
  async function rate(ticker, { fresh = false } = {}) {
    const t = ticker.toLowerCase();
    const hit = rates.get(t);
    if (!fresh && hit && Date.now() - hit.at < 5 * 60_000) return hit.usd;
    try {
      const d = await call('GET', `/api/v1/currencies/${encodeURIComponent(t)}?currency=usd`);
      const usd = Number(d.price);
      if (!(usd > 0)) throw new BconError(`no price for ${t}`);
      rates.set(t, { usd, at: Date.now() });
      return usd;
    } catch (e) {
      if (hit) return hit.usd; // a stale price beats none for a display
      throw e;
    }
  }

  return {
    refreshStore,
    get store() { return store; },
    get storeAge() { return store ? Date.now() - storeAt : Infinity; },
    enabledChains: () => Object.keys(store?.chains || {}),
    rate,
    cachedRate: (ticker) => rates.get(ticker.toLowerCase())?.usd ?? null,

    // Opens a deposit: Bcon converts the dollar amount at its own rate and
    // returns the address and the exact coin amount to send.
    async newAddress(code, usdCents, externalId) {
      const c = BCON_COINS[code];
      const d = await call('POST', '/api/v2/address', {
        apiKey: chainKey(c.chain),
        body: {
          payment_currency: c.ticker, origin_amount: (usdCents / 100).toFixed(2), origin_currency: 'USD',
          external_id: externalId, chain: c.chain,
        },
      });
      if (!d.address || units(d.payment_amount) === null) throw new BconError('Bcon returned no address', { body: d });
      return { address: String(d.address), amount: String(d.payment_amount) };
    },

    // { txid, address, status: unconfirmed|partially_confirmed|confirmed, sum, coin }
    async transaction(txid, chain) {
      const d = await call('GET', `/api/v1/transactions/${encodeURIComponent(txid)}`, { apiKey: chain ? chainKey(chain) : key });
      const t = d.transaction || d;
      if (!t || !t.transaction_id) throw new BconError('Bcon returned no transaction', { body: d });
      return {
        txid: String(t.transaction_id), address: t.address ? String(t.address) : null, status: String(t.status || ''),
        sum: String(t.sum ?? ''), coin: coinById(t.currency?.id), currencyId: t.currency?.id ?? null,
      };
    },

    // Payments Bcon has seen to an address, newest first.
    async history(address, chain) {
      const d = await call('GET', `/api/v1/user/history?address=${encodeURIComponent(address)}`, { apiKey: chainKey(chain) });
      return (d.transactions || []).map((t) => ({
        txid: String(t.transaction_id), status: String(t.status || ''), sum: String(t.sum ?? ''),
        coin: coinById(t.currency?.id), at: Date.parse(t.created_at) || 0,
      }));
    },
  };
}
