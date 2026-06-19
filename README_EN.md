# Meteora DLMM LP Automation Bot (lp_bot)

This project is a liquidity management automation bot specifically designed for the **Meteora DLMM (Dynamic Liquidity Market Maker)** protocol in the Solana ecosystem. It automatically adjusts, establishes, and monitors trading positions based on the current market price (Active Bin), enabling an efficient automated market-making strategy.

## Key Features

*   **Automatic Position Opening & Rebalancing**: Automatically calculates and establishes buy or sell positions based on the current Active Bin.
*   **Bidirectional Strategy Switching**: When a buy position is fully filled, the bot automatically switches to a sell strategy; and vice versa.
*   **Dynamic Price Monitoring**: Real-time pool price monitoring. If the price deviates far from the position range without being filled, the bot automatically removes liquidity and re-establishes the position near the current price (Rebuild).
*   **Multi-Pool Management**: Supports monitoring and trading on multiple pools configured in `config.json` simultaneously.
*   **REST API Interface**: Built-in Express server providing APIs for querying positions, manual rebalancing, creating new positions, and one-click liquidation.
*   **Impermanent Loss Mitigation**: Auto stop-loss on sharp crashes (removes liquidity + swaps token back to SOL) and volatility entry filter (blocks new positions during market crashes to avoid catching falling knives).
*   **Performance Optimization**: Significantly reduces RPC request overhead and response latency by caching Pool instances and only refreshing state via `refetchStates()`.

## Core Files

*   [`lp_bot.ts`](lp_bot.ts): Main bot entry point, contains the core monitoring loop logic.
*   [`dlmm_func.ts`](dlmm_func.ts): Wrapper around the Meteora DLMM SDK, includes position creation, liquidation, earnings calculation, kline analysis, and swap functions.
*   [`server.ts`](server.ts): Express-based management backend API.
*   [`run.sh`](run.sh): Shell script for convenient bot startup.

## Quick Start

### 1. Environment Setup

Ensure [Node.js](https://nodejs.org/) (v16+) and npm are installed.

### 2. Install Dependencies

In the project root directory, run:

```bash
npm install
```

### 3. Configuration

1.  **Wallet Setup**:
    Create `wallet.json` (or `wallet_test.json`) in the root directory with your Solana private key as a byte array.

2.  **Bot Configuration**:
    Copy `config.json.example` to `config.json` and edit as needed:

    ```json
    {
        "solana_url": "Your Solana RPC node URL",
        "pool_list": [
            {
                "pool_addr": "Pool contract address",
                "action": "buy",       // Initial action: 'buy' or 'sell'
                "upper_bin": 69,       // Position span in bins
                "stopbin": 69,         // Profit-taking / fill threshold (bins)
                "rebuild": 10,         // How many bins to drift before triggering rebuild
                "pool_size": 3.5,      // Position size (SOL)
                "stop_loss_pct": 0.05, // (Optional) Crash stop-loss threshold: exit if price drops >5% per cycle (~3min), default 0.05
                "vol_filter_pct": 0.03 // (Optional) Volatility filter: block new entries if price drops >3% per cycle, default 0.03
            }
        ]
    }
    ```

    > **Impermanent Loss Protection**: `stop_loss_pct` and `vol_filter_pct` are triggered based on price drop percentage within a single monitoring cycle (~2.5–3.5 minutes). Set thresholds above the pool's normal trading velocity to avoid false stops. Both keys are optional; defaults apply if omitted. When `stop_loss_pct` fires, the bot removes liquidity and swaps the freed token back to SOL through the same pool. When `vol_filter_pct` triggers, it prevents re-entry while the market is still crashing (avoiding catching falling knives).

### 4. Run the Bot

Using the provided script:

```bash
bash run.sh
```

Or directly:

```bash
npx ts-node lp_bot.ts
```

### 5. Start the API Server (Optional)

To manage positions remotely via API:

```bash
npx ts-node server.ts
```

Default runs on `http://localhost:3000`.

## API Reference (server.ts)

*   `GET /getPositions`: Get current position snapshot and wallet balance.
*   `POST /rebalance`: Manually rebalance positions within a specified price range.
*   `POST /createNewPosition`: Create a new position in a specified pool.
*   `POST /closePoolAndTradeALlSol`: Exit all liquidity from a pool and attempt to convert to SOL.

## Important Notes & Risk Disclaimer

1.  **Private Key Security**: Keep `wallet.json` secure and never commit it to public repositories.
2.  **Network Quality**: Solana transaction success is highly dependent on RPC node quality. Use a private, high-quality RPC for stable bot operation.
3.  **Impermanent Loss (IL)**: As a liquidity provider, you should understand Meteora DLMM mechanics. This bot does not guarantee profits; sharp market swings can result in losses despite IL mitigation features.
4.  **Testing Recommended**: Before deploying significant capital, test on Devnet or use small amounts on Mainnet first.

## Disclaimer

This project is provided for learning, research, and technical exchange purposes only. It does not constitute investment advice. Users assume all risks and losses arising from use of this project.
