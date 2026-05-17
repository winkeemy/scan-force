/**
 * ScanForce Backend Server
 * Express proxy for Amazon PA-API, Keepa, and FBA fee calculation
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Papa = require('papaparse');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { RateLimiterMemory } = require('rate-limiter-flexible');

const AmazonPAAPI = require('./lib/amazon-paapi');
const KeepaAPI = require('./lib/keepa');
const { calculateFBAFees, estimateMonthlySales, classifyCategory } = require('./lib/fba-calculator');

const app = express();
const PORT = process.env.PORT || 3001;

// ==================== Middleware ====================
app.use(express.json({ limit: '50mb' }));

const corsOrigins = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: corsOrigins.includes('*') ? true : corsOrigins,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

// Rate limiter
const rateLimiter = new RateLimiterMemory({
  points: parseInt(process.env.RATE_LIMIT_PER_MINUTE) || 60,
  duration: 60,
});
app.use(async (req, res, next) => {
  try {
    await rateLimiter.consume(req.ip);
    next();
  } catch {
    res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }
});

// File upload
const upload = multer({
  dest: '/tmp/scanforce-uploads/',
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.csv', '.tsv', '.xlsx', '.xls'].includes(ext)) cb(null, true);
    else cb(new Error('Only CSV, TSV, and XLSX files are allowed'));
  },
});

// ==================== Initialize API Clients ====================
let amazonClient = null;
let keepaClient = null;

if (process.env.AMAZON_ACCESS_KEY && process.env.AMAZON_SECRET_KEY) {
  amazonClient = new AmazonPAAPI({
    accessKey: process.env.AMAZON_ACCESS_KEY,
    secretKey: process.env.AMAZON_SECRET_KEY,
    partnerTag: process.env.AMAZON_PARTNER_TAG,
    marketplace: process.env.AMAZON_MARKETPLACE || 'www.amazon.com',
    region: process.env.AMAZON_REGION || 'us-east-1',
  });
  console.log('✅ Amazon PA-API client initialized');
} else {
  console.log('⚠️  Amazon PA-API credentials not set — product lookups will use Keepa or fallback');
}

if (process.env.KEEPA_API_KEY) {
  keepaClient = new KeepaAPI(process.env.KEEPA_API_KEY);
  console.log('✅ Keepa API client initialized');
} else {
  console.log('⚠️  Keepa API key not set — price history unavailable');
}

// ==================== Health Check ====================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    services: {
      amazon_paapi: !!amazonClient,
      keepa: !!keepaClient,
      fba_calculator: true,
    },
    timestamp: new Date().toISOString(),
  });
});

// ==================== API Status ====================
app.get('/api/status', async (req, res) => {
  const status = {
    amazon_paapi: { connected: !!amazonClient, configured: !!(process.env.AMAZON_ACCESS_KEY) },
    keepa: { connected: !!keepaClient, configured: !!(process.env.KEEPA_API_KEY) },
    fba_calculator: { connected: true, configured: true },
  };

  if (keepaClient) {
    try {
      const tokenStatus = await keepaClient.getTokenStatus();
      status.keepa.tokensLeft = tokenStatus.tokensLeft;
      status.keepa.refillIn = tokenStatus.refillIn;
    } catch (err) {
      status.keepa.error = err.message;
    }
  }

  res.json(status);
});

// ==================== Lookup by ASIN ====================
app.post('/api/lookup/asin', async (req, res) => {
  try {
    const { asins, marketplace = 'US' } = req.body;

    if (!asins || !Array.isArray(asins) || !asins.length) {
      return res.status(400).json({ error: 'Provide an array of ASINs' });
    }

    // Validate ASINs
    const validAsins = asins.filter(a => /^B0[A-Z0-9]{8}$/i.test(String(a).trim()));
    if (!validAsins.length) {
      return res.status(400).json({ error: 'No valid ASINs provided (format: B0 + 8 alphanumeric)' });
    }

    const results = {};
    const errors = [];

    // 1. Try Amazon PA-API
    if (amazonClient) {
      try {
        const amazonData = await amazonClient.getItemsByASINBatch(validAsins);
        amazonData.forEach(item => {
          if (!item.error) {
            results[item.asin] = { ...results[item.asin], amazon: item };
          } else {
            errors.push({ asin: item.asin, source: 'amazon', error: item.error });
          }
        });
      } catch (err) {
        errors.push({ source: 'amazon', error: err.message });
      }
    }

    // 2. Keepa data (price history, BSR, sales estimates)
    if (keepaClient) {
      try {
        const domain = KeepaAPI.getDomainCode(marketplace);
        const keepaData = await keepaClient.getProductsBatch(validAsins, domain);
        keepaData.forEach(item => {
          if (!item.error) {
            results[item.asin] = { ...results[item.asin], keepa: item };
          } else {
            errors.push({ asin: item.asin, source: 'keepa', error: item.error });
          }
        });
      } catch (err) {
        errors.push({ source: 'keepa', error: err.message });
      }
    }

    // 3. Merge and calculate fees
    const merged = validAsins.map(asin => mergeProductData(asin, results[asin], null));

    res.json({
      products: merged,
      errors,
      sources: {
        amazon: !!amazonClient,
        keepa: !!keepaClient,
      },
      count: merged.length,
    });
  } catch (err) {
    console.error('ASIN lookup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== Scan Uploaded File ====================
app.post('/api/scan', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const {
      col_upc, col_asin, col_title, col_cost, col_qty, col_brand,
      marketplace = 'US', min_roi = 0, min_profit = 0,
    } = req.body;

    // Parse file
    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    let rows = [];

    if (ext === '.csv' || ext === '.tsv') {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const parsed = Papa.parse(fileContent, { header: true, skipEmptyLines: true });
      rows = parsed.data;
    } else {
      const wb = XLSX.readFile(filePath);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    }

    // Cleanup temp file
    fs.unlinkSync(filePath);

    if (!rows.length) {
      return res.status(400).json({ error: 'File contains no data rows' });
    }

    // Extract ASINs and UPCs
    const productsFromFile = rows.map((row, idx) => {
      const rawAsin = col_asin ? String(row[col_asin] || '').trim().toUpperCase() : '';
      const rawUpc = col_upc ? String(row[col_upc] || '').trim() : '';
      const asin = /^B0[A-Z0-9]{8}$/.test(rawAsin) ? rawAsin : '';
      const upc = rawUpc.replace(/[^0-9]/g, '');

      return {
        rowIndex: idx,
        asin,
        upc,
        title: col_title ? String(row[col_title] || '') : '',
        cost: parseFloat(String(row[col_cost] || '').replace(/[^0-9.]/g, '')) || 0,
        qty: col_qty ? parseInt(row[col_qty]) || 0 : 0,
        brand: col_brand ? String(row[col_brand] || '') : '',
      };
    });

    // Collect unique ASINs to look up
    const uniqueAsins = [...new Set(productsFromFile.map(p => p.asin).filter(Boolean))];

    // Look up all ASINs in batch
    const lookupResults = {};
    const lookupErrors = [];

    if (uniqueAsins.length > 0) {
      // Amazon PA-API
      if (amazonClient) {
        try {
          const amazonData = await amazonClient.getItemsByASINBatch(uniqueAsins);
          amazonData.forEach(item => {
            if (!item.error) {
              lookupResults[item.asin] = { ...lookupResults[item.asin], amazon: item };
            }
          });
        } catch (err) {
          lookupErrors.push({ source: 'amazon', error: err.message });
        }
      }

      // Keepa
      if (keepaClient) {
        try {
          const domain = KeepaAPI.getDomainCode(marketplace);
          const keepaData = await keepaClient.getProductsBatch(uniqueAsins, domain);
          keepaData.forEach(item => {
            if (!item.error) {
              lookupResults[item.asin] = { ...lookupResults[item.asin], keepa: item };
            }
          });
        } catch (err) {
          lookupErrors.push({ source: 'keepa', error: err.message });
        }
      }
    }

    // Merge file data with API data and calculate profitability
    const scannedProducts = productsFromFile
      .filter(p => p.asin || p.upc) // Must have at least one identifier
      .map(fileProduct => {
        const apiData = lookupResults[fileProduct.asin] || {};
        return mergeProductData(fileProduct.asin, apiData, fileProduct);
      });

    // Summary stats
    const profitable = scannedProducts.filter(p => p.profit > min_profit && p.roi > min_roi);
    const avgROI = profitable.length
      ? profitable.reduce((s, p) => s + p.roi, 0) / profitable.length
      : 0;
    const avgProfit = profitable.length
      ? profitable.reduce((s, p) => s + p.profit, 0) / profitable.length
      : 0;

    res.json({
      products: scannedProducts,
      summary: {
        totalRows: rows.length,
        scanned: scannedProducts.length,
        matched: scannedProducts.filter(p => p.dataSource !== 'none').length,
        profitable: profitable.length,
        avgROI: Math.round(avgROI * 100) / 100,
        avgProfit: Math.round(avgProfit * 100) / 100,
        totalPotentialProfit: Math.round(profitable.reduce((s, p) => s + p.profit * (p.monthlySales || 1), 0)),
      },
      errors: lookupErrors,
      sources: {
        amazon: !!amazonClient,
        keepa: !!keepaClient,
      },
    });
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== FBA Fee Calculator ====================
app.post('/api/fees', (req, res) => {
  try {
    const { price, weightOz, category, lengthIn, widthIn, heightIn } = req.body;

    if (!price || price <= 0) {
      return res.status(400).json({ error: 'Price must be a positive number' });
    }

    const fees = calculateFBAFees({
      price,
      weightOz: weightOz || 16,
      category: category || 'Other',
      lengthIn, widthIn, heightIn,
    });

    res.json(fees);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Keepa Price History ====================
app.get('/api/keepa/history/:asin', async (req, res) => {
  try {
    if (!keepaClient) {
      return res.status(503).json({ error: 'Keepa API not configured' });
    }

    const { asin } = req.params;
    const marketplace = req.query.marketplace || 'US';
    const domain = KeepaAPI.getDomainCode(marketplace);

    const products = await keepaClient.getProducts([asin], domain, {
      history: true,
      stats: '90',
      rating: true,
    });

    if (!products.length) {
      return res.status(404).json({ error: 'Product not found on Keepa' });
    }

    res.json(products[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Keepa Token Status ====================
app.get('/api/keepa/tokens', async (req, res) => {
  try {
    if (!keepaClient) {
      return res.status(503).json({ error: 'Keepa API not configured' });
    }
    const status = await keepaClient.getTokenStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Data Merging Logic ====================
function mergeProductData(asin, apiData, fileProduct) {
  const amazon = apiData?.amazon || {};
  const keepa = apiData?.keepa || {};
  const file = fileProduct || {};

  // Priority: Amazon PA-API > Keepa > File > Fallback
  const title = amazon.title || keepa.title || file.title || '';
  const brand = amazon.brand || keepa.brand || file.brand || '';
  const category = amazon.category || keepa.categoryName || '';

  // Price: Buy Box from Keepa > Amazon listing price > null
  const amazonPrice = keepa.buyBoxPrice || keepa.amazonPrice || amazon.amazonPrice || null;

  const cost = file.cost || 0;
  const upc = file.upc || '';
  const qty = file.qty || 0;

  // Weight: Keepa > Amazon > default estimate
  const weightOz = keepa.packageWeightOz || amazon.weight || 16;

  // BSR: Keepa (more reliable real-time) > Amazon
  const bsr = keepa.bsr || amazon.bsr || null;

  // Calculate FBA fees
  let feeBreakdown = null;
  if (amazonPrice && amazonPrice > 0) {
    // Use Keepa's FBA fees if available, otherwise calculate locally
    if (keepa.fbaFees && keepa.fbaFees.total) {
      feeBreakdown = {
        total: keepa.fbaFees.total,
        referral: keepa.fbaFees.referral || 0,
        fulfillment: keepa.fbaFees.pickAndPack || 0,
        storage: keepa.fbaFees.storageFee || 0,
        closing: 0,
        referralRate: amazonPrice > 0 ? Math.round((keepa.fbaFees.referral / amazonPrice) * 1000) / 10 : 0,
        sizeTier: 'from_keepa',
        category: classifyCategory(category),
      };
    } else {
      feeBreakdown = calculateFBAFees({
        price: amazonPrice,
        weightOz,
        category,
      });
    }
  }

  const fbaFees = feeBreakdown ? feeBreakdown.total : 0;
  const profit = amazonPrice ? Math.round((amazonPrice - cost - fbaFees) * 100) / 100 : null;
  const roi = cost > 0 && profit !== null ? Math.round((profit / cost) * 10000) / 100 : null;

  // Sales estimates
  const monthlySales = keepa.monthlySold || (bsr ? estimateMonthlySales(bsr, category) : null);

  // Determine data source
  let dataSource = 'none';
  if (amazon.asin && keepa.asin) dataSource = 'amazon+keepa';
  else if (amazon.asin) dataSource = 'amazon';
  else if (keepa.asin) dataSource = 'keepa';

  return {
    asin: asin || file.asin || '',
    upc,
    title,
    brand,
    category,
    cost,
    qty,
    amazonPrice,
    fbaFees,
    feeBreakdown,
    profit,
    roi,
    bsr,
    bsr30: keepa.bsr30 || null,
    bsr90: keepa.bsr90 || null,
    monthlySales,
    sellers: keepa.newOfferCount || amazon.sellerCount || null,
    rating: keepa.rating || null,
    reviews: keepa.reviewCount || null,
    weightOz: Math.round(weightOz * 10) / 10,
    weightLb: Math.round((weightOz / 16) * 100) / 100,
    imageUrl: amazon.imageUrl || keepa.imageUrl || null,
    isPrime: amazon.isPrime || false,
    // Keepa extras
    avgPrice90: keepa.avgPrice90 || null,
    minPrice90: keepa.minPrice90 || null,
    maxPrice90: keepa.maxPrice90 || null,
    avgBuyBox90: keepa.avgBuyBox90 || null,
    listedSince: keepa.listedSince || null,
    isSNS: keepa.isSNS || false,
    isAddonItem: keepa.isAddonItem || false,
    // Price history for charts
    priceHistory: keepa.priceHistory || null,
    // Links
    amazonUrl: `https://www.amazon.com/dp/${asin || ''}`,
    keepaUrl: `https://keepa.com/#!product/1-${asin || ''}`,
    // Meta
    dataSource,
    lastUpdated: keepa.lastUpdate || new Date().toISOString().split('T')[0],
  };
}

// ==================== Error Handler ====================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║        ⚡ ScanForce Backend Server ⚡        ║
╠══════════════════════════════════════════════╣
║  Port:     ${String(PORT).padEnd(33)}║
║  PA-API:   ${(amazonClient ? '✅ Connected' : '❌ Not configured').padEnd(33)}║
║  Keepa:    ${(keepaClient ? '✅ Connected' : '❌ Not configured').padEnd(33)}║
║  FBA Calc: ${'✅ Built-in'.padEnd(33)}║
╠══════════════════════════════════════════════╣
║  Endpoints:                                  ║
║  GET  /api/health          Health check      ║
║  GET  /api/status          API status        ║
║  POST /api/lookup/asin     ASIN lookup       ║
║  POST /api/scan            Scan file         ║
║  POST /api/fees            FBA fee calc      ║
║  GET  /api/keepa/history/:asin  Price hist   ║
║  GET  /api/keepa/tokens    Token balance     ║
╚══════════════════════════════════════════════╝
  `);
});

module.exports = app;
