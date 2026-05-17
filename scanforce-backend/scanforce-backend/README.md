# ⚡ ScanForce Backend — Amazon Product Scanner API

Backend proxy server that connects ScanForce to **real Amazon & Keepa data**.

## What It Does

| Endpoint | Source | Data |
|----------|--------|------|
| `POST /api/lookup/asin` | Amazon PA-API + Keepa | Product title, price, BSR, sellers, images, weight |
| `POST /api/scan` | All APIs | Upload CSV/XLSX → bulk scan → returns enriched products |
| `POST /api/fees` | Local calculator | FBA fee breakdown (referral, fulfillment, storage) |
| `GET /api/keepa/history/:asin` | Keepa | 90-day price history, Buy Box, sales rank charts |
| `GET /api/keepa/tokens` | Keepa | Remaining API tokens |
| `GET /api/status` | All | Which APIs are connected |

## Quick Start

### 1. Install

```bash
cd scanforce-backend
npm install
```

### 2. Configure API Keys

```bash
cp .env.example .env
```

Edit `.env` and add your credentials:

#### Amazon PA-API 5.0 (Product data + pricing)
1. Sign up for [Amazon Associates](https://affiliate-program.amazon.com/)
2. Apply for [PA-API access](https://webservices.amazon.com/paapi5/documentation/)
3. Get your Access Key, Secret Key, and Associate Tag

#### Keepa API (Price history + BSR + sales estimates)
1. Create account at [keepa.com](https://keepa.com)
2. Subscribe to [API access](https://keepa.com/#!api) (~$19/mo for 10k tokens)
3. Copy your API key

### 3. Run

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

Server starts on `http://localhost:3001`

### 4. Test

```bash
# Health check
curl http://localhost:3001/api/health

# API status (shows which services are connected)
curl http://localhost:3001/api/status

# Look up ASINs
curl -X POST http://localhost:3001/api/lookup/asin \
  -H "Content-Type: application/json" \
  -d '{"asins": ["B0XFFPTUIV", "B06MI52OFZ", "B0GW8SNJ90"]}'

# Calculate FBA fees
curl -X POST http://localhost:3001/api/fees \
  -H "Content-Type: application/json" \
  -d '{"price": 24.99, "weightOz": 12, "category": "Home & Kitchen"}'

# Keepa price history
curl http://localhost:3001/api/keepa/history/B0XFFPTUIV

# Scan a file
curl -X POST http://localhost:3001/api/scan \
  -F "file=@supplier_catalog.csv" \
  -F "col_asin=ASIN" \
  -F "col_cost=Cost" \
  -F "col_title=Product Title" \
  -F "marketplace=US"
```

## API Response Example

```json
// POST /api/lookup/asin
{
  "products": [
    {
      "asin": "B0XFFPTUIV",
      "title": "Product Name from Amazon",
      "brand": "BrandName",
      "category": "Home & Kitchen",
      "amazonPrice": 29.99,
      "cost": 0,
      "fbaFees": 8.42,
      "feeBreakdown": {
        "total": 8.42,
        "referral": 4.50,
        "fulfillment": 3.86,
        "storage": 0.06,
        "referralRate": 15.0,
        "sizeTier": "large_standard"
      },
      "bsr": 12450,
      "monthlySales": 285,
      "sellers": 4,
      "rating": 4.5,
      "reviews": 1230,
      "priceHistory": {
        "amazon": [{"date": "2025-01-15", "value": 27.99}, ...],
        "buyBox": [{"date": "2025-01-15", "value": 28.49}, ...],
        "salesRank": [{"date": "2025-01-15", "value": 11200}, ...]
      },
      "dataSource": "amazon+keepa"
    }
  ],
  "sources": { "amazon": true, "keepa": true }
}
```

## Connecting the Frontend

Update the ScanForce frontend HTML to point to your backend:

```javascript
// In scanforce.html, add at the top of <script>:
const API_BASE = 'http://localhost:3001/api';

// Replace the simulated scan with real API calls:
async function startScan() {
  const formData = new FormData();
  formData.append('file', document.getElementById('fileInput').files[0]);
  formData.append('col_asin', document.getElementById('col_asin').value);
  formData.append('col_upc', document.getElementById('col_upc').value);
  formData.append('col_cost', document.getElementById('col_cost').value);
  formData.append('col_title', document.getElementById('col_title').value);
  formData.append('marketplace', document.getElementById('marketplace').value);

  const response = await fetch(`${API_BASE}/scan`, {
    method: 'POST',
    body: formData,
  });
  const data = await response.json();
  // data.products = array of enriched products with real Amazon data
}
```

## Graceful Degradation

The server works with **any combination** of API keys:

| PA-API | Keepa | Result |
|--------|-------|--------|
| ✅ | ✅ | **Full data** — prices, BSR, history, sales, images |
| ✅ | ❌ | Prices + BSR from Amazon, no price history |
| ❌ | ✅ | Full Keepa data (prices, BSR, history, sales) |
| ❌ | ❌ | FBA fee calculator only (local), no product data |

## Rate Limits

- **Amazon PA-API**: 1 request/second, 10 ASINs per request
- **Keepa**: Depends on plan (10k-100k tokens/month), 100 ASINs per request
- **Server**: 60 requests/minute per IP (configurable)

## File Structure

```
scanforce-backend/
├── server.js              # Express app + routes
├── lib/
│   ├── amazon-paapi.js    # Amazon PA-API v5 client (AWS Sig V4)
│   ├── keepa.js           # Keepa API client
│   └── fba-calculator.js  # Local FBA fee calculator
├── .env.example           # Config template
├── package.json
└── README.md
```

## Deployment

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3001
CMD ["node", "server.js"]
```

### Railway / Render / Fly.io

Set environment variables from `.env.example` in your platform's dashboard, then deploy. The server binds to `PORT` from env automatically.

## Cost Estimate

| Service | Cost | What You Get |
|---------|------|--------------|
| Amazon PA-API | Free (with Associates account) | Product data, prices, BSR |
| Keepa API | ~$19/mo (10k tokens) | Price history, sales estimates |
| Hosting | $5-10/mo (Railway/Render) | Server |
| **Total** | **~$25-30/mo** | **Full real-data scanner** |
