// Bidness.ai Core Engine - v1.1
// Implements GBM probability model, scoring, and data pipeline

const TICKERS = ['AAPL', 'NVDA', 'MSFT', 'GOOGL', 'AMZN', 'JPM', 'SPY', 'BTC-USD'];

let userBalance = 25000;
let positions = [];

// GBM + Stats Calculation
async function fetchHistoricalData(ticker) {
  try {
    let url;
    if (ticker.includes('USD')) {
      // Crypto fallback
      url = `https://api.binance.com/api/v3/klines?symbol=${ticker.replace('-','')}&interval=1d&limit=252`;
    } else {
      url = `https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}.us&i=d`;
    }
    
    const response = await fetch(url);
    const text = await response.text();
    
    let prices = [];
    
    if (ticker.includes('USD')) {
      // Binance JSON
      const data = JSON.parse(text);
      prices = data.map(d => parseFloat(d[4])); // Close price
    } else {
      // Stooq CSV
      const lines = text.trim().split('\n');
      for (let i = 1; i < Math.min(260, lines.length); i++) {
        const cols = lines[i].split(',');
        if (cols[4] && !isNaN(parseFloat(cols[4]))) {
          prices.push(parseFloat(cols[4]));
        }
      }
    }
    
    return prices.filter(p => p > 0).reverse(); // oldest to newest
  } catch (e) {
    console.warn(`Data fetch failed for ${ticker}, using simulation`);
    return generateSimulatedPrices(ticker);
  }
}

function generateSimulatedPrices(ticker) {
  const base = ticker === 'AAPL' ? 228 : ticker === 'NVDA' ? 142 : 180;
  const prices = [];
  let price = base;
  for (let i = 0; i < 252; i++) {
    price *= (1 + (Math.random() - 0.48) * 0.015);
    prices.push(Math.round(price * 100) / 100);
  }
  return prices;
}

function calculateStats(prices) {
  if (prices.length < 30) return { current: prices[prices.length-1] || 150, dailyDrift: 0.0008, dailyVol: 0.018, monthlyDrift: 0.0168, monthlyVol: 0.085 };
  
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i-1]) / prices[i-1]);
  }
  
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / returns.length;
  
  return {
    current: prices[prices.length - 1],
    dailyDrift: meanReturn,
    dailyVol: Math.sqrt(variance),
    monthlyDrift: meanReturn * 21,
    monthlyVol: Math.sqrt(variance) * Math.sqrt(21)
  };
}

function normCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804 * Math.exp(-x * x / 2);
  let prob = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + 1.330274429 * t))));
  return x >= 0 ? 1 - prob : prob;
}

function calculateGBMBProbability(current, target, monthlyDrift, monthlyVol, months = 1) {
  if (monthlyVol <= 0) return 0.5;
  const t = months;
  const driftTerm = monthlyDrift * t;
  const volTerm = monthlyVol * Math.sqrt(t);
  const d = (Math.log(target / current) - driftTerm) / volTerm;
  let prob = normCDF(d);
  
  // R10: Probability ceiling at 70%
  if (prob > 0.70) {
    let newTarget = target * 1.02;
    while (calculateGBMBProbability(current, newTarget, monthlyDrift, monthlyVol, months) > 0.70 && newTarget < current * 2) {
      newTarget *= 1.02;
    }
    return { probability: 0.70, adjustedTarget: Math.round(newTarget * 100) / 100 };
  }
  return { probability: Math.round(prob * 100), adjustedTarget: null };
}

// Combined Scoring Engine
function calculateTotalScore(tradingScore, engagementScore, contributionScore) {
  return Math.round(0.6 * tradingScore + 0.3 * engagementScore + 0.1 * contributionScore);
}

function getProjectedEquity(rank, totalUsers = 50) {
  if (rank > totalUsers) return "0.000%";
  const basePool = 1.5;
  return (basePool * (totalUsers - rank + 1) / (totalUsers * (totalUsers + 1) / 2)).toFixed(3) + "%";
}

// Export for index.html
window.bidnessEngine = {
  fetchHistoricalData,
  calculateStats,
  calculateGBMBProbability,
  calculateTotalScore,
  getProjectedEquity,
  userBalance,
  positions
};
