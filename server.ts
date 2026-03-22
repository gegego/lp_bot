import express, { Request, Response } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import {getMyPoolAddresses, loadWallet, rebalance, closePoorAndTradeALlSol, totally_newposition, snapshot_pool, getBinFromPrice } from './dlmm_func';


const app = express();
const port = 3000;
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const wallet = loadWallet('./wallet_test.json'); // 替换为你的私钥文件路径

app.use(express.json());

class PoolManager {
    private static cache: Map<string, DLMM> = new Map();

    static async getPool(poolAddress: string): Promise<DLMM> {
        if (!this.cache.has(poolAddress)) {
            console.log(`[PoolManager] 正在创建新实例: ${poolAddress}`);
            const pool = await DLMM.create(connection, new PublicKey(poolAddress));
            this.cache.set(poolAddress, pool);
        }
        
        const pool = this.cache.get(poolAddress)!;
        // 关键优化：每次请求只刷新状态，不重建对象
        await pool.refetchStates();
        return pool;
    }
}

// 1. closePoolAndTradeALlSol
app.post('/closePoolAndTradeALlSol', async (req: Request, res: Response) => {
    console.log('Received request: closePoolAndTradeALlSol');
    // Placeholder logic
    const { poolAddress } = req.body;
    const dlmmPool = await PoolManager.getPool(poolAddress);
    await closePoorAndTradeALlSol(wallet, connection, dlmmPool);
    res.json({
        success: true,
        message: `Pool ${poolAddress} closed and traded to SOL`,
        timestamp: new Date().toISOString()
    });
});

// 2. rebalance
app.post('/rebalance',async (req: Request, res: Response) => {
    console.log('Received request: rebalance');
    // Placeholder logic
    const { poolAddress, minprice, maxprice } = req.body;
    const dlmmPool = await PoolManager.getPool(poolAddress);
    const minBinId = dlmmPool.getBinIdFromPrice(Number(dlmmPool.toPricePerLamport(minprice)), false);
    const maxBinId = dlmmPool.getBinIdFromPrice(Number(dlmmPool.toPricePerLamport(maxprice)), true);
    await rebalance(wallet, connection, dlmmPool, minBinId, maxBinId);
    res.json({
        success: true,
        message: `Position ${poolAddress} rebalanced to ${minprice} to ${maxprice}`,
        timestamp: new Date().toISOString()
    });
});

// 3. getPositions
app.get('/getPositions', async (req: Request, res: Response) => {
    console.log('Received request: getPositions');
    // Placeholder logic
    let poollist = await getMyPoolAddresses(connection,wallet);
    let ret = {}
    if(poollist.length === 0){
        ret = {}
    }
    else{
        console.log('test')
        let pool_addr = poollist[0]
        const dlmmPool = await PoolManager.getPool(pool_addr);
        ret = await snapshot_pool(dlmmPool, wallet);
    }
    const sol_wallet = await connection.getBalance(wallet.publicKey);
    ret['sol_in_wallet'] = sol_wallet/1e9;

    res.json({
        success: true,
        positions: [
            ret
        ],
        timestamp: new Date().toISOString()
    });
});

// 4. createNewPosition
app.post('/createNewPosition',async (req: Request, res: Response) => {
    console.log('Received request: createNewPosition');
    // Placeholder logic
    const { poolAddress, amount, minprice, maxprice } = req.body;
    const dlmmPool = await PoolManager.getPool(poolAddress);
    const minBinId = dlmmPool.getBinIdFromPrice(Number(dlmmPool.toPricePerLamport(minprice)), false);
    const maxBinId = dlmmPool.getBinIdFromPrice(Number(dlmmPool.toPricePerLamport(maxprice)), true);
    await totally_newposition(wallet, connection, dlmmPool, amount, minBinId, maxBinId);
    res.json({
        success: true,
        message: `New position created for ${poolAddress} with amount ${amount}`,
        positionId: 'new-pos-' + Math.floor(Math.random() * 1000),
        timestamp: new Date().toISOString()
    });
});

const server = app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});

// 封装一个优雅退出的函数
const gracefulShutdown = () => {
  console.log('收到关闭信号，正在处理后续工作...');
  
  // 1. 停止接收新的 HTTP 请求
  server.close(async () => {
    console.log('HTTP 服务器已关闭。');
    
    // 2. 这里处理你的交易逻辑后续
    // 例如：await cancelAllOrders(); 
    // 例如：await redis.quit();
    
    console.log('清理完毕，进程退出。');
    process.exit(0);
  });

  // 如果 10 秒内没关掉，强制退出
  setTimeout(() => {
    console.error('强制退出：清理超时');
    process.exit(1);
  }, 10000);
};

// 监听两种常见的退出信号
process.on('SIGTERM', gracefulShutdown); // 由 kill 命令触发
process.on('SIGINT', gracefulShutdown);  // 由 Ctrl+C 触发