# Solami track submission notes

Track: "Build something live on Solana data" (Superteam Earn, Solami). Deadline 13 Oct 2026.

## Links
- Repo (public, MIT): https://github.com/vam-luffy/program-pulse
- Demo video (2-3 min, live mainnet): (to add)
- Author: Vamshith S Bangera, GitHub vam-luffy, X @vamshith_ban, Telegram @Monkey_D_Luffy3898

## Project name
Program Pulse

## Description
Program Pulse is a live monitor for any Solana program. Give it one or more program IDs and it streams every transaction touching them through Solami's Yellowstone gRPC firehose with a server-side filter, then shows transactions per minute, success and error rate, unique signers, top instructions decoded from the program's IDL, compute units and fees, and stream lag against the chain tip. It fires Telegram alerts when the error rate spikes, when a program goes silent, or when traffic surges, and it resolves them when things recover. Built for builders who ship a program and want to know within seconds when it misbehaves, without running an indexer.

## How Solami is used
- Yellowstone gRPC (grpc.solami.dev): primary data path, server-side transaction filter on the watched program IDs plus a slots filter, slot replay from the last seen slot on reconnect with signature dedupe, exponential reconnect backoff.
- RPC (rpc.solami.dev): getSlot for stream lag and replay start, getSignaturesForAddress and getTransactionsForAddress for the polling fallback.
- Fallback chain gRPC -> Mirage -> WebSocket logsSubscribe -> RPC polling, each logged, with automatic retry of gRPC every 5 minutes so a plan upgrade switches the data path without a restart.
- `npm run probe` reports which Solami endpoints the configured key can reach.

## Metrics surfaced
tx/min, ok/failed counts, error rate (5m and 1h), unique signers (1h), top instructions, average compute units, average fee, last-seen slot, stream lag in slots and seconds, source health, recent alerts.

## Run it
```
npm install
npm run dev:replay          # no key: replays recorded mainnet traffic, alerts fire with --chaos
npm run dev                 # live: SOLAMI_API_KEY, PROGRAM_IDS, TELEGRAM_* in .env
npm run build && npm start  # single process on :8787
```

## Anything else
41 unit tests, ESLint and TypeScript checks, Dockerfile and compose, CI workflow. Default demo programs are Jupiter v6 and Pump.fun; any program ID works, and IDLs dropped into `idls/` decode instruction names.
