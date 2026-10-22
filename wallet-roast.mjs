#!/usr/bin/env node
// /wallet-roast: paste a wallet, get its real onchain history as one roast poster. Claude writes the roast.
//
//   node wallet-roast.mjs <0x address | name.eth> [--chain ethereum|base] [--deep N] [--json]
//                         [--png card.png] [--roast "line 1|line 2|line 3"]
//
// Data: Blockscout's keyless explorer API (txs, token transfers, token balances, counters; Routescan as the
// Ethereum fallback), the chain's public RPC (nonce, balance) and openchain.xyz for contract method names.
// No API keys, no prices. Every number is computed from what the chain returned; anything we can't
// compute prints "no data".
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(`--${k}`); return i < 0 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const VALUED = new Set(['--chain', '--deep', '--png', '--roast']);
const input = argv.find((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
if (!input) { console.error('usage: wallet-roast <0x address | name.eth> [--chain ethereum|base] [--deep N] [--png out.png] [--roast "a|b|c"] [--json]'); process.exit(1); }
const t0 = Date.now();
const WINDOW = 10000; // the explorer API's max page; --deep walks further back in steps of this

const CHAINS = {
  ethereum: {
    api: ['https://eth.blockscout.com/api', 'https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api'],
    v2: 'https://eth.blockscout.com/api/v2',
    rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  },
  base: {
    api: ['https://base.blockscout.com/api'],
    v2: 'https://base.blockscout.com/api/v2',
    rpc: ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org'],
  },
};
const chain = String(flag('chain') || 'ethereum').toLowerCase().replace(/^eth$/, 'ethereum');
const C = CHAINS[chain];
if (!C) { console.error(`chain "${chain}" not supported yet. try: ${Object.keys(CHAINS).join(', ')} (solana: next version)`); process.exit(1); }
const deep = Math.max(1, Math.min(20, parseInt(flag('deep')) || 1));

const used = new Set(); // explorer hosts that actually answered
const notes = []; // honest log of what failed, printed on the card footer and in the JSON
async function getJSON(url, opts = {}) {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'wallet-roast/0.1' }, signal: AbortSignal.timeout(60000), ...opts });
    const text = await r.text();
    if (/^\s*</.test(text)) return { blocked: /Just a moment|cloudflare/i.test(text) };
    return r.ok ? JSON.parse(text) : null;
  } catch { return null; }
}
// Etherscan-style call, first explorer that answers wins. Returns an array, or null if no source answered.
async function explorer(params, sources = C.api) {
  const q = new URLSearchParams({ module: 'account', ...params }).toString();
  // Keyless explorers drop the odd request under load (429s, timeouts), so each source gets three tries (now, +3s, +8s).
  for (const base of sources) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const j = await getJSON(`${base}?${q}`);
      if (j?.blocked) { notes.push(`${new URL(base).host} is behind a cloudflare check right now`); break; }
      if (Array.isArray(j?.result)) { used.add(new URL(base).host); return j.result; }
      if (j && /no (transactions|token transfers|records)/i.test(j.message || '')) { used.add(new URL(base).host); return []; }
      if (j?.message && /not supported|invalid action/i.test(j.message + j.result)) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, [3000, 8000][attempt]));
    }
  }
  notes.push(`${params.action} unavailable`);
  return null;
}
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  for (const url of C.rpc) {
    const r = await getJSON(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (typeof r?.result === 'string' && /^0x[0-9a-f]*$/i.test(r.result)) return BigInt(r.result === '0x' ? 0 : r.result);
  }
  return null;
}

// Resolve ENS through Blockscout's Ethereum search (ENS lives on mainnet whatever chain we roast).
let addr = input, ens = null;
if (!/^0x[0-9a-fA-F]{40}$/.test(input)) {
  if (!/\.[a-z]+$/i.test(input)) { console.error(`"${input}" isn't an EVM address or an ENS name. solana: next version.`); process.exit(1); }
  const s = await getJSON(`${CHAINS.ethereum.v2}/search?q=${encodeURIComponent(input)}`);
  const hit = (s?.items || []).find((i) => i.type === 'ens_domain' && i.ens_info?.name?.toLowerCase() === input.toLowerCase());
  if (!hit?.address_hash) { console.error(`couldn't resolve ${input}. paste the 0x address instead.`); process.exit(2); }
  addr = hit.address_hash; ens = input.toLowerCase();
}
const me = addr.toLowerCase();

// Everything in parallel: full-history counters + first tx + the latest window of txs and token transfers.
const [info, counters, firstArr, nonce, bal, txs0, tts, held0] = await Promise.all([
  getJSON(`${C.v2}/addresses/${addr}`),
  getJSON(`${C.v2}/addresses/${addr}/counters`),
  // Blockscout's keyless /api allows ~10 calls an hour per IP, so the cheap first-tx lookup goes to the fallback first.
  explorer({ action: 'txlist', address: addr, sort: 'asc', page: 1, offset: 1 }, [...C.api].reverse()),
  rpc('eth_getTransactionCount', [addr, 'latest']),
  rpc('eth_getBalance', [addr, 'latest']),
  explorer({ action: 'txlist', address: addr, sort: 'desc', page: 1, offset: WINDOW }),
  explorer({ action: 'tokentx', address: addr, sort: 'desc', page: 1, offset: WINDOW }),
  explorer({ action: 'tokenlist', address: addr }),
]);
if (!ens && info?.ens_domain_name) ens = info.ens_domain_name;
// No balance list (rate limit)? Page Blockscout's v2 token list instead, capped so a spam magnet doesn't take a minute.
let held = held0, heldCapped = false;
if (!held) {
  const items = []; let next = null, pages = 0;
  do {
    const qs = new URLSearchParams({ type: 'ERC-20,ERC-721,ERC-1155', ...(next || {}) }).toString();
    const j = await getJSON(`${C.v2}/addresses/${addr}/tokens?${qs}`);
    if (!Array.isArray(j?.items)) { if (!pages) items.length = 0; break; }
    items.push(...j.items); next = j.next_page_params; pages++;
  } while (next && pages < 3);
  if (pages) {
    held = items.map((i) => ({ contractAddress: i.token?.address_hash, balance: i.value, name: i.token?.name, symbol: i.token?.symbol, type: i.token?.type }));
    heldCapped = !!next;
    const i = notes.indexOf('tokenlist unavailable'); if (i >= 0) notes.splice(i, 1);
    if (heldCapped) notes.push(`balance list rate-limited, read first ${items.length} holdings only`);
  }
}
if (!ens && chain !== 'ethereum') ens = (await getJSON(`${CHAINS.ethereum.v2}/addresses/${addr}`))?.ens_domain_name || null;

// --deep: walk older windows by block range (the API caps page x offset at 10,000).
let txs = txs0;
let windows = txs ? 1 : 0, exhausted = txs != null && txs.length < WINDOW; // exhausted = we reached the first tx
if (txs && !exhausted) {
  const seen = new Set(txs.map((t) => t.hash));
  while (windows < deep) {
    const minBlock = Math.min(...txs.map((t) => +t.blockNumber));
    const older = await explorer({ action: 'txlist', address: addr, sort: 'desc', page: 1, offset: WINDOW, startblock: 0, endblock: minBlock });
    windows++;
    const fresh = (older || []).filter((t) => !seen.has(t.hash));
    fresh.forEach((t) => seen.add(t.hash));
    txs = txs.concat(fresh);
    if (older && older.length < WINDOW) exhausted = true;
    if (!older || exhausted) break;
  }
}
const fullTxHistory = exhausted;
const firstTx = firstArr?.[0] || (fullTxHistory && txs.length ? txs.reduce((a, t) => (+t.timeStamp < +a.timeStamp ? t : a)) : null);

// ---- stats ----
const n = (v) => (v == null || v === '' ? null : Number(v));
const DAY = 864e5, WD = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const iso = (ts) => new Date(ts).toISOString().slice(0, 10);
const eth = (wei) => (wei == null ? null : Number(wei) / 1e18);
const unesc = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');

const stats = {
  wallet: { input, address: addr, ens, chain, is_contract: info?.is_contract ?? null, account_type: info?.proxy_type === 'eip7702' ? `EIP-7702 smart account (${info.implementations?.[0]?.name || 'unknown impl'})` : null },
  lifetime: {
    first_tx: firstTx ? iso(+firstTx.timeStamp * 1000) : null,
    age_years: firstTx ? +(((Date.now() - +firstTx.timeStamp * 1000) / DAY) / 365.25).toFixed(1) : null,
    first_tx_was: firstTx ? (firstTx.from?.toLowerCase() === me ? 'sent' : 'received') + (firstTx.value && firstTx.value !== '0' ? ` ${fmtEth(eth(firstTx.value))} ETH` : '') : null,
    txs_total: n(counters?.transactions_count) ?? (fullTxHistory ? txs.length : null),
    txs_sent: nonce != null ? Number(nonce) : null,
    token_transfers_total: n(counters?.token_transfers_count),
    gas_units_total: n(counters?.gas_usage_count),
    balance_eth: bal != null ? eth(bal) : null,
  },
};

// Tokens held right now (full history, from the balance list).
if (held) {
  const live = held.filter((t) => t.balance && t.balance !== '0');
  const erc20 = live.filter((t) => /20/.test(t.type || 'ERC-20'));
  const nfts = live.filter((t) => /721|1155|404/.test(t.type || ''));
  const urlish = /(https?:|www\.|t\.me|\.(com|io|xyz|org|net|app|fi|finance|site|online|top|gift|vip|cc)\b|claim|visit|reward|airdrop)/i;
  stats.holdings = {
    capped: heldCapped, // true = only the first pages were read, so the counts below are minimums ("N+")
    tokens_held: erc20.length,
    nft_collections_held: nfts.length,
    url_named_tokens_held: live.filter((t) => urlish.test(unesc(t.name) + ' ' + unesc(t.symbol))).length,
  };
} else stats.holdings = null;

// Window of normal txs: behaviour stats from the txs this wallet SENT.
if (txs) {
  const out = txs.filter((t) => t.from?.toLowerCase() === me).sort((a, b) => a.timeStamp - b.timeStamp);
  const fee = (t) => BigInt(t.gasUsed || 0) * BigInt(t.gasPrice || 0);
  const failed = out.filter((t) => t.isError === '1' || t.txreceipt_status === '0');
  const hours = Array(24).fill(0), wdays = Array(7).fill(0), perDay = {};
  for (const t of out) { const d = new Date(+t.timeStamp * 1000); hours[d.getUTCHours()]++; wdays[d.getUTCDay()]++; const k = iso(d); perDay[k] = (perDay[k] || 0) + 1; }
  let gap = null;
  for (let i = 1; i < out.length; i++) { const g = (out[i].timeStamp - out[i - 1].timeStamp) * 1000; if (!gap || g > gap.ms) gap = { ms: g, from: iso(out[i - 1].timeStamp * 1000), to: iso(out[i].timeStamp * 1000) }; }
  const big = out.reduce((m, t) => (BigInt(t.value || 0) > BigInt(m?.value || 0) ? t : m), null);
  const sel = {};
  for (const t of out) { const s = (t.input || '0x').slice(0, 10); const k = s.length < 10 ? 'plain ETH send' : s; sel[k] = (sel[k] || 0) + 1; }
  const topSel = Object.entries(sel).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const names = await methodNames(topSel.map(([s]) => s).filter((s) => s.startsWith('0x')));
  const recDay = Object.entries(perDay).sort((a, b) => b[1] - a[1])[0];
  const maxIdx = (arr) => arr.indexOf(Math.max(...arr));
  stats.window = {
    scope: fullTxHistory ? 'full history' : `latest ${txs.length.toLocaleString('en-US')} txs`,
    from: txs.length ? iso(Math.min(...txs.map((t) => +t.timeStamp)) * 1000) : null,
    to: txs.length ? iso(Math.max(...txs.map((t) => +t.timeStamp)) * 1000) : null,
    txs: txs.length,
    sent: out.length,
    received: txs.filter((t) => t.to?.toLowerCase() === me && t.from?.toLowerCase() !== me).length,
    received_zero_value: txs.filter((t) => t.to?.toLowerCase() === me && t.from?.toLowerCase() !== me && t.value === '0').length,
    self_sends: out.filter((t) => t.to?.toLowerCase() === me).length,
    failed: failed.length,
    failed_pct: out.length ? +((failed.length / out.length) * 100).toFixed(1) : null,
    gas_spent_eth: out.length ? eth(out.reduce((s, t) => s + fee(t), 0n)) : null,
    gas_burned_on_failed_eth: failed.length ? eth(failed.reduce((s, t) => s + fee(t), 0n)) : 0,
    gas_note: chain === 'ethereum' ? null : 'L2 execution fee only (L1 data fee not included)',
    top_methods: topSel.map(([s, c]) => ({ method: names[s] || s, count: c })),
    busiest_hour_utc: out.length ? maxIdx(hours) : null,
    busiest_weekday: out.length ? WD[maxIdx(wdays)] : null,
    active_days: Object.keys(perDay).length,
    record_day: recDay ? { date: recDay[0], txs: recDay[1] } : null,
    longest_gap_days: gap ? +(gap.ms / DAY).toFixed(1) : null,
    longest_gap: gap ? { from: gap.from, to: gap.to } : null,
    biggest_eth_out: big && big.value !== '0' ? { eth: eth(big.value), to: big.to, date: iso(big.timeStamp * 1000) } : null,
    counterparties: new Set(out.map((t) => t.to?.toLowerCase()).filter(Boolean)).size,
  };
} else stats.window = null;

// Window of token transfers.
if (tts) {
  const by = {};
  for (const t of tts) {
    const k = t.contractAddress?.toLowerCase(); if (!k) continue;
    const e = (by[k] ||= { symbol: unesc(t.tokenSymbol) || '?', name: unesc(t.tokenName), n: 0, in: 0, out: 0 });
    e.n++; if (t.to?.toLowerCase() === me) e.in++; if (t.from?.toLowerCase() === me) e.out++;
  }
  const list = Object.entries(by);
  const heldNow = held && !heldCapped ? new Set(held.filter((t) => t.balance && t.balance !== '0').map((t) => t.contractAddress?.toLowerCase())) : null;
  const received = list.filter(([, e]) => e.in > 0);
  stats.tokens = {
    scope: tts.length < WINDOW ? 'full history' : `latest ${tts.length.toLocaleString('en-US')} token transfers`,
    from: tts.length ? iso(Math.min(...tts.map((t) => +t.timeStamp)) * 1000) : null,
    to: tts.length ? iso(Math.max(...tts.map((t) => +t.timeStamp)) * 1000) : null,
    transfers: tts.length,
    transfers_in: tts.filter((t) => t.to?.toLowerCase() === me).length,
    transfers_out: tts.filter((t) => t.from?.toLowerCase() === me).length,
    distinct_tokens: list.length,
    top_tokens: list.sort((a, b) => b[1].n - a[1].n).slice(0, 3).map(([a, e]) => ({ symbol: e.symbol, transfers: e.n, address: a })),
    received_tokens: received.length,
    received_still_held: heldNow ? received.filter(([a]) => heldNow.has(a)).length : null,
    received_now_zero: heldNow ? received.filter(([a]) => !heldNow.has(a)).length : null,
    received_never_sent: received.filter(([, e]) => e.out === 0).length,
  };
} else stats.tokens = null;

const roast = typeof flag('roast') === 'string' ? flag('roast').split('|').map((s) => s.trim()).filter(Boolean).slice(0, 5) : [];
stats.roast = roast;
stats.sources = { explorer: [...used, ...(held && !held0 ? [new URL(C.v2).host + ' v2'] : [])], rpc: nonce != null || bal != null, method_names: 'openchain.xyz', windows_fetched: windows };
stats.notes = [...new Set(notes)];
if (!txs && !tts) stats.notes.push(`no explorer data for ${chain}; only RPC numbers are real here`);
stats.seconds = +((Date.now() - t0) / 1000).toFixed(1);

async function methodNames(sels) {
  const out = {};
  const LOCAL = { '0x095ea7b3': 'approve', '0xa9059cbb': 'transfer', '0x23b872dd': 'transferFrom', '0xac9650d8': 'multicall', '0x5ae401dc': 'multicall', '0x3593564c': 'execute', '0x6a761202': 'execTransaction', '0xd0e30db0': 'deposit', '0x2e1a7d4d': 'withdraw', '0xa22cb465': 'setApprovalForAll' };
  if (sels.length) {
    const j = await getJSON(`https://api.openchain.xyz/signature-database/v1/lookup?function=${sels.join(',')}&filter=true`);
    for (const s of sels) { const nm = j?.result?.function?.[s]?.[0]?.name; out[s] = nm ? nm.split('(')[0] : LOCAL[s] || s; }
    // Uniswap's names don't fit a card. Same meaning, fewer letters.
    for (const s of sels) out[s] = out[s].replace(/SupportingFeeOnTransferTokens$/, ' (fee-on-transfer)').replace(/^swapExact/, 'swap');
  }
  return out;
}
function fmtEth(x) {
  if (x == null) return null;
  if (x === 0) return '0';
  return x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 2 }) : x >= 1 ? x.toFixed(2) : x >= 0.001 ? x.toFixed(4) : x.toPrecision(2);
}

if (flag('json')) { console.log(JSON.stringify(stats, null, 2)); process.exit(0); }

// ---- ASCII card ----
const L = buildLines(stats);
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const W = 64, c = (k, s) => (TTY ? `\x1b[${k}m${s}\x1b[0m` : s), vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - vis(s).length));
const clip = (s, w) => (s.length > w ? s.slice(0, w - 1) + '…' : s);
const box = [`╭${'─'.repeat(W)}╮`];
for (const l of L) {
  if (l.rule) { box.push(`├${'─'.repeat(W)}┤`); if (l.title) box.push(`│ ${pad(c('2', clip(l.title, W - 2)), W - 2)} │`); continue; }
  if (l.head) { box.push(`│ ${pad(c('1', clip(l.head, W - 2)), W - 2)} │`); continue; }
  wrap(l.v, W - 14).forEach((v, i) => box.push(`│ ${pad(c('2', (i ? '' : l.k).padEnd(12)) + v, W - 2)} │`));
}
if (roast.length) { box.push(`├${'─'.repeat(W)}┤`); for (const r of roast) wrap(`» ${r}`, W - 2).forEach((s, i) => box.push(`│ ${pad(c('33', i ? '  ' + s : s), W - 2)} │`)); }
box.push(`╰${'─'.repeat(W)}╯`);
box.push(c('2', `  ${stats.seconds}s · ${[...new Set(stats.sources.explorer.map((x) => x.replace(/ v2$/, '')))].join(' + ') || 'no explorer'}${stats.sources.rpc ? ' + rpc' : ''}${stats.notes.length ? ' · ' + stats.notes.join('; ') : ''}`));
console.log(box.join('\n'));
console.log('\n```json\n' + JSON.stringify(stats) + '\n```');

function wrap(s, w) { const out = []; let cur = ''; for (const word of s.split(' ')) { if (cur && (cur + ' ' + word).length > w) { out.push(cur); cur = word; } else cur = cur ? cur + ' ' + word : word; } if (cur) out.push(cur); return out.map((x) => clip(x, w)); }

// Shared by the ASCII box and the PNG so they never disagree.
function buildLines(s) {
  const nd = 'no data', num = (x) => (x == null ? nd : x.toLocaleString('en-US'));
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '?');
  const lt = s.lifetime, w = s.window, tk = s.tokens, h = s.holdings;
  const out = [
    { head: `/wallet-roast  ${s.wallet.ens || short(s.wallet.address)}` },
    { k: 'chain', v: `${s.wallet.chain} · ${short(s.wallet.address)}` },
    { rule: true, title: 'lifetime' },
    { k: 'first tx', v: lt.first_tx ? `${lt.first_tx} (${lt.age_years.toFixed(1)}y ago) · ${lt.first_tx_was}` : nd },
    { k: 'txs', v: [lt.txs_total != null && `${num(lt.txs_total)} total`, lt.txs_sent != null && `${num(lt.txs_sent)} sent`].filter(Boolean).join(' · ') || nd },
    { k: 'tokens', v: [lt.token_transfers_total != null && `${num(lt.token_transfers_total)} transfers`, h && `${num(h.tokens_held)}${h.capped ? '+' : ''} held now`].filter(Boolean).join(' · ') || nd },
    ...(h && !h.capped ? [{ k: '', v: `${num(h.url_named_tokens_held)}${h.capped ? '+' : ''} of them have a url in the name` }] : []),
    { k: 'balance', v: lt.balance_eth != null ? `${fmtEth(lt.balance_eth)} ETH` : nd },
  ];
  if (w) {
    const g = w.gas_spent_eth;
    out.push(
      { rule: true, title: `${w.scope}${w.scope === 'full history' ? '' : ` · ${w.from} to ${w.to}`}` },
      { k: 'sent', v: `${num(w.sent)} txs on ${num(w.active_days)} days · ${num(w.failed)} failed${w.failed_pct != null ? ` (${w.failed_pct}%)` : ''}` },
      { k: 'top calls', v: w.top_methods.length ? w.top_methods.slice(0, 3).map((m) => `${(m.method.length > 30 ? m.method.slice(0, 29) + '…' : m.method)} ×${m.count.toLocaleString('en-US')}`).join(', ') : nd },
      { k: 'gas', v: g != null ? `${fmtEth(g)} ETH${w.failed ? ` · ${fmtEth(w.gas_burned_on_failed_eth)} on fails` : ''}${w.gas_note ? ' (L2 exec only)' : ''}` : nd },
      { k: 'busiest', v: w.busiest_hour_utc != null ? `${String(w.busiest_hour_utc).padStart(2, '0')}:00 UTC · ${w.busiest_weekday}` : nd },
      { k: 'record day', v: w.record_day ? `${w.record_day.txs.toLocaleString('en-US')} txs on ${w.record_day.date}` : nd },
      { k: 'longest gap', v: w.longest_gap_days != null ? `${w.longest_gap_days}d (${w.longest_gap.from} to ${w.longest_gap.to})` : nd },
      { k: 'biggest out', v: w.biggest_eth_out ? `${fmtEth(w.biggest_eth_out.eth)} ETH to ${short(w.biggest_eth_out.to)} · ${w.biggest_eth_out.date}` : 'no ETH sent' },
      { k: 'inbox', v: `${num(w.received)} txs in · ${num(w.received_zero_value)} with 0 ETH attached` },
    );
  } else out.push({ rule: true, title: 'transactions' }, { k: 'txs', v: nd });
  if (tk) {
    out.push(
      { rule: true, title: `${tk.scope}${tk.scope === 'full history' ? '' : ` · ${tk.from} to ${tk.to}`}` },
      { k: 'touched', v: `${num(tk.distinct_tokens)} tokens · ${num(tk.transfers_in)} in / ${num(tk.transfers_out)} out` },
      { k: 'top tokens', v: tk.top_tokens.length ? tk.top_tokens.map((t) => `${t.symbol.slice(0, 16)} ×${t.transfers.toLocaleString('en-US')}`).join(', ') : nd },
      { k: 'received', v: `${num(tk.received_tokens)} tokens · ${tk.received_still_held != null ? `${num(tk.received_still_held)} still held, ${num(tk.received_now_zero)} at zero` : 'still held: no data'}` },
    );
  } else out.push({ rule: true, title: 'token transfers' }, { k: 'tokens', v: nd });
  return out;
}

// ---- PNG: a comedy-roast poster. The wallet's own blockie is the guest of honour under the spotlight, the
// onchain numbers are the material, Claude's lines are the jokes and the last one is the punchline. ----
const png = flag('png');
if (png) await renderPng(png === true ? 'wallet-roast.png' : png);

// The Ethereum blockie (the identicon Etherscan draws for an address, seeded by the lowercase address).
function blockie(seed) {
  const r = [0, 0, 0, 0];
  for (let i = 0; i < seed.length; i++) r[i % 4] = ((r[i % 4] << 5) - r[i % 4]) + seed.charCodeAt(i);
  const rand = () => { const t = r[0] ^ (r[0] << 11); r[0] = r[1]; r[1] = r[2]; r[2] = r[3]; r[3] = r[3] ^ (r[3] >> 19) ^ t ^ (t >> 8); return (r[3] >>> 0) / ((1 << 31) >>> 0); };
  const color = () => `hsl(${Math.floor(rand() * 360)},${rand() * 60 + 40}%,${(rand() + rand() + rand() + rand()) * 25}%)`;
  const fg = color(), bg = color(), spot = color(), cells = [];
  for (let y = 0; y < 8; y++) { const row = []; for (let x = 0; x < 4; x++) row[x] = Math.floor(rand() * 2.3); cells.push(...row, ...row.slice().reverse()); }
  return cells.map((c) => [bg, fg, spot][c]);
}

async function renderPng(file) {
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]);
  const num = (x) => x.toLocaleString('en-US');
  const keep = (s) => esc(s).replace(/(\S+-\S+)/g, '<span style="white-space:nowrap">$1</span>') // "143.8-day" never splits at the hyphen
    .replace(/(\d[\d,.]*) (ETH|txs?|tokens?)\b/g, '$1&nbsp;$2'); // nor "0.10 ETH" between number and unit
  const sh = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '?');
  const lt = stats.lifetime, w = stats.window, tk = stats.tokens;
  // The material: the most roastable real numbers in plain words. With jokes on the card they carry the numbers,
  // so only the lifetime line stays. Window numbers always say their window.
  const facts = [];
  if (lt.txs_total != null && lt.first_tx) facts.push(`${num(lt.txs_total)} transactions since ${lt.first_tx.slice(0, 4)}`);
  if (w?.top_methods?.[0]) { const m = w.top_methods[0]; facts.push(`${num(m.count)} × ${m.method.replace(/ \(fee-on-transfer\)$/, '')}`); }
  if (w?.failed) facts.push(`${num(w.failed)} failed${w.gas_burned_on_failed_eth ? `, ${fmtEth(w.gas_burned_on_failed_eth)} ETH of gas burned on them` : ''}`);
  if (w?.record_day) facts.push(`${num(w.record_day.txs)} txs in one day`);
  if (w?.biggest_eth_out) facts.push(`${fmtEth(w.biggest_eth_out.eth)} ETH sent in one go`);
  if (tk?.distinct_tokens) facts.push(`${num(tk.distinct_tokens)} different tokens touched`);
  const scope = w ? (w.scope === 'full history' ? 'Numbers from the full history.' : `Numbers from the ${w.scope}, ${w.from} to ${w.to}.`) : 'Lifetime numbers only.';
  const jokes = roast.slice(0, -1), punch = roast.at(-1);
  const name = stats.wallet.ens || sh(me);
  const nameSize = Math.min(118, Math.floor(1720 / name.length)); // long ENS names shrink to one line instead of splitting mid-word
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const html = `<!doctype html><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Limelight&family=Cormorant+Garamond:ital,wght@0,500;0,700;1,500;1,600&display=block" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0}
  body{width:1200px;height:1500px;overflow:hidden;position:relative;color:#F6EBD9;font-family:'Cormorant Garamond',serif;
    background:radial-gradient(46% 30% at 50% 33%,rgba(255,228,176,.46),rgba(255,228,176,.12) 60%,transparent 76%),
      repeating-linear-gradient(90deg,#33050D 0,#5A0B18 26px,#7C1526 52px,#5A0B18 78px,#33050D 104px),#33050D}
  body::before{content:"";position:absolute;inset:0;background:linear-gradient(to top,rgba(12,1,3,.92),rgba(12,1,3,.55) 30%,transparent 52%),
    radial-gradient(120% 80% at 50% 30%,transparent 50%,rgba(12,1,3,.6))}
  #fit{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:1040px;display:flex;flex-direction:column;align-items:center;text-align:center}
  .of{font:46px/1 'Limelight',serif;letter-spacing:5px;color:#E7B956}
  .name{font:118px/1.02 'Limelight',serif;margin-top:14px;max-width:1040px;overflow-wrap:anywhere;text-shadow:0 5px 0 #1A0306,0 0 46px rgba(231,185,86,.3)}
  .who{font:500 31px/1.2 'Cormorant Garamond',serif;color:#E8CFA5;margin-top:12px}
  .frame{margin-top:38px;padding:16px;background:linear-gradient(135deg,#F6D985,#B5822B 42%,#F8E29A 58%,#94631A);box-shadow:0 34px 60px rgba(10,1,3,.6),inset 0 0 0 2px rgba(255,240,200,.5)}
  .frame>div{padding:12px;background:#140205;line-height:0}
  .material{margin-top:46px;font:700 45px/1.17 'Cormorant Garamond',serif}
  .scope{font:italic 500 27px/1.2 'Cormorant Garamond',serif;color:#D8B98C;margin-top:10px}
  .jokes{margin-top:34px;font:italic 500 41px/1.2 'Cormorant Garamond',serif;color:#F1E2C8;max-width:980px}
  .jokes p{margin:14px 0;text-wrap:balance}
  .punch{margin-top:30px;font:60px/1.08 'Limelight',serif;color:#E7B956;max-width:1000px;text-wrap:balance}
  footer{position:absolute;left:84px;right:84px;bottom:40px;display:flex;justify-content:space-between;font:600 25px 'Cormorant Garamond',serif;color:#C9A878}
</style>
<div id="fit">
  <div class="of">The Roast of</div>
  <div class="name" style="font-size:${nameSize}px">${esc(name)}</div>
  <div class="who">${stats.wallet.ens ? `${esc(sh(me))} on ` : 'on '}${esc(chain[0].toUpperCase() + chain.slice(1))}</div>
  <div class="frame"><div><svg width="256" height="256" viewBox="0 0 8 8" shape-rendering="crispEdges">${blockie(me).map((c, i) => `<rect x="${i % 8}" y="${Math.floor(i / 8)}" width="1" height="1" fill="${c}"/>`).join('')}</svg></div></div>
  <div class="material">${(roast.length ? facts.slice(0, 1) : facts.slice(0, 4)).map((f) => `<div>${esc(f)}</div>`).join('')}</div>
  <div class="scope">${esc(scope)}</div>
  ${jokes.length ? `<div class="jokes">${jokes.map((j) => `<p>“${keep(j)}”</p>`).join('')}</div>` : ''}
  ${punch ? `<div class="punch">${keep(punch)}</div>` : ''}
</div>
<footer><span>/wallet-roast</span><span>onchain data only, ${esc(today)}</span></footer>
<script>addEventListener('load',async()=>{await document.fonts.ready;const f=document.getElementById('fit');if(f.dataset.scale)return;const b=f.getBoundingClientRect();document.title='fit '+Math.min(1,1330/b.height,1080/b.width).toFixed(4);});</script>`;
  // Two passes: measure the poster once fonts are in (headless screenshots don't wait for late JS),
  // then bake the scale into the page so a long roast still fits the 4:5 frame.
  const dir = mkdtempSync(join(tmpdir(), 'roast-'));
  const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const run = (args) => new Promise((res) => { let out = ''; const p = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${dir}/p`, '--virtual-time-budget=15000', '--window-size=1200,1500', ...args, `file://${dir}/c.html`], { stdio: ['ignore', 'pipe', 'ignore'] }); p.stdout.on('data', (d) => (out += d)); p.on('exit', () => res(out)); });
  writeFileSync(join(dir, 'c.html'), html);
  const scale = Number((await run(['--dump-dom'])).match(/<title>fit ([\d.]+)<\/title>/)?.[1]) || 1;
  const baked = html.replace('<div id="fit">', `<div id="fit" data-scale="${scale}" style="transform:translate(-50%,-50%) scale(${scale})">`);
  writeFileSync(join(dir, 'c.html'), baked);
  if (process.env.WALLET_ROAST_HTML) writeFileSync(process.env.WALLET_ROAST_HTML, baked); // keep the page for design tweaks
  await run([`--screenshot=${file}`]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`card → ${file}`);
}
