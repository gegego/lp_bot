# Meteora DLMM LP 自动化机器人 (lp_bot)

本项目是一个专门针对 Solana 生态中 **Meteora DLMM (Dynamic Liquidity Market Maker)** 协议开发的流动性提供 (LP) 自动化管理机器人。它能够根据当前市场价格（Active Bin）自动调整、建立和监控交易仓位，实现高效的自动化做市策略。

## 主要功能

*   **自动建仓与调仓**：根据当前 Active Bin 自动计算并建立买入（Buy）或卖出（Sell）仓位。
*   **双向策略切换**：当买入仓位被完全填满后，机器人可自动切换为卖出策略；反之亦然。
*   **动态价格监控**：实时监控池子价格，如果价格偏离仓位过远且未成交，机器人会自动撤资并重新在当前价附近建仓（Rebuild）。
*   **多池子管理**：支持在 `config.json` 中配置多个池子同时进行监控和交易。
*   **REST API 接口**：内置 Express 服务器，提供查询持仓、手动再平衡、创建新仓位和一键清仓的 API 接口。
*   **性能优化**：通过缓存 Pool 实例并仅刷新状态（refetchStates），显著降低 RPC 请求开销和响应延迟。

## 核心文件说明

*   [`lp_bot.ts`](lp_bot.ts): 机器人的主入口，包含核心监控循环逻辑。
*   [`dlmm_func.ts`](dlmm_func.ts): 对 Meteora DLMM SDK 的封装，包含建仓、撤资、收益计算、K线分析等功能函数。
*   [`server.ts`](server.ts): 基于 Express 的管理后台 API。
*   [`run.sh`](run.sh): 方便启动机器人的 Shell 脚本。

## 快速开始

### 1. 环境准备

确保您的环境中已安装 [Node.js](https://nodejs.org/) (推荐 v16 以上版本) 和 npm。

### 2. 安装依赖

在项目根目录下运行：

```bash
npm install
```

### 3. 配置

1.  **钱包配置**：
    在根目录下创建 `wallet.json`（或 `wallet_test.json`），内容为你的 Solana 私钥数组（[byte array] 格式）。

2.  **机器人配置**：
    将 `config.json.example` 重命名为 `config.json` 并根据需要修改：

    ```json
    {
        "solana_url": "你的 Solana RPC 节点地址",
        "pool_list": [
            {
                "pool_addr": "池子合约地址",
                "action": "buy",       // 初始动作：'buy' 或 'sell'
                "upper_bin": 69,      // 仓位的 bin 跨度
                "stopbin": 69,        // 止盈/成交判定阈值 (bin 数量)
                "rebuild": 10,        // 偏离多少 bin 后触发重新建仓
                "pool_size": 3.5      // 建仓金额 (SOL)
            }
        ]
    }
    ```

### 4. 运行机器人

使用脚本启动：

```bash
bash run.sh
```

或者直接运行：

```bash
npx ts-node lp_bot.ts
```

### 5. 启动 API 服务器（可选）

如果你需要通过 API 远程管理，可以运行：

```bash
npx ts-node server.ts
```
默认运行在 `http://localhost:3000`。

## API 接口参考 (server.ts)

*   `GET /getPositions`: 获取当前持仓快照及钱包余额。
*   `POST /rebalance`: 根据指定的价格区间手动再平衡仓位。
*   `POST /createNewPosition`: 在指定池子创建新仓位。
*   `POST /closePoolAndTradeALlSol`: 撤出指定池子的所有流动性并尝试全部兑换为 SOL。

## 注意事项与风险提示

1.  **私钥安全**：请务必妥善保管你的 `wallet.json` 文件，切勿上传到公共代码库。
2.  **网络延迟**：Solana 链上交易受 RPC 节点质量影响很大，建议使用私有高质量 RPC 以保证机器人运行稳定。
3.  **无常损失 (IL)**：作为流动性提供者，您需要了解 Meteora DLMM 的工作原理，本项目不保证盈利，市场剧烈波动时可能存在亏损风险。
4.  **测试建议**：在正式投入大额资金前，建议先在 Devnet 或使用小额资金在 Mainnet 测试。

## 免责声明

本项目仅供学习研究和技术交流使用，不构成任何投资建议。用户因使用本项目所产生的任何损失或风险由用户自行承担。
