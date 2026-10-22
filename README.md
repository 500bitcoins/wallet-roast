# /wallet-roast

A Claude Code skill. Paste any wallet and Claude roasts it, using nothing but what the chain says it did. You get the stats in your terminal and a roast poster PNG you can post: "The Roast of <wallet>", with the wallet's own blockie as the guest of honour.

```
╭────────────────────────────────────────────────────────────────╮
│ /wallet-roast  vitalik.eth                                     │
│ chain       ethereum · 0xd8dA…6045                             │
├────────────────────────────────────────────────────────────────┤
│ lifetime                                                       │
│ first tx    2015-09-28 (11.1y ago) · received 0.2500 ETH       │
│ txs         78,388 total · 5,969 sent                          │
│ tokens      403,700 transfers · 6,977 held now                 │
│             139 of them have a url in the name                 │
│ balance     5.77 ETH                                           │
├────────────────────────────────────────────────────────────────┤
│ latest 10,000 txs · 2025-03-13 to 2026-10-18                   │
│ sent        4,442 txs on 95 days · 156 failed (3.5%)           │
│ top calls   approve ×2,156, swapTokensForETH (fee-on-tran…     │
│             ×2,014, multicall ×78                              │
│ gas         0.7314 ETH · 0.0190 on fails                       │
│ busiest     12:00 UTC · Thursdays                              │
│ record day  1,880 txs on 2026-04-30                            │
│ longest gap 35.1d (2026-08-21 to 2026-09-25)                   │
│ biggest out 1,006 ETH to 0x3c77…41ab · 2025-11-26              │
│ inbox       5,558 txs in · 4,393 with 0 ETH attached           │
├────────────────────────────────────────────────────────────────┤
│ latest 10,000 token transfers · 2026-05-11 to 2026-10-19       │
│ touched     865 tokens · 2,499 in / 7,511 out                  │
│ top tokens  AsteroShib.com ×7,306, CMD ×685, ALPHA ×308        │
│ received    855 tokens · 829 still held, 26 at zero            │
╰────────────────────────────────────────────────────────────────╯
  17.5s · eth.blockscout.com + rpc
```

- One file, zero dependencies, Node 18+.
- No API keys. Data comes from Blockscout's public explorer API (transactions, token transfers, token balances, lifetime counters), Routescan as the Ethereum fallback, the chain's public RPC (nonce, balance) and openchain.xyz (contract method names).
- Real numbers only. Anything a source didn't return prints `no data`, and the footer says which source failed and why.
- Claude writes the roast in your session from the stats: 3 to 5 lines, about the wallet's behaviour, never about the person, never about prices.
- `--png` renders the roast poster with headless Chrome.

## Install

Copy this folder to `~/.claude/skills/wallet-roast`, then in Claude Code type `/wallet-roast vitalik.eth`, or paste an address and say "roast this wallet".

## Run it without Claude Code

```bash
node wallet-roast.mjs <0x address | name.eth> [--chain ethereum|base] [--json]
node wallet-roast.mjs <wallet> --png card.png --roast "line one|line two|line three"
```

| flag | what it does |
|---|---|
| `--chain` | `ethereum` (default) or `base` |
| `--json` | just the numbers |
| `--png file` | render the poster (set `CHROME_BIN` if Chrome isn't in the default macOS location) |
| `--roast "a\|b\|c"` | put up to 5 roast lines on the poster; the last one is the punchline, printed biggest |
| `--deep N` | walk N windows of 10,000 txs back instead of 1 (slower, uses more free quota) |

## What's on the card

The terminal card has every number below. The poster keeps it short: the wallet's name and blockie, its lifetime transaction count, which window the jokes' numbers come from, the roast lines and the punchline (with no roast lines it shows the four most roastable numbers instead).

**Lifetime (whole history):** first transaction and wallet age, total txs and txs sent, total token transfers, tokens held right now (and how many of them have a url for a name, the classic airdrop-spam tell), ETH balance.

**Latest window of txs** (the full history for most wallets; the latest 10,000 for whales, with the dates printed): txs sent and on how many days, failed txs, the contract methods it calls most, gas paid and gas burned on failures, busiest hour and weekday, record day, longest gap between sends, biggest single ETH send, how much of the inbox is 0-ETH junk.

**Latest window of token transfers:** distinct tokens touched, the three it moved most, how many tokens it received and whether it still holds them.

## Limits (v0)

- **Chains:** Ethereum works. Base uses `base.blockscout.com`, which sits behind a Cloudflare bot check from some networks; when that happens the Base card only has what the public RPC gives (txs sent, balance) and says so.
- **Solana:** next version.
- **Rate limit:** Blockscout's keyless `/api` allows about 10 calls an hour per IP, and a run uses 3. After that, txs fall back to Routescan (slower) and token holdings fall back to the first 150 from Blockscout's v2 list (printed as `150+`).
- **Whales:** wallets with more than 10,000 txs or token transfers are analysed over the latest 10,000 (`--deep` for more txs). A run on vitalik.eth takes 10–20s.
- **Gas on Base** is the L2 execution fee only (no L1 data fee).
- No USD values and no prices anywhere, on purpose.

## License

MIT
