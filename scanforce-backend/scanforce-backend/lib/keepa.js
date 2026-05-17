/**
 * Keepa API Client
 * Handles product lookups, price history, and sales rank data
 * Docs: https://keepa.com/#!discuss/t/using-the-keepa-api/47
 */

const fetch = require('node-fetch');

class KeepaAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.keepa.com';
    this.tokensLeft = null;
  }

  /**
   * Look up products by ASIN
   * @param {string[]} asins - Up to 100 ASINs per request
   * @param {number} domain - 1=.com, 2=.co.uk, 3=.de, 4=.fr, 5=.co.jp, 6=.ca
   * @param {object} options
   */
  async getProducts(asins, domain = 1, options = {}) {
    if (!asins.length) return [];

    const params = new URLSearchParams({
      key: this.apiKey,
      domain: domain.toString(),
      asin: asins.join(','),
      // Data to include
      stats: options.stats || '90',         // Stats period in days
      history: options.history !== false ? '1' : '0',  // Price history
      offers: options.offers || '0',        // Marketplace offers
      rating: options.rating !== false ? '1' : '0',
      buybox: options.buybox !== false ? '1' : '0',
    });

    const url = `${this.baseUrl}/product?${params}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      const err = new Error(data.error.message || 'Keepa API error');
      err.status = data.error.type;
      throw err;
    }

    this.tokensLeft = data.tokensLeft;
    return (data.products || []).map(p => this._parseProduct(p));
  }

  /**
   * Parse Keepa product into usable format
   */
  _parseProduct(p) {
    const stats = p.stats || {};

    return {
      asin: p.asin,
      title: p.title || '',
      brand: p.brand || '',
      manufacturer: p.manufacturer || '',
      categoryId: p.rootCategory,
      categoryName: p.categoryTree?.[p.categoryTree.length - 1]?.name || '',
      // Current pricing (in cents for .com, convert to dollars)
      amazonPrice: this._keepaPriceToDollars(stats.current?.[0]),   // Amazon price
      newPrice: this._keepaPriceToDollars(stats.current?.[1]),       // Marketplace new
      usedPrice: this._keepaPriceToDollars(stats.current?.[2]),      // Marketplace used
      buyBoxPrice: this._keepaPriceToDollars(stats.current?.[18]),   // Buy Box
      // Sales rank
      bsr: stats.current?.[3] > 0 ? stats.current[3] : null,
      bsr30: stats.avg30?.[3] > 0 ? stats.avg30[3] : null,
      bsr90: stats.avg90?.[3] > 0 ? stats.avg90[3] : null,
      // Price stats (90-day)
      avgPrice90: this._keepaPriceToDollars(stats.avg90?.[0]),
      minPrice90: this._keepaPriceToDollars(stats.min90?.[0]),
      maxPrice90: this._keepaPriceToDollars(stats.max90?.[0]),
      // Buy box stats
      avgBuyBox90: this._keepaPriceToDollars(stats.avg90?.[18]),
      // Offer counts
      newOfferCount: stats.current?.[11] || null,
      // Ratings
      rating: p.csv?.[16] ? this._getLastValue(p.csv[16]) / 10 : null,
      reviewCount: p.csv?.[17] ? this._getLastValue(p.csv[17]) : null,
      // Product details
      packageWeight: p.packageWeight ? p.packageWeight / 100 : null, // grams to... keep grams
      packageWeightOz: p.packageWeight ? (p.packageWeight / 100) * 0.03527396 : null,
      itemWeight: p.itemWeight ? p.itemWeight / 100 : null,
      itemWeightOz: p.itemWeight ? (p.itemWeight / 100) * 0.03527396 : null,
      imageUrl: p.imagesCSV ? `https://images-na.ssl-images-amazon.com/images/I/${p.imagesCSV.split(',')[0]}` : null,
      // FBA
      fbaFees: p.fbaFees ? this._parseFBAFees(p.fbaFees) : null,
      isSNS: p.isSNS || false,
      isAddonItem: p.isAddonItem || false,
      // Price history (for charts)
      priceHistory: this._parsePriceHistory(p.csv),
      // Monthly sales estimate from Keepa
      monthlySold: p.monthlySold || null,
      // Timestamps
      lastUpdate: p.lastUpdate ? this._keepaTimeToDate(p.lastUpdate) : null,
      listedSince: p.listedSince ? this._keepaTimeToDate(p.listedSince) : null,
      source: 'keepa',
    };
  }

  /**
   * Parse Keepa CSV price history into chart-ready format
   * Keepa CSV format: [time, value, time, value, ...]
   * CSV indices: 0=Amazon, 1=New, 2=Used, 3=SalesRank, 11=NewOfferCount, 18=BuyBox
   */
  _parsePriceHistory(csv) {
    if (!csv) return { amazon: [], buyBox: [], salesRank: [], newPrice: [] };

    const parseTimeSeries = (arr, isDollars = true) => {
      if (!arr || !arr.length) return [];
      const points = [];
      for (let i = 0; i < arr.length; i += 2) {
        const time = arr[i];
        const value = arr[i + 1];
        if (time && value > 0) {
          points.push({
            date: this._keepaTimeToDate(time),
            value: isDollars ? value / 100 : value,
          });
        }
      }
      return points;
    };

    return {
      amazon: parseTimeSeries(csv[0], true),
      newPrice: parseTimeSeries(csv[1], true),
      salesRank: parseTimeSeries(csv[3], false),
      buyBox: parseTimeSeries(csv[18], true),
    };
  }

  /**
   * Keepa prices are in cents (for .com domain)
   */
  _keepaPriceToDollars(val) {
    if (val === undefined || val === null || val < 0) return null;
    return val / 100;
  }

  /**
   * Keepa timestamps: minutes since 2011-01-01
   */
  _keepaTimeToDate(keepaMinutes) {
    const epoch = new Date('2011-01-01T00:00:00Z').getTime();
    return new Date(epoch + keepaMinutes * 60000).toISOString().split('T')[0];
  }

  /**
   * Get last value from a Keepa CSV time series
   */
  _getLastValue(arr) {
    if (!arr || arr.length < 2) return null;
    return arr[arr.length - 1];
  }

  /**
   * Parse Keepa FBA fees object
   */
  _parseFBAFees(fees) {
    return {
      pickAndPack: fees.pickAndPackFee ? fees.pickAndPackFee / 100 : null,
      referral: fees.referralFee ? fees.referralFee / 100 : null,
      storageFee: fees.storageFee ? fees.storageFee / 100 : null,
      total: fees.totalFee ? fees.totalFee / 100 : null,
    };
  }

  /**
   * Batch lookup: handles >100 ASINs by chunking
   */
  async getProductsBatch(asins, domain = 1, options = {}, delayMs = 2000) {
    const results = [];
    const chunks = [];
    for (let i = 0; i < asins.length; i += 100) {
      chunks.push(asins.slice(i, i + 100));
    }

    for (let i = 0; i < chunks.length; i++) {
      try {
        const products = await this.getProducts(chunks[i], domain, options);
        results.push(...products);
      } catch (err) {
        console.error(`Keepa batch ${i + 1}/${chunks.length} error:`, err.message);
        chunks[i].forEach(asin => {
          results.push({ asin, error: err.message, source: 'keepa' });
        });
      }
      // Respect rate limits
      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    return results;
  }

  /**
   * Get remaining API tokens
   */
  async getTokenStatus() {
    const url = `${this.baseUrl}/token?key=${this.apiKey}`;
    const response = await fetch(url);
    const data = await response.json();
    return {
      tokensLeft: data.tokensLeft,
      refillIn: data.refillIn,    // seconds until next refill
      refillRate: data.refillRate, // tokens per minute
    };
  }

  /**
   * Domain code helper
   */
  static getDomainCode(marketplace) {
    const map = {
      'www.amazon.com': 1, 'US': 1,
      'www.amazon.co.uk': 2, 'UK': 2,
      'www.amazon.de': 3, 'DE': 3,
      'www.amazon.fr': 4, 'FR': 4,
      'www.amazon.co.jp': 5, 'JP': 5,
      'www.amazon.ca': 6, 'CA': 6,
      'www.amazon.it': 8, 'IT': 8,
      'www.amazon.es': 9, 'ES': 9,
      'www.amazon.in': 10, 'IN': 10,
      'www.amazon.com.mx': 11, 'MX': 11,
      'www.amazon.com.au': 13, 'AU': 13,
    };
    return map[marketplace] || 1;
  }
}

module.exports = KeepaAPI;
