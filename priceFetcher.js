// priceFetcher.js
const axios = require('axios');

const COINGECKO_API_URL = 'https://api.coingecko.com/api/v3/simple/price';

const ASSET_IDS = {
  ETH: 'ethereum',
  USDT: 'tether',
};

const priceCache = {
  data: {},
  ttl: parseInt(process.env.PRICE_CACHE_TTL_MS || '60000', 10),
};

async function getPriceInUSD(assetSymbol) {
  const now = Date.now();
  const key = assetSymbol.toUpperCase();

  if (priceCache.data[key] && (now - priceCache.data[key].timestamp < priceCache.ttl)) {
    return priceCache.data[key].price;
  }

  const assetId = ASSET_IDS[key];
  if (!assetId) {
    console.error(`Unsupported asset symbol for price fetching: ${assetSymbol}`);
    throw new Error(`Unsupported asset for price: ${assetSymbol}`);
  }

  try {
    const response = await axios.get(COINGECKO_API_URL, {
      params: {
        ids: assetId,
        vs_currencies: 'usd',
      },
      timeout: 5000
    });

    const price = response.data[assetId]?.usd;

    if (typeof price !== 'number' || price <= 0) {
       console.error(`Received invalid price for ${assetSymbol} from API:`, response.data);
       if (priceCache.data[key]) {
           console.warn(`Using stale cache for ${key} due to invalid API response.`);
           return priceCache.data[key].price;
       }
       throw new Error(`Price not found or invalid for ${assetSymbol} in API response.`);
    }

    priceCache.data[key] = { price, timestamp: now };
    console.log(`- Fetched and cached price for ${assetSymbol}: $${price.toFixed(2)}`);
    return price;

  } catch (error) {
    console.error(`Failed to fetch price for ${assetSymbol}:`, error.message);
     if (priceCache.data[key]) {
        console.warn(`Using stale cache for ${key} due to API fetch failure.`);
        return priceCache.data[key].price;
     }
    throw new Error(`Could not fetch price for ${assetSymbol}.`);
  }
}

module.exports = { getPriceInUSD };