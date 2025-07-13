// ethereumWalletUtils.js
const { ethers } = require('ethers');
const crypto = require('crypto');
const dotenv = require('dotenv');
const axios = require('axios');
const ERC20_ABI = require('./erc20_abi.json');

dotenv.config();

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const INFURA_PROJECT_ID = process.env.INFURA_PROJECT_ID;

let provider;
if (ALCHEMY_API_KEY) {
  provider = new ethers.AlchemyProvider('mainnet', ALCHEMY_API_KEY);
  console.log('✅ Using Alchemy provider.');
} else if (INFURA_PROJECT_ID) {
   provider = new ethers.InfuraProvider('mainnet', INFURA_PROJECT_ID);
   console.log('✅ Using Infura provider.');
} else {
   console.error('❌ FATAL: No blockchain provider configured. Set ALCHEMY_API_KEY or INFURA_PROJECT_ID in .env.');
   process.exit(1);
}

const GAS_PRICE_CACHE = { data: null, timestamp: 0, ttl: 60 * 1000 };

async function getGasPrice() {
    const now = Date.now();
    if (GAS_PRICE_CACHE.data && (now - GAS_PRICE_CACHE.timestamp < GAS_PRICE_CACHE.ttl)) {
        return GAS_PRICE_CACHE.data;
    }

    try {
        const feeData = await provider.getFeeData();

        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
             const gasPrices = {
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
                maxFeePerGas: feeData.maxFeePerGas,
                type: 2
             };
             GAS_PRICE_CACHE.data = gasPrices;
             GAS_PRICE_CACHE.timestamp = now;
             return gasPrices;
        } else if (feeData.gasPrice) {
             console.warn('EIP-1559 fee data not available, falling back to legacy gas price.');
             const gasPrices = {
                 gasPrice: feeData.gasPrice,
                 type: 0
             };
             GAS_PRICE_CACHE.data = gasPrices;
             GAS_PRICE_CACHE.timestamp = now;
             return gasPrices;
        } else {
            throw new Error('Could not fetch any gas price data.');
        }

    } catch (error) {
        console.error("Failed to fetch gas prices:", error.message);
        if (GAS_PRICE_CACHE.data) {
             console.warn('Using stale gas price cache due to fetch failure.');
             return GAS_PRICE_CACHE.data;
        }
        throw new Error('Failed to obtain gas price data.');
    }
}

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  console.error('ERROR: ENCRYPTION_KEY must be a 64-character hex string. Generate one and add it to your .env');
  process.exit(1);
}

function encryptPrivateKey(privateKey) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptPrivateKey(encryptedPrivateKey) {
  try {
    const textParts = encryptedPrivateKey.split(':');
    const iv = Buffer.from(textParts[0], 'hex');
    const encryptedText = Buffer.from(textParts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (error) {
     console.error('Failed to decrypt private key:', error.message);
     throw new Error('Decryption failed.');
  }
}

async function generateEthereumWallet() {
  try {
    const wallet = ethers.Wallet.createRandom();
    return {
      address: wallet.address,
      encryptedPrivateKey: encryptPrivateKey(wallet.privateKey),
    };
  } catch (error) {
    console.error('Ethereum wallet generation failed:', error);
    throw new Error('Failed to generate Ethereum wallet.');
  }
}

async function getWalletBalances(address) {
  try {
    const usdtContractAddress = process.env.USDT_CONTRACT_ADDRESS;
    if (!usdtContractAddress) {
        const ethBalanceWei = await provider.getBalance(address);
        const ethBalance = parseFloat(ethers.formatEther(ethBalanceWei));
        return { ethBalance, usdtBalance: 0 };
    }

     if (!ethers.isAddress(usdtContractAddress)) {
         console.error(`Invalid USDT_CONTRACT_ADDRESS: ${usdtContractAddress}`);
         const ethBalanceWei = await provider.getBalance(address);
         const ethBalance = parseFloat(ethers.formatEther(ethBalanceWei));
         return { ethBalance, usdtBalance: 0 };
     }

    const usdtContract = new ethers.Contract(usdtContractAddress, ERC20_ABI, provider);

    const [ethBalanceWei, usdtBalanceRaw] = await Promise.all([
      provider.getBalance(address),
      usdtContract.balanceOf(address)
    ]);

    const ethBalance = parseFloat(ethers.formatEther(ethBalanceWei));
    const usdtBalance = parseFloat(ethers.formatUnits(usdtBalanceRaw, 6));

    return { ethBalance, usdtBalance };
  } catch (error) {
    console.error(`Failed to get balances for ${address}:`, error.message);
    return { ethBalance: 0, usdtBalance: 0 };
  }
}

async function sweepWallet(encryptedPrivateKey, toAddress, asset) {
  let privateKey;
  try {
     privateKey = decryptPrivateKey(encryptedPrivateKey);
  } catch (err) {
      console.error(`Failed to decrypt private key for sweep: ${err.message}`);
      return { success: false, reason: 'decryption_failed' };
  }

  let wallet;
  try {
     wallet = new ethers.Wallet(privateKey, provider);
  } catch (err) {
      console.error(`Invalid private key for sweep: ${err.message}`);
      return { success: false, reason: 'invalid_private_key' };
  }

  if (!ethers.isAddress(toAddress)) {
      console.error(`Invalid destination address for sweep: ${toAddress}`);
      return { success: false, reason: 'invalid_destination_address' };
  }

  try {
    if (asset.toUpperCase() === 'ETH') {
      return sweepEth(wallet, toAddress);
    } else if (asset.toUpperCase() === 'USDT') {
      return sweepUsdt(wallet, toAddress);
    } else {
      console.error(`Unsupported asset for sweeping: ${asset}`);
      return { success: false, reason: `unsupported_asset_${asset}` };
    }
  } catch (error) {
     console.error(`Sweep execution failed for ${asset} from ${wallet.address}:`, error.message);
     if (error.message.includes('insufficient funds')) {
         return { success: false, reason: 'insufficient_funds_for_tx' };
     }
     return { success: false, reason: `sweep_execution_error: ${error.message}` };
  }
}

async function sweepEth(wallet, toAddress) {
  const fromAddress = wallet.address;
  const [balance, gasPrices] = await Promise.all([
    provider.getBalance(fromAddress),
    getGasPrice()
  ]);

  const gasLimit = 21000n;

  let maxGasCost;
   if (gasPrices.type === 2) {
        maxGasCost = gasLimit * gasPrices.maxFeePerGas;
   } else {
        maxGasCost = gasLimit * gasPrices.gasPrice;
   }


  if (balance <= maxGasCost) {
    console.warn(`Sweep ETH for ${fromAddress}: Insufficient balance (${ethers.formatEther(balance)} ETH) to cover gas cost (${ethers.formatEther(maxGasCost)} ETH).`);
    return { success: false, reason: 'insufficient_for_gas' };
  }
  const amountToSend = balance - maxGasCost;

  const tx = {
    to: toAddress,
    value: amountToSend,
    gasLimit: gasLimit,
    type: gasPrices.type
  };
  if (gasPrices.type === 2) {
      tx.maxPriorityFeePerGas = gasPrices.maxPriorityFeePerGas;
      tx.maxFeePerGas = gasPrices.maxFeePerGas;
  } else {
      tx.gasPrice = gasPrices.gasPrice;
  }

  console.log(`Sweeping ${ethers.formatEther(amountToSend)} ETH from ${fromAddress} to ${toAddress}. Gas cost est: ${ethers.formatEther(maxGasCost)} ETH.`);

  const txResponse = await wallet.sendTransaction(tx);
  console.log(`ETH Sweep Tx sent: ${txResponse.hash}`);
  return { success: true, txHash: txResponse.hash };
}

async function sweepUsdt(wallet, toAddress) {
  const usdtContractAddress = process.env.USDT_CONTRACT_ADDRESS;
    if (!usdtContractAddress || !ethers.isAddress(usdtContractAddress)) {
       console.error('USDT_CONTRACT_ADDRESS is not set or invalid.');
       return { success: false, reason: 'usdt_contract_not_configured' };
    }

  const usdtContract = new ethers.Contract(usdtContractAddress, ERC20_ABI, wallet);

  const [usdtBalanceRaw, ethBalance, gasPrices] = await Promise.all([
        usdtContract.balanceOf(wallet.address),
        provider.getBalance(wallet.address),
        getGasPrice()
  ]);

  if (usdtBalanceRaw === 0n) {
      console.warn(`Sweep USDT for ${wallet.address}: Zero USDT balance.`);
      return { success: false, reason: 'zero_usdt_balance' };
  }

  const gasLimit = 65000n;
  let maxGasCost;
   if (gasPrices.type === 2) {
        maxGasCost = gasLimit * gasPrices.maxFeePerGas;
   } else {
        maxGasCost = gasLimit * gasPrices.gasPrice;
   }


  if (ethBalance < maxGasCost) {
    console.warn(`Sweep USDT for ${wallet.address}: Insufficient ETH for gas. Need ${ethers.formatEther(maxGasCost)} ETH, have ${ethers.formatEther(ethBalance)} ETH.`);
    return { success: false, reason: 'insufficient_eth_for_gas' };
  }

  console.log(`Sweeping ${ethers.formatUnits(usdtBalanceRaw, 6)} USDT from ${wallet.address} to ${toAddress}. ETH available for gas: ${ethers.formatEther(ethBalance)}`);

  const txOptions = {
    gasLimit: gasLimit,
    type: gasPrices.type
  };
   if (gasPrices.type === 2) {
      txOptions.maxPriorityFeePerGas = gasPrices.maxPriorityFeePerGas;
      txOptions.maxFeePerGas = gasPrices.maxFeePerGas;
   } else {
      txOptions.gasPrice = gasPrices.gasPrice;
   }

  const txResponse = await usdtContract.transfer(toAddress, usdtBalanceRaw, txOptions);
  console.log(`USDT Sweep Tx sent: ${txResponse.hash}`);
  return { success: true, txHash: txResponse.hash };
}


function isValidEthereumAddress(address) {
  try {
    ethers.getAddress(address);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  generateEthereumWallet,
  encryptPrivateKey,
  decryptPrivateKey,
  getWalletBalances,
  sweepWallet,
  isValidEthereumAddress,
  provider,
};