// Watch-only crypto. Bitcoin deposit addresses are derived from the site's
// extended public key (xpub/zpub), and USDT on Tron is paid into one
// address and matched by exact amount. Payments are read from public block
// explorers. The server never holds a key that can spend anything.
import { HDKey } from '@scure/bip32';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';

const b58c = createBase58check(sha256);
const hash160 = (b) => ripemd160(sha256(b));

// SLIP-132 version bytes say which kind of address a key makes. Electrum's
// default ("Standard wallet", native segwit) exports a zpub.
const PREFIXES = {
  xpub: { version: 0x0488b21e, net: 'main', type: 'p2pkh' },
  ypub: { version: 0x049d7cb2, net: 'main', type: 'p2sh-p2wpkh' },
  zpub: { version: 0x04b24746, net: 'main', type: 'p2wpkh' },
  tpub: { version: 0x043587cf, net: 'test', type: 'p2pkh' },
  upub: { version: 0x044a5262, net: 'test', type: 'p2sh-p2wpkh' },
  vpub: { version: 0x045f1cf6, net: 'test', type: 'p2wpkh' },
};
const NET = {
  main: { hrp: 'bc', p2pkh: 0x00, p2sh: 0x05 },
  test: { hrp: 'tb', p2pkh: 0x6f, p2sh: 0xc4 },
};

export class ChainError extends Error {}

// Bitcoin addresses from an account-level extended public key, on the
// receive chain (…/0/i) the way Electrum and other wallets number them.
export function btcWallet(xpub) {
  const s = String(xpub || '').trim();
  const p = PREFIXES[s.slice(0, 4)];
  if (!p) throw new ChainError('BTC_XPUB must start with zpub, xpub or ypub (vpub/tpub/upub for testnet)');
  let receive;
  try {
    receive = HDKey.fromExtendedKey(s, { public: p.version, private: 0 }).deriveChild(0);
  } catch (e) {
    throw new ChainError(`BTC_XPUB is not a valid extended public key (${e.message})`);
  }
  const net = NET[p.net];
  return {
    net: p.net,
    type: p.type,
    address(index) {
      const h = hash160(receive.deriveChild(index).publicKey);
      if (p.type === 'p2wpkh') return bech32.encode(net.hrp, [0, ...bech32.toWords(h)]);
      if (p.type === 'p2pkh') return b58c.encode(Uint8Array.from([net.p2pkh, ...h]));
      const redeem = Uint8Array.from([0x00, 0x14, ...h]);
      return b58c.encode(Uint8Array.from([net.p2sh, ...hash160(redeem)]));
    },
  };
}

// Checksummed validation, so a typo in a withdrawal address is caught.
export function btcAddressOk(a, netName = 'main') {
  const s = String(a || '').trim();
  const net = NET[netName];
  if (/^(bc|tb)1/i.test(s)) {
    if (s !== s.toLowerCase()) return false;
    for (const codec of [bech32, bech32m]) {
      try {
        const { prefix, words } = codec.decode(s);
        if (prefix !== net.hrp) return false;
        const ver = words[0];
        const prog = codec.fromWords(words.slice(1));
        if (ver === 0) return codec === bech32 && (prog.length === 20 || prog.length === 32);
        return codec === bech32m && ver <= 16 && prog.length >= 2 && prog.length <= 40;
      } catch {}
    }
    return false;
  }
  try {
    const b = b58c.decode(s);
    return b.length === 21 && (b[0] === net.p2pkh || b[0] === net.p2sh);
  } catch { return false; }
}

export function tronAddressOk(a) {
  try {
    const b = b58c.decode(String(a || '').trim());
    return b.length === 21 && b[0] === 0x41;
  } catch { return false; }
}

async function getJson(url, { headers = {}, timeoutMs = 15_000 } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ChainError(`${new URL(url).host} unreachable: ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new ChainError(`${new URL(url).host} HTTP ${res.status}: ${text.slice(0, 120)}`);
  try { return JSON.parse(text); } catch { throw new ChainError(`${new URL(url).host} sent something that isn't JSON`); }
}

// Esplora API (mempool.space, blockstream.info). Each call tries the next
// server if one fails.
export function esplora(bases) {
  async function get(path) {
    let last;
    for (const base of bases) {
      try { return await getJson(base + path); } catch (e) { last = e; }
    }
    throw last;
  }
  return {
    tip: async () => Number(await get('/blocks/tip/height')),
    // Payments to one address: [{ txid, sats, height|null }]. Newest first;
    // the explorers return every unconfirmed one and the latest 25
    // confirmed, which is plenty for a deposit address.
    async received(address) {
      const txs = await get(`/address/${encodeURIComponent(address)}/txs`);
      const out = [];
      for (const t of txs) {
        const sats = t.vout.filter((o) => o.scriptpubkey_address === address).reduce((s, o) => s + o.value, 0);
        if (sats > 0) out.push({ txid: t.txid, sats, height: t.status?.confirmed ? t.status.block_height : null });
      }
      return out;
    },
  };
}

// Dollar price of bitcoin from the first source that answers. Understands
// mempool.space ({ USD }) and Coinbase ({ data: { amount } }).
export function btcPrice(urls) {
  let cached = null;
  return {
    async get({ fresh = false } = {}) {
      if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.usd;
      let last;
      for (const url of urls) {
        try {
          const j = await getJson(url);
          const usd = Number(j.USD ?? j.data?.amount);
          if (!(usd > 0)) throw new ChainError(`no price from ${new URL(url).host}`);
          cached = { usd, at: Date.now() };
          return usd;
        } catch (e) { last = e; }
      }
      if (!fresh && cached) return cached.usd;
      throw last;
    },
    get cached() { return cached?.usd ?? null; },
  };
}

// TronGrid: confirmed USDT transfers into an address since a time.
// Amounts stay integer micro-USDT (6 decimals) so they compare exactly.
export function tronGrid({ base, apiKey, contract }) {
  return {
    async received(address, sinceMs) {
      const q = new URLSearchParams({
        only_to: 'true', only_confirmed: 'true', limit: '200', contract_address: contract, min_timestamp: String(Math.max(0, Math.floor(sinceMs))),
      });
      const j = await getJson(`${base}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${q}`, {
        headers: apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {},
      });
      if (j.success === false) throw new ChainError(`TronGrid: ${j.error || 'request failed'}`);
      return (j.data || [])
        // Fake tokens that call themselves USDT are common; only the real
        // contract counts.
        .filter((t) => t.type === 'Transfer' && t.to === address && t.token_info?.address === contract && Number(t.token_info?.decimals) === 6)
        .map((t) => ({ txid: String(t.transaction_id), from: t.from, micro: BigInt(t.value), at: Number(t.block_timestamp) }));
    },
  };
}

// "25.01" -> 25010000n; "0.00012345" BTC -> 12345n sats.
export function toUnits(s, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(s));
  if (!m) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(((m[2] || '') + '0'.repeat(decimals)).slice(0, decimals));
}
export const satsToBtc = (sats) => (Number(sats) / 1e8).toFixed(8);
