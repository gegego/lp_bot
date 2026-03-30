import test from "node:test";

const { Connection, PublicKey, Keypair, VersionedTransaction, TransactionExpiredBlockheightExceededError,ComputeBudgetProgram } = require("@solana/web3.js");
const DLMM_Module = require("@meteora-ag/dlmm");
const fs = require("fs");
const BN = require("bn.js");
const util = require('util');
const bs58  = require('bs58');

// 调试输出：看看 SDK 到底导出了什么（运行成功后可以删掉）
// console.log("SDK Export Keys:", Object.keys(DLMM_Module));

// 自动寻找 DLMM 类
let DLMM;
if (DLMM_Module.default) {
    DLMM = DLMM_Module.default;
} else if (typeof DLMM_Module === 'function') {
    DLMM = DLMM_Module;
} else {
    DLMM = DLMM_Module; // 最后的保底尝试
}

async function safeSendTransaction_old(connection, transaction, signers) {
    // 🔍 防御性检查：确保所有签名者都存在
    signers.forEach((s, i) => {
        if (!s || !s.publicKey) {
            throw new Error(`第 ${i} 个签名者是无效的！请检查你的传参。`);
        }
    });

    // 1. 获取最新的 Blockhash (这是 VersionedTransaction 必须的)
    const latestBlockhash = await connection.getLatestBlockhash();

    // 2. 如果 transaction 是 VersionedTransaction，直接签名
    if (transaction instanceof VersionedTransaction) {
        transaction.sign(signers);
    } else {
        // 如果是旧版 Transaction
        transaction.recentBlockhash = latestBlockhash.blockhash;
        transaction.sign(...signers); // 注意这里的扩展运算符 ...
    }

    // 3. 序列化并发送原始交易
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: false,
        maxRetries: 2,
    });

    // 4. 确认交易
    await connection.confirmTransaction({
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        signature: txid,
    });

    return txid;
}

async function safeSendTransaction(connection, transaction, signers, maxAttempts = 3) {
    // 🔍 防御性检查：确保所有签名者都存在
    signers.forEach((s, i) => {
        if (!s || !s.publicKey) {
            throw new Error(`第 ${i} 个签名者是无效的！请检查你的传参。`);
        }
    });

    let attempt = 0;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            // 🔍 1. 获取最新的 Blockhash
            // 使用 'confirmed' 级别获取 Blockhash 通常比 'finalized' 更快且更不容易过期
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

            // 💸 2. 注入优先费 (如果 transaction 允许修改)
            // 注意：如果是 VersionedTransaction 且已经编译好，修改指令会比较复杂
            // 建议在构建 transaction 时就加入以下指令：
            // ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 })

            // ✍️ 3. 更新 Blockhash 并签名
            if (transaction instanceof VersionedTransaction) {
                transaction.message.recentBlockhash = blockhash;
                transaction.sign(signers);
            } else {
                transaction.recentBlockhash = blockhash;
                transaction.lastValidBlockHeight = lastValidBlockHeight;
                transaction.sign(...signers);
            }

            // 🚀 4. 发送交易
            const rawTransaction = transaction.serialize();
            const txid = await connection.sendRawTransaction(rawTransaction, {
                skipPreflight: false, // 设为 false 可以捕捉模拟运行时的逻辑错误
                maxRetries: 0,        // 我们自己在外部写循环，所以关掉 RPC 默认的重试
                preflightCommitment: 'confirmed',
            });

            console.log(`第 ${attempt} 次尝试，交易已发送: ${txid}`);

            // 🏁 5. 确认交易
            const confirmation = await connection.confirmTransaction({
                signature: txid,
                blockhash: blockhash,
                lastValidBlockHeight: lastValidBlockHeight,
            }, 'confirmed');

            if (confirmation.value.err) {
                throw new Error(`交易执行失败: ${confirmation.value.err.toString()}`);
            }

            return txid;

        } catch (error) {
            // ⚠️ 处理过期错误，触发重试
            if (error instanceof TransactionExpiredBlockheightExceededError) {
                console.warn(`第 ${attempt} 次尝试超时，正在重试...`);
                if (attempt === maxAttempts) throw new Error("达到最大重试次数，交易最终失败。");
                continue; 
            }
            
            // 如果是其他错误（比如余额不足），直接抛出不再重试
            throw error;
        }
    }
}

// 从文件加载私钥
export function loadWallet(path) {
    let secretKey;
    try {
      secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(path)));
    } catch (e) {
        console.error("❌ 无法读取 wallet.json，请确保文件存在。");
        return;
    }
    return Keypair.fromSecretKey(secretKey);
}

export function loadConfig(path) {
    let dict;
    try {
      dict = JSON.parse(fs.readFileSync(path));
    } catch (e) {
        console.error("❌ 无法读取,请确保文件存在。");
        return;
    }
    return dict;
}

function getBinIdFromPrice(
    targetPrice: number,
    binStep: number,
    decimalsX: number,
    decimalsY: number
): number {
    // 1. 调整精度差 (非常重要！)
    // 池子内部价格是基于原始单位的，公式：UI_Price * (10^X / 10^Y)
    const adjustedPrice = targetPrice * (Math.pow(10, decimalsX) / Math.pow(10, decimalsY));

    // 2. 计算 log(P) / log(1 + step)
    const step = binStep / 10000;
    const binId = Math.log(adjustedPrice) / Math.log(1 + step);

    // 3. 取整 (BinID 必须是整数)
    return Math.round(binId);
}

export function getBinFromPrice(
    price: number,
    binStep: number,
    decimalsA: number,
    decimalsB: number
  ): number {
    const step = binStep / 10000;
    // 计算精度偏移量: 10^(decimalsB - decimalsA)
    const decimalAdjustment = Math.pow(10, decimalsB - decimalsA);

    // 公式: Price = (1 + step)^Bin * decimalAdjustment
    // 反解 Bin: Bin = log(Price / decimalAdjustment) / log(1 + step)
    const bin = Math.log(price / decimalAdjustment) / Math.log(1 + step);

    // 使用 Math.round 或 Math.floor 取决于协议实现，
    // 通常这里使用 Math.floor 来获取价格所在的当前桶
    return Math.floor(bin);
}

async function createPosition(dlmmPool, wallet, sol_conn, minbinid, maxbinid, amountRaw_sol) {
    await dlmmPool.refetchStates(); // 刷新池子状态
    // const activeBin = await dlmmPool.getActiveBin();
    // const range = 35; // 向上下各扩展 50 个 bin
    const minBinId = minbinid;
    const maxBinId = maxbinid;

    // --- 3. 重新加注 ---
    console.log(`准备在区间 [${minBinId}, ${maxBinId}] 重新加注...`);
    
    // 注意：这里的 Amount 需要根据你撤资后钱包里的实际余额来定
    // 建议使用较小的固定金额进行测试
    let amountRawX = 0;
    try {
        const tokenAccounts = await sol_conn.getParsedTokenAccountsByOwner(wallet.publicKey, {
            mint: dlmmPool.tokenX.publicKey,
        });

        if (tokenAccounts.value.length > 0) {
            amountRawX = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
            console.log(`🪙 token 余额: ${amountRawX}`);
        } else {
            console.log("🪙 token 余额: 0 (未发现 token 代币账户)");
        }
    } catch (e) {
        console.error("❌ 查询 token 余额失败:", e.message);
    }
    
    // let amountRawY = await sol_conn.getBalance(wallet.publicKey);    
    // const safeBalanceY = amountRawY - (0.1 * 1e9); // 预留 0.1 SOL 运费
    // console.log(`💰 SOL 余额: ${safeBalanceY / 1e9} SOL`);

    const totalXAmount = new BN(amountRawX);
    const totalYAmount = new BN(amountRaw_sol);
    let positionKeypair = Keypair.generate();
    const addLiquidityTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey, // 为新仓位生成一个地址        
        totalXAmount: totalXAmount,
        totalYAmount: totalYAmount,
        strategy: {
            strategyType: 0,
            minBinId: minBinId,
            maxBinId: maxBinId,            
        },
        user: wallet.publicKey,
        slippage: 1
    });
    const txid = await safeSendTransaction(sol_conn, addLiquidityTx, [wallet, positionKeypair]);
    console.log(`✅ 建仓成功！TX: ${txid}`);
    console.log(`📍 仓位地址: ${positionKeypair.publicKey.toBase58()}`);
}

export async function createPosition_sol(dlmmPool, wallet, sol_conn, minbinid, maxbinid, amountRaw_sol) {
    await dlmmPool.refetchStates(); // 刷新池子状态
    // const activeBin = await dlmmPool.getActiveBin();
    // const range = 35; // 向上下各扩展 50 个 bin
    const minBinId = minbinid;
    const maxBinId = maxbinid;

    // --- 3. 重新加注 ---
    console.log(`准备在区间 [${minBinId}, ${maxBinId}] 重新加注...`);
    
    // 注意：这里的 Amount 需要根据你撤资后钱包里的实际余额来定
    // 建议使用较小的固定金额进行测试
    let amountRawX = 0;
    // let amountRawY = await sol_conn.getBalance(wallet.publicKey);    
    // const safeBalanceY = amountRawY - (0.1 * 1e9); // 预留 0.1 SOL 运费
    // console.log(`💰 SOL 余额: ${safeBalanceY / 1e9} SOL`);

    const totalXAmount = new BN(amountRawX);
    const totalYAmount = new BN(amountRaw_sol);
    let positionKeypair = Keypair.generate();
    const addLiquidityTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey, // 为新仓位生成一个地址        
        totalXAmount: totalXAmount,
        totalYAmount: totalYAmount,
        strategy: {
            strategyType: 0,
            minBinId: minBinId,
            maxBinId: maxBinId,            
        },
        user: wallet.publicKey,
        slippage: 1
    });
    const txid = await safeSendTransaction(sol_conn, addLiquidityTx, [wallet, positionKeypair]);
    console.log(`✅ 建仓成功！TX: ${txid}`);
    console.log(`📍 仓位地址: ${positionKeypair.publicKey.toBase58()}`);
}

export async function createPosition_token(dlmmPool, wallet, sol_conn, minbinid, maxbinid, percent=1) {
    await dlmmPool.refetchStates(); // 刷新池子状态
    // const activeBin = await dlmmPool.getActiveBin();
    // const range = 35; // 向上下各扩展 50 个 bin
    const minBinId = minbinid;
    const maxBinId = maxbinid;

    // --- 3. 重新加注 ---
    console.log(`准备在区间 [${minBinId}, ${maxBinId}] 重新加注...`);
    
    // 注意：这里的 Amount 需要根据你撤资后钱包里的实际余额来定
    // 建议使用较小的固定金额进行测试
    let amountRawX = 0;
    try {
        const tokenAccounts = await sol_conn.getParsedTokenAccountsByOwner(wallet.publicKey, {
            mint: dlmmPool.tokenX.publicKey,
        });

        if (tokenAccounts.value.length > 0) {
            amountRawX = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
            console.log(`🪙 token 余额: ${amountRawX}`);
        } else {
            console.log("🪙 token 余额: 0 (未发现 token 代币账户)");
        }
    } catch (e) {
        console.error("❌ 查询 token 余额失败:", e.message);
    }

    const totalXAmount = new BN(Math.floor(amountRawX*percent));
    const totalYAmount = new BN(0);
    let positionKeypair = Keypair.generate();
    const addLiquidityTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey, // 为新仓位生成一个地址        
        totalXAmount: totalXAmount,
        totalYAmount: totalYAmount,
        strategy: {
            strategyType: 0,
            minBinId: minBinId,
            maxBinId: maxBinId,            
        },
        user: wallet.publicKey,
        slippage: 1
    });
    const txid = await safeSendTransaction(sol_conn, addLiquidityTx, [wallet, positionKeypair]);
    console.log(`✅ 建仓成功！TX: ${txid}`);
    console.log(`📍 仓位地址: ${positionKeypair.publicKey.toBase58()}`);
}


async function removeLiquidity(dlmmPool, wallet, sol_conn) {
    // 2. 获取用户持仓
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    
    if (userPositions.length === 0) {
        console.log("当前无活跃仓位");
        return;
    } else {
        console.log(`发现 ${userPositions.length} 个仓位，准备撤资...`);
        
        for (const position of userPositions) {
            await removeLiquidity_single(dlmmPool, wallet, sol_conn, position);
        }
    }
}

async function removeLiquidity_trade(dlmmPool, wallet, sol_conn) {
    // 2. 获取用户持仓
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    
    if (userPositions.length === 0) {
        console.log("当前无活跃仓位");
        return;
    } else {
        console.log(`发现 ${userPositions.length} 个仓位，准备撤资...`);
        
        for (const position of userPositions) {
            const minBinId = position.positionData.lowerBinId;
            const maxBinId = position.positionData.upperBinId;
            if((maxBinId - minBinId) < 10){
                await removeLiquidity_single(dlmmPool, wallet, sol_conn, position);
                break
            }        
        }
    }
}

export async function removeLiquidity_single(dlmmPool, wallet, sol_conn, position) {
    // 获取该仓位所有的 Bin ID
    const minBinId = position.positionData.lowerBinId;
    const maxBinId = position.positionData.upperBinId;
    // 构造撤资交易
    const removeLiquidityTx = await dlmmPool.removeLiquidity({
        user: wallet.publicKey,
        position: position.publicKey,               
        fromBinId: minBinId,
        toBinId: maxBinId,
        bps: new BN(10000), // 100% 撤出
        shouldClaimAndClose: true,
    });

    // 注意：Meteora 可能返回一个数组，因为交易可能被拆分
    if (Array.isArray(removeLiquidityTx)) {
        for (const tx of removeLiquidityTx) {
            const txid = await safeSendTransaction(sol_conn, tx, [wallet]);
            console.log(`✅ 撤资成功: ${txid}`);
        }
    } else {
        const txid = await safeSendTransaction(sol_conn, removeLiquidityTx, [wallet]);
        console.log(`✅ 撤资成功: ${txid}`);
    }
}

async function addLiquidity_part(dlmmPool, wallet, sol_conn, minid, maxId, amount) {
    await dlmmPool.refetchStates(); // 刷新池子状态
    const activeBin = await dlmmPool.getActiveBin();
    // const range = 35; // 向上下各扩展 50 个 bin
    const minBinId = minid;
    const maxBinId = maxId;
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    
    if (userPositions.length === 0) {
        console.log("当前无活跃仓位");
        return;
    } else {
        const position = userPositions[0];
        let totalXAmount = 0
        let totalYAmount = 0;
        if(activeBin.binId < minid){
            totalXAmount = amount;
        }
        else{
            totalYAmount = amount
        }        
        const addLiquidityTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: position.publicKey,
            totalXAmount: new BN(totalXAmount),
            totalYAmount: new BN(totalYAmount),
            strategy: {
                strategyType: 0,
                minBinId: minBinId,
                maxBinId: maxBinId,            
            },
            user: wallet.publicKey,
            slippage: 1
        });
        const txid = await safeSendTransaction(sol_conn, addLiquidityTx, [wallet, position.publicKey]);
        console.log(`✅ 建仓成功！TX: ${txid}`);
        console.log(`📍 仓位地址: ${position.publicKey.toBase58()}`);
    }
    
}


async function removeLiquidity_part(dlmmPool, wallet, sol_conn, minid, maxid, percent=100) {
    // 2. 获取用户持仓
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    
    if (userPositions.length === 0) {
        console.log("当前无活跃仓位");
        return;
    } else {
        console.log(`发现 ${userPositions.length} 个仓位，准备撤资...`);
        
        for (const position of userPositions) {
            // 获取该仓位所有的 Bin ID
            const minBinId = minid;
            const maxBinId = maxid;
            // 构造撤资交易
            const removeLiquidityTx = await dlmmPool.removeLiquidity({
                user: wallet.publicKey,
                position: position.publicKey,               
                fromBinId: minBinId,
                toBinId: maxBinId,
                bps: new BN(percent*100), // 100% 撤出
                shouldClaimAndClose: false,
            });

            // 注意：Meteora 可能返回一个数组，因为交易可能被拆分
            if (Array.isArray(removeLiquidityTx)) {
                for (const tx of removeLiquidityTx) {
                    const txid = await safeSendTransaction(sol_conn, tx, [wallet]);
                    console.log(`✅ 撤资成功: ${txid}`);
                }
            } else {
                const txid = await safeSendTransaction(sol_conn, removeLiquidityTx, [wallet]);
                console.log(`✅ 撤资成功: ${txid}`);
            }
        }
    }
}

export async function snapshot_pool(dlmmPool, wallet) {
    // 1. 获取最新状态和价格
    await dlmmPool.refetchStates();
    const activeBin = await dlmmPool.getActiveBin();
    const currentPrice = dlmmPool.fromPricePerLamport(Number(activeBin.price)); // 1 MET = ? SOL
    console.log(`currentPrice ${currentPrice}...`);
    // 2. 获取用户持仓
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    
    if (userPositions.length === 0) {
        console.log("当前无活跃仓位");
        return {};
    }

    let totalUnclaimedFeeInSol = 0;
    let totalPositionValueInSol = 0;

    let total_x = 0;
    let total_y = 0;

    for (const position of userPositions) {

        // console.log("--- 深度结构探测开始 ---");
        // console.log(util.inspect(position, { 
        //     showHidden: false, 
        //     depth: 5,         // 递归深度，5层通常足够了
        //     colors: true, 
        //     compact: false    // 格式化输出，不压缩在一行
        // }));
        // console.log("--- 深度结构探测结束 ---");
        // A. 计算未提取手续费 (以 SOL 计价)
        // feeX 和 feeY 已经是 BN 格式，需要转换成人类可读的数字
        console.log(`minBinId ${position.positionData.lowerBinId}`);
        console.log(`maxBinId ${position.positionData.upperBinId}`);

        const feeX = Number(position.positionData.feeX) / 1e6; // 假设 MET 是 9 位小数
        const feeY = Number(position.positionData.feeY) / 1e9; // SOL 是 9 位小数

        const feeInSol = (feeX * currentPrice) + feeY;
        totalUnclaimedFeeInSol += feeInSol;

        // B. 计算当前本金价值 (以 SOL 计价)
        const totalX = Number(position.positionData.totalXAmount) / 1e6;
        const totalY = Number(position.positionData.totalYAmount) / 1e9;
        
        const positionValueInSol = (totalX * currentPrice) + totalY;
        totalPositionValueInSol += positionValueInSol;

        total_x += totalX+feeX;
        total_y += totalY+feeY;
    }

    // let sol_inwal = await sol_conn.getBalance(wallet.publicKey);
    let totalSOL = totalUnclaimedFeeInSol+totalPositionValueInSol;
    // console.log(`总sol: ${totalSOL.toFixed(6)} SOL`);
    return {totalSOL, total_x, total_y};
}

async function monitorEarningsInSol(dlmmPool, wallet) {
    // 1. 获取最新状态和价格
    await dlmmPool.refetchStates();
    const activeBin = await dlmmPool.getActiveBin();
    const currentPrice = dlmmPool.fromPricePerLamport(Number(activeBin.price)); // 1 MET = ? SOL
    console.log(`currentPrice ${currentPrice}...`);
    // 2. 获取用户持仓
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    
    if (userPositions.length === 0) {
        console.log("当前无活跃仓位");
        return;
    }

    let totalUnclaimedFeeInSol = 0;
    let totalPositionValueInSol = 0;

    for (const position of userPositions) {

        // console.log("--- 深度结构探测开始 ---");
        // console.log(util.inspect(position, { 
        //     showHidden: false, 
        //     depth: 5,         // 递归深度，5层通常足够了
        //     colors: true, 
        //     compact: false    // 格式化输出，不压缩在一行
        // }));
        // console.log("--- 深度结构探测结束 ---");
        // A. 计算未提取手续费 (以 SOL 计价)
        // feeX 和 feeY 已经是 BN 格式，需要转换成人类可读的数字
        console.log(`minBinId ${position.positionData.lowerBinId}`);
        console.log(`maxBinId ${position.positionData.upperBinId}`);

        const feeX = Number(position.positionData.feeX) / 1e6; // 假设 MET 是 9 位小数
        const feeY = Number(position.positionData.feeY) / 1e9; // SOL 是 9 位小数

        const feeInSol = (feeX * currentPrice) + feeY;
        totalUnclaimedFeeInSol += feeInSol;

        // B. 计算当前本金价值 (以 SOL 计价)
        const totalX = Number(position.positionData.totalXAmount) / 1e6;
        const totalY = Number(position.positionData.totalYAmount) / 1e9;
        
        const positionValueInSol = (totalX * currentPrice) + totalY;
        totalPositionValueInSol += positionValueInSol;

        console.log(`仓位 ${position.publicKey.toBase58().slice(0, 8)}...`);
        console.log(`  - 待领手续费: ${feeInSol.toFixed(6)} SOL`);
        console.log(`  - 当前本金价值: ${positionValueInSol.toFixed(6)} SOL`);
    }

    console.log("-----------------------------------------");
    console.log(`🔥 总待领收益: ${totalUnclaimedFeeInSol.toFixed(6)} SOL`);
    console.log(`📊 总持仓价值: ${totalPositionValueInSol.toFixed(6)} SOL`);
}

async function check_pnl(wallet_path, pool_addr) {
  const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const wallet = loadWallet(wallet_path); // 替换为你的私钥文件路径
  const POOL_ADDRESS = new PublicKey(pool_addr);
  const dlmmPool = await DLMM.create(connection, POOL_ADDRESS);
  monitorEarningsInSol(dlmmPool, wallet);
}

export async function getMyPoolAddresses(connection, wallet) {
    try {
        console.log(`🔍 正在扫描钱包: ${wallet.publicKey.toBase58()} 的所有仓位...`);

        // 1. 调用静态方法获取用户的所有仓位信息
        // 注意：这是 DLMM 类的静态方法，不需要先创建池子实例
        const allPositions = await DLMM.getAllLbPairPositionsByUser(connection, wallet.publicKey);

        if (allPositions.length === 0) {
            console.log("❌ 该钱包目前没有任何活跃的 DLMM 仓位。");
            return [];
        }
        const mypool = [];

        allPositions.forEach((data, posKey) => {
            mypool.push(posKey);
        });

        return mypool;
    } catch (err) {
        console.error("❌ 获取池子列表失败:", err);
        return [];
    }
}

export async function rebalance(wallet, connection, dlmmPool, minbinid, maxbinid) {    
    let sol_wallet_1 = await connection.getBalance(wallet.publicKey);
    const { totalSOL, total_x, total_y} = await snapshot_pool(dlmmPool, wallet);
    console.log(`pool sol: ${totalSOL}, sol in wallet: ${sol_wallet_1/1e9}, total_x: ${total_x}, total_y:${total_y}`)
    await removeLiquidity(dlmmPool, wallet, connection);

    let amountRawX = Math.floor(total_x*1e6);
    let amountRawY = Math.floor(total_y*1e9);
    const balX = amountRawX;
    const balY = amountRawY;

    const activeBin = await dlmmPool.getActiveBin();
    const currentPrice = dlmmPool.fromPricePerLamport(Number(activeBin.price.toString()));
    const minId = minbinid;
    const maxId = maxbinid;
    const { action, amount } = calculateRebalanceSwap(
        Number(balX) / 1e6, 
        Number(balY) / 1e9, 
        activeBin.binId,
        minId, 
        maxId, 
        dlmmPool.lbPair.binStep, 
        currentPrice
    );
    const totalsolvalX = (balX/1e6)*currentPrice
    const totalsolvalY = (balY/1e9)
    console.log(totalsolvalX, totalsolvalY, totalsolvalX+totalsolvalY)
    let amountRaw_Sol = totalsolvalY;

    if (action === 'BUY_token') {
        console.log(`🛒 比例失衡：正在用 ${amount.toFixed(4)} SOL 买入更多 token...`);
        // await swapSOLtoToken(wallet, dlmmPool.tokenX.publicKey.toString(), Math.floor(amount*1e9));
        console.log(`配平后：X： ${totalsolvalX+amount}， Y: ${totalsolvalY-amount}`)
        amountRaw_Sol = Math.floor((totalsolvalY-amount)*1e9)
    } else {
        console.log(`💰 比例失衡：正在卖出 ${amount.toFixed(4)} token 换回 SOL...${amount*currentPrice}`);
        // await swaptokenToSol(connection, wallet, dlmmPool.tokenX.publicKey.toString(), Math.floor(amount*1e6));
        console.log(`配平后：X： ${totalsolvalX-amount*currentPrice}， Y: ${totalsolvalY+amount*currentPrice}`)
        amountRaw_Sol = Math.floor((totalsolvalY+amount*currentPrice)*1e9)
    }
    console.log(`trade in sol: ${amountRaw_Sol/1e9}`)
    await createPosition(dlmmPool, wallet, connection, minId, maxId, amountRaw_Sol)
    let sol_wallet_2 = await connection.getBalance(wallet.publicKey);
    console.log(`sol in wallet after: ${sol_wallet_2/1e9}`)
}

export async function closePoorAndTradeALlSol(wallet, connection, dlmmPool) {    
    let sol_wallet_1 = await connection.getBalance(wallet.publicKey);
    const { totalSOL, total_x, total_y} = await snapshot_pool(dlmmPool, wallet);
    console.log(`pool sol: ${totalSOL}, sol in wallet: ${sol_wallet_1/1e9}, total_x: ${total_x}, total_y:${total_y}`)
    await removeLiquidity(dlmmPool, wallet, connection);
    const token_addr = dlmmPool.tokenX.publicKey.toString()
    // await swaptokenToSol(connection, wallet, token_addr);
}

function calculateRebalanceSwap(
    currX: number,      // 当前 MET 余额 (实数)
    currY: number,      // 当前 SOL 余额 (实数)
    activeId: number,
    minId: number,
    maxId: number,
    binStep: number,
    currentPrice: number
) {
    const step = binStep / 10000;
    
    // 1. 计算目标区间的价值权重比例 R
    const numBinsBelow = Math.max(0, activeId - minId);
    const weightSOL = numBinsBelow + 0.5; // 加上 Active Bin 的 0.5 权重

    let weightTO_in_SOL = 0.5; // Active Bin 的 MET 部分
    const numBinsAbove = Math.max(0, maxId - activeId);
    for (let n = 1; n <= numBinsAbove; n++) {
        weightTO_in_SOL += 1 / Math.pow(1 + step, n);
    }

    // R 是每单位 SOL 对应的 MET 数量权重
    // 注意：这里的权重计算已经折算到了当前价格
    const targetRatio = (weightTO_in_SOL / weightSOL) / currentPrice;

    // 2. 应用配平公式计算 deltaX
    // deltaX = (R * currY - currX) / (1 + R * Price)
    const deltaX = (targetRatio * currY - currX) / (1 + targetRatio * currentPrice);

    // 3. 决定动作
    if (deltaX > 0) {
        // 需要买入 MET，消耗的是 SOL
        const solToSpend = deltaX * currentPrice;
        return { action: 'BUY_token', amount: solToSpend * 1.005 }; // 稍微多备一点 SOL 防止滑点
    } else {
        // 需要卖出 MET，换回 SOL
        return { action: 'SELL_token', amount: Math.abs(deltaX) * 0.995 }; // 稍微少卖一点防止滑点
    }
}

export async function totally_newposition(wallet, connection, dlmmPool, sol_amount, minbinid, maxbinid) {
    await dlmmPool.refetchStates();
    const activeBin = await dlmmPool.getActiveBin();
    const currentPrice = dlmmPool.fromPricePerLamport(Number(activeBin.price.toString()));
    const token_addr = dlmmPool.tokenX.publicKey.toString()

    const totalSolAmount = sol_amount;    
    console.log(currentPrice)
    // 2. 获得24h里的最大最小值
    const minId = minbinid;
    const maxId = maxbinid;
    console.log(activeBin.binId, minId, maxId)
    const { solToSwap, expectedtoken, targetRatio } = calculateInitialSwap(
        totalSolAmount,
        activeBin.binId,
        minId,
        maxId,
        dlmmPool.lbPair.binStep,
        currentPrice
    );
    console.log(solToSwap, expectedtoken, targetRatio)
    const decimals = 9;
    // 转换方式 A：简单乘法（容易在小数位多时出问题）
    const amountRaw_SOL = Math.floor(solToSwap * Math.pow(10, decimals)).toString();
    console.log(amountRaw_SOL)
    // await swapSOLtoToken( wallet, token_addr, amountRaw_SOL);

    const raw_sol_tradein = Math.floor((totalSolAmount - solToSwap)*1e9);
    console.log(`raw_sol_tradein: ${raw_sol_tradein}`)

    await createPosition(dlmmPool, wallet, connection, minId, maxId, raw_sol_tradein)
}

function calculateInitialSwap(
    totalSolInput: number,
    activeId: number,
    minId: number,
    maxId: number,
    binStep: number,
    currentPrice: number
) {
    const step = binStep / 10000;
    
    // --- 计算左侧 (SOL 部分) 的权重 ---
    // 每个在 Active Bin 左侧的 Bin 只存 SOL，权重固定为 1
    const numBinsBelow = Math.max(0, activeId - minId);
    const weightSOL = numBinsBelow;

    // --- 计算右侧 (MET 部分) 的权重 ---
    // 我们计算的是：要把这些 Bin 填满，需要的 MET “折合到当前价格”相当于多少 SOL
    // 公式：Value_in_SOL = Sum( 1 / (1 + step)^n )，其中 n 是距离 Active Bin 的偏移量
    let weightMET_in_SOL = 0;
    const numBinsAbove = Math.max(0, maxId - activeId);

    for (let n = 1; n <= numBinsAbove; n++) {
        // 随着 binID 升高，每个 Bin 需要的 MET 数量减少，
        // 但其单价升高，最终每个 Bin 消耗的“价值”相对于当前价是递减的
        weightMET_in_SOL += 1 / Math.pow(1 + step, n);
    }

    // --- 处理 Active Bin (假设 50/50 分配) ---
    const weightSOL_active = 0.5;
    const weightMET_in_SOL_active = 0.5; // 简化处理，Active Bin 的 MET 部分价值约等于 0.5 SOL

    const totalWeightSOL = weightSOL + weightSOL_active;
    const totalWeightMET = weightMET_in_SOL + weightMET_in_SOL_active;

    // --- 计算最终需要拿去交换的比例 ---
    // 比例 = (MET 部分占的总价值权重) / (总价值权重)
    const swapRatio = totalWeightMET / (totalWeightSOL + totalWeightMET);

    // 计算需要 Swap 的 SOL 数量
    const solToSwap = totalSolInput * swapRatio;
    
    // 预留 0.5% 的安全边际，防止因滑点导致建仓时 SOL 不够
    const safeSolToSwap = solToSwap * 0.995;

    return {
        solToSwap: safeSolToSwap,
        expectedtoken: safeSolToSwap / currentPrice,
        targetRatio: swapRatio
    };
}

async function isPriceStableKLine(pool_addr) {
    let klineData = []
    klineData = await pool_kline(pool_addr);
    // 假设 klineData 是最近 3-5 根 5m K线
    const lastCandle = klineData[klineData.length - 1];
    
    // 1. 计算振幅百分比: (High - Low) / Low
    const amplitude = (lastCandle.high - lastCandle.low) / lastCandle.low;
    
    // 2. 计算实体占比: |Close - Open| / (High - Low)
    // 如果实体很小但影线很大，说明正在剧烈洗盘
    const bodySize = Math.abs(lastCandle.close - lastCandle.open);
    const candleRange = lastCandle.high - lastCandle.low;
    const bodyRatio = bodySize / candleRange;

    // 门槛设置
    const MAX_AMPLITUDE = 0.03; // 5分钟振幅不能超过 3%
    const MIN_BODY_RATIO = 0.4; // 实体至少要占总波动的 40% (防止长针)

    if (amplitude > MAX_AMPLITUDE || bodyRatio < MIN_BODY_RATIO) {
        console.log(`⚠️ 市场不稳: 振幅 ${amplitude.toFixed(4)}, 实体比 ${bodyRatio.toFixed(2)}`);
        return false;
    }
    console.log('true')
    return true;
}

/**
 * 1h K线策略分析
 */
async function analyze1hStrategy(klines: any[]) {
    if (klines.length < 20) return { action: 'WAIT', reason: '数据不足' };

    const lastCandle = klines[klines.length - 1];
    const prevCandle = klines[klines.length - 2];    
    
    // 1. 计算简单的 EMA 20 (这里可以用简单逻辑模拟)
    const prices = klines.map(k => k.close);
    const ema20 = calculateEMA(prices, 20);

    // 2. 进场逻辑判断
    const isAboveEMA = lastCandle.close > ema20;
    const isTrendReversed = prevCandle.close <= ema20 && lastCandle.close > ema20; // 金叉

    // 3. 波动率检查 (1h 振幅)
    const amplitude = (lastCandle.high - lastCandle.low) / lastCandle.low;

    // --- 逻辑分支 ---

    // 情况 A: 进场信号
    if (isAboveEMA && amplitude < 0.10) {
        return { action: 'ENTER', reason: '1h 趋势向上且波动受控' };
    }

    // 情况 B: 止损信号
    if (lastCandle.close < ema20 * 0.98) {
        return { action: 'STOP_LOSS', reason: '1h 价格跌破 EMA20 支撑' };
    }

    return { action: 'HOLD', reason: '维持现状' };
}

// EMA 基础公式: $EMA_t = \alpha \cdot P_t + (1 - \alpha) \cdot EMA_{t-1}$
function calculateEMA(data: number[], period: number) {
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) {
        ema = data[i] * k + ema * (1 - k);
    }
    return ema;
}

async function pool_kline(pool_addr, timeframe='5m') {
    const now = Math.floor(Date.now()/1000);
    const timestart = now - 60*60*21
    const url = `https://dlmm.datapi.meteora.ag/pools/${pool_addr}/ohlcv?timeframe=${timeframe}&start_time=${timestart}&end_time=${now}`;
    const options = { method: 'GET' };
    //console.log(url)
    try {
        // 1. 使用 await 等待请求完成
        const response = await fetch(url, options);        
        // 2. 等待解析为 JSON
        const kline = await response.json();
        return kline.data;

    } catch (err) {
        console.error("抓取池子列表失败:", err);
        return []; // 出错时返回空数组防止后续逻辑崩掉
    }
}

async function checkRebalanceNeed(dlmmPool, currentPosition, params = { 
    bufferPercent: 0.1,    // 缓冲区：出界 10% 才触发
    minFeeMultiple: 3,     // 利润覆盖倍数：未领手续费需 > 3倍预估成本
    maxPriceVolatility: 0.05 // 5分钟内波动率超过5%则不动作（防砸）
}) {
    // 1. 获取基础数据
    const activeBin = dlmmPool.getActiveBin();
    const activeId = activeBin.binId;
    
    // 从当前仓位数据中获取范围（假设你已在本地记录或从 position 对象提取）
    
    const minBinId = currentPosition.positionData.lowerBinId;
    const maxBinId = currentPosition.positionData.upperBinId;

    // 2. 检查：空间维度 (Is Out of Range?)
    // 我们引入一个“软边界”，防止价格在边缘反复横跳导致频繁重组
    const rangeWidth = maxBinId - minBinId;
    const lowerBuffer = minBinId - Math.floor(rangeWidth * params.bufferPercent);
    const upperBuffer = maxBinId + Math.ceil(rangeWidth * params.bufferPercent);

    const isOutOfRange = activeId < lowerBuffer || activeId > upperBuffer;
    
    if (!isOutOfRange) {
        return { shouldRebalance: false, reason: "PRICE_IN_RANGE" };
    }

    // // 5. 检查：时间维度 (Cooldown)
    const lastUpdateUnix = currentPosition.positionData.lastUpdatedAt.toNumber(); // 从数据库/本地获取
    // const lastUpdateDate = new Date(lastUpdateUnix * 1000);
    const now = Date.now();
    if (now - lastUpdateUnix*1000 < 10 * 60 * 1000) { // 15分钟冷却期
        return { shouldRebalance: false, reason: "IN_COOLDOWN_PERIOD" };
    }

    // 满足所有条件，触发重组
    return { shouldRebalance: true, reason: "OUT_OF_RANGE_AND_PROFITABLE" };
}

async function lookupPool() {
    console.log("正在获取数据...");
    const result = await findBestPool(); // 这里的 await 是关键！
    for (const pool of result){
        const targetpool = {'name': pool.name, 'v24h_tvl':pool.volume['24h']/pool.tvl, 'baseFeeRate':pool.pool_config['base_fee_pct']}
        const Realized_APY = calculateActualAPY(targetpool)
        if((pool.volume['24h']/pool.tvl)>0.1 && pool.name.includes('SOL')&& Realized_APY>50 ){
            const kline_data =  await pool_kline(pool.address, '1h');
            const ret = await analyze1hStrategy(kline_data)
            if(ret.action==="ENTER"){
                console.log(`${pool.address},${pool.name}, ${pool.tvl}, ${pool.volume['24h']/pool.tvl}, ${pool.pool_config['bin_step']}, ${Realized_APY}`)
                console.log(ret)
            }            
        }
    }
    return null;
    //console.log("✅ 真正的数据结果：", result);
}

export async function findBestPool() {
    const usdc_addr = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const sol_addr = 'So11111111111111111111111111111111111111112'

    const url = 'https://dlmm.datapi.meteora.ag/pools?page=1&sort_by=tvl%3Adesc&page_size=1000&filter_by=tvl%3E70000';
    const options = { method: 'GET' };

    try {
        // 1. 使用 await 等待请求完成
        const response = await fetch(url, options);
        
        // 2. 等待解析为 JSON
        const data = await response.json();

        // 3. 此时 data 已经拿到了，我们可以进行排序和过滤
        // 注意：Meteora API 返回的结构通常是 { data: [...], pagination: ... }
        // 或者是直接的数组，你需要根据实际返回结构调整，这里假设是 data.data
        const pools = data.data || data; 

        const sortedPools = pools.sort((a: any, b: any) => {
            const efficiencyA = a.volume['24h'] / a.tvl;
            const efficiencyB = b.volume['24h'] / b.tvl;
            return efficiencyB - efficiencyA;
        });

        // 4. 正确地将结果 return 出去
        return sortedPools;

    } catch (err) {
        console.error("抓取池子列表失败:", err);
        return []; // 出错时返回空数组防止后续逻辑崩掉
    }
}

function shouldMigrate(currentPool, targetPool, myValueSol) {
    const FEE_RATE = 0.001; // 假设 0.1%
    const SWAP_FRICTION = 0.005; // 预估换仓损耗 0.5%

    const currentDailyFee = myValueSol * currentPool.v24h_tvl * FEE_RATE;
    const targetDailyFee = myValueSol * targetPool.v24h_tvl * FEE_RATE;
    
    const migrationCost = myValueSol * SWAP_FRICTION;
    const profitDiff = targetDailyFee - currentDailyFee;

    if (profitDiff <= 0) return false;

    const breakevenDays = migrationCost / profitDiff;

    console.log(`对比: ${currentPool.name} -> ${targetPool.name}`);
    console.log(`回本所需天数: ${breakevenDays.toFixed(2)} 天`);

    // 如果 2 天内能回本，且目标池子 TVL 足够大（防止滑点）
    return breakevenDays < 2 && targetPool.tvl > 100000;
}

export function calculateActualAPY(pool) {
    // 每日收益 = 效率 * 费率
    // 这里的 feeRate 需要从 API 获取，比如 0.0004 代表 0.04%
    const dailyReturn = pool.v24h_tvl * pool.baseFeeRate*0.01; 
    return dailyReturn * 365 * 100; // 转换成百分比年化
}

async function checkRebalanceConditions(dlmmPool, wallet, minbinid, maxbinid) {
    const activeBin = await dlmmPool.getActiveBin();
    const currentPrice =  dlmmPool.fromPricePerLamport(Number(activeBin.price));
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    
    if (userPositions.length === 0) {
        console.log("当前无活跃仓位");
        return;
    } else {
        console.log(`发现 ${userPositions.length} 个仓位，准备撤资...`);
        
        for (const position of userPositions) {
            // 获取该仓位所有的 Bin ID
            // const minBinId = position.positionData.lowerBinId;
            // const maxBinId = position.positionData.upperBinId;

            // const isOutOfRange = activeBin.binId < minBinId || activeBin.binId > maxBinId;

            // console.log("--- 深度结构探测开始 ---");
            // console.log(util.inspect(position, { 
            //     showHidden: false, 
            //     depth: 5,         // 递归深度，5层通常足够了
            //     colors: true, 
            //     compact: false    // 格式化输出，不压缩在一行
            // }));
            // console.log("--- 深度结构探测结束 ---");

            const feeX = Number(position.positionData.feeX) / 1e6; // 假设 MET 是 9 位小数
            const feeY = Number(position.positionData.feeY) / 1e9; // SOL 是 9 位小数

            const feeInSol = (feeX * currentPrice) + feeY;
            console.log(feeInSol,feeX,feeY)    

            const balX = Number(position.positionData.totalXAmount);
            const balY = Number(position.positionData.totalYAmount);
            const minId = minbinid;
            const maxId = maxbinid
            const { action, amount } = calculateRebalanceSwap(
                Number(balX) / 1e6, 
                Number(balY) / 1e9, 
                activeBin.binId,
                minId, 
                maxId, 
                dlmmPool.lbPair.binStep, 
                currentPrice
            );
            const totalsolvalX = (balX/1e6)*currentPrice
            const totalsolvalY = (balY/1e9)
            console.log(totalsolvalX, totalsolvalY, totalsolvalX+totalsolvalY)

            if (action === 'BUY_token') {
                console.log(`🛒 比例失衡：正在用 ${amount.toFixed(4)} SOL 买入更多 token...`);
                console.log(`配平后：X： ${totalsolvalX+amount}， Y: ${totalsolvalY-amount}`)
            } else {
                console.log(`💰 比例失衡：正在卖出 ${amount.toFixed(4)} MET 换回 SOL...${amount*currentPrice}`);
                console.log(`配平后：X： ${totalsolvalX-amount*currentPrice}， Y: ${totalsolvalY+amount*currentPrice}`)
            }

            // const fees = await dlmmPool.getUnclaimedFees();
            // const cost = estimateRebalanceCost(); 

            // // 3. 检查价格是否断崖式下跌 (防砸)
            // const priceChange = (currentPrice - lastPrice) / lastPrice;
            // if (priceChange < -0.05) { // 1分钟跌5%
            //     console.log("🚨 检测到瀑布，触发紧急避险，暂不重组");
            //     return "EXIT_OR_WAIT";
            // }

            // if (isOutOfRange && fees > cost * 3) {
            //     return "REBALANCE";
            // }
            
            return "HOLD";
        }
    }

    
    
    // 1. 检查是否出界
    
    
    // 2. 检查收益是否覆盖成本 (伪代码)
    
    
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 在 min 和 max 秒之间随机休眠
 */
async function randomSleep(min: number, max: number) {
    const ms = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
    console.log(`💤 随机休眠 ${ms / 1000} 秒...`);
    await sleep(ms);
}