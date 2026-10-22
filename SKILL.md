---
name: wallet-roast
description: Roast any EVM wallet from its real onchain history and render a shareable roast poster. Use when the user pastes a wallet address or ENS name and asks to roast it, "wallet-roast <address>", "/wallet-roast", or "roast my wallet".
---

# /wallet-roast

1. Take the wallet from the user's message: a `0x…` address or an ENS name (`name.eth`). If they named a chain, pass `--chain ethereum` or `--chain base` (default ethereum). Solana isn't supported yet: say so.
2. Run it once to get the stats:

   ```bash
   node "${CLAUDE_SKILL_DIR}/wallet-roast.mjs" <wallet> [--chain base]
   ```

   It prints a stats card and a JSON block. A big wallet takes 10–20s.
3. Write the roast: **3 to 5 short lines**, savage but good-natured, like a friend reading your bank statement out loud.
   - Roast only what the numbers show: failed txs, gas burned, approvals, the spam tokens they're still holding, the 3am record day, the 101-day ghosting, the token they touched 7,000 times. Quote the real number in most lines.
   - A field that says "no data" doesn't exist. Don't joke about it as if it were zero.
   - The tx/token sections cover the window the card names (e.g. "latest 10,000 txs · 2025-03-13 to 2026-10-18"). Don't call a window number "all time".
   - Never mention prices, USD values, price targets, or whether to buy or sell anything. ETH amounts on the card are fine.
   - Never punch at the person: no jokes about identity, looks, age, nationality, wealth or who they are. It's the wallet's behaviour that's on trial.
   - Funny beats mean. Dry beats loud. Keep each line under ~90 characters so it fits the poster. The last line is the punchline, printed biggest, so make it the best.
4. Render the card with the roast on it:

   ```bash
   node "${CLAUDE_SKILL_DIR}/wallet-roast.mjs" <wallet> [--chain base] --png wallet-roast.png --roast "line 1|line 2|line 3"
   ```

   Separate lines with `|`, and don't use `|` inside a line. Then show the ASCII card, the roast lines, and the PNG path.

Use `--json` when you only need the numbers. `--deep N` walks N windows of 10,000 txs back for wallets with huge histories (slower, uses more of the free API quota).

Data: Blockscout's keyless explorer API (txs, token transfers, token balances, counters), Routescan as Ethereum fallback, the chain's public RPC (nonce, balance), openchain.xyz for method names. No API keys. If a source is down or rate-limited the card says "no data" and the footer says why; never fill the gap with a guess.
