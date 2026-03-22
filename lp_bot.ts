const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const fs = require("fs");
const {loadWallet, createPosition_token, createPosition_sol, removeLiquidity_single, snapshot_pool, findBestPool, calculateActualAPY, closePoorAndTradeALlSol,getMyPoolAddresses} = require("./dlmm_func");
const DLMM_Module = require("@meteora-ag/dlmm");
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

export let DLMM;
if (DLMM_Module.default) {
    DLMM = DLMM_Module.default;
} else if (typeof DLMM_Module === 'function') {
    DLMM = DLMM_Module;
} else {
    DLMM = DLMM_Module; // 最后的保底尝试
}

(async () => {

    // const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
    const connection = new Connection("https://mainnet.helius-rpc.com/?api-key=59d4f054-941b-4286-a6a5-e2f0bdae611d", {
                                            commitment: "confirmed",
                                            confirmTransactionInitialTimeout: 60000, // 增加到60秒
                                        });
    
    const wallet = loadWallet('./wallet.json'); // 替换为你的私钥文件路径
    const pool_addr = 'HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh';
    const POOL_ADDRESS = new PublicKey(pool_addr);
    const dlmmPool = await DLMM.create(connection, POOL_ADDRESS);    
    // console.log("--- 深度结构探测开始 ---");
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
    while(true){
        try{
            await dlmmPool.refetchStates();
            const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
            const activebin = await dlmmPool.getActiveBin();
            // const currentPrice = dlmmPool.fromPricePerLamport(Number(activebin.price));
            console.log(`current bin id:${activebin.binId}`)
            // console.log(`current price:${currentPrice}`)
            console.log(`positon count:${userPositions.length}`)
            if(userPositions.length == 1){
                console.log(`only normal position, open new trade position`)
                // await dlmmPool.refetchStates();
                // const activebin = await dlmmPool.getActiveBin();
                const maxBinId_add = activebin.binId+6
                const minBinId_add = activebin.binId+1
                await createPosition_token(dlmmPool, wallet, connection, minBinId_add, maxBinId_add, 1);
            }
            else{
                for(const position of userPositions){
                    const minBinId = position.positionData.lowerBinId;
                    const maxBinId = position.positionData.upperBinId;            
                    if((maxBinId - minBinId) < 20){
                        console.log(minBinId, maxBinId)
                        console.log(`trade position monitor,activeid:${activebin.binId}, minid:${minBinId}, maxBinId:${maxBinId}`)

                        if (activebin.binId >= (minBinId+2)){
                            console.log('order eat')
                            await removeLiquidity_single(dlmmPool, wallet, connection, position);
                        }        

                        if(activebin.binId <= (minBinId-3)){
                            console.log('price too low, recreate trade order')
                            await removeLiquidity_single(dlmmPool, wallet, connection, position);
                        }   
                    }   
                }
            
            }
        }
        catch (error) {           
            // 如果是其他错误（比如余额不足），直接抛出不再重试
            console.error("❌ error:", error.message);
        }    
        await randomSleep(60, 90)        
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
    // const minBinId_add = activebin.binId-5
    // const maxBinId_add = activebin.binId-1
    // await createPosition_sol(dlmmPool, wallet, connection, minBinId_add, maxBinId_add, Math.floor(0.8*1e9));
    
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

