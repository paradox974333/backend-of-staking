// generateAdminWallet.js
const { generateEthereumWallet, encryptPrivateKey } = require('./ethereumWalletUtils');
const crypto = require('crypto');

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64) {
    const newEncryptionKey = crypto.randomBytes(32).toString('hex');
    console.warn('\n⚠️ WARNING: ENCRYPTION_KEY is not set or invalid in your .env file.');
    console.warn(`Consider adding this to your .env: ENCRYPTION_KEY=${newEncryptionKey}`);
    console.warn('Store this key securely!');
    console.warn('⚠️ This key is CRITICAL for decrypting user private keys.');
} else {
    console.log('\n✅ Existing ENCRYPTION_KEY found.');
}

(async () => {
  try {
      const wallet = await generateEthereumWallet();
      console.log('\n✅ New Admin Wallet Generated (Ethereum)');
      console.log('-------------------------------------------');
      console.log('📥 Admin Wallet Address:', wallet.address);
      console.log('   (Copy this value to ADMIN_WALLET_ADDRESS in your .env file)');
      console.log('\n🔐 Encrypted Private Key:', wallet.encryptedPrivateKey);
      console.log('   (Store this value SECURELY and OFFLINE for disaster recovery. Do NOT expose this in production.)');
       console.log('   (This encrypted key is NOT needed in the running application, only the address is.)');
      console.log('-------------------------------------------');
  } catch (error) {
      console.error('❌ Failed to generate admin wallet:', error);
  }
})();