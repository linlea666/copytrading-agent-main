# Copy Trading Agent

Automated copy trading agent that mirrors leader accounts' positions onto your own wallets with configurable risk controls. The agent listens for the leader's fills, derives target exposure per market, and places IOC limit orders to sync the follower account while enforcing leverage, notional, and slippage caps.

**v2.0 New Features:**
- 🔥 **Multi-pair support**: Copy trade multiple leaders with independent followers
- 📊 **Proportional copy trading**: Copy based on leader's leverage ratio, not absolute position size
- 🛡️ **Historical position detection**: Don't copy pre-existing positions at startup
- ⚡ **Batch fill handling**: Efficiently handle rapid/quantitative trading patterns
- 💾 **State persistence**: Survive restarts without losing historical position tracking

## Disclaimer

This code is not audited and is provided as is. Use at your own risk.

## Live Vaults on Hyperliquid, For Non-Technical Users

Please deposit at your own risk, we only copytrade other users, no gurantees on their performance. We have max leverage limit at 10x to avoid getting liquidated. Following vaults are copytrading: [AlphaArena Agents by Nof1.ai](https://nof1.ai).

Portal: [SigmaArena](https://sigmaarena.com)

- **DeepSeek V3.1**: [Deposit Into Vault](https://app.hyperliquid.xyz/vaults/0x250ca707028959f86c92e410235856622d27306f) | [Live Logs](https://userapi-compute.eigencloud.xyz/logs/0x4418BA3C4a1E52BBd8f1133fA136CCED3807c6f9) | [Portfolio Dashboard](https://www.coinglass.com/hyperliquid/0x250ca707028959f86c92e410235856622d27306f)
- **Qwen3 Max**: [Deposit Into Vault](https://app.hyperliquid.xyz/vaults/0x391d287ddf3ec911de7e211b4b33364361e194b9) | [Live Logs](https://userapi-compute.eigencloud.xyz/logs/0xfFE88cADD07B343C79d8e617853A1e140c695860) | [Portfolio Dashboard](https://www.coinglass.com/hyperliquid/0x391d287ddf3ec911de7e211b4b33364361e194b9)
- **Grok 4**: [Deposit Into Vault](https://app.hyperliquid.xyz/vaults/0xd3e4cd447dc6657716b56ac11f38825fa8cd60ac) | [Live Logs](https://userapi-compute.eigencloud.xyz/logs/0x9abb8630488a02Ec3410C26785f661fa49218140) | [Portfolio Dashboard](https://www.coinglass.com/hyperliquid/0xd3e4cd447dc6657716b56ac11f38825fa8cd60ac)
- **Inverse GPT-5**: [Deposit Into Vault](https://app.hyperliquid.xyz/vaults/0xba75577c834ed2abacc71ff9d0c18f30e9c34517) | [Live Logs](https://userapi-compute.eigencloud.xyz/logs/0x0feaA0eb6004972CFAA5Ce99cBa705D283525f95) | [Portfolio Dashboard](https://www.coinglass.com/hyperliquid/0xba75577c834ed2abacc71ff9d0c18f30e9c34517)
- **Inverse Gemini 2.5 Pro**: [Deposit Into Vault](https://app.hyperliquid.xyz/vaults/0x4f1a910a1f4396043fced901b5f97e47544bb6c1) | [Live Logs](https://userapi-compute.eigencloud.xyz/logs/0xfeC9Ac284FC46e5e67E69430889B7AAF5BF47C7e) | [Portfolio Dashboard](https://www.coinglass.com/hyperliquid/0x4f1a910a1f4396043fced901b5f97e47544bb6c1)

## Supported Exchanges

- [x] **Hyperliquid** — Full support (WebSocket + HTTP API)
- [ ] **Lighter** — Planned
- [ ] **Aster** — Planned

## System Flow

![Copytrading Agent Flow](./docs/Flowchart.png)

## Features
- WebSocket subscription to leader fills with automatic reconnection.
- Periodic reconciliation against on-chain `clearinghouseState` snapshots.
- Risk-aware position sizing via copy ratio, leverage, notional, and slippage limits.
- Shared state engine for leader/follower positions and account metrics.
- Optional vault routing: point the follower at a vault and orders will append the vault address automatically.
- TypeScript codebase with typed Hyperliquid SDK integration.

## Setup

### Multi-Pair Mode (Recommended)

For copying multiple leaders or advanced configurations:

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create your configuration file:
   ```bash
   cp config/pairs.example.json config/pairs.json
   ```

3. Edit `config/pairs.json` to configure your leader-follower pairs:
   ```json
   {
     "environment": "mainnet",
     "reconciliationIntervalMs": 60000,
     "refreshAccountIntervalMs": 5000,
     "stateDir": "./data/state",
     "pairs": [
       {
         "id": "smart-whale-1",
         "leaderAddress": "0x...",
         "followerPrivateKey": "${FOLLOWER_1_PRIVATE_KEY}",
         "risk": {
           "copyRatio": 1.0,
           "maxLeverage": 10,
           "maxNotionalUsd": 50000,
           "maxSlippageBps": 25,
           "inverse": false
         },
         "minOrderNotionalUsd": 15,
         "syncDebounceMs": 300,
         "enabled": true
       }
     ]
   }
   ```

4. Set environment variables for private keys:
   ```bash
   export FOLLOWER_1_PRIVATE_KEY=0x...
   export FOLLOWER_2_PRIVATE_KEY=0x...  # if you have multiple pairs
   ```

5. Build and run:
   ```bash
   npm run build
   npm start
   ```

#### Configuration Options

| Field | Description | Default |
|-------|-------------|---------|
| `copyRatio` | Position size multiplier (1.0=100%, 0.5=50%, 2.0=200%) | 1.0 |
| `maxLeverage` | Maximum leverage cap for follower | 10 |
| `maxNotionalUsd` | Maximum position value in USD | 250000 |
| `maxSlippageBps` | Maximum slippage in basis points | 25 |
| `minOrderNotionalUsd` | Minimum order value (skip smaller orders) | 15 |
| `syncDebounceMs` | Debounce delay for batch fills (ms) | 300 |
| `inverse` | Invert copy direction (long↔short) | false |

#### How Proportional Copy Trading Works

The copy ratio works on **leverage basis**, not absolute position size:

```
Your Position = (Leader's Leverage × Copy Ratio) × Your Equity

Example:
- Leader equity: $10,000, opens $1,000 position → 10% leverage
- Your equity: $1,000, copyRatio: 1.0
- Your position: 10% × $1,000 = $100 (same leverage ratio)
```

This ensures your risk exposure matches the leader proportionally.

#### Historical Position Handling

The agent tracks positions that existed before you started copying:

- **Startup**: Records all leader's current positions as "historical"
- **Historical positions**: Won't copy add/reduce/close operations
- **Position closes**: Once historical position fully closes, that coin becomes copyable
- **Direction flip**: If leader flips direction (long→short), treated as new position

State is persisted in `data/state/{pair-id}.json` to survive restarts.

### Single-Pair Mode (Legacy)

For simple single-pair setups using environment variables:

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the sample environment and fill in your keys:
   ```bash
   cp examples/.env.example .env
   ```
   - `LEADER_ADDRESS`: wallet you want to mirror.
   - `FOLLOWER_PRIVATE_KEY`: private key for your follower API wallet.
   - `FOLLOWER_VAULT_ADDRESS` (optional): set if your follower trades through a vault instead of the base account.
   - Adjust risk knobs (`COPY_RATIO`, `MAX_LEVERAGE`, etc.) as needed.
   - Set `INVERSE=true` to inverse copytrade (leader long → follower short, and vice versa).
3. Build the project:
   ```bash
   npm run build
   ```
4. Run the daemon:
   ```bash
   npm start
   ```
   For quick iteration you can use `npm run dev`, which runs the TypeScript entrypoint directly via `ts-node`.

> **Note**: If `config/pairs.json` exists, multi-pair mode takes precedence over environment variables.

## Docker

Build the image and run with a bind-mounted `.env` file:

```bash
docker build -t copytrading-agent .
docker run --rm \
  --name copytrading-agent \
  -v $(pwd)/.env:/app/.env:ro \
  copytrading-agent
```

Alternatively, set envs via `--env-file` (dotenv in the app also loads .env if present):

```bash
docker run --rm \
  --env-file ./.env \
  copytrading-agent
```

## Deployment to EigenCloud

EigenCloud (via EigenX CLI) allows deploying this trading agent in a Trusted Execution Environment (TEE) with secure key management.

### Prerequisites
- Allowlisted Ethereum account (Sepolia for testnet). Request onboarding at [EigenCloud Onboarding](https://onboarding.eigencloud.xyz).
- Docker installed.
- Sepolia ETH for deployments.

### Installation
#### macOS/Linux
```bash
curl -fsSL https://eigenx-scripts.s3.us-east-1.amazonaws.com/install-eigenx.sh | bash
```

#### Windows
```bash
curl -fsSL https://eigenx-scripts.s3.us-east-1.amazonaws.com/install-eigenx.ps1 | powershell -
```

### Initial Setup
```bash
docker login
eigenx auth login  # Or eigenx auth generate --store (if you don't have a eth account, keep this account separate from your trading account)
```

### Deploy the Agent
From the project directory:
```bash
cp .env.example .env
# Edit .env: set LEADER, etc
eigenx app deploy
```

### Monitoring
```bash
eigenx app info --watch
eigenx app logs --watch
```

### Updates
Edit code or .env, then:
```bash
eigenx app upgrade <app-name>
```

For full CLI reference, see the [EigenX Documentation](https://github.com/Layr-Labs/eigenx-cli).

## Testing
- No automated tests are bundled yet. Add your own checks or dry-run on Hyperliquid testnet before risking capital.

## Project Layout
- `src/index.ts` — entrypoint with auto-detection of multi-pair or single-pair mode.
- `src/config` — environment loading, JSON config parsing, and risk configuration.
- `src/core` — multi-pair orchestrator and instance management.
  - `orchestrator.ts` — manages multiple copy trading instances.
  - `copyTradingInstance.ts` — encapsulates a single leader-follower pair.
- `src/clients` — Hyperliquid SDK client/transport factories.
- `src/domain` — shared trader state logic plus leader/follower specializations.
  - `historyTracker.ts` — tracks historical positions that shouldn't be copied.
  - `statePersistence.ts` — persists state to JSON files for restart recovery.
- `src/services` — subscriptions, market metadata, reconciler, and order executor.
  - `debouncedSync.ts` — handles batch fill events efficiently.
- `config/pairs.example.json` — reference multi-pair configuration.
- `examples/.env.example` — reference environment variables for single-pair mode.
- `data/state/` — persistent state files for each pair (auto-generated).

## Notes
- The repo uses ESM modules (`"type": "module"`); Node 20+ is recommended.
- Network access and trading actions happen against the URLs defined in the Hyperliquid SDK transports. Set `HYPERLIQUID_ENVIRONMENT=testnet` to dry-run safely.