/**
 * Local FBA Fee Calculator
 * Accurate calculation based on Amazon FBA fee schedule 2024-2025
 * Used as fallback when SP-API GetMyFeesEstimate is unavailable
 */

// Referral fee rates by category
const REFERRAL_FEES = {
  'Amazon Device Accessories':       { rate: 0.45, min: 0.30 },
  'Amazon Explore':                  { rate: 0.30, min: 0.30 },
  'Appliances':                      { rate: 0.08, min: 0.30, tiered: true, tierThreshold: 300, tierRate: 0.15 },
  'Automotive & Powersports':        { rate: 0.12, min: 0.30 },
  'Baby Products':                   { rate: 0.08, min: 0.30, tiered: true, tierThreshold: 10, tierRate: 0.15 },
  'Backpacks, Handbags & Luggage':   { rate: 0.15, min: 0.30 },
  'Beauty & Personal Care':          { rate: 0.08, min: 0.30, tiered: true, tierThreshold: 10, tierRate: 0.15 },
  'Books':                           { rate: 0.15, min: 0.00, closingFee: 1.80 },
  'Camera & Photo':                  { rate: 0.08, min: 0.30 },
  'Clothing & Accessories':          { rate: 0.17, min: 0.30 },
  'Collectible Coins':               { rate: 0.15, min: 0.30 },
  'Consumer Electronics':            { rate: 0.08, min: 0.30 },
  'Electronics':                     { rate: 0.08, min: 0.30 },
  'Electronics Accessories':         { rate: 0.15, min: 0.30, tiered: true, tierThreshold: 100, tierRate: 0.08 },
  'Everything Else':                 { rate: 0.15, min: 0.30 },
  'Furniture':                       { rate: 0.15, min: 0.30 },
  'Grocery & Gourmet Food':          { rate: 0.08, min: 0.30, tiered: true, tierThreshold: 15, tierRate: 0.15 },
  'Health & Household':              { rate: 0.08, min: 0.30, tiered: true, tierThreshold: 10, tierRate: 0.15 },
  'Home & Kitchen':                  { rate: 0.15, min: 0.30 },
  'Industrial & Scientific':         { rate: 0.12, min: 0.30 },
  'Jewelry':                         { rate: 0.20, min: 0.30, tiered: true, tierThreshold: 250, tierRate: 0.05 },
  'Kitchen':                         { rate: 0.15, min: 0.30 },
  'Lawn & Garden':                   { rate: 0.15, min: 0.30 },
  'Mattresses':                      { rate: 0.15, min: 0.30 },
  'Music':                           { rate: 0.15, min: 0.00, closingFee: 1.80 },
  'Musical Instruments':             { rate: 0.15, min: 0.30 },
  'Office Products':                 { rate: 0.15, min: 0.30 },
  'Outdoors':                        { rate: 0.15, min: 0.30 },
  'Patio, Lawn & Garden':            { rate: 0.15, min: 0.30 },
  'Pet Supplies':                    { rate: 0.15, min: 0.30, tiered: true, tierThreshold: 10, tierRate: 0.22 },
  'Software':                        { rate: 0.15, min: 0.00, closingFee: 1.80 },
  'Sports & Outdoors':               { rate: 0.15, min: 0.30 },
  'Tools & Home Improvement':        { rate: 0.15, min: 0.30 },
  'Toys & Games':                    { rate: 0.15, min: 0.30 },
  'Video Games':                     { rate: 0.15, min: 0.00, closingFee: 1.80 },
  'Watches':                         { rate: 0.16, min: 0.30, tiered: true, tierThreshold: 1500, tierRate: 0.03 },
  // Default
  'Other':                           { rate: 0.15, min: 0.30 },
};

// FBA fulfillment fees by size tier (2024 rates)
const FULFILLMENT_FEES = {
  // Small standard (<=15oz, <=15x12x0.75")
  small_standard: [
    { maxOz: 2,  fee: 3.06 },
    { maxOz: 4,  fee: 3.15 },
    { maxOz: 6,  fee: 3.24 },
    { maxOz: 8,  fee: 3.33 },
    { maxOz: 10, fee: 3.43 },
    { maxOz: 12, fee: 3.53 },
    { maxOz: 14, fee: 3.60 },
    { maxOz: 16, fee: 3.65 },
  ],
  // Large standard (<=20lb, <=18x14x8")
  large_standard: [
    { maxOz: 4,  fee: 3.68 },
    { maxOz: 8,  fee: 3.90 },
    { maxOz: 12, fee: 4.08 },
    { maxOz: 16, fee: 4.76 },
    { maxLb: 1.5, fee: 5.19 },
    { maxLb: 2,   fee: 5.44 },
    { maxLb: 2.5, fee: 5.61 },
    { maxLb: 3,   fee: 5.80 },
    // Above 3lb: base + per-lb surcharge
    { maxLb: 20, fee: 6.05, perLb: 0.16, baseLb: 3 },
  ],
  // Small oversize (<=70lb, <=60x30")
  small_oversize: [
    { maxLb: 70, fee: 9.73, perLb: 0.42, baseLb: 2 },
  ],
  // Medium oversize
  medium_oversize: [
    { maxLb: 150, fee: 19.05, perLb: 0.42, baseLb: 2 },
  ],
  // Large oversize
  large_oversize: [
    { maxLb: 150, fee: 89.98, perLb: 0.83, baseLb: 90 },
  ],
  // Special oversize
  special_oversize: [
    { maxLb: 9999, fee: 158.49, perLb: 0.83, baseLb: 90 },
  ],
};

// Monthly storage fees (per cubic foot)
const STORAGE_FEES = {
  standard: { janToSep: 0.87, octToDec: 2.40 },
  oversize: { janToSep: 0.56, octToDec: 1.40 },
};

function classifyCategory(categoryName) {
  if (!categoryName) return 'Other';
  const name = categoryName.toLowerCase();

  // Match to closest referral category
  for (const cat of Object.keys(REFERRAL_FEES)) {
    if (name.includes(cat.toLowerCase()) || cat.toLowerCase().includes(name)) {
      return cat;
    }
  }

  // Fuzzy matching
  if (name.includes('beauty') || name.includes('personal care') || name.includes('skin')) return 'Beauty & Personal Care';
  if (name.includes('health') || name.includes('household')) return 'Health & Household';
  if (name.includes('grocery') || name.includes('food') || name.includes('gourmet')) return 'Grocery & Gourmet Food';
  if (name.includes('electronic') || name.includes('tech')) return 'Electronics';
  if (name.includes('home') || name.includes('kitchen')) return 'Home & Kitchen';
  if (name.includes('toy') || name.includes('game')) return 'Toys & Games';
  if (name.includes('sport') || name.includes('outdoor')) return 'Sports & Outdoors';
  if (name.includes('cloth') || name.includes('apparel') || name.includes('fashion')) return 'Clothing & Accessories';
  if (name.includes('pet')) return 'Pet Supplies';
  if (name.includes('baby')) return 'Baby Products';
  if (name.includes('tool') || name.includes('improvement')) return 'Tools & Home Improvement';
  if (name.includes('book')) return 'Books';
  if (name.includes('auto') || name.includes('car')) return 'Automotive & Powersports';
  if (name.includes('office')) return 'Office Products';
  if (name.includes('lawn') || name.includes('garden') || name.includes('patio')) return 'Patio, Lawn & Garden';

  return 'Other';
}

function determineSizeTier(weightOz, lengthIn, widthIn, heightIn) {
  const weightLb = weightOz / 16;
  const longest = Math.max(lengthIn || 0, widthIn || 0, heightIn || 0);
  const median = [lengthIn || 0, widthIn || 0, heightIn || 0].sort((a, b) => a - b)[1];
  const shortest = Math.min(lengthIn || 0, widthIn || 0, heightIn || 0);
  const girth = 2 * (median + shortest);
  const lengthPlusGirth = longest + girth;

  if (weightOz <= 16 && longest <= 15 && median <= 12 && shortest <= 0.75) {
    return 'small_standard';
  }
  if (weightLb <= 20 && longest <= 18 && median <= 14 && shortest <= 8) {
    return 'large_standard';
  }
  if (weightLb <= 70 && longest <= 60 && lengthPlusGirth <= 130) {
    return 'small_oversize';
  }
  if (weightLb <= 150 && longest <= 108 && lengthPlusGirth <= 130) {
    return 'medium_oversize';
  }
  if (weightLb <= 150 && longest <= 108 && lengthPlusGirth <= 165) {
    return 'large_oversize';
  }
  return 'special_oversize';
}

/**
 * Calculate complete FBA fees
 * @param {object} params
 * @param {number} params.price - Selling price in dollars
 * @param {number} params.weightOz - Weight in ounces
 * @param {string} params.category - Amazon category name
 * @param {number} [params.lengthIn] - Length in inches
 * @param {number} [params.widthIn] - Width in inches
 * @param {number} [params.heightIn] - Height in inches
 * @returns {object} Fee breakdown
 */
function calculateFBAFees({ price, weightOz, category, lengthIn, widthIn, heightIn }) {
  const catKey = classifyCategory(category);
  const catFee = REFERRAL_FEES[catKey] || REFERRAL_FEES['Other'];

  // 1. Referral Fee
  let referralFee;
  if (catFee.tiered && price > catFee.tierThreshold) {
    // Tiered: lower rate on amount above threshold
    referralFee = catFee.tierThreshold * catFee.rate + (price - catFee.tierThreshold) * catFee.tierRate;
  } else {
    referralFee = price * catFee.rate;
  }
  referralFee = Math.max(referralFee, catFee.min);

  // 2. Size Tier
  const sizeTier = determineSizeTier(
    weightOz,
    lengthIn || (weightOz < 16 ? 12 : 15), // default dimensions if not provided
    widthIn || (weightOz < 16 ? 9 : 12),
    heightIn || (weightOz < 16 ? 0.5 : 4)
  );

  // 3. Fulfillment Fee
  const tiers = FULFILLMENT_FEES[sizeTier];
  const weightLb = weightOz / 16;
  let fulfillmentFee = tiers[tiers.length - 1].fee; // default to highest

  for (const tier of tiers) {
    if (tier.maxOz !== undefined && weightOz <= tier.maxOz) {
      fulfillmentFee = tier.fee;
      break;
    }
    if (tier.maxLb !== undefined && weightLb <= tier.maxLb) {
      if (tier.perLb && weightLb > tier.baseLb) {
        fulfillmentFee = tier.fee + Math.ceil(weightLb - tier.baseLb) * tier.perLb;
      } else {
        fulfillmentFee = tier.fee;
      }
      break;
    }
  }

  // 4. Storage Fee (average monthly)
  const isOversize = sizeTier.includes('oversize');
  const storageRates = isOversize ? STORAGE_FEES.oversize : STORAGE_FEES.standard;
  const avgStorageRate = (storageRates.janToSep * 9 + storageRates.octToDec * 3) / 12;
  // Estimate cubic feet from weight if no dimensions
  const cubicFt = (lengthIn && widthIn && heightIn)
    ? (lengthIn * widthIn * heightIn) / 1728
    : Math.max(0.1, (weightLb * 0.8) / 62.4);
  const storageFee = cubicFt * avgStorageRate;

  // 5. Closing Fee (media only)
  const closingFee = catFee.closingFee || 0;

  const totalFees = referralFee + fulfillmentFee + storageFee + closingFee;

  return {
    total: round2(totalFees),
    referral: round2(referralFee),
    referralRate: round1((referralFee / price) * 100),
    fulfillment: round2(fulfillmentFee),
    storage: round2(storageFee),
    closing: round2(closingFee),
    sizeTier,
    category: catKey,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round1(n) { return Math.round(n * 10) / 10; }

/**
 * Estimate monthly sales from BSR using exponential decay
 * Based on Jungle Scout / Helium10 models
 */
function estimateMonthlySales(bsr, category) {
  if (!bsr || bsr <= 0) return null;

  const multipliers = {
    'Home & Kitchen': 1.2, 'Toys & Games': 1.0, 'Beauty & Personal Care': 1.3,
    'Health & Household': 1.1, 'Sports & Outdoors': 0.9, 'Electronics': 1.5,
    'Office Products': 0.7, 'Pet Supplies': 0.8, 'Baby Products': 0.9,
    'Grocery & Gourmet Food': 1.8, 'Clothing & Accessories': 1.4, 'Books': 0.6,
    'Automotive & Powersports': 0.5, 'Patio, Lawn & Garden': 0.7,
    'Tools & Home Improvement': 0.8,
  };

  const catKey = classifyCategory(category);
  const mult = multipliers[catKey] || 1.0;
  const baseSales = 450000 * Math.pow(bsr, -0.72) * mult;
  return Math.max(1, Math.round(baseSales));
}

module.exports = {
  calculateFBAFees,
  estimateMonthlySales,
  classifyCategory,
  determineSizeTier,
  REFERRAL_FEES,
};
