// depositListener.js
const { ethers } = require('ethers');
const User = require('./user');
const { getPriceInUSD } = require('./priceFetcher');
const { sweepWallet, isValidEthereumAddress, provider: staticProvider } = require('./ethereumWalletUtils'); // Import static provider for waitForTransaction
const { notifyAdminOfError } = require('./errorNotifier');
const ERC20_ABI = require('./erc20_abi.json');

const ALCHEMY_WEBSOCKET_URL = process.env.ALCHEMY_WEBSOCKET_URL;
const INFURA_WEBSOCKET_URL = process.env.INFURA_WEBSOCKET_URL;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY; // Used by ethers internally sometimes

const NETWORK = process.env.BLOCKCHAIN_NETWORK || 'mainnet';

const CONFIRMATIONS_REQUIRED = parseInt(process.env.CONFIRMATIONS_REQUIRED || '12', 10);
const MIN_DEPOSIT_USD = parseFloat(process.env.MIN_DEPOSIT_USD || '5.00');
const USER_ADDRESS_REFRESH_INTERVAL_MS = parseInt(process.env.USER_ADDRESS_REFRESH_INTERVAL_MS || '600000', 10); // 10 minutes
const CONFIRMATION_CHECK_INTERVAL_MS = parseInt(process.env.CONFIRMATION_CHECK_INTERVAL_MS || '30000', 10); // 30 seconds
const CREDITS_HISTORY_LIMIT = parseInt(process.env.CREDITS_HISTORY_LIMIT || '1000', 10);


let provider; // This will hold the WebSocketProvider instance
let userAddresses = new Set();
let confirmationMonitorInterval = null;
let userAddressRefreshInterval = null;
let websocketProviderConnected = false; // Simple flag to track perceived connection state

// Need a provider for waitForTransaction, using the static provider from ethereumWalletUtils
// This provider uses a HTTP/RPC connection, which is more stable for polling/waiting
const httpProvider = staticProvider; // Alias for clarity


async function loadUserAddresses() {
    try {
        // Only fetch wallet addresses for active users
        const users = await User.find({ isActive: true }).select('walletAddress');
        const newAddresses = new Set();
        users.forEach(user => {
            if (isValidEthereumAddress(user.walletAddress)) {
                newAddresses.add(user.walletAddress.toLowerCase());
            } else {
                 // Log invalid addresses found in DB
                 console.warn(`⚠️ Invalid wallet address format found in DB for user: ${user._id}`);
            }
        });

        // Check for significant changes (optional, for logging)
        if (userAddresses.size !== newAddresses.size) {
             console.log(`🔄 Refreshed user addresses cache. Count changed from ${userAddresses.size} to ${newAddresses.size}`);
        } else {
             // console.log(`🔄 Refreshed user addresses cache. Count: ${newAddresses.size}`);
        }
        userAddresses = newAddresses;

    } catch (err) {
        console.error('❌ Failed to load user addresses for listener:', err);
         await notifyAdminOfError('Deposit Listener Error', err, 'Failed to load user addresses from DB.');
    }
}

async function processConfirmedDeposit(depositTxHash) {
    try {
        const user = await User.findOne({ 'deposits.txHash': depositTxHash }).select('_id username credits creditsHistory deposits privateKey');
        if (!user) {
            console.warn(`Confirmed deposit ${depositTxHash} - User not found in DB.`);
            return;
        }

        const depositEntryIndex = user.deposits.findIndex(d => d.txHash === depositTxHash);
        if (depositEntryIndex === -1) {
             console.warn(`Confirmed deposit ${depositTxHash} - Entry not found in user document.`);
             return;
        }
        const depositEntry = user.deposits[depositEntryIndex];

         if (depositEntry.status === 'credited' || depositEntry.status === 'failed') {
             // This can happen if cron job runs before websocket listener processes
             console.log(`Deposit ${depositTxHash} already processed (${depositEntry.status}). Skipping.`);
             return;
         }

        console.log(`✅ Deposit ${depositTxHash} confirmed. Processing credit and sweep for user ${user.username} (${user._id})...`);

        const creditsToAdd = depositEntry.usdValue;
        const amountToSweep = depositEntry.cryptoAmount; // This is the amount of crypto received
        const assetToSweep = depositEntry.asset; // This is the asset symbol ('ETH' or 'USDT')

        // Perform atomic update for credits and status change
        const updateResult = await User.findByIdAndUpdate(
            user._id,
            {
                $inc: { credits: creditsToAdd },
                $set: {
                    [`deposits.${depositEntryIndex}.status`]: 'credited',
                    [`deposits.${depositEntryIndex}.creditedAt`]: new Date()
                },
                $push: {
                     creditsHistory: {
                        $each: [{ // Use $each for multiple or a single push with sorting capability
                            type: 'deposit',
                            amount: creditsToAdd,
                            reason: `Deposit of ${amountToSweep.toFixed(6)} ${assetToSweep} (Tx: ${depositTxHash})`,
                            date: new Date()
                        }],
                        $sort: { date: 1 } // Maintain date order if needed before slicing
                    }
                }
            },
            { new: true, select: '_id username credits deposits creditsHistory' }
        );

        if (!updateResult) {
            console.error(`Failed atomic update for user ${user._id} for deposit ${depositTxHash}.`);
             await notifyAdminOfError('Deposit Processing Error', new Error('Atomic update failed'), `User ID: ${user._id}, TxHash: ${depositTxHash}. Failed to credit user/update status.`);
             return; // Exit if update failed
        }

        // Manually trim history AFTER the update if needed (can't easily slice in $push with sorting)
        if (updateResult.creditsHistory.length > CREDITS_HISTORY_LIMIT) {
            updateResult.creditsHistory = updateResult.creditsHistory.slice(-CREDITS_HISTORY_LIMIT); // Keep the last N
            await updateResult.save().catch(saveErr => {
                console.error(`Error saving user history after deposit credit ${user._id}:`, saveErr);
                // Log the error but don't fail the main response, as the credits/deposit update succeeded.
            });
        }


        console.log(`✅ User ${updateResult.username} (${updateResult._id}) credited with ${creditsToAdd.toFixed(2)} credits for deposit ${depositTxHash}. Status set to 'credited'.`);

        // --- Sweep Logic ---
        // Only attempt sweep if the admin wallet address and user private key are available
        if (!process.env.ADMIN_WALLET_ADDRESS) {
            console.warn(`ADMIN_WALLET_ADDRESS not set. Skipping sweep for user ${user.username} (${user._id}) post-credit.`);
             await notifyAdminOfError('Admin Wallet Not Configured', null, `User ${user.username} (${user._id}) deposited, but ADMIN_WALLET_ADDRESS is not set. Manual sweep may be required for Tx: ${depositTxHash}`);
             return; // Sweep skipped
        }

        if (!user.privateKey) {
             console.error(`Private key missing for user ${user.username} (${user._id}). Cannot sweep.`);
             await notifyAdminOfError('User Private Key Missing', null, `User ${user.username} (${user._id}) deposited (Tx: ${depositTxHash}), but their private key is not stored in DB. Manual sweep required.`);
             return; // Sweep skipped
        }

        console.log(`Attempting to sweep ${assetToSweep} from ${user.username}'s wallet...`);
        try {
            const sweepResult = await sweepWallet(user.privateKey, process.env.ADMIN_WALLET_ADDRESS, assetToSweep);

            // Need to refetch or update the user document after atomic update to access the updated deposits array
            // or simply find the deposit entry by id again from the updatedUser object.
            const depositEntryAfterUpdate = updatedUser.deposits.find(d => d.txHash === depositTxHash);
            if (!depositEntryAfterUpdate) {
                 console.error(`Could not find deposit entry ${depositTxHash} in user document after crediting. Cannot record sweep TX.`);
                 // Don't return, the crediting succeeded, but log and notify
                 await notifyAdminOfError('Deposit Sweep TX Recording Error', new Error('Deposit entry not found after update'), `User: ${user.username} (${user._id}), TxHash: ${depositTxHash}. Sweep likely happened, but TX hash could not be recorded in DB.`);
            } else {
                 if (sweepResult.success) {
                     console.log(`🧹 Swept ${assetToSweep} from ${user.username}. Sweep Tx: ${sweepResult.txHash}`);
                     depositEntryAfterUpdate.sweepTxHash = sweepResult.txHash; // Store sweep tx hash on the object
                 } else {
                     console.error(`- Sweep failed for ${user.username} (${user._id}) after crediting (${assetToSweep}): ${sweepResult.reason || 'unknown'}. NOTIFY ADMIN!`);
                     depositEntryAfterUpdate.sweepError = sweepResult.reason || 'unknown sweep failure';
                     if (sweepResult.reason === 'insufficient_eth_for_gas') {
                          await notifyAdminOfError('USDT Sweep Requires Gas (Post-Credit)', new Error(sweepResult.reason), `User: ${user.username} (${user._id}) received ${creditsToAdd.toFixed(2)} credits for ${assetToSweep} Tx: ${depositTxHash}, but sweep failed due to insufficient ETH for gas. Admin must manually sweep!`);
                     } else {
                          await notifyAdminOfError('Deposit Sweep Failed (Post-Credit)', new Error(sweepResult.reason || 'unknown sweep failure'), `User: ${user.username} (${user._id}) received ${creditsToAdd.toFixed(2)} credits for ${assetToSweep} Tx: ${depositTxHash}, but sweep failed. Admin must manually sweep! Reason: ${sweepResult.reason}`);
                     }
                 }
                 // Save again to record sweep details (tx hash or error)
                 await updatedUser.save().catch(saveErr => {
                      console.error(`Error saving user ${user._id} sweep details:`, saveErr);
                      notifyAdminOfError('Deposit Sweep Details Save Error', saveErr, `Failed to save sweep details for user ${user._id}, TxHash: ${depositTxHash}.`).catch(console.error);
                 });
            }


        } catch (sweepError) {
            console.error(`- CRITICAL Exception during Sweep for user ${user.username} (${user._id}) post-credit: ${sweepError.message}. NOTIFY ADMIN!`);
            await notifyAdminOfError('Critical Sweep Exception (Post-Credit)', sweepError, `User: ${user.username} (${user._id}) received ${creditsToAdd.toFixed(2)} credits for ${assetToSweep} Tx: ${depositTxHash}, but sweep failed unexpectedly.`);
            // Attempt to save the user document to at least record the credited status, even if sweep details are missing
             if (updateResult && updateResult.isModified()) { // Check if anything else was modified before the save attempt above
                  await updateResult.save().catch(saveErr => {
                       console.error(`Error saving user ${user._id} after sweep exception:`, saveErr);
                       notifyAdminOfError('Deposit Processing Save Error After Sweep Exception', saveErr, `Failed to save user ${user._id} after critical sweep exception for TxHash: ${depositTxHash}.`).catch(console.error);
                  });
             }
        }

    } catch (err) {
        console.error(`❌ Error processing confirmed deposit ${depositTxHash}:`, err);
         await notifyAdminOfError('Deposit Confirmation Processing Error', err, `TxHash: ${depositTxHash}. Failed during credit or save.`);
    }
}


async function monitorConfirmations() {
    if (!websocketProviderConnected) {
        // Only run if the websocket provider is believed to be connected
        return;
    }

    try {
        const pendingDeposits = await User.aggregate([
            { $match: { 'deposits.status': { $in: ['unconfirmed', 'confirmed'] } } },
            { $unwind: '$deposits' },
            { $match: { 'deposits.status': { $in: ['unconfirmed', 'confirmed'] } } },
            { $project: {
                _id: 0,
                userId: '$_id',
                txHash: '$deposits.txHash',
                status: '$deposits.status'
            }}
        ]);

        if (pendingDeposits.length === 0) {
            return;
        }
        // console.log(`Monitoring ${pendingDeposits.length} pending deposits...`);

        // Use the httpProvider which is better for polling/waiting
        const confirmationPromises = pendingDeposits.map(async (deposit) => {
            try {
                if (deposit.status === 'unconfirmed') {
                     // Use httpProvider for waitForTransaction
                     const receipt = await httpProvider.waitForTransaction(deposit.txHash, CONFIRMATIONS_REQUIRED, 600000); // Timeout after 10 mins

                     if (receipt && receipt.confirmations >= CONFIRMATIONS_REQUIRED) {
                         console.log(`🎉 Deposit ${deposit.txHash} reached ${receipt.confirmations} confirmations.`);

                         // Find the user and update the deposit status to 'confirmed'
                         const user = await User.findOne({ 'deposits.txHash': deposit.txHash }).select('deposits');
                         if (user) {
                             const depositEntry = user.deposits.find(d => d.txHash === deposit.txHash);
                             if (depositEntry && depositEntry.status === 'unconfirmed') {
                                depositEntry.status = 'confirmed';
                                depositEntry.confirmedAt = new Date();
                                depositEntry.blockNumber = receipt.blockNumber;
                                await user.save();
                                console.log(`Deposit ${deposit.txHash} status updated to 'confirmed'. Ready for processing.`);
                                // Trigger processing now that it's confirmed
                                // Use setImmediate to not block the confirmation monitor loop
                                setImmediate(() => processConfirmedDeposit(deposit.txHash).catch(console.error));

                               } else {
                                   console.log(`Deposit ${deposit.txHash} status already ${depositEntry.status}.`);
                               }
                            } else {
                                console.warn(`User not found for confirmed deposit ${deposit.txHash}`);
                                // This case is unlikely if recordDetectedDeposit worked, but good to handle
                           }

                       } else if (receipt === null) {
                           // Transaction not found or confirmed within the timeout
                           console.warn(`⏳ Deposit ${deposit.txHash} not found or confirmed within timeout (${CONFIRMATIONS_REQUIRED} confs). Marking as failed.`);
                           const user = await User.findOne({ 'deposits.txHash': deposit.txHash }).select('deposits');
                           if (user) {
                               const depositEntry = user.deposits.find(d => d.txHash === deposit.txHash);
                               if (depositEntry && depositEntry.status === 'unconfirmed') { // Ensure it wasn't processed elsewhere
                                   depositEntry.status = 'failed';
                                   depositEntry.error = 'Transaction not found or confirmed within timeout';
                                   await user.save();
                                   console.log(`Deposit ${deposit.txHash} status updated to 'failed'.`);
                                    await notifyAdminOfError('Deposit Confirmation Timeout', new Error('Transaction not confirmed within timeout'), `TxHash: ${deposit.txHash}. User ID: ${user._id}.`);
                               }
                           }
                       }
                   } else if (deposit.status === 'confirmed') {
                       // If status is already 'confirmed', it means it was previously marked but processing might have failed
                       // Re-trigger processing in case it failed the first time after status update
                        console.log(`Attempting to re-process already 'confirmed' deposit ${deposit.txHash}...`);
                        setImmediate(() => processConfirmedDeposit(deposit.txHash).catch(console.error));
                   }

            } catch (txCheckErr) {
                console.error(`❌ Error checking confirmations for ${deposit.txHash}:`, txCheckErr.message);
                 // Don't spam admin for transient network errors during check, maybe add a retry/threshold logic later
                 // await notifyAdminOfError('Deposit Confirmation Check Error', txCheckErr, `TxHash: ${deposit.txHash}.`);
            }
        });

        await Promise.allSettled(confirmationPromises); // Use allSettled to ensure all promises run even if some fail

    } catch (err) {
        console.error('❌ Critical error in confirmation monitor:', err);
         await notifyAdminOfError('Deposit Confirmation Monitor Failed', err);
    }
}


async function startDepositListener() {
    const websocketUrl = ALCHEMY_WEBSOCKET_URL || INFURA_WEBSOCKET_URL;

    if (!websocketUrl) {
        console.error('❌ FATAL: No blockchain WebSocket provider URL configured. Set ALCHEMY_WEBSOCKET_URL or INFURA_WEBSOCKET_URL in .env.');
        await notifyAdminOfError('Deposit Listener Fatal Error', new Error('No WebSocket Provider URL'), 'Blockchain WebSocket URL not configured.');
        // Consider exiting the process or marking the listener as permanently failed if this is a startup error
        return;
    }

     if (!process.env.ADMIN_WALLET_ADDRESS) {
         console.warn("⚠️ ADMIN_WALLET_ADDRESS not set. Sweep functionality will be unavailable.");
     }
     // USDT_CONTRACT_ADDRESS warning is handled later when setting up listener


    try {
        // Instantiate the WebSocket provider
        provider = new ethers.WebSocketProvider(websocketUrl, NETWORK);
        console.log(`Attempting to connect to WebSocket provider for ${NETWORK}...`);

        // Add a debug listener for more verbosity if needed
        provider.on("debug", (info) => {
             if (process.env.NODE_ENV !== 'production') console.debug("🔌 WebSocket provider debug:", info);
        });

        // Set up the error handler BEFORE attaching other listeners
        // This is the primary way to detect disconnection/failure in v6 WebSocketProvider
        provider.on("error", async (error) => {
             console.error("🔌 WebSocket provider error:", error.message);
             websocketProviderConnected = false; // Mark state as disconnected

             // Clean up existing listeners and intervals to prevent duplicates/zombies
             if (userAddressRefreshInterval) { clearInterval(userAddressRefreshInterval); userAddressRefreshInterval = null; }
             if (confirmationMonitorInterval) { clearInterval(confirmationMonitorInterval); confirmationMonitorInterval = null; }
             if (provider) {
                 provider.removeAllListeners(); // Removes 'block', 'Transfer', etc.
                 // Destroying the provider often cleans up the underlying connection resources
                 provider.destroy(); // Note: destroy might also emit 'error' depending on state
                 provider = null; // Clear the provider reference
             }
             console.log("Attempting to restart deposit listener in 5 seconds...");
             // Schedule a retry attempt
             setTimeout(startDepositListener, 5000);

             // Notify admin only for significant/persistent errors.
             // For development, notifying all errors is fine. For production, consider error rate limiting.
             await notifyAdminOfError('WebSocket Provider Connection Error', error, `Blockchain WebSocket connection failed. Attempting reconnect.`);
        });

        // --- Setup logic previously inside the removed "connect" listener ---
        // This code runs immediately after the provider instance is created.
        // The provider internally manages connecting in the background.
        // The event listeners attached below will start receiving events once the connection is active.

         await loadUserAddresses(); // Load addresses initially for the first check

        // Start interval timers *after* successful provider instantiation
         userAddressRefreshInterval = setInterval(loadUserAddresses, USER_ADDRESS_REFRESH_INTERVAL_MS);
         console.log(`Started user address refresh interval (${USER_ADDRESS_REFRESH_INTERVAL_MS / 1000}s)`);

         confirmationMonitorInterval = setInterval(monitorConfirmations, CONFIRMATION_CHECK_INTERVAL_MS);
         console.log(`Started confirmation monitor interval (${CONFIRMATION_CHECK_INTERVAL_MS / 1000}s)`);

        console.log("Setting up block and event listeners...");

        // Listen for new blocks (primarily for ETH deposits)
        provider.on("block", async (blockNumber) => {
            if (!websocketProviderConnected || !provider) { // Check flags/provider state
                // console.log(`Ignoring block ${blockNumber}, provider not connected.`);
                return;
            }
            // console.log(`New block received: ${blockNumber}`);
            try {
                const block = await provider.getBlock(blockNumber, true); // Fetch block with transactions
                if (!block || !block.transactions) return;

                for (const tx of block.transactions) {
                    // Check if the 'to' address is one of our user wallet addresses and it's an ETH transfer (value > 0)
                    if (tx.to && userAddresses.has(tx.to.toLowerCase()) && tx.value > 0n) {
                        const ethAmount = parseFloat(ethers.formatEther(tx.value));
                        console.log(`💰 Potential ETH deposit detected in block ${blockNumber}: Tx ${tx.hash} to ${tx.to} (${ethAmount} ETH)`);
                        // Use setImmediate to avoid blocking the block listener loop
                        setImmediate(() => recordDetectedDeposit(tx.hash, 'ETH', ethAmount, tx.from, tx.to, blockNumber).catch(console.error));
                    }
                }
            } catch (blockErr) {
                console.error(`❌ Error processing new block ${blockNumber}:`, blockErr.message);
                // Log block processing errors, but maybe don't notify admin unless they are persistent
                 notifyAdminOfError('Deposit Listener Block Processing Error', blockErr, `Error processing block ${blockNumber} for ETH deposits.`).catch(console.error);
            }
        });


        // Listen for USDT transfers if contract address is configured
        const usdtContractAddress = process.env.USDT_CONTRACT_ADDRESS;
        if (usdtContractAddress && isValidEthereumAddress(usdtContractAddress)) {
            try {
                 const usdtContract = new ethers.Contract(usdtContractAddress, ERC20_ABI, provider);
                 // Create a filter to only listen for 'Transfer' events where the 'to' address is in our set of user addresses
                 // This is more efficient than fetching all Transfer events and filtering client-side.
                 const toAddressesArray = Array.from(userAddresses);
                 if (toAddressesArray.length > 0) {
                      const filter = usdtContract.filters.Transfer(null, toAddressesArray); // Filter by 'to' address
                      console.log(`Listening for USDT transfers to ${toAddressesArray.length} user addresses on ${usdtContractAddress}...`);

                       usdtContract.on(filter, async (from, to, amount, event) => {
                           if (!websocketProviderConnected || !provider) { // Check flags/provider state
                                // console.log(`Ignoring USDT event, provider not connected.`);
                               return;
                           }
                            console.log(`💰 Potential USDT deposit detected: Tx ${event.log.transactionHash} to ${to}`);
                           try {
                               // The event provides the amount and necessary transaction info directly in event.log
                               const usdtAmount = parseFloat(ethers.formatUnits(amount, 6)); // Assuming 6 decimals for USDT based on typical USDT ABI

                               if (usdtAmount > 0) {
                                   // Use setImmediate to avoid blocking the event listener
                                    setImmediate(() => recordDetectedDeposit(event.log.transactionHash, 'USDT', usdtAmount, from, to, event.log.blockNumber).catch(console.error));
                               } else {
                                    console.log(`Ignoring zero-amount USDT transfer: ${event.log.transactionHash}`);
                               }
                           } catch (processErr) {
                               console.error(`❌ Error processing USDT event ${event.log.transactionHash}:`, processErr.message);
                                await notifyAdminOfError('Deposit Listener USDT Event Processing Error', processErr, `TxHash: ${event.log.transactionHash}. Failed processing USDT transfer event.`);
                           }
                       });
                      console.log(`✅ Started listening for new blocks and filtered USDT transfers.`);
                 } else {
                      console.warn('⚠️ No user wallet addresses loaded. Skipping USDT event listener setup.');
                 }

            } catch (contractErr) {
                 console.error(`❌ Error setting up USDT contract listener on address ${usdtContractAddress}:`, contractErr.message);
                 await notifyAdminOfError('USDT Listener Setup Error', contractErr, `Failed to set up USDT contract listener on address ${usdtContractAddress}.`);
            }
        } else {
            console.warn('⚠️ USDT_CONTRACT_ADDRESS not set or invalid. USDT deposits will not be detected by listener.');
        }

        // Set the connected flag after all listeners and intervals are set up
        websocketProviderConnected = true;
        console.log(`✅ Deposit listener successfully initialized and running.`);


    } catch (err) {
        console.error('❌ Failed to create WebSocket provider instance or initialize listeners:', err);
         websocketProviderConnected = false; // Ensure flag is false on initial failure
        console.log("Attempting to restart deposit listener in 5 seconds after initial failure...");
        setTimeout(startDepositListener, 5000); // Retry connection attempt
         await notifyAdminOfError('Failed to Start Deposit Listener', err, 'Error during initial setup of deposit listener.');
    }
}

async function recordDetectedDeposit(txHash, asset, cryptoAmount, fromAddress, toAddress, blockNumber) {
    try {
        // Use findOneAndUpdate with upsert: true might seem tempting, but can be complex
        // Standard findOne and then update/save is safer for this logic.
        const existingDeposit = await User.findOne({ 'deposits.txHash': txHash }).select('_id');

        if (existingDeposit) {
             // Deposit already exists for *any* user, likely already processed or being processed
             //console.log(`Deposit Tx ${txHash} already exists in DB. Skipping recording.`);
            return;
        }

        const user = await User.findOne({ walletAddress: toAddress.toLowerCase() }).select('_id username deposits');
        if (!user) {
            // This could happen if a user's wallet address was generated but they are deleted before depositing.
            // Or if the userAddresses cache is stale, but the interval should mitigate this.
            console.warn(`Detected deposit Tx ${txHash} to address ${toAddress}, but no matching user found in DB.`);
             await notifyAdminOfError('Deposit to Unassigned Address', null, `Detected deposit Tx ${txHash} for ${cryptoAmount} ${asset} to address ${toAddress}, but no user has this wallet address.`);
            return;
        }

        console.log(`✍️ Recording potential deposit Tx ${txHash} for user ${user.username} (${user._id})...`);

        let usdValue = 0;
        try {
            const price = await getPriceInUSD(asset);
            if (price > 0) {
                 usdValue = Math.floor((cryptoAmount * price) * 100) / 100; // Floor to 2 decimal places for USD value
            } else {
                console.warn(`Could not get valid price for ${asset} for Tx ${txHash}. USD value set to 0.`);
                 // Notify admin if price fetch fails specifically during deposit recording
                 await notifyAdminOfError('Deposit Price Fetch Failed (Recording)', null, `Could not get price for ${asset} for deposit Tx ${txHash}. User: ${user.username}. USD value set to 0 for now.`);
            }
        } catch (priceErr) {
            console.error(`❌ Failed to get price for ${asset} for Tx ${txHash}:`, priceErr.message);
             await notifyAdminOfError('Deposit Price Fetch Error (Recording)', priceErr, `Failed to get price for ${asset} for deposit Tx ${txHash}. User: ${user.username}. USD value set to 0 for now.`);
            usdValue = 0;
        }

        if (usdValue < MIN_DEPOSIT_USD) {
             console.log(`Ignoring deposit Tx ${txHash} for user ${user.username}: USD value ${usdValue.toFixed(2)} below minimum ${MIN_DEPOSIT_USD}.`);
             return;
        }

         // Add the new deposit entry
         user.deposits.push({
             txHash,
             asset,
             cryptoAmount,
             usdValue,
             blockNumber,
             fromAddress,
             toAddress,
             status: 'unconfirmed', // Always start as unconfirmed
             detectedAt: new Date()
         });

        await user.save();
        console.log(`✅ Deposit Tx ${txHash} recorded as 'unconfirmed' for user ${user.username}. Estimated value: $${usdValue.toFixed(2)}`);

    } catch (err) {
        console.error(`❌ Error recording detected deposit Tx ${txHash}:`, err);
         await notifyAdminOfError('Deposit Recording Error', err, `Failed to record deposit Tx ${txHash}. Asset: ${asset}, Amount: ${cryptoAmount}, To: ${toAddress}.`);
    }
}


function initializeDepositListener() {
  console.log('👂 Initializing blockchain deposit listener...');

  // Load addresses once at startup. The interval will keep it updated.
  loadUserAddresses().then(() => {
      startDepositListener(); // Then attempt to start the listener
  }).catch(err => {
      console.error('FATAL: Failed to load user addresses at startup. Cannot start listener.', err);
       notifyAdminOfError('FATAL: Failed to Load User Addresses', err, 'Server cannot start deposit listener without user addresses.');
      // Decide if you want to exit the process here if initial address load fails.
      // process.exit(1); // Uncomment to exit on this critical startup failure
  });
}

function shutdownDepositListener() {
  console.log('🛑 Shutting down deposit listener...');
  if (userAddressRefreshInterval) { clearInterval(userAddressRefreshInterval); userAddressRefreshInterval = null; }
  if (confirmationMonitorInterval) { clearInterval(confirmationMonitorInterval); confirmationMonitorInterval = null; }
  if (provider) {
      provider.removeAllListeners();
      provider.destroy();
      provider = null; // Clear provider reference
  }
  websocketProviderConnected = false;
  console.log('🔌 WebSocket provider destroyed.');
}

module.exports = {
  initializeDepositListener,
  shutdownDepositListener,
  // Keep processConfirmedDeposit exported if it's called by other modules (like cron jobs)
  processConfirmedDeposit,
};