const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const fs = require("fs");
const {loadConfig, loadWallet, createPosition_token, createPosition_sol, removeLiquidity_single, snapshot_pool, findBestPool, calculateActualAPY, closePoorAndTradeALlSol,getMyPoolAddresses} = require("./dlmm_func");
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

(async () => {   
    const wallet = loadWallet('./wallet.json'); // 替换为你的私钥文件路径

    const pool_config_list = [
        {
            'pool_addr':"HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh",
            'action': "sell",
            'binstep': 20,
            'upper_bin':35,
            'stopbin':10,
            'rebuild':5
        },
        {
            'pool_addr':"53RSBX3tsax8KLnEhm8ahScK1khySNPhHFSTPoZpZq2J",
            'action': "sell",
            'binstep': 2,
            'upper_bin':60,
            'stopbin':30,
            'rebuild':10
        }        
    ]
    while(true){
        for(const pool_conf of pool_config_list){
            try{
                const dlmmPool = await PoolManager.getPool(pool_conf["pool_addr"]);
                console.log(`pool addr:${pool_conf["pool_addr"]}`)
                // await dlmmPool.refetchStates();
                const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
                const activebin = await dlmmPool.getActiveBin();
                // const currentPrice = dlmmPool.fromPricePerLamport(Number(activebin.price));
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
                        await createPosition_sol(dlmmPool, wallet, connection, minBinId_add, maxBinId_add, Math.floor(3*1e9));
                    }
                }
                else{
                    const position = userPositions[0]
                    const minBinId = position.positionData.lowerBinId;
                    const maxBinId = position.positionData.upperBinId;    
                    if(pool_conf['action']=="sell"){
                        console.log(`sell position monitor,activeid:${activebin.binId}, minid:${minBinId}, maxBinId:${maxBinId}`)
                        console.log(`stopbin:${minBinId+pool_conf["stopbin"]}, rebuildbin:${minBinId-pool_conf["rebuild"]}`)
                        if (activebin.binId >= (minBinId+pool_conf["stopbin"])){
                            console.log('order eat')
                            await removeLiquidity_single(dlmmPool, wallet, connection, position);
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
                            await removeLiquidity_single(dlmmPool, wallet, connection, position);
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
        await randomSleep(50, 70)        
    }

    // const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    // for(const position of userPositions){
    //     const minBinId = position.positionData.lowerBinId;
    //     const maxBinId = position.positionData.upperBinId;            
    //     if((maxBinId - minBinId) < 20){
    //         await removeLiquidity_single(dlmmPool, wallet, connection, position);  
    //     }   
    // }

    // const currentPrice = dlmmPool.fromPricePerLamport(Number(activebin.price));
    // const currentbin = getBinFromPrice(currentPrice, dlmmPool.lbPair.binStep, 9, 6);
    // const currentbin2 = dlmmPool.getBinIdFromPrice(activebin.price, false);
    
    // const maxBinId = position.positionData.upperBinId;   
    // await removeLiquidity_trade(dlmmPool, wallet, connection);
    // const binid = Math.floor(minBinId + (activebin.binId - minBinId)*0.6);
    // console.log(binid)
    // await dlmmPool.refetchStates();
    // const activebin = await dlmmPool.getActiveBin();
    // const minBinId_add = activebin.binId-60
    // const maxBinId_add = activebin.binId-1
    // await createPosition_sol(dlmmPool, wallet, connection, minBinId_add, maxBinId_add, Math.floor(4*1e9));

    // await dlmmPool.refetchStates();
    // const activebin = await dlmmPool.getActiveBin();
    // const maxBinId_add = activebin.binId+5
    // const minBinId_add = activebin.binId
    // await createPosition_token(dlmmPool, wallet, connection, minBinId_add, maxBinId_add, 1);

    // await addLiquidity_part(dlmmPool, wallet, connection, minBinId_add, maxBinId_add, Math.floor(0.3*1e9));
    // checkRebalanceConditions(dlmmPool, wallet, minBinId, maxBinId)
    // rebalance(wallet,connection, dlmmPool, minBinId, maxBinId);
    // await totally_newposition(wallet, connection, dlmmPool, 2.3, minBinId, maxBinId);
    //await removeLiquidity_part(dlmmPool, wallet, connection, minBinId, maxBinId)
})();

    // const POOL_ADDRESS = new PublicKey(pool_addr);
    // const dlmmPool = await DLMM.create(connection, POOL_ADDRESS);   
    // console.log("--- 深度结构探测开始 ---");pool_addr
    // console.log(util.inspect(userPositions[0], { 
    //     showHidden: false, 
    //     depth: 5,         // 递归深度，5层通常足够了
    //     colors: true, 
    //     compact: false    // 格式化输出，不压缩在一行
    // }));
    // console.log("--- 深度结构探测结束 ---");
    // const result = await dlmmPool.getBinsBetweenMinAndMaxPrice(0.0000231, 0.000026)
    // const minBinId = dlmmPool.getBinIdFromPrice(Number(dlmmPool.toPricePerLamport(0.0000241)),false);
    // const maxBinId = dlmmPool.getBinIdFromPrice(Number(dlmmPool.toPricePerLamport(0.0000245)), true);
    // console.log("minbinid:",minBinId);
    // console.log("maxbinid:",maxBinId);
    // console.log(currentbin2)