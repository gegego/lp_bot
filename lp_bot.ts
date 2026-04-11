const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const fs = require("fs");
const {loadConfig, loadWallet, createPosition_token, createPosition_sol, removeLiquidity_single, snapshot_position, get_wallet_token_balance, snapshot_pool} = require("./dlmm_func");
import DLMM from '@meteora-ag/dlmm';
const util = require('util');

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 在 min 和 max 秒之间随机休眠
 */
async function randomSleep(min: number, max: number) {
    const ms = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
    console.log(`💤 随机休眠 ${ms / 1000} 秒...`);
    await sleep(ms);
}


const config_lp = loadConfig('./config.json')
console.log(config_lp)
const connection = new Connection(config_lp["solana_url"], {commitment: "confirmed",
                                    confirmTransactionInitialTimeout: 60000, // 增加到60秒
                                });                                
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

async function recordValue(totalSol, walletSol, totalPosSol, totalTokenValSol) {
    const timestamp = new Date().toISOString();
    const logFile = "balance_history.csv";
    
    // 如果文件不存在，写入表头
    if (!fs.existsSync(logFile)) {
        fs.writeFileSync(logFile, "timestamp,total_sol,wallet_sol,position_sol,wallet_token_sol\n");
    }
    
    const logLine = `${timestamp},${totalSol.toFixed(6)},${walletSol.toFixed(6)},${totalPosSol.toFixed(6)},${totalTokenValSol.toFixed(6)}\n`;
    fs.appendFileSync(logFile, logLine);
    console.log(`📊 [Value Record] Total: ${totalSol.toFixed(4)} SOL (Wallet: ${walletSol.toFixed(4)}, Position: ${totalPosSol.toFixed(4)}, Tokens: ${totalTokenValSol.toFixed(4)})`);
}

(async () => {   
    const wallet = loadWallet('./wallet.json'); // 替换为你的私钥文件路径

    const pool_config_list = config_lp["pool_list"]
    while(true){
        let totalPosVal = 0;
        let totalTokenValVal = 0;
        let walletSol = (await connection.getBalance(wallet.publicKey)) / 1e9;

        for(const pool_conf of pool_config_list){
            try{
                const dlmmPool = await PoolManager.getPool(pool_conf["pool_addr"]);
                console.log(`pool addr:${pool_conf["pool_addr"]}`)                
                const activebin = await dlmmPool.getActiveBin();
                const currentPrice = Number(dlmmPool.fromPricePerLamport(Number(activebin.price)));

                const tokenXAddr = dlmmPool.tokenX.publicKey.toBase58();
                const tokenBal = Number(await get_wallet_token_balance(connection, wallet, tokenXAddr));
                totalTokenValVal += tokenBal * currentPrice;

                const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
                console.log(`current bin id:${activebin.binId}`)
                // console.log(`current price:${currentPrice}`)
                console.log(`positon count:${userPositions.length}`)
                if(userPositions.length == 0){
                    console.log(`only normal position, open new trade position`)
                    if(pool_conf['action']=="sell"){
                        const maxBinId_add = activebin.binId+pool_conf['upper_bin']
                        const minBinId_add = activebin.binId+1
                        await createPosition_token(dlmmPool, wallet, connection, minBinId_add, maxBinId_add, 1);
                    }
                    else{
                        const minBinId_add = activebin.binId-pool_conf['upper_bin']
                        const maxBinId_add = activebin.binId-1
                        await createPosition_sol(dlmmPool, wallet, connection, minBinId_add, maxBinId_add, Math.floor(pool_conf["pool_size"]*1e9));
                    }
                }
                else{
                    const position = userPositions[0]
                    const minBinId = position.positionData.lowerBinId;
                    const maxBinId = position.positionData.upperBinId;
                    const posVal = await snapshot_position(dlmmPool, position);
                    totalPosVal += (posVal.total_token * currentPrice) +posVal.total_sol;
                    if(pool_conf['action']=="sell"){
                        console.log(`sell position monitor,activeid:${activebin.binId}, minid:${minBinId}, maxBinId:${maxBinId}`)
                        console.log(`stopbin:${minBinId+pool_conf["stopbin"]}, rebuildbin:${minBinId-pool_conf["rebuild"]}`)
                        if (activebin.binId >= (minBinId+pool_conf["stopbin"])){
                            console.log('order eat')
                            const ret = await removeLiquidity_single(dlmmPool, wallet, connection, position);
                            if(ret==true){
                                pool_conf['action'] = "buy";
                            }                            
                        }        
                        if(activebin.binId <= (minBinId-pool_conf["rebuild"])){
                            console.log('price too low, rebuild trade order')
                            await removeLiquidity_single(dlmmPool, wallet, connection, position);
                        }   
                    } 
                    else{
                        console.log(`buy position monitor,activeid:${activebin.binId}, minid:${minBinId}, maxBinId:${maxBinId}`)
                        console.log(`stopbin:${maxBinId-pool_conf["stopbin"]}, rebuildbin:${maxBinId+pool_conf["rebuild"]}`)
                        if (activebin.binId <= (maxBinId-pool_conf["stopbin"])){
                            console.log('order eat')
                            const ret = await removeLiquidity_single(dlmmPool, wallet, connection, position);
                            if(ret==true){
                                pool_conf['action'] = "sell";
                            }  
                        }        
                        if(activebin.binId >= (maxBinId+pool_conf["rebuild"])){
                            console.log('price too low, rebuild trade order')
                            await removeLiquidity_single(dlmmPool, wallet, connection, position);
                        } 
                    }                               
                }
            }
            catch (error) {           
                // 如果是其他错误（比如余额不足），直接抛出不再重试
                console.error("❌ error:", error.message);
            }    
            await randomSleep(5, 10)      
        }
        // 循环结束后记录总价值
        await recordValue(walletSol + totalPosVal + totalTokenValVal, walletSol, totalPosVal, totalTokenValVal);
        await randomSleep(50, 70)        
    }
})();

// console.log("--- 深度结构探测开始 ---");pool_addr
// console.log(util.inspect(userPositions[0], { 
//     showHidden: false, 
//     depth: 5,         // 递归深度，5层通常足够了
//     colors: true, 
//     compact: false    // 格式化输出，不压缩在一行
// }));
// console.log("--- 深度结构探测结束 ---");

