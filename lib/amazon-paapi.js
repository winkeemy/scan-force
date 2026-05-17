/**
 * Amazon Product Advertising API 5.0 Client
 * Handles AWS Signature v4 request signing and product lookups
 * Docs: https://webservices.amazon.com/paapi5/documentation/
 */

const crypto = require('crypto');
const fetch = require('node-fetch');

class AmazonPAAPI {
  constructor(config) {
    this.accessKey = config.accessKey;
    this.secretKey = config.secretKey;
    this.partnerTag = config.partnerTag;
    this.marketplace = config.marketplace || 'www.amazon.com';
    this.region = config.region || 'us-east-1';
    this.host = `webservices.${this.marketplace}`;
    this.endpoint = `https://${this.host}/paapi5`;
  }

  // ========== AWS Signature V4 Signing ==========
  _hmac(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest();
  }

  _hash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  _getSignatureKey(dateStamp) {
    const kDate = this._hmac(`AWS4${this.secretKey}`, dateStamp);
    const kRegion = this._hmac(kDate, this.region);
    const kService = this._hmac(kRegion, 'ProductAdvertisingAPI');
    return this._hmac(kService, 'aws4_request');
  }

  _signRequest(path, payload) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);

    const canonicalHeaders = [
      `content-encoding:amz-1.0`,
      `content-type:application/json; charset=utf-8`,
      `host:${this.host}`,
      `x-amz-date:${amzDate}`,
      `x-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${path}`,
    ].join('\n') + '\n';

    const signedHeaders = 'content-encoding;content-type;host;x-amz-date;x-amz-target';
    const payloadHash = this._hash(payload);

    const canonicalRequest = [
      'POST',
      `/paapi5/${path.toLowerCase()}`,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.region}/ProductAdvertisingAPI/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      this._hash(canonicalRequest),
    ].join('\n');

    const signingKey = this._getSignatureKey(dateStamp);
    const signature = this._hmac(signingKey, stringToSign).toString('hex');

    const authHeader = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'amz-1.0',
      'Host': this.host,
      'X-Amz-Date': amzDate,
      'X-Amz-Target': `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${path}`,
      'Authorization': authHeader,
    };
  }

  async _request(operation, body) {
    const payload = JSON.stringify(body);
    const headers = this._signRequest(operation, payload);
    const url = `${this.endpoint}/${operation.toLowerCase()}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: payload,
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data?.Errors?.[0]?.Message || data?.message || `PA-API error ${response.status}`;
      const err = new Error(errMsg);
      err.status = response.status;
      err.code = data?.Errors?.[0]?.Code || 'UnknownError';
      throw err;
    }

    return data;
  }

  // ========== Product Lookups ==========

  /**
   * Look up products by ASIN (up to 10 per request)
   * @param {string[]} asins - Array of ASINs (max 10)
   * @returns {object[]} Array of product data
   */
  async getItemsByASIN(asins) {
    if (!asins.length) return [];
    // PA-API allows max 10 items per request
    const batch = asins.slice(0, 10);

    const body = {
      ItemIds: batch,
      ItemIdType: 'ASIN',
      PartnerTag: this.partnerTag,
      PartnerType: 'Associates',
      Marketplace: this.marketplace,
      Resources: [
        'ItemInfo.Title',
        'ItemInfo.ByLineInfo',
        'ItemInfo.Classifications',
        'ItemInfo.ContentInfo',
        'ItemInfo.Features',
        'ItemInfo.ManufactureInfo',
        'ItemInfo.ProductInfo',
        'ItemInfo.TechnicalInfo',
        'ItemInfo.TradeInInfo',
        'Offers.Listings.Price',
        'Offers.Listings.DeliveryInfo.IsFreeShippingEligible',
        'Offers.Listings.DeliveryInfo.IsPrimeEligible',
        'Offers.Listings.MerchantInfo',
        'Offers.Listings.Condition',
        'Offers.Summaries.OfferCount',
        'Offers.Summaries.LowestPrice',
        'BrowseNodeInfo.BrowseNodes',
        'BrowseNodeInfo.BrowseNodes.SalesRank',
        'Images.Primary.Large',
      ],
    };

    const data = await this._request('GetItems', body);
    return this._parseItemResults(data);
  }

  /**
   * Search for products by keyword
   * @param {string} keyword
   * @param {number} maxResults - Max 10
   */
  async searchItems(keyword, maxResults = 10) {
    const body = {
      Keywords: keyword,
      SearchIndex: 'All',
      ItemCount: Math.min(maxResults, 10),
      PartnerTag: this.partnerTag,
      PartnerType: 'Associates',
      Marketplace: this.marketplace,
      Resources: [
        'ItemInfo.Title',
        'ItemInfo.ByLineInfo',
        'ItemInfo.Classifications',
        'ItemInfo.ProductInfo',
        'Offers.Listings.Price',
        'Offers.Summaries.OfferCount',
        'Offers.Summaries.LowestPrice',
        'BrowseNodeInfo.BrowseNodes.SalesRank',
        'Images.Primary.Large',
      ],
    };

    const data = await this._request('SearchItems', body);
    return this._parseItemResults(data);
  }

  // ========== Response Parsing ==========
  _parseItemResults(data) {
    const items = data?.ItemsResult?.Items || data?.SearchResult?.Items || [];
    return items.map(item => this._parseItem(item));
  }

  _parseItem(item) {
    const listing = item?.Offers?.Listings?.[0];
    const summary = item?.Offers?.Summaries?.[0];
    const browseNode = item?.BrowseNodeInfo?.BrowseNodes?.[0];

    return {
      asin: item.ASIN,
      title: item?.ItemInfo?.Title?.DisplayValue || '',
      brand: item?.ItemInfo?.ByLineInfo?.Brand?.DisplayValue || '',
      manufacturer: item?.ItemInfo?.ManufactureInfo?.ItemPartNumber?.DisplayValue || '',
      category: browseNode?.DisplayName || item?.ItemInfo?.Classifications?.Binding?.DisplayValue || '',
      categoryId: browseNode?.Id || '',
      // Pricing
      amazonPrice: listing?.Price?.Amount || null,
      currency: listing?.Price?.Currency || 'USD',
      lowestPrice: summary?.LowestPrice?.Amount || null,
      // Sales data
      bsr: browseNode?.SalesRank || null,
      // Seller info
      sellerCount: summary?.OfferCount || null,
      isPrime: listing?.DeliveryInfo?.IsPrimeEligible || false,
      isFreeShipping: listing?.DeliveryInfo?.IsFreeShippingEligible || false,
      merchantName: listing?.MerchantInfo?.Name || '',
      // Product info
      features: item?.ItemInfo?.Features?.DisplayValues || [],
      imageUrl: item?.Images?.Primary?.Large?.URL || '',
      // Dimensions & weight
      dimensions: item?.ItemInfo?.ProductInfo?.ItemDimensions || null,
      weight: this._parseWeight(item?.ItemInfo?.ProductInfo),
      detailUrl: item.DetailPageURL || `https://www.amazon.com/dp/${item.ASIN}`,
      source: 'amazon_paapi',
    };
  }

  _parseWeight(productInfo) {
    const w = productInfo?.ItemDimensions?.Weight;
    if (!w) return null;
    // Convert to ounces
    const val = w.DisplayValue;
    const unit = w.Unit?.toLowerCase();
    if (unit === 'pounds') return val * 16;
    if (unit === 'ounces') return val;
    if (unit === 'grams') return val * 0.03527396;
    if (unit === 'kilograms') return val * 35.27396;
    return val;
  }

  /**
   * Batch lookup: handles more than 10 ASINs by chunking
   */
  async getItemsByASINBatch(asins, delayMs = 1100) {
    const results = [];
    const chunks = [];
    for (let i = 0; i < asins.length; i += 10) {
      chunks.push(asins.slice(i, i + 10));
    }

    for (let i = 0; i < chunks.length; i++) {
      try {
        const items = await this.getItemsByASIN(chunks[i]);
        results.push(...items);
      } catch (err) {
        console.error(`PA-API batch ${i + 1}/${chunks.length} error:`, err.message);
        // Mark failed ASINs
        chunks[i].forEach(asin => {
          results.push({ asin, error: err.message, source: 'amazon_paapi' });
        });
      }
      // PA-API rate limit: 1 request/second
      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    return results;
  }
}

module.exports = AmazonPAAPI;
