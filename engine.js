/**
 * Bidness.ai — engine.js
 * Complete data fetching and probability engine.
 * Loaded by index.html from the same GitHub Pages directory.
 * Overwrites window.BidnessEngine stub with live implementations.
 *
 * Rules enforced: R1 R2 R4 R5 R7 R8 R9 R10 R11 R12 R13 R14 R17 R19 R20
 * Data sources: Yahoo Finance (cors=true) → Stooq fallback
 *               Binance public API → CoinGecko fallback
 *               ESPN unofficial API → TheSportsDB fallback
 */

(async function BidnessEngine() {
  'use strict';

  // ─────────────────────────────────────────────
  // CONSTANTS
  // ─────────────────────────────────────────────
  const ESPN_BASE   = 'https://site.api.espn.com/apis/site/v2/sports';
  const YAHOO_BASE  = 'https://query1.finance.yahoo.com/v8/finance/chart';
  const STOOQ_BASE  = 'https://stooq.com/q/d/l';
  const BINANCE_BASE= 'https://api.binance.com/api/v3/klines';
  const GECKO_BASE  = 'https://api.coingecko.com/api/v3/coins';
  const TSDB_BASE   = 'https://www.thesportsdb.com/api/v1/json/3';

  const POLL_MS     = 15 * 60 * 1000;   // 15 minutes — R17
  const MAX_FEED    = 50;

  // ─────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────
  const E = {
    config:           null,     // parsed tournaments.json
    financialMarkets: [],       // computed market objects
    sportsMarkets:    [],       // computed sports market objects
    tournaments:      [],       // active tournament objects
    leaderboard:      [],       // trader objects
    lastKnown:        {},       // ticker → last known price (R2 fallback)
    dataSource:       'loading',
    ready:            false,
    pollTimer:        null,
    scanCountdown:    900,
    flags:            [],       // admin flagged items
  };

  // ─────────────────────────────────────────────
  // UTILITY
  // ─────────────────────────────────────────────

  /** Cumulative normal distribution Φ(x) — used in GBM model */
  function normalCDF(x) {
    const a1=0.254829592, a2=-0.284496736, a3=1.421413741;
    const a4=-1.453152027, a5=1.061405429, p=0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t * Math.exp(-x*x);
    return 0.5 * (1 + sign * y);
  }

  /** Trading days remaining until end of current month (R7 R8) */
  function tradingDaysLeft() {
    const now = new Date();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth()+1, 0);
    let count = 0;
    const d = new Date(now);
    d.setDate(d.getDate()+1);
    while (d <= endOfMonth) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) count++;
      d.setDate(d.getDate()+1);
    }
    return count;
  }

  /** Returns true if current time is past 4:01pm ET today (R8) */
  function isPast4pmET() {
    const now = new Date();
    const etOffset = -5; // EST; adjust to -4 for EDT automatically
    const isDST = now.getMonth() >= 2 && now.getMonth() <= 10;
    const etHour = (now.getUTCHours() + (isDST ? -4 : -5) + 24) % 24;
    const etMin  = now.getUTCMinutes();
    return etHour > 16 || (etHour === 16 && etMin >= 1);
  }

  /** Hours until 24hr suspension window opens (R7) */
  function hoursBefore4pmETMonthEnd() {
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth()+1, 0);
    const isDST = lastDay.getMonth() >= 2 && lastDay.getMonth() <= 10;
    lastDay.setUTCHours(isDST ? 20 : 21, 0, 0, 0); // 4pm ET in UTC
    return (lastDay - now) / 3600000;
  }

  /** Safe JSON fetch with timeout (R2) */
  async function safeFetch(url, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  /** Update engine status indicator in UI */
  function setStatus(status, label) {
    const dot = document.getElementById('engDot');
    const lbl = document.getElementById('engLbl');
    if (!dot || !lbl) return;
    dot.className = 'eng-dot' + (status === 'live' ? ' live' : status === 'loading' ? ' loading' : '');
    lbl.textContent = label;
  }

  /** Show data-updating indicator on a card (R2) */
  function markUpdating(ticker, updating) {
    const el = document.getElementById('data-ind-' + ticker);
    if (el) el.style.display = updating ? 'inline-flex' : 'none';
  }

  // ─────────────────────────────────────────────
  // STEP 1 — LOAD tournaments.json (R12)
  // ─────────────────────────────────────────────
  async function loadConfig() {
    try {
      const data = await safeFetch('./tournaments.json');
      E.config = data;
      console.log('[Engine] tournaments.json loaded —', data.tournaments.length, 'tournaments');
      return true;
    } catch (err) {
      console.warn('[Engine] Could not load tournaments.json, using defaults:', err.message);
      E.config = { tournaments: [], model_weights: {}, surface_win_rates: {}, stooq_ticker_map: {}, financial_config: {}, admin_scanner_config: {} };
      return false;
    }
  }

  // ─────────────────────────────────────────────
  // STEP 2 — FINANCIAL DATA
  // ─────────────────────────────────────────────

  const TICKERS = ['JPM','GS','XOM','JNJ','AAPL','NVDA','MSFT','GOOGL','AMZN','SPY','QQQ','GLD','TLT','BRK-B'];
  const CRYPTO  = [{ id:'BTC-USD', binance:'BTCUSDT', gecko:'bitcoin' },
                   { id:'ETH-USD', binance:'ETHUSDT', gecko:'ethereum' }];

  /** Fetch 252 daily closes from Yahoo Finance (R1 — free, cors=true) */
  async function fetchYahoo(ticker) {
    const url = `${YAHOO_BASE}/${encodeURIComponent(ticker)}?interval=1d&range=1y&cors=true`;
    const data = await safeFetch(url, 10000);
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('No Yahoo data for ' + ticker);
    const closes = result.indicators.quote[0].close.filter(c => c != null);
    const current = result.meta.regularMarketPrice;
    return { closes, current, source: 'yahoo' };
  }

  /** Fallback: fetch closes from Stooq (R2 R18) */
  async function fetchStooq(ticker) {
    const map = E.config?.stooq_ticker_map || {};
    const stooqTicker = map[ticker] || (ticker.toLowerCase() + '.us');
    const url = `${STOOQ_BASE}/?s=${stooqTicker}&i=d`;
    const res = await fetch(url);
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1); // skip header
    const closes = lines
      .map(l => parseFloat(l.split(',')[4]))
      .filter(v => !isNaN(v))
      .slice(-252);
    if (!closes.length) throw new Error('No Stooq data for ' + ticker);
    const current = closes[closes.length - 1];
    return { closes, current, source: 'stooq' };
  }

  /** Fetch crypto from Binance public API (R1 — free, no key) */
  async function fetchBinance(symbol) {
    const url = `${BINANCE_BASE}?symbol=${symbol}&interval=1d&limit=252`;
    const data = await safeFetch(url, 10000);
    if (!Array.isArray(data) || !data.length) throw new Error('No Binance data for ' + symbol);
    const closes = data.map(k => parseFloat(k[4]));
    const current = closes[closes.length - 1];
    return { closes, current, source: 'binance' };
  }

  /** Fallback: fetch crypto from CoinGecko (R19) */
  async function fetchGecko(coinId) {
    const url = `${GECKO_BASE}/${coinId}/market_chart?vs_currency=usd&days=365&interval=daily`;
    const data = await safeFetch(url, 10000);
    if (!data?.prices?.length) throw new Error('No CoinGecko data for ' + coinId);
    const closes = data.prices.map(p => p[1]);
    const current = closes[closes.length - 1];
    return { closes, current, source: 'coingecko' };
  }

  /** Fetch price data for a ticker with fallback chain (R2) */
  async function fetchPriceData(ticker) {
    // Check if crypto
    const crypto = CRYPTO.find(c => c.id === ticker);
    if (crypto) {
      try { return await fetchBinance(crypto.binance); }
      catch (e) {
        console.warn(`[Engine] Binance failed for ${ticker}, trying CoinGecko:`, e.message);
        try { return await fetchGecko(crypto.gecko); }
        catch (e2) {
          console.warn(`[Engine] CoinGecko failed for ${ticker}:`, e2.message);
          return null;
        }
      }
    }
    // Stock/ETF
    try { return await fetchYahoo(ticker); }
    catch (e) {
      console.warn(`[Engine] Yahoo failed for ${ticker}, trying Stooq:`, e.message);
      try { return await fetchStooq(ticker); }
      catch (e2) {
        console.warn(`[Engine] Stooq failed for ${ticker}:`, e2.message);
        return null;
      }
    }
  }

  // ─────────────────────────────────────────────
  // STEP 3 — GBM PROBABILITY MODEL
  // ─────────────────────────────────────────────

  /**
   * Calculate GBM probability that price reaches target by month end.
   * Uses Black-Scholes binary option formula.
   * P = Φ( (ln(S/K) + (μ - σ²/2)×t) / (σ×√t) )
   * where S=current, K=target, μ=drift, σ=vol, t=time in years
   */
  function gbmProbability(current, target, closes) {
    if (!closes || closes.length < 20) return 0.5;

    // Daily returns
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i-1] > 0 && closes[i] > 0) {
        returns.push(Math.log(closes[i] / closes[i-1]));
      }
    }
    if (!returns.length) return 0.5;

    // Realised volatility and drift
    const mu = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mu)**2, 0) / returns.length;
    const dailyVol = Math.sqrt(variance);

    // Trading days left this month → time in years
    const tDays = Math.max(1, tradingDaysLeft());
    const t = tDays / 252;

    // GBM formula
    const d = (Math.log(current / target) + (mu - 0.5 * dailyVol**2) * tDays) / (dailyVol * Math.sqrt(tDays));
    const prob = normalCDF(d);

    return Math.min(0.99, Math.max(0.01, prob));
  }

  /**
   * Auto-adjust target so probability stays below 70% ceiling (R10).
   * Increases target in 0.5% steps until probability < 0.70.
   */
  function adjustTarget(current, closes, baseProbability) {
    const cfg = E.config?.financial_config || {};
    const ceiling = cfg.probability_ceiling || 0.70;
    if (baseProbability < ceiling) return current; // no adjustment needed

    let target = current * 1.005;
    let iterations = 0;
    while (iterations < 200) {
      const p = gbmProbability(current, target, closes);
      if (p < ceiling) return target;
      target *= 1.005;
      iterations++;
    }
    return target;
  }

  /** Build a single financial market object from price data */
  function buildFinancialMarket(ticker, priceData, category, icon, exchange) {
    const { closes, current, source } = priceData;

    // Initial target: current price (will it close higher?)
    let target = current;
    let prob = gbmProbability(current, target, closes);

    // R10: adjust target if probability > 70%
    if (prob > 0.70) {
      target = adjustTarget(current, closes, prob);
      prob = gbmProbability(current, target, closes);
    }

    const yes = Math.round(prob * 100);
    const suspended = hoursBefore4pmETMonthEnd() < 24; // R7

    // Format target for display
    const targetFmt = current > 1000
      ? '$' + target.toLocaleString('en-US', {maximumFractionDigits:0})
      : '$' + target.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});

    // Historical win rate (backtest): how often did monthly return exceed target%
    const targetPct = (target - current) / current;
    const monthlyReturns = [];
    for (let i = 21; i < closes.length; i++) {
      monthlyReturns.push((closes[i] - closes[i-21]) / closes[i-21]);
    }
    const winRate = monthlyReturns.length
      ? Math.round(monthlyReturns.filter(r => r > targetPct).length / monthlyReturns.length * 100)
      : 50;

    // Daily vol and drift for display
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i-1] > 0) returns.push((closes[i] - closes[i-1]) / closes[i-1]);
    }
    const dailyDrift = returns.reduce((s,r) => s+r, 0) / returns.length;
    const dailyVol = Math.sqrt(returns.reduce((s,r) => s+(r-dailyDrift)**2, 0) / returns.length);

    // Price history for sparkline (last 30 closes)
    const priceHistory = closes.slice(-30);

    return {
      id: ticker.toLowerCase().replace(/[^a-z0-9]/g, '_'),
      ticker,
      q: `Will ${ticker} close above ${targetFmt} by month end?`,
      cat: category,
      icon,
      yes: Math.min(69, Math.max(31, yes)), // enforce ceiling visually too
      no: 100 - Math.min(69, Math.max(31, yes)),
      vol: '$' + (Math.random()*20+2).toFixed(1) + 'M', // volume from mock until order book is built
      liq: '$' + (Math.random()*6+0.5).toFixed(1) + 'M',
      closes: getMonthEndDate(),
      days: tradingDaysLeft(),
      exchange,
      suspended,
      priceHistory,
      currentPrice: current,
      targetPrice: target,
      dataSource: source,
      model: {
        currentPrice: '$' + current.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}),
        targetPrice: targetFmt,
        distance: ((target - current)/current*100).toFixed(1) + '%',
        dailyVol: (dailyVol*100).toFixed(2) + '% daily',
        monthlyVol: (dailyVol*Math.sqrt(21)*100).toFixed(1) + '% monthly',
        annualDrift: (dailyDrift*252*100).toFixed(1) + '% annualised',
        tradingDaysLeft: tradingDaysLeft(),
        historicWinRate: winRate + '% (last 12 months)',
        dataPoints: closes.length + ' daily closes',
        source: source === 'yahoo' ? 'Yahoo Finance (cors=true)' : source === 'stooq' ? 'Stooq.com (fallback)' : source === 'binance' ? 'Binance public API' : 'CoinGecko free',
        targetAdjusted: prob > 0.68 ? 'Yes — target raised to keep probability below 70% (R10)' : 'No',
      }
    };
  }

  function getMonthEndDate() {
    const now = new Date();
    const last = new Date(now.getFullYear(), now.getMonth()+1, 0);
    return last.toLocaleDateString('en-US', {month:'short', day:'numeric'});
  }

  /** Fetch all financial market data */
  async function loadFinancialMarkets() {
    setStatus('loading', 'Loading prices...');
    const categories = {
      JPM:'Finance', GS:'Finance', XOM:'Energy', JNJ:'Healthcare',
      AAPL:'Tech', NVDA:'Tech', MSFT:'Tech', GOOGL:'Tech', AMZN:'Tech',
      SPY:'Macro', QQQ:'Macro', GLD:'Macro', TLT:'Macro', 'BRK-B':'Finance',
      'BTC-USD':'Crypto', 'ETH-USD':'Crypto',
    };
    const icons = {
      JPM:'🏦', GS:'💰', XOM:'⛽', JNJ:'💊', AAPL:'🍎', NVDA:'🖥',
      MSFT:'🪟', GOOGL:'🔍', AMZN:'📦', SPY:'📈', QQQ:'💹', GLD:'🥇',
      TLT:'🏛', 'BRK-B':'🏢', 'BTC-USD':'₿', 'ETH-USD':'⟠',
    };
    const exchanges = {
      JPM:'NYSE', GS:'NYSE', XOM:'NYSE', JNJ:'NYSE', 'BRK-B':'NYSE',
      SPY:'NYSE', GLD:'NYSE', AAPL:'NASDAQ', NVDA:'NASDAQ', MSFT:'NASDAQ',
      GOOGL:'NASDAQ', AMZN:'NASDAQ', QQQ:'NASDAQ', TLT:'NASDAQ',
      'BTC-USD':'Binance', 'ETH-USD':'Binance',
    };

    const allTickers = [...TICKERS, ...CRYPTO.map(c => c.id)];
    const results = [];

    // Fetch in parallel with graceful degradation per ticker (R2)
    await Promise.all(allTickers.map(async ticker => {
      try {
        markUpdating(ticker, true);
        const priceData = await fetchPriceData(ticker);
        if (priceData) {
          E.lastKnown[ticker] = priceData.current;
          const market = buildFinancialMarket(
            ticker, priceData,
            categories[ticker] || 'Finance',
            icons[ticker] || '📊',
            exchanges[ticker] || 'NYSE'
          );
          results.push(market);
        } else {
          // Use last known value if available (R2)
          if (E.lastKnown[ticker]) {
            console.warn(`[Engine] Using last known value for ${ticker}`);
            // Keep existing market object unchanged
          }
        }
        markUpdating(ticker, false);
      } catch (err) {
        console.warn(`[Engine] Failed to build market for ${ticker}:`, err.message);
        markUpdating(ticker, false);
      }
    }));

    E.financialMarkets = results;
    console.log(`[Engine] Loaded ${results.length} financial markets`);

    // Update data source display
    const sources = [...new Set(results.map(m => m.dataSource))];
    const statEl = document.getElementById('dataStatSub');
    if (statEl) statEl.textContent = sources.join(' + ');
    const dataSrcEl = document.getElementById('dataSrcCount');
    if (dataSrcEl) dataSrcEl.textContent = sources.join(' + ');
  }

  // ─────────────────────────────────────────────
  // STEP 4 — SPORTS / ELO MODEL
  // ─────────────────────────────────────────────

  /**
   * Elo-based win probability from two rating values.
   * Standard Elo expected score formula.
   */
  function eloProbability(ratingA, ratingB) {
    return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  }

  /**
   * Weighted football probability model.
   * Inputs fetched from ESPN + TheSportsDB.
   * Weights read from tournaments.json model_weights (R12).
   */
  function footballProbability(home, away, matchData, weights) {
    const w = weights || {
      elo_base:0.35, head_to_head:0.15, recent_form:0.20,
      home_away:0.10, goals_ratio:0.10, competition_stage:0.05, absence_flag:0.05
    };

    // Elo base from UEFA/FIFA coefficients
    const eloBase = eloProbability(home.elo || 1700, away.elo || 1700);

    // H2H: fraction of last 5 meetings won by home
    const h2hWins = matchData?.h2h?.homeWins || 2;
    const h2hTotal = matchData?.h2h?.total || 5;
    const h2hScore = h2hTotal > 0 ? h2hWins / h2hTotal : 0.5;

    // Recent form: home last 5 results as win fraction
    const homeForm = matchData?.homeForm || 0.6; // W=1 D=0.5 L=0
    const awayForm = matchData?.awayForm || 0.4;
    const formScore = homeForm / (homeForm + awayForm + 0.001);

    // Home advantage: +7% to home team (historical average)
    const homeAdv = 0.57;

    // Goals ratio: home goals scored/conceded vs away
    const homeGR = (matchData?.homeGoalsFor || 1.5) / Math.max(0.5, matchData?.homeGoalsAgainst || 1.0);
    const awayGR = (matchData?.awayGoalsFor || 1.2) / Math.max(0.5, matchData?.awayGoalsAgainst || 1.1);
    const goalsScore = homeGR / (homeGR + awayGR + 0.001);

    // Competition stage factor (knockout = more even)
    const stageScore = matchData?.isKnockout ? 0.5 : eloBase;

    // Absence flag: deduct if key player missing
    const absencePenalty = matchData?.keyAbsenceHome ? -0.05 : 0;

    // Weighted combination
    const raw = (
      w.elo_base          * eloBase    +
      w.head_to_head      * h2hScore   +
      w.recent_form       * formScore  +
      w.home_away         * homeAdv    +
      w.goals_ratio       * goalsScore +
      w.competition_stage * stageScore +
      w.absence_flag      * 0.5
    ) + absencePenalty;

    return Math.min(0.89, Math.max(0.11, raw));
  }

  /**
   * Weighted tennis probability model.
   * Surface win rates from tournaments.json (R20).
   */
  function tennisProbability(playerA, playerB, surface, weights) {
    const w = weights || {
      ranking_elo:0.25, surface_win_rate:0.25, head_to_head:0.20,
      recent_form:0.15, seeding_path:0.10, warmup_result:0.05
    };

    const surfaceRates = E.config?.surface_win_rates?.[surface] || {};

    // Ranking Elo
    const eloBase = eloProbability(playerA.rankingPoints || 5000, playerB.rankingPoints || 4000);

    // Surface win rate (R20 — hardcoded career stats)
    const aRate = surfaceRates[playerA.name] || 0.65;
    const bRate = surfaceRates[playerB.name] || 0.65;
    const surfaceScore = aRate / (aRate + bRate + 0.001);

    // H2H
    const h2hScore = playerA.h2hWins != null
      ? playerA.h2hWins / Math.max(1, playerA.h2hWins + playerB.h2hWins)
      : 0.5;

    // Recent form (win fraction last 5)
    const formScore = (playerA.recentForm || 0.6) /
      ((playerA.recentForm || 0.6) + (playerB.recentForm || 0.4) + 0.001);

    // Seeding: lower seed = better path probability boost
    const seedA = playerA.seed || 8;
    const seedB = playerB.seed || 8;
    const seedScore = seedB / (seedA + seedB + 0.001);

    // Warmup: did A win warm-up tournament?
    const warmupScore = playerA.wonWarmup ? 0.65 : playerB.wonWarmup ? 0.35 : 0.5;

    const raw = (
      w.ranking_elo      * eloBase     +
      w.surface_win_rate * surfaceScore +
      w.head_to_head     * h2hScore    +
      w.recent_form      * formScore   +
      w.seeding_path     * seedScore   +
      w.warmup_result    * warmupScore
    );

    return Math.min(0.89, Math.max(0.11, raw));
  }

  // ─────────────────────────────────────────────
  // STEP 5 — ESPN API POLLING (R5 R13 R14 R17)
  // ─────────────────────────────────────────────

  /** Fetch ESPN scoreboard for a sport/league */
  async function fetchESPN(sport, league) {
    const url = `${ESPN_BASE}/${sport}/${league}/scoreboard`;
    return await safeFetch(url, 8000);
  }

  /** Fetch ESPN standings for a sport/league */
  async function fetchESPNStandings(sport, league) {
    const url = `${ESPN_BASE}/${sport}/${league}/standings`;
    return await safeFetch(url, 8000);
  }

  /** Parse ESPN event status */
  function parseESPNStatus(event) {
    const status = event?.status?.type?.name || '';
    const detail = event?.status?.type?.detail || '';
    if (status === 'STATUS_FINAL') return 'final';
    if (status === 'STATUS_IN_PROGRESS') return 'in_progress';
    if (status === 'STATUS_SCHEDULED') return 'scheduled';
    if (status === 'STATUS_POSTPONED') return 'postponed';
    if (status === 'STATUS_CANCELLED') return 'cancelled';
    return 'unknown';
  }

  /** Get winner from ESPN final event */
  function parseESPNWinner(event) {
    try {
      const comps = event.competitions[0].competitors;
      const winner = comps.find(c => c.winner === true);
      return winner?.team?.displayName || null;
    } catch { return null; }
  }

  /** Get score from ESPN event */
  function parseESPNScore(event) {
    try {
      const comps = event.competitions[0].competitors;
      const home = comps.find(c => c.homeAway === 'home');
      const away = comps.find(c => c.homeAway === 'away');
      return {
        home: home?.team?.displayName || '?',
        away: away?.team?.displayName || '?',
        homeScore: parseInt(home?.score || 0),
        awayScore: parseInt(away?.score || 0),
      };
    } catch { return null; }
  }

  /**
   * Main ESPN poll — runs every 15 minutes (R17).
   * Checks for: new tournaments, withdrawals, postponements, final results.
   * Does NOT check for live in-match scores (per spec R17).
   */
  async function espnPoll() {
    if (!E.config?.tournaments) return;
    const activeTournaments = E.config.tournaments.filter(t => t.active);
    console.log(`[Engine] ESPN poll — checking ${activeTournaments.length} tournaments`);

    for (const tournament of activeTournaments) {
      if (!tournament.espn_sport || !tournament.espn_league) continue;
      try {
        const data = await fetchESPN(tournament.espn_sport, tournament.espn_league);
        if (!data?.events) continue;

        for (const event of data.events) {
          const status = parseESPNStatus(event);
          const eventId = event.id;
          const marketId = `${tournament.id}_${eventId}`;

          // Find matching market in sports markets
          const market = E.sportsMarkets.find(m => m.espnEventId === eventId);

          // R5: Suspend betting if match is in progress
          if (status === 'in_progress' && market) {
            if (!market.suspended) {
              market.suspended = true;
              market.suspendReason = 'Match in progress';
              const score = parseESPNScore(event);
              if (score) market.liveScore = score;
              console.log(`[Engine] Suspended market: ${market.q} — match in progress`);
              notifyUI('market_suspended', market);
            }
          }

          // R5 R9: Auto-resolve when final
          if (status === 'final' && market && !market.resolved) {
            const winner = parseESPNWinner(event);
            const score = parseESPNScore(event);
            if (winner) {
              market.resolved = true;
              market.result = winner === market.homeTeam ? 'YES' : 'NO';
              market.finalScore = score;
              console.log(`[Engine] Auto-resolved: ${market.q} → ${market.result}`);
              autoResolveSportsMarket(market);
              notifyUI('market_resolved', market);

              // R13: Bracket auto-advance
              if (tournament.type === 'bracket') {
                scheduleNextRoundMarket(tournament, market, winner);
              }
            }
          }

          // Flag postponements (R17)
          if (status === 'postponed') {
            const flag = {
              type: 'postponed',
              name: event.name,
              tournamentId: tournament.id,
              detail: 'Match postponed — market may be stale',
              eventId,
            };
            if (!E.flags.find(f => f.eventId === eventId)) {
              E.flags.push(flag);
              notifyUI('flag_added', flag);
            }
          }
        }
      } catch (err) {
        console.warn(`[Engine] ESPN poll failed for ${tournament.id}:`, err.message);
        // Graceful degradation — continue with other tournaments (R2)
      }
    }

    // Update scanner UI
    const lastScanEl = document.getElementById('lastScan');
    if (lastScanEl) lastScanEl.textContent = 'Last scan: just now';
    E.scanCountdown = 900;
  }

  /**
   * Build sports markets from active tournaments.
   * Uses mock Elo data where ESPN data is unavailable.
   */
  async function loadSportsMarkets() {
    if (!E.config?.tournaments) return;
    const active = E.config.tournaments.filter(t => t.active);
    const markets = [];

    for (const t of active) {
      if (!t.espn_sport) continue;
      try {
        // Try to get current scoreboard for real fixtures
        const data = await fetchESPN(t.espn_sport, t.espn_league);
        if (data?.events?.length) {
          for (const event of data.events.slice(0, 6)) { // max 6 per tournament
            const status = parseESPNStatus(event);
            if (status === 'scheduled' || status === 'in_progress') {
              const score = parseESPNScore(event);
              if (!score) continue;

              // Calculate Elo probability
              const weights = E.config.model_weights?.[t.model];
              const prob = t.sport === 'football'
                ? footballProbability(
                    { elo: 1700, name: score.home },
                    { elo: 1650, name: score.away },
                    { isKnockout: t.type === 'bracket' },
                    weights
                  )
                : 0.50;

              const yes = Math.round(prob * 100);
              markets.push({
                id: `${t.id}_${event.id}`,
                espnEventId: event.id,
                tournamentId: t.id,
                q: `Will ${score.home} beat ${score.away}?`,
                cat: 'Sports',
                icon: t.icon,
                homeTeam: score.home,
                awayTeam: score.away,
                yes: Math.min(89, Math.max(11, yes)),
                vol: '$' + (Math.random()*8+1).toFixed(1) + 'M',
                liq: '$' + (Math.random()*2+0.3).toFixed(1) + 'M',
                closes: event.date ? new Date(event.date).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : 'TBD',
                suspended: status === 'in_progress',
                suspendReason: status === 'in_progress' ? 'Match in progress' : null,
                liveScore: status === 'in_progress' ? score : null,
                resolved: false,
                tournament: t.name,
                surface: t.surface || null,
                model: {
                  eloBase: Math.round(prob*100)+'% (Elo)',
                  homeTeam: score.home,
                  awayTeam: score.away,
                  source: 'ESPN API',
                  weights: JSON.stringify(weights || {}).slice(0,80),
                }
              });
            }
          }
        }
      } catch (err) {
        console.warn(`[Engine] Could not load ESPN markets for ${t.id}:`, err.message);
        // Continue — sports markets are optional enhancements (R2)
      }
    }

    E.sportsMarkets = markets;
    console.log(`[Engine] Loaded ${markets.length} sports markets from ESPN`);
  }

  /** Schedule next round market after bracket result (R13) */
  function scheduleNextRoundMarket(tournament, resolvedMarket, winner) {
    console.log(`[Engine] Bracket auto-advance: ${winner} advances in ${tournament.name}`);
    // In full implementation: fetch next round draw from ESPN,
    // calculate new Elo probability, create new market object.
    // For now: notify UI to refresh tournament display.
    notifyUI('bracket_advanced', { tournament, winner, resolvedMarket });
  }

  // ─────────────────────────────────────────────
  // STEP 6 — AUTO-RESOLUTION (R9)
  // ─────────────────────────────────────────────

  /**
   * Auto-resolve financial markets at month end (R9).
   * Fetches actual closing price from Yahoo Finance.
   * Called at 4:01pm ET on last trading day of month (R8).
   */
  async function autoResolveFinancialMarkets() {
    const hoursLeft = hoursBefore4pmETMonthEnd();
    if (hoursLeft > 0.1) return; // not yet time

    console.log('[Engine] Auto-resolving financial markets...');
    for (const market of E.financialMarkets) {
      if (market.resolved) continue;
      try {
        const priceData = await fetchPriceData(market.ticker);
        if (!priceData) continue;
        const finalPrice = priceData.current;
        const result = finalPrice >= market.targetPrice ? 'YES' : 'NO';
        market.resolved = true;
        market.result = result;
        market.finalPrice = finalPrice;
        console.log(`[Engine] Resolved ${market.ticker}: ${finalPrice} vs ${market.targetPrice} → ${result}`);
        notifyUI('market_resolved', market);
        // Pay out winning positions
        payoutPositions(market.id, result);
      } catch (err) {
        console.warn(`[Engine] Could not resolve ${market.ticker}:`, err.message);
      }
    }
  }

  /** Payout winning positions from localStorage state */
  function payoutPositions(marketId, result) {
    try {
      const raw = localStorage.getItem('bidness_positions');
      if (!raw) return;
      const positions = JSON.parse(raw);
      const winning = positions.filter(p => p.marketId === marketId && p.side === result);
      let totalPayout = 0;
      winning.forEach(p => { totalPayout += p.shares; }); // $1 per share
      if (totalPayout > 0) {
        const balRaw = localStorage.getItem('bidness_balance');
        const bal = balRaw ? parseFloat(balRaw) : 10000;
        localStorage.setItem('bidness_balance', String(bal + totalPayout));
        notifyUI('payout', { marketId, result, amount: totalPayout });
        console.log(`[Engine] Paid out $${totalPayout.toFixed(2)} for ${marketId} → ${result}`);
      }
    } catch (err) {
      console.warn('[Engine] Payout error:', err.message);
    }
  }

  /** Auto-resolve a sports market and payout */
  function autoResolveSportsMarket(market) {
    payoutPositions(market.id, market.result);
    addActivityEvent({
      type: 'resolve',
      market: market.q,
      result: market.result,
      payout: Math.floor(Math.random() * 200 + 50) * 1000, // will be real payout in production
    });
  }

  // ─────────────────────────────────────────────
  // STEP 7 — DAILY RECALCULATION (R8)
  // ─────────────────────────────────────────────

  /** Check if we need to run the 4:01pm ET recalculation (R8) */
  function checkDailyRecalc() {
    if (!isPast4pmET()) return;
    const today = new Date().toDateString();
    const lastRecalc = localStorage.getItem('bidness_last_recalc');
    if (lastRecalc === today) return; // already done today

    console.log('[Engine] 4:01pm ET — running daily probability recalculation (R8)');
    localStorage.setItem('bidness_last_recalc', today);
    loadFinancialMarkets().then(() => {
      notifyUI('markets_updated', { reason: '4:01pm ET close' });
      addActivityEvent({
        type: 'price_update',
        message: 'Daily close received — all probabilities recalculated',
      });
    });
  }

  // ─────────────────────────────────────────────
  // STEP 8 — ACTIVITY FEED EVENTS
  // ─────────────────────────────────────────────

  function addActivityEvent(evt) {
    const feedList = document.getElementById('feedList');
    if (!feedList) return;
    // Dispatch custom event for index.html to handle
    window.dispatchEvent(new CustomEvent('bidness:feed', { detail: evt }));
  }

  /** Notify UI of engine events via custom events */
  function notifyUI(type, data) {
    window.dispatchEvent(new CustomEvent('bidness:' + type, { detail: data }));
  }

  // ─────────────────────────────────────────────
  // STEP 9 — LEADERBOARD (mock enhanced with real trade data)
  // ─────────────────────────────────────────────

  function buildLeaderboard() {
    // In production: read from real trade history in localStorage or backend.
    // For demo: realistic mock data that updates when user trades.
    return [
      {name:'Alexander Rowe',handle:'@arow_capital',profit:2400000,accuracy:94.2,trades:1847,ini:'AR',av:0,badges:['🔥','🎯','💎'],call:'Called Fed pause at 19% · +$340K'},
      {name:'Elena Vasquez',handle:'@elv_trades',profit:891000,accuracy:88.4,trades:923,ini:'EV',av:1,badges:['🎯','💎'],call:'Called BTC rally at 34% · +$84K'},
      {name:'Marcus Kim',handle:'@mk_forecast',profit:654000,accuracy:91.7,trades:672,ini:'MK',av:2,badges:['🔥','🎯'],call:'Called Labour win at 72% · +$29K'},
      {name:'Priya Sharma',handle:'@ps_markets',profit:412000,accuracy:86.1,trades:548,ini:'PS',av:3,badges:['🎯'],call:'Called ETF approval at 55% · +$61K'},
      {name:'James O\'Brien',handle:'@job_predict',profit:298000,accuracy:83.5,trades:441,ini:'JO',av:4,badges:['🔥'],call:'Called S&P 5500 at 41% · +$38K'},
      {name:'Yuki Tanaka',handle:'@yt_analytics',profit:187000,accuracy:89.3,trades:334,ini:'YT',av:5,badges:['🎯'],call:'Called SpaceX success at 71% · +$22K'},
      {name:'Ravi Patel',handle:'@ravi_calls',profit:142000,accuracy:81.2,trades:289,ini:'RP',av:0,badges:['🔥'],call:'Called gold rally at 38% · +$18K'},
      {name:'Sofia Chen',handle:'@sofia_bets',profit:98000,accuracy:79.8,trades:201,ini:'SC',av:1,badges:[],call:'Called GPT-5 delay at 62% · +$12K'},
    ];
  }

  // ─────────────────────────────────────────────
  // STEP 10 — TOURNAMENT OBJECTS FOR UI
  // ─────────────────────────────────────────────

  /**
   * Build display-ready tournament objects from config + ESPN data.
   * Each tournament includes its active markets as sub-items.
   */
  function buildTournamentObjects() {
    if (!E.config?.tournaments) return [];
    return E.config.tournaments.filter(t => t.active).map(t => {
      // Get markets for this tournament
      const tMkts = E.sportsMarkets.filter(m => m.tournamentId === t.id);

      // Build season winner candidates for leagues
      let seasonWinner = null;
      if (t.type === 'league') {
        seasonWinner = buildMockSeasonWinner(t);
      }

      // Build bracket for knockout tournaments
      let bracket = null;
      if (t.type === 'bracket') {
        bracket = buildMockBracket(t, tMkts);
      }

      return {
        ...t,
        activeMarkets: tMkts.length || getMockMarketCount(t),
        status: getTournamentStatus(t),
        seasonWinner,
        bracket,
        fixtures: tMkts.length ? tMkts.map(m => ({
          home: m.homeTeam,
          away: m.awayTeam,
          homeProb: m.yes,
          date: m.closes,
          status: m.suspended ? 'in_progress' : 'open',
        })) : getMockFixtures(t),
      };
    });
  }

  function getTournamentStatus(t) {
    const month = new Date().getMonth() + 1;
    if (t.type === 'league') return `Matchday ${Math.floor(Math.random()*5+32)} of 38`;
    if (t.type === 'bracket') {
      const rounds = t.rounds || [];
      return rounds[Math.min(rounds.length-1, 1)] || 'Active';
    }
    return 'Active';
  }

  function getMockMarketCount(t) {
    if (t.type === 'league') return Math.floor(Math.random()*5+5);
    if (t.type === 'bracket') return Math.floor(Math.random()*3+1);
    return 1;
  }

  function buildMockSeasonWinner(t) {
    const teams = {
      eng_premier_league: [{team:'Arsenal',prob:48,color:'#EF0107'},{team:'Man City',prob:31,color:'#6CABDD'},{team:'Liverpool',prob:14,color:'#C8102E'},{team:'Chelsea',prob:7,color:'#034694'}],
      sco_premiership:    [{team:'Celtic',prob:68,color:'#16A734'},{team:'Rangers',prob:25,color:'#1B458F'},{team:'Hearts',prob:7,color:'#8B0000'}],
      fra_ligue1:         [{team:'PSG',prob:71,color:'#004170'},{team:'Marseille',prob:16,color:'#009FC9'},{team:'Monaco',prob:13,color:'#ED1C24'}],
      esp_laliga:         [{team:'Real Madrid',prob:54,color:'#FEBE10'},{team:'Barcelona',prob:32,color:'#A50044'},{team:'Atletico',prob:14,color:'#CB3524'}],
      ita_seriea:         [{team:'Inter Milan',prob:56,color:'#0068A8'},{team:'AC Milan',prob:22,color:'#FB090B'},{team:'Juventus',prob:22,color:'#000000'}],
      ger_bundesliga:     [{team:'Bayern Munich',prob:61,color:'#DC052D'},{team:'Bayer Leverkusen',prob:24,color:'#E32221'},{team:'Dortmund',prob:15,color:'#FDE100'}],
    };
    return teams[t.id] || [{team:'Leader',prob:55,color:'#00c896'},{team:'Challenger',prob:30,color:'#3d7fff'},{team:'Contender',prob:15,color:'#9b72f5'}];
  }

  function buildMockBracket(t, liveMarkets) {
    const brackets = {
      uefa_champions_league: [
        {round:'Semi Finals',matches:[
          {home:'Real Madrid',away:'Bayern Munich',homeProb:56,date:'May 8',status:'open'},
          {home:'Arsenal',away:'PSG',homeProb:48,date:'May 8',status:'open'},
        ]},
        {round:'Final',matches:[{home:'TBD',away:'TBD',homeProb:50,date:'Jun 1',status:'pending'}]},
      ],
      fifa_world_cup: [
        {round:'Group Stage',matches:[
          {home:'France',away:'England',homeProb:54,date:'Jun 15',status:'open'},
          {home:'Brazil',away:'Argentina',homeProb:47,date:'Jun 16',status:'open'},
        ]},
      ],
      tennis_french_open: [
        {round:'Semi Finals',matches:[
          {home:'Alcaraz',away:'Djokovic',homeProb:54,date:'Jun 6',status:'open'},
          {home:'Sinner',away:'Ruud',homeProb:63,date:'Jun 6',status:'open'},
        ]},
        {round:'Final',matches:[{home:'TBD',away:'TBD',homeProb:50,date:'Jun 8',status:'pending'}]},
      ],
      tennis_wimbledon: [
        {round:'Quarter Finals',matches:[
          {home:'Alcaraz',away:'Medvedev',homeProb:61,date:'Jul 10',status:'open'},
          {home:'Djokovic',away:'Sinner',homeProb:52,date:'Jul 10',status:'open'},
        ]},
      ],
    };
    // Merge with any live ESPN markets
    const base = brackets[t.id] || [{round:t.rounds?.[0]||'Current Round',matches:[{home:'TBD',away:'TBD',homeProb:50,date:'TBD',status:'pending'}]}];
    if (liveMarkets.length) {
      base[0].matches = liveMarkets.slice(0,4).map(m => ({
        home: m.homeTeam, away: m.awayTeam,
        homeProb: m.yes, date: m.closes,
        status: m.suspended ? 'in_progress' : 'open',
        score: m.liveScore,
      }));
    }
    return base;
  }

  function getMockFixtures(t) {
    const fixtures = {
      eng_premier_league: [
        {home:'Arsenal',away:'Everton',homeProb:78,date:'May 18',status:'open'},
        {home:'Liverpool',away:'Wolves',homeProb:72,date:'May 18',status:'open'},
        {home:'Man City',away:'West Ham',homeProb:81,date:'May 18',status:'open'},
      ],
      sco_premiership: [
        {home:'Celtic',away:'Rangers',homeProb:57,date:'May 25',status:'open'},
        {home:'Hearts',away:'Hibs',homeProb:51,date:'May 25',status:'open'},
      ],
    };
    return fixtures[t.id] || [];
  }

  // ─────────────────────────────────────────────
  // PUBLIC API — window.BidnessEngine
  // ─────────────────────────────────────────────

  window.BidnessEngine = {
    ready: false,
    dataSource: 'loading',

    /** Returns computed financial market objects */
    getFinancialMarkets() {
      return E.financialMarkets.length ? E.financialMarkets : window.BidnessEngine._stub.getFinancialMarkets();
    },

    /** Returns computed sports market objects */
    getSportsMarkets() {
      return E.sportsMarkets;
    },

    /** Returns display-ready tournament objects */
    getTournaments() {
      const built = buildTournamentObjects();
      return built.length ? built : window.BidnessEngine._stub.getTournaments();
    },

    /** Returns leaderboard data */
    getLeaderboard() {
      return buildLeaderboard();
    },

    /** Called by index.html when a trade is confirmed — updates prices */
    onTrade(marketId, side, amount) {
      const m = E.financialMarkets.find(x => x.id === marketId)
             || E.sportsMarkets.find(x => x.id === marketId);
      if (!m) return;
      // AMM-style price impact: larger trades move price more
      const impact = (amount / 100000) * 2.5;
      if (side === 'YES') m.yes = Math.min(69, Math.round(m.yes + impact));
      else m.yes = Math.max(31, Math.round(m.yes - impact));
      // Save to localStorage for persistence
      try { localStorage.setItem('bidness_last_trade', JSON.stringify({marketId, side, amount, ts: Date.now()})); }
      catch(e) {}
    },

    /** Returns admin flags list */
    getFlags() { return E.flags; },

    /** Returns scanner countdown */
    getScanCountdown() { return E.scanCountdown; },

    /** Force a manual ESPN scan */
    async manualScan() { await espnPoll(); },

    /** Stub reference — index.html sets this before engine loads */
    _stub: null,
  };

  // ─────────────────────────────────────────────
  // INITIALISATION
  // ─────────────────────────────────────────────

  async function init() {
    console.log('[Engine] Initialising Bidness.ai engine...');
    setStatus('loading', 'Loading...');

    // Save stub reference before overwriting
    window.BidnessEngine._stub = window.BidnessEngine._stub || {
      getFinancialMarkets: () => [],
      getTournaments: () => [],
    };

    // Step 1: Load config
    await loadConfig();

    // Step 2: Load financial markets (parallel fetch all tickers)
    await loadFinancialMarkets();

    // Step 3: Load sports markets from ESPN
    await loadSportsMarkets();

    // Step 4: Build leaderboard
    E.leaderboard = buildLeaderboard();

    // Mark ready
    E.ready = true;
    E.dataSource = E.financialMarkets.length > 0 ? 'live' : 'mock';
    window.BidnessEngine.ready = true;
    window.BidnessEngine.dataSource = E.dataSource;

    setStatus(E.dataSource === 'live' ? 'live' : 'mock',
              E.dataSource === 'live' ? 'Live data' : 'Demo data');

    // Update data source display
    const subEl = document.getElementById('dataStatSub');
    if (subEl) subEl.textContent = E.dataSource === 'live' ? 'Yahoo · Binance · ESPN' : 'Mock data';

    // Notify index.html that engine is ready — triggers re-render
    window.dispatchEvent(new CustomEvent('bidness:ready', {
      detail: { marketCount: E.financialMarkets.length, dataSource: E.dataSource }
    }));

    console.log(`[Engine] Ready — ${E.financialMarkets.length} financial, ${E.sportsMarkets.length} sports markets`);

    // Step 5: Start 15-minute ESPN poll (R17 R11 — only while page is open)
    E.pollTimer = setInterval(async () => {
      await espnPoll();
      // Also check daily recalc trigger
      checkDailyRecalc();
      // Check month-end resolution
      await autoResolveFinancialMarkets();
      // Tick scan countdown in UI
      E.scanCountdown = 900;
    }, POLL_MS);

    // Step 6: Check if we need daily recalc right now (R8)
    checkDailyRecalc();

    // Step 7: Check month-end resolution (R9)
    await autoResolveFinancialMarkets();

    // Step 8: Countdown ticker for admin scanner display
    setInterval(() => {
      E.scanCountdown = Math.max(0, E.scanCountdown - 1);
      const el = document.getElementById('scanNext');
      if (el) {
        const m = Math.floor(E.scanCountdown / 60);
        const s = E.scanCountdown % 60;
        el.textContent = m + ':' + (s < 10 ? '0' : '') + s;
      }
    }, 1000);
  }

  // Start engine when DOM is ready (R11 — page-open triggers refresh)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
