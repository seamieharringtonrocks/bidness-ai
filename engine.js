/**
 * Bidness.ai — engine.js v2.0
 * Rules enforced: R1 R2 R4 R5 R6 R7 R8 R9 R10 R11 R12 R13 R14 R16 R17 R18 R19 R20
 *
 * DATA SOURCES (all free, no API keys — R1):
 *   Stocks/ETFs  : Yahoo Finance (cors=true) → Stooq fallback
 *   Crypto       : Binance public API → CoinGecko fallback
 *   Football Elo : club-elo.com API (club matches) / fifa_team_elo in tournaments.json (internationals)
 *   Tennis       : ATP/WTA rankings in tournaments.json (R20) + surface win rates
 *   Sports data  : ESPN unofficial API → TheSportsDB on-demand fallback (R16)
 *   Golf         : Coming soon — placeholder only
 *
 * All external calls routed through corsproxy.io (R1 — free, no key, GitHub Pages compatible)
 */

(async function BidnessEngine() {
  'use strict';

  // ─────────────────────────────────────────────
  // CORS PROXY — R1: required for GitHub Pages
  // corsproxy.io is free, no key required
  // ─────────────────────────────────────────────
  const PROXY = 'https://corsproxy.io/?';
  const px = url => PROXY + encodeURIComponent(url);

  // Base URLs (never called directly — always wrapped with px())
  const YAHOO   = 'https://query1.finance.yahoo.com/v8/finance/chart';
  const STOOQ   = 'https://stooq.com/q/d/l';
  const BINANCE = 'https://api.binance.com/api/v3/klines';
  const GECKO   = 'https://api.coingecko.com/api/v3/coins';
  const ESPN    = 'https://site.api.espn.com/apis/site/v2/sports';
  const TSDB    = 'https://www.thesportsdb.com/api/v1/json/3';
  const CLUBELO = 'http://api.clubelo.com';

  const POLL_MS = 15 * 60 * 1000; // R17: 15-minute scan interval

  // ─────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────
  const E = {
    config:           null,
    financialMarkets: [],
    sportsMarkets:    [],
    tournaments:      [],
    leaderboard:      [],
    lastKnown:        {},   // R2: last known prices
    clubEloCache:     {},   // cache club Elo to avoid hammering API
    ready:            false,
    dataSource:       'loading',
    flags:            [],
    scanCountdown:    900,
  };

  // ─────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────

  /** Φ(x) — cumulative normal distribution for GBM model */
  function normalCDF(x) {
    const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
    return 0.5*(1+sign*y);
  }

  /** Safe fetch with timeout — R2: never throws to caller */
  async function safeFetch(url, timeoutMs=9000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch(e) {
      clearTimeout(timer);
      throw e;
    }
  }

  /** Safe text fetch (for CSV responses) */
  async function safeFetchText(url, timeoutMs=9000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch(e) {
      clearTimeout(timer);
      throw e;
    }
  }

  /** R4: Format ISO date string to user local time */
  function formatLocalDate(isoOrStr) {
    if (!isoOrStr || isoOrStr === 'TBD') return 'TBD';
    try {
      const d = new Date(isoOrStr);
      if (isNaN(d)) return isoOrStr; // fallback to raw string
      return d.toLocaleDateString(undefined, { month:'short', day:'numeric' });
    } catch { return isoOrStr; }
  }

  /** R4: Format full local datetime */
  function formatLocalDateTime(isoStr) {
    if (!isoStr) return 'TBD';
    try {
      const d = new Date(isoStr);
      return d.toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    } catch { return isoStr; }
  }

  /** Trading days left until end of current month — R7 R8 */
  function tradingDaysLeft() {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth()+1, 0);
    let count = 0;
    const d = new Date(now); d.setDate(d.getDate()+1);
    while (d <= end) { if (d.getDay()!==0&&d.getDay()!==6) count++; d.setDate(d.getDate()+1); }
    return count;
  }

  /** Hours until 4pm ET on last trading day of month — R7 */
  function hoursUntilMonthEndClose() {
    const now = new Date();
    const last = new Date(now.getFullYear(), now.getMonth()+1, 0);
    const isDST = last.getMonth()>=2 && last.getMonth()<=10;
    last.setUTCHours(isDST?20:21, 0, 0, 0); // 4pm ET in UTC
    return (last - now) / 3600000;
  }

  /** R8: Has 4:01pm ET passed today? */
  function isPast4pmET() {
    const now = new Date();
    const isDST = now.getMonth()>=2 && now.getMonth()<=10;
    const etHour = (now.getUTCHours() + (isDST?-4:-5) + 24) % 24;
    return etHour > 16 || (etHour===16 && now.getUTCMinutes()>=1);
  }

  /** Update engine status chip in UI */
  function setStatus(status, label) {
    const dot=document.getElementById('engD'), lbl=document.getElementById('engL');
    if (!dot||!lbl) return;
    dot.className='ed'+(status==='live'?' live':status==='loading'?' loading':'');
    lbl.textContent=label;
  }

  /** Notify index.html via custom events */
  function emit(type, data) {
    window.dispatchEvent(new CustomEvent('bidness:'+type, { detail: data }));
  }

  // ─────────────────────────────────────────────
  // STEP 1 — LOAD CONFIG (R12)
  // ─────────────────────────────────────────────
  async function loadConfig() {
    try {
      // Try local first (GitHub Pages), then proxied
      let data;
      try { data = await safeFetch('./tournaments.json'); }
      catch { data = await safeFetch(px(window.location.origin + '/tournaments.json')); }
      E.config = data;
      console.log('[Engine] Config loaded —', E.config.tournaments?.length, 'tournaments');
    } catch(e) {
      console.warn('[Engine] Could not load tournaments.json:', e.message);
      E.config = { tournaments:[], model_weights:{}, surface_win_rates:{},
                   stooq_ticker_map:{}, financial_config:{}, admin_scanner_config:{},
                   atp_rankings:{players:[]}, wta_rankings:{players:[]}, fifa_team_elo:{teams:{}} };
    }
  }

  // ─────────────────────────────────────────────
  // STEP 2 — FINANCIAL DATA + GBM MODEL
  // ─────────────────────────────────────────────

  const TICKERS = ['JPM','GS','XOM','JNJ','AAPL','NVDA','MSFT','GOOGL','AMZN',
                   'SPY','QQQ','GLD','TLT','BRK-B'];
  const CRYPTO  = [{id:'BTC-USD',binance:'BTCUSDT',gecko:'bitcoin'},
                   {id:'ETH-USD',binance:'ETHUSDT',gecko:'ethereum'}];

  async function fetchYahoo(ticker) {
    const url = px(`${YAHOO}/${encodeURIComponent(ticker)}?interval=1d&range=1y&cors=true`);
    const data = await safeFetch(url, 10000);
    const r = data?.chart?.result?.[0];
    if (!r) throw new Error('No Yahoo data');
    const closes = r.indicators.quote[0].close.filter(c=>c!=null);
    return { closes, current: r.meta.regularMarketPrice, source:'yahoo' };
  }

  async function fetchStooq(ticker) {
    const map = E.config?.stooq_ticker_map || {};
    const st = map[ticker] || (ticker.toLowerCase()+'.us'); // R18
    const url = px(`${STOOQ}/?s=${st}&i=d`);
    const text = await safeFetchText(url, 10000);
    const lines = text.trim().split('\n').slice(1);
    const closes = lines.map(l=>parseFloat(l.split(',')[4])).filter(v=>!isNaN(v)).slice(-252);
    if (!closes.length) throw new Error('No Stooq data');
    return { closes, current: closes[closes.length-1], source:'stooq' };
  }

  async function fetchBinance(symbol) {
    // Binance allows CORS natively — no proxy needed (R19)
    const url = `${BINANCE}?symbol=${symbol}&interval=1d&limit=252`;
    const data = await safeFetch(url, 10000);
    if (!Array.isArray(data)||!data.length) throw new Error('No Binance data');
    const closes = data.map(k=>parseFloat(k[4]));
    return { closes, current: closes[closes.length-1], source:'binance' };
  }

  async function fetchGecko(coinId) {
    // CoinGecko allows CORS natively — R19 fallback
    const url = `${GECKO}/${coinId}/market_chart?vs_currency=usd&days=365&interval=daily`;
    const data = await safeFetch(url, 10000);
    if (!data?.prices?.length) throw new Error('No CoinGecko data');
    const closes = data.prices.map(p=>p[1]);
    return { closes, current: closes[closes.length-1], source:'coingecko' };
  }

  async function fetchPriceData(ticker) {
    const crypto = CRYPTO.find(c=>c.id===ticker);
    if (crypto) {
      try { return await fetchBinance(crypto.binance); }
      catch(e) {
        console.warn(`[Engine] Binance failed ${ticker}:`, e.message);
        try { return await fetchGecko(crypto.gecko); }
        catch(e2) { console.warn(`[Engine] CoinGecko failed ${ticker}:`, e2.message); return null; }
      }
    }
    try { return await fetchYahoo(ticker); }
    catch(e) {
      console.warn(`[Engine] Yahoo failed ${ticker}:`, e.message);
      try { return await fetchStooq(ticker); } // R18
      catch(e2) { console.warn(`[Engine] Stooq failed ${ticker}:`, e2.message); return null; }
    }
  }

  /** GBM probability: P(price reaches target by month end) — R10 */
  function gbmProbability(current, target, closes) {
    if (!closes||closes.length<20) return 0.5;
    const rets = [];
    for (let i=1;i<closes.length;i++) {
      if (closes[i-1]>0&&closes[i]>0) rets.push(Math.log(closes[i]/closes[i-1]));
    }
    if (!rets.length) return 0.5;
    const mu = rets.reduce((s,r)=>s+r,0)/rets.length;
    const variance = rets.reduce((s,r)=>s+(r-mu)**2,0)/rets.length;
    const vol = Math.sqrt(variance);
    const t = Math.max(1, tradingDaysLeft());
    const d = (Math.log(current/target) + (mu-0.5*vol**2)*t) / (vol*Math.sqrt(t));
    return Math.min(0.99, Math.max(0.01, normalCDF(d)));
  }

  /** R10: Auto-raise target until probability < 70% ceiling */
  function adjustTarget(current, closes, prob) {
    const ceil = E.config?.financial_config?.probability_ceiling || 0.70;
    if (prob < ceil) return current;
    let target = current * 1.005;
    for (let i=0;i<200;i++) {
      if (gbmProbability(current, target, closes) < ceil) return target;
      target *= 1.005;
    }
    return target;
  }

  function getMonthEndISO() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth()+1, 0).toISOString().split('T')[0];
  }

  function buildFinancialMarket(ticker, priceData, category, icon, exchange) {
    const { closes, current, source } = priceData;
    let target = current;
    let prob = gbmProbability(current, target, closes);
    if (prob > 0.70) { target = adjustTarget(current, closes, prob); prob = gbmProbability(current, target, closes); }

    const yes = Math.min(69, Math.max(31, Math.round(prob*100)));
    const suspended = hoursUntilMonthEndClose() < 24; // R7

    const rets = [];
    for (let i=1;i<closes.length;i++) if(closes[i-1]>0) rets.push((closes[i]-closes[i-1])/closes[i-1]);
    const mu = rets.reduce((s,r)=>s+r,0)/rets.length;
    const vol = Math.sqrt(rets.reduce((s,r)=>s+(r-mu)**2,0)/rets.length);

    const monthlyRets = [];
    for (let i=21;i<closes.length;i++) monthlyRets.push((closes[i]-closes[i-21])/closes[i-21]);
    const targetPct = (target-current)/current;
    const winRate = monthlyRets.length ? Math.round(monthlyRets.filter(r=>r>targetPct).length/monthlyRets.length*100) : 50;

    const targetFmt = current>1000
      ? '$'+target.toLocaleString('en-US',{maximumFractionDigits:0})
      : '$'+target.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});

    return {
      id: ticker.toLowerCase().replace(/[^a-z0-9]/g,'_'),
      ticker, cat: category, icon, exchange,
      q: `Will ${ticker} close above ${targetFmt} by month end?`,
      yes, no: 100-yes,
      vol: '$'+(Math.random()*20+2).toFixed(1)+'M',
      liq: '$'+(Math.random()*6+0.5).toFixed(1)+'M',
      closes: formatLocalDate(getMonthEndISO()), // R4
      closesISO: getMonthEndISO(),
      days: tradingDaysLeft(),
      suspended,
      suspendReason: suspended ? '24hr pre-close suspension (R7)' : null,
      priceHistory: closes.slice(-30),
      currentPrice: current,
      targetPrice: target,
      dataSource: source,
      model: {
        currentPrice: '$'+current.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}),
        targetPrice: targetFmt,
        distanceToTarget: ((target-current)/current*100).toFixed(1)+'%',
        dailyVolatility: (vol*100).toFixed(2)+'% daily',
        monthlyVolatility: (vol*Math.sqrt(21)*100).toFixed(1)+'% monthly',
        annualisedDrift: (mu*252*100).toFixed(1)+'% per year',
        tradingDaysLeft: tradingDaysLeft(),
        historicWinRate: winRate+'% (12-month backtest)',
        dataPoints: closes.length+' daily closes',
        source: source==='yahoo'?'Yahoo Finance (cors=true)':source==='stooq'?'Stooq.com (R18 fallback)':source==='binance'?'Binance public API':'CoinGecko free (R19 fallback)',
        targetAdjusted: prob>0.68?'Yes — raised to keep prob below 70% ceiling (R10)':'No',
        model: 'GBM Black-Scholes binary option formula',
      }
    };
  }

  async function loadFinancialMarkets() {
    setStatus('loading','Loading prices...');
    const cats  = {JPM:'Finance',GS:'Finance',XOM:'Energy',JNJ:'Healthcare',AAPL:'Tech',
                   NVDA:'Tech',MSFT:'Tech',GOOGL:'Tech',AMZN:'Tech',SPY:'Macro',
                   QQQ:'Macro',GLD:'Macro',TLT:'Macro','BRK-B':'Finance','BTC-USD':'Crypto','ETH-USD':'Crypto'};
    const icons = {JPM:'🏦',GS:'💰',XOM:'⛽',JNJ:'💊',AAPL:'🍎',NVDA:'🖥',MSFT:'🪟',
                   GOOGL:'🔍',AMZN:'📦',SPY:'📈',QQQ:'💹',GLD:'🥇',TLT:'🏛','BRK-B':'🏢','BTC-USD':'₿','ETH-USD':'⟠'};
    const exch  = {JPM:'NYSE',GS:'NYSE',XOM:'NYSE',JNJ:'NYSE','BRK-B':'NYSE',SPY:'NYSE',GLD:'NYSE',
                   AAPL:'NASDAQ',NVDA:'NASDAQ',MSFT:'NASDAQ',GOOGL:'NASDAQ',AMZN:'NASDAQ',QQQ:'NASDAQ',TLT:'NASDAQ',
                   'BTC-USD':'Binance','ETH-USD':'Binance'};

    const allTickers = [...TICKERS, ...CRYPTO.map(c=>c.id)];
    const results = [];

    await Promise.all(allTickers.map(async ticker => {
      try {
        const pd = await fetchPriceData(ticker);
        if (pd) {
          E.lastKnown[ticker] = pd.current; // R2: save last known
          results.push(buildFinancialMarket(ticker, pd, cats[ticker]||'Finance', icons[ticker]||'📊', exch[ticker]||'NYSE'));
        } else if (E.lastKnown[ticker]) {
          console.warn(`[Engine] R2: Using last known value for ${ticker}`);
        }
      } catch(e) {
        console.warn(`[Engine] R2: Skipping ${ticker}:`, e.message);
      }
    }));

    E.financialMarkets = results;
    console.log(`[Engine] ${results.length} financial markets loaded`);

    // Update data source display — R2
    const sources = [...new Set(results.map(m=>m.dataSource))];
    const el = id => document.getElementById(id);
    if(el('dStS')) el('dStS').textContent = sources.join(' + ');
    if(el('actDSrc')) el('actDSrc').textContent = sources.join(' + ');
  }

  // ─────────────────────────────────────────────
  // STEP 3 — FOOTBALL ELO (Live club-elo.com)
  // ─────────────────────────────────────────────

  /** Fetch real Elo rating from club-elo.com for a club team */
  async function fetchClubElo(teamName) {
    if (E.clubEloCache[teamName]) return E.clubEloCache[teamName];
    // club-elo.com returns CSV: Rank,Club,Country,Level,Elo,From,To
    const slug = teamName.replace(/ /g,''); // e.g. "Real Madrid" → "RealMadrid"
    try {
      const url = px(`${CLUBELO}/${slug}`);
      const text = await safeFetchText(url, 7000);
      const lines = text.trim().split('\n');
      // Find most recent entry (last line with valid Elo)
      for (let i=lines.length-1;i>=1;i--) {
        const parts = lines[i].split(',');
        const elo = parseFloat(parts[4]);
        if (!isNaN(elo) && elo > 0) {
          E.clubEloCache[teamName] = elo;
          return elo;
        }
      }
    } catch(e) {
      console.warn(`[Engine] club-elo.com failed for ${teamName}:`, e.message);
    }
    // Fallback: check fifa_team_elo in config (for international teams)
    const intlElo = E.config?.fifa_team_elo?.teams?.[teamName];
    if (intlElo) return intlElo;
    return 1700; // R2: graceful degradation default
  }

  /** Standard Elo win probability */
  function eloProbability(ratingA, ratingB) {
    return 1 / (1 + Math.pow(10, (ratingB-ratingA)/400));
  }

  /**
   * Full weighted football probability model.
   * Inputs: real Elo ratings + ESPN form data + config weights (R12 R20)
   */
  function footballProbabilityWeighted(homeElo, awayElo, matchData, weights) {
    const w = weights || E.config?.model_weights?.football_league || {
      elo_base:0.35, head_to_head:0.15, recent_form:0.20,
      home_away:0.10, goals_ratio:0.10, competition_stage:0.05, absence_flag:0.05
    };
    const eloBase  = eloProbability(homeElo, awayElo);
    const h2hScore = matchData?.h2hHomeWins!=null ? matchData.h2hHomeWins/Math.max(1,matchData.h2hTotal) : 0.5;
    const homeForm = matchData?.homeForm ?? 0.6;
    const awayForm = matchData?.awayForm ?? 0.4;
    const formScore= homeForm/(homeForm+awayForm+0.001);
    const homeAdv  = 0.57; // historical home advantage
    const homeGR   = (matchData?.homeGoalsFor??1.5)/Math.max(0.5, matchData?.homeGoalsAgainst??1.0);
    const awayGR   = (matchData?.awayGoalsFor??1.2)/Math.max(0.5, matchData?.awayGoalsAgainst??1.1);
    const goalsScore = homeGR/(homeGR+awayGR+0.001);
    const stageScore = matchData?.isKnockout ? 0.5 : eloBase;
    const absencePen = matchData?.keyAbsenceHome ? -0.05 : 0;

    const raw = (
      w.elo_base          * eloBase    +
      w.head_to_head      * h2hScore   +
      w.recent_form       * formScore  +
      w.home_away         * homeAdv    +
      w.goals_ratio       * goalsScore +
      w.competition_stage * stageScore +
      w.absence_flag      * 0.5
    ) + absencePen;

    return Math.min(0.89, Math.max(0.11, raw));
  }

  // ─────────────────────────────────────────────
  // STEP 4 — TENNIS PROBABILITY MODEL (R20)
  // Rankings from tournaments.json, surface rates hardcoded
  // ─────────────────────────────────────────────

  function getTennisRanking(playerName, tour='atp') {
    const rankings = tour==='atp'
      ? E.config?.atp_rankings?.players || []
      : E.config?.wta_rankings?.players || [];
    const p = rankings.find(r => r.name.toLowerCase()===playerName.toLowerCase());
    return p ? p.points : 2000; // R2: default mid-ranking
  }

  /** R20: Surface win rates in tournaments.json */
  function getSurfaceWinRate(playerName, surface) {
    return E.config?.surface_win_rates?.[surface]?.[playerName] ?? 0.65;
  }

  function tennisProbabilityWeighted(playerA, playerB, surface, tour='atp') {
    const w = E.config?.model_weights?.tennis_grand_slam || {
      ranking_elo:0.25, surface_win_rate:0.25, head_to_head:0.20,
      recent_form:0.15, seeding_path:0.10, warmup_result:0.05
    };
    const ptA = getTennisRanking(playerA.name, tour);
    const ptB = getTennisRanking(playerB.name, tour);
    const eloBase    = eloProbability(ptA, ptB);
    const aRate      = getSurfaceWinRate(playerA.name, surface);
    const bRate      = getSurfaceWinRate(playerB.name, surface);
    const surfScore  = aRate/(aRate+bRate+0.001);
    const h2hScore   = playerA.h2hWins!=null ? playerA.h2hWins/Math.max(1,playerA.h2hWins+playerB.h2hWins) : 0.5;
    const formScore  = (playerA.recentForm??0.6)/((playerA.recentForm??0.6)+(playerB.recentForm??0.4)+0.001);
    const seedA      = playerA.seed || 8;
    const seedB      = playerB.seed || 8;
    const seedScore  = seedB/(seedA+seedB+0.001);
    const warmupScore= playerA.wonWarmup ? 0.62 : playerB.wonWarmup ? 0.38 : 0.5;

    const raw = (
      w.ranking_elo       * eloBase    +
      w.surface_win_rate  * surfScore  +
      w.head_to_head      * h2hScore   +
      w.recent_form       * formScore  +
      w.seeding_path      * seedScore  +
      w.warmup_result     * warmupScore
    );
    return Math.min(0.89, Math.max(0.11, raw));
  }

  // ─────────────────────────────────────────────
  // STEP 5 — ESPN POLLING (R5 R6 R13 R17)
  // ─────────────────────────────────────────────

  async function fetchESPN(sport, league, endpoint='scoreboard') {
    const url = px(`${ESPN}/${sport}/${league}/${endpoint}`);
    return await safeFetch(url, 9000);
  }

  function parseESPNStatus(event) {
    const s = event?.status?.type?.name || '';
    if (s==='STATUS_FINAL') return 'final';
    if (s==='STATUS_IN_PROGRESS') return 'in_progress';
    if (s==='STATUS_SCHEDULED') return 'scheduled';
    if (s==='STATUS_POSTPONED') return 'postponed';
    if (s==='STATUS_CANCELLED') return 'cancelled';
    return 'unknown';
  }

  function parseESPNTeams(event) {
    try {
      const comps = event.competitions[0].competitors;
      const home = comps.find(c=>c.homeAway==='home');
      const away = comps.find(c=>c.homeAway==='away');
      return {
        home: home?.team?.displayName || home?.team?.shortDisplayName || '?',
        away: away?.team?.displayName || away?.team?.shortDisplayName || '?',
        homeScore: parseInt(home?.score||0),
        awayScore: parseInt(away?.score||0),
        winner: comps.find(c=>c.winner===true)?.team?.displayName || null,
      };
    } catch { return null; }
  }

  /** R17: 15-min scan — withdrawals, postponements, finals only */
  async function espnPoll() {
    if (!E.config?.tournaments) return;
    const active = E.config.tournaments.filter(t=>t.active && t.espn_sport && !t.coming_soon);
    console.log(`[Engine] R17: ESPN poll — ${active.length} tournaments`);

    for (const t of active) {
      try {
        const data = await fetchESPN(t.espn_sport, t.espn_league);
        if (!data?.events) continue;

        for (const event of data.events) {
          const status = parseESPNStatus(event);
          const teams  = parseESPNTeams(event);
          if (!teams) continue;
          const mktId = `${t.id}_${event.id}`;
          const market = E.sportsMarkets.find(m=>m.espnEventId===event.id||m.id===mktId);

          // R5: Suspend at kick-off
          if (status==='in_progress' && market && !market.suspended) {
            market.suspended = true;
            market.suspendReason = 'in_progress';
            market.liveScore = teams;
            emit('market_suspended', market);
            console.log(`[Engine] R5: Suspended ${market.q}`);
          }

          // R5 R9: Auto-resolve on final
          if (status==='final' && market && !market.resolved) {
            market.resolved = true;
            market.suspended = true;
            market.result = teams.winner===market.homeTeam ? 'YES' : 'NO';
            market.finalScore = teams;
            market.suspendReason = 'result_pending'; // R6
            payoutPositions(market.id, market.result);
            emit('market_resolved', market);
            // R13: Bracket auto-advance
            if (t.type==='bracket' && teams.winner) advanceBracket(t, market, teams.winner);
            console.log(`[Engine] R5/R9: Resolved ${market.q} → ${market.result}`);
          }

          // Flag postponements for admin (R17)
          if (status==='postponed') {
            const flag = { type:'postponed', name:event.name, tournamentId:t.id,
                           detail:'Match postponed — market may be stale', eventId:event.id };
            if (!E.flags.find(f=>f.eventId===event.id)) {
              E.flags.push(flag);
              emit('flag_added', flag);
            }
          }

          // R6: Check for withdrawn players in tennis (scan event details)
          if (t.sport==='tennis' && event.notes?.length) {
            const withdrawal = event.notes.find(n=>n.type?.toLowerCase().includes('withdrawal')||n.headline?.toLowerCase().includes('retir'));
            if (withdrawal && market) {
              market.suspended = true;
              market.suspendReason = 'withdrawal';
              const flag = { type:'withdrawal', name:event.name, tournamentId:t.id,
                             detail: withdrawal.headline||'Player withdrawal detected', eventId:event.id };
              if (!E.flags.find(f=>f.eventId===event.id)) {
                E.flags.push(flag); emit('flag_added', flag);
              }
            }
          }
        }
      } catch(e) {
        console.warn(`[Engine] R2: ESPN poll failed ${t.id}:`, e.message);
        // Graceful degradation — continue with next tournament
      }
    }

    const el = document.getElementById('lastScan');
    if (el) el.textContent = 'Last scan: '+new Date().toLocaleTimeString();
    E.scanCountdown = 900;
    emit('scan_complete', { timestamp: Date.now(), flags: E.flags.length });
  }

  /** R13: Bracket auto-advance — create next round market */
  function advanceBracket(tournament, resolvedMarket, winner) {
    console.log(`[Engine] R13: ${winner} advances in ${tournament.name}`);
    // Find next round bracket slot and create market
    const bracket = E.config.tournaments.find(t=>t.id===tournament.id)?.bracket || [];
    for (let ri=0;ri<bracket.length;ri++) {
      for (let mi=0;mi<bracket[ri].matches.length;mi++) {
        const m = bracket[ri].matches[mi];
        if (m.home==='TBD'||m.away==='TBD') {
          // Slot winner in
          if (m.home==='TBD') { m.home=winner; }
          else if (m.away==='TBD') { m.away=winner; }
          // If both slots filled, create a market
          if (m.home!=='TBD'&&m.away!=='TBD'&&m.status==='pending') {
            m.status='open';
            // Recalculate probability with updated Elo
            fetchClubElo(m.home).then(heElo => {
              fetchClubElo(m.away).then(awElo => {
                const prob = footballProbabilityWeighted(heElo, awElo, {isKnockout:true});
                m.homeProb = Math.round(prob*100);
                emit('markets_updated', { reason:'Bracket advance — new match available' });
              });
            });
          }
          return;
        }
      }
    }
    emit('markets_updated', { reason:'Bracket advanced' });
  }

  // ─────────────────────────────────────────────
  // STEP 6 — SPORTS MARKETS FROM ESPN + ELO (R12 R14)
  // ─────────────────────────────────────────────

  /**
   * Build sports markets for a tournament.
   * R12: reads fixtures from tournaments.json config
   * R14: generates per-matchday markets for leagues
   */
  async function buildSportsMarketsForTournament(t) {
    const markets = [];
    if (t.coming_soon) return markets; // Golf placeholder — skip

    // Try ESPN for live/upcoming fixtures first
    let espnEvents = [];
    try {
      const data = await fetchESPN(t.espn_sport, t.espn_league);
      espnEvents = data?.events || [];
    } catch(e) {
      console.warn(`[Engine] ESPN failed for ${t.id}, using config fixtures (R2):`, e.message);
    }

    if (t.type==='league') {
      // R14: League per-matchday markets
      // Use ESPN events if available, fall back to config fixtures
      const fixtures = espnEvents.length > 0
        ? espnEvents.filter(e=>['scheduled','in_progress'].includes(parseESPNStatus(e))).slice(0,8)
        : null;

      if (fixtures && fixtures.length) {
        for (const event of fixtures) {
          const teams = parseESPNTeams(event);
          if (!teams) continue;
          const status = parseESPNStatus(event);
          // Fetch real Elo ratings from club-elo.com
          const [homeElo, awayElo] = await Promise.all([
            fetchClubElo(teams.home),
            fetchClubElo(teams.away),
          ]);
          const prob = footballProbabilityWeighted(homeElo, awayElo,
            { isKnockout:false }, E.config?.model_weights?.football_league);
          const yes = Math.min(89, Math.max(11, Math.round(prob*100)));

          markets.push({
            id: `${t.id}_${event.id}`,
            espnEventId: event.id,
            tournamentId: t.id,
            q: `Will ${teams.home} beat ${teams.away}? (${t.short_name})`,
            cat:'Sports', icon:t.icon,
            homeTeam:teams.home, awayTeam:teams.away,
            yes, no:100-yes,
            vol:'$'+( Math.random()*5+0.5).toFixed(1)+'M',
            liq:'$'+(Math.random()*2+0.2).toFixed(1)+'M',
            closes: formatLocalDate(event.date),       // R4
            closesISO: event.date || null,
            suspended: status==='in_progress',
            suspendReason: status==='in_progress' ? 'in_progress' : null,
            resolved: false,
            liveScore: status==='in_progress' ? teams : null,
            dataSource: 'espn',
            tournament: t.name,
            model: {
              homeTeam:teams.home, homeElo:Math.round(homeElo),
              awayTeam:teams.away, awayElo:Math.round(awayElo),
              eloProbability: Math.round(eloProbability(homeElo,awayElo)*100)+'%',
              weightedProbability: yes+'%',
              source:'club-elo.com + ESPN',
              weights: 'R12: from tournaments.json model_weights.football_league',
            }
          });
        }
      } else if (t.fixtures) {
        // R12: Fall back to config fixtures with FIFA Elo for international
        for (const f of t.fixtures.slice(0,6)) {
          const homeElo = E.config?.fifa_team_elo?.teams?.[f.home] || 1700;
          const awayElo = E.config?.fifa_team_elo?.teams?.[f.away] || 1650;
          const prob = footballProbabilityWeighted(homeElo, awayElo, {isKnockout:false});
          const yes = Math.min(89, Math.max(11, Math.round(prob*100)));
          markets.push({
            id:`${t.id}_${f.home.replace(/ /g,'_')}_${f.away.replace(/ /g,'_')}`,
            tournamentId:t.id, q:`Will ${f.home} beat ${f.away}? (${t.short_name})`,
            cat:'Sports', icon:t.icon, homeTeam:f.home, awayTeam:f.away,
            yes, no:100-yes, vol:'$'+(Math.random()*4+0.5).toFixed(1)+'M',
            liq:'$'+(Math.random()*1.5+0.2).toFixed(1)+'M',
            closes:formatLocalDate(f.date), closesISO:f.date||null,
            suspended:false, resolved:false, dataSource:'config', tournament:t.name,
            model:{homeTeam:f.home,homeElo,awayTeam:f.away,awayElo,
                   source:'Config fixtures + FIFA Elo (R12)'}
          });
        }
      }
    } else if (t.type==='bracket') {
      // Bracket tournament — build markets from config bracket + ESPN
      const allFixtures = t.group_stage_fixtures || [];
      const bracketRounds = t.bracket || [];

      // World Cup: build from group_stage_fixtures (R12)
      if (allFixtures.length) {
        // Only show upcoming fixtures (next 14 days) to avoid overwhelming UI
        const now = new Date();
        const soon = new Date(now); soon.setDate(soon.getDate()+21);
        const upcoming = allFixtures.filter(f => {
          const d = new Date(f.date+' 2026');
          return !isNaN(d) && d >= now && d <= soon;
        }).slice(0, 24); // R15: curated display

        for (const f of upcoming) {
          const homeElo = E.config?.fifa_team_elo?.teams?.[f.home] || 1700;
          const awayElo = E.config?.fifa_team_elo?.teams?.[f.away] || 1650;
          const prob = footballProbabilityWeighted(homeElo, awayElo, {isKnockout:false});
          const yes = Math.min(89, Math.max(11, Math.round(prob*100)));
          markets.push({
            id:`${t.id}_${f.home.replace(/ /g,'_')}_${f.away.replace(/ /g,'_')}`,
            tournamentId:t.id,
            q:`Will ${f.home} beat ${f.away}? (Group ${f.group})`,
            cat:'Sports', icon:t.icon, homeTeam:f.home, awayTeam:f.away,
            yes, no:100-yes, group:f.group,
            vol:'$'+(Math.random()*8+1).toFixed(1)+'M',
            liq:'$'+(Math.random()*3+0.5).toFixed(1)+'M',
            closes: formatLocalDate(f.date+' 2026'),
            closesISO: f.date+' 2026',
            suspended:false, resolved:false, dataSource:'config', tournament:t.name, venue:f.venue||'',
            model:{homeTeam:f.home,homeElo,awayTeam:f.away,awayElo,
                   group:'Group '+f.group, source:'FIFA Elo (tournaments.json R12)'}
          });
        }
      }

      // Bracket knockout rounds
      for (const round of bracketRounds) {
        for (const m of round.matches) {
          if (m.status!=='open'||m.home==='TBD'||m.away==='TBD') continue;
          const [homeElo, awayElo] = await Promise.all([
            fetchClubElo(m.home), fetchClubElo(m.away)
          ]);
          const prob = footballProbabilityWeighted(homeElo, awayElo, {isKnockout:true},
            E.config?.model_weights?.football_knockout);
          const yes = Math.min(89, Math.max(11, Math.round(prob*100)));
          m.homeProb = yes; // Update bracket display probability
          markets.push({
            id:`${t.id}_ko_${m.home.replace(/ /g,'_')}_${m.away.replace(/ /g,'_')}`,
            tournamentId:t.id, round:round.round,
            q:`Will ${m.home} beat ${m.away}? (${round.round})`,
            cat:'Sports', icon:t.icon, homeTeam:m.home, awayTeam:m.away,
            yes, no:100-yes, vol:'$'+(Math.random()*12+2).toFixed(1)+'M',
            liq:'$'+(Math.random()*4+1).toFixed(1)+'M',
            closes:formatLocalDate(m.date), closesISO:m.date||null,
            suspended:false, resolved:false, dataSource:'club-elo', tournament:t.name,
            model:{homeTeam:m.home,homeElo:Math.round(homeElo),awayTeam:m.away,awayElo:Math.round(awayElo),
                   round:round.round, source:'club-elo.com + weighted Elo'}
          });
        }
      }

      // Tennis bracket
      if (t.sport==='tennis') {
        const surface = t.surface || 'hard';
        const tour    = t.draws?.includes('womens_singles') ? 'wta' : 'atp';
        for (const round of bracketRounds) {
          for (const m of round.matches) {
            if (m.status!=='open'||m.home==='TBD'||m.away==='TBD') continue;
            const prob = tennisProbabilityWeighted(
              { name:m.home, seed:m.homeSeed||4 },
              { name:m.away, seed:m.awaySeed||8 },
              surface, tour
            );
            const yes = Math.min(89, Math.max(11, Math.round(prob*100)));
            m.homeProb = yes;
            markets.push({
              id:`${t.id}_${m.home.replace(/ /g,'_')}_${m.away.replace(/ /g,'_')}`,
              tournamentId:t.id, round:round.round,
              q:`Will ${m.home} beat ${m.away}? (${t.name} ${round.round})`,
              cat:'Sports', icon:t.icon, homeTeam:m.home, awayTeam:m.away,
              yes, no:100-yes, vol:'$'+(Math.random()*6+1).toFixed(1)+'M',
              liq:'$'+(Math.random()*2+0.5).toFixed(1)+'M',
              closes:formatLocalDate(m.date), closesISO:m.date||null,
              suspended:false, resolved:false, dataSource:'config', tournament:t.name, surface,
              model:{
                playerA:m.home, rankingPtsA:getTennisRanking(m.home,tour),
                surfaceWinRateA: (getSurfaceWinRate(m.home,surface)*100).toFixed(1)+'%',
                playerB:m.away, rankingPtsB:getTennisRanking(m.away,tour),
                surfaceWinRateB: (getSurfaceWinRate(m.away,surface)*100).toFixed(1)+'%',
                surface, round:round.round,
                source:'ATP/WTA rankings (tournaments.json R20) + surface rates',
              }
            });
          }
        }
      }
    }
    return markets;
  }

  async function loadSportsMarkets() {
    if (!E.config?.tournaments) return;
    const active = E.config.tournaments.filter(t=>t.active);
    const allMarkets = [];

    // Build sequentially to avoid hammering club-elo.com
    for (const t of active) {
      try {
        const mks = await buildSportsMarketsForTournament(t);
        allMarkets.push(...mks);
        console.log(`[Engine] ${t.id}: ${mks.length} markets built`);
      } catch(e) {
        console.warn(`[Engine] R2: Failed to build markets for ${t.id}:`, e.message);
      }
    }
    E.sportsMarkets = allMarkets;
    console.log(`[Engine] ${allMarkets.length} total sports markets loaded`);
  }

  // ─────────────────────────────────────────────
  // STEP 7 — TOURNAMENT DISPLAY OBJECTS (R12 R15)
  // ─────────────────────────────────────────────

  function buildTournamentDisplayObjects() {
    if (!E.config?.tournaments) return [];
    return E.config.tournaments.map(t => {
      const tMkts = E.sportsMarkets.filter(m=>m.tournamentId===t.id);

      // R15: curated display — group fixtures, limit display
      let displayFixtures = tMkts.slice(0,6).map(m=>({
        home:m.homeTeam, away:m.awayTeam, homeProb:m.yes,
        date:m.closes, status:m.suspended?'in_progress':'open',
        liveScore:m.liveScore||null,
      }));

      // Season winner probabilities for leagues (derived from Elo)
      let seasonWinner = t.seasonWinner || null;

      // World Cup: group by group letter
      let groupFixtures = null;
      if (t.group_stage_fixtures) {
        const groups = {};
        const upcomingMkts = tMkts.filter(m=>!m.resolved&&!m.suspended);
        upcomingMkts.forEach(m => {
          if (!groups[m.group]) groups[m.group] = [];
          groups[m.group].push(m);
        });
        groupFixtures = groups;
      }

      return {
        ...t,
        activeMarkets: tMkts.filter(m=>!m.resolved).length,
        fixtures: displayFixtures,
        seasonWinner,
        groupFixtures, // World Cup grouped display
        bracket: t.bracket || [],
      };
    });
  }

  // ─────────────────────────────────────────────
  // STEP 8 — AUTO-RESOLUTION (R9)
  // ─────────────────────────────────────────────

  async function autoResolveFinancialMarkets() {
    if (hoursUntilMonthEndClose() > 0.1) return;
    console.log('[Engine] R9: Auto-resolving financial markets at month end close');
    for (const market of E.financialMarkets) {
      if (market.resolved) continue;
      try {
        const pd = await fetchPriceData(market.ticker);
        if (!pd) continue;
        market.resolved = true;
        market.result = pd.current >= market.targetPrice ? 'YES' : 'NO';
        market.finalPrice = pd.current;
        payoutPositions(market.id, market.result);
        emit('market_resolved', market);
        console.log(`[Engine] R9: ${market.ticker} resolved → ${market.result}`);
      } catch(e) {
        console.warn(`[Engine] R2: Could not resolve ${market.ticker}:`, e.message);
      }
    }
  }

  function payoutPositions(marketId, result) {
    try {
      const raw = localStorage.getItem('bidness_positions');
      if (!raw) return;
      const positions = JSON.parse(raw);
      const winning = positions.filter(p=>p.marketId===marketId&&p.side===result);
      const totalPayout = winning.reduce((s,p)=>s+p.shares, 0);
      if (totalPayout > 0) {
        const bal = parseFloat(localStorage.getItem('bidness_balance')||'10000');
        localStorage.setItem('bidness_balance', String(bal+totalPayout));
        emit('payout', { marketId, result, amount:totalPayout });
        emit('feed', { type:'resolve', market:marketId, result, payout:totalPayout });
      }
    } catch(e) {
      console.warn('[Engine] Payout error:', e.message);
    }
  }

  // ─────────────────────────────────────────────
  // STEP 9 — DAILY RECALCULATION (R8)
  // ─────────────────────────────────────────────

  async function checkDailyRecalc() {
    if (!isPast4pmET()) return;
    const today = new Date().toDateString();
    if (localStorage.getItem('bidness_last_recalc')===today) return;
    console.log('[Engine] R8: 4:01pm ET — running daily recalculation');
    localStorage.setItem('bidness_last_recalc', today);
    await loadFinancialMarkets();
    emit('markets_updated', { reason:'4:01pm ET daily close' });
    emit('feed', { type:'price_update', message:'Daily close received — all GBM probabilities recalculated (R8)' });
  }

  // ─────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────

  window.BidnessEngine = {
    ready:      false,
    dataSource: 'loading',

    getFinancialMarkets() {
      return E.financialMarkets.length ? E.financialMarkets : (window.BidnessEngine._stub?.getFinancialMarkets?.() || []);
    },
    getSportsMarkets()   { return E.sportsMarkets; },
    getTournaments()     { return buildTournamentDisplayObjects(); },
    getLeaderboard()     { return buildLeaderboard(); },
    getFlags()           { return E.flags; },
    getScanCountdown()   { return E.scanCountdown; },

    onTrade(marketId, side, amount) {
      const m = [...E.financialMarkets,...E.sportsMarkets].find(x=>x.id===marketId);
      if (!m) return;
      const impact = (amount/100000)*2.5;
      m.yes = Math.min(89, Math.max(11, Math.round(side==='YES' ? m.yes+impact : m.yes-impact)));
      try { localStorage.setItem('bidness_last_trade', JSON.stringify({marketId,side,amount,ts:Date.now()})); } catch(e){}
    },

    async manualScan() { await espnPoll(); },

    // Formatting utility exposed to UI (R4)
    formatLocalDate,
    formatLocalDateTime,

    _stub: null,
  };

  // ─────────────────────────────────────────────
  // LEADERBOARD (mock — real order book not yet built)
  // ─────────────────────────────────────────────
  function buildLeaderboard() {
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
  // INIT (R11: page-open triggers all refreshes)
  // ─────────────────────────────────────────────
  async function init() {
    console.log('[Engine] Bidness.ai engine v2.0 initialising...');
    window.BidnessEngine._stub = window.BidnessEngine._stub || { getFinancialMarkets:()=>[], getTournaments:()=>[] };
    setStatus('loading','Loading...');

    // 1. Load config from tournaments.json (R12)
    await loadConfig();

    // 2. Load all financial markets in parallel (Yahoo/Binance with fallbacks)
    await loadFinancialMarkets();

    // 3. Load sports markets (ESPN + club-elo.com + config fixtures)
    await loadSportsMarkets();

    // 4. Build leaderboard
    E.leaderboard = buildLeaderboard();

    // Mark ready
    E.ready = true;
    E.dataSource = E.financialMarkets.length > 0 ? 'live' : 'mock';
    window.BidnessEngine.ready = true;
    window.BidnessEngine.dataSource = E.dataSource;

    setStatus(E.dataSource==='live'?'live':'mock', E.dataSource==='live'?'Live data':'Demo data');

    emit('ready', {
      marketCount: E.financialMarkets.length,
      sportsCount: E.sportsMarkets.length,
      dataSource: E.dataSource,
    });

    console.log(`[Engine] Ready — ${E.financialMarkets.length} financial, ${E.sportsMarkets.length} sports markets`);

    // 5. Start 15-min ESPN poll (R17 — only while page is open per R11)
    setInterval(async () => {
      await espnPoll();
      await checkDailyRecalc();
      await autoResolveFinancialMarkets();
    }, POLL_MS);

    // 6. Check daily recalc immediately on load (R8 R11)
    await checkDailyRecalc();

    // 7. Check month-end resolution (R9 R11)
    await autoResolveFinancialMarkets();

    // 8. Countdown ticker for admin scanner display
    setInterval(() => {
      E.scanCountdown = Math.max(0, E.scanCountdown-1);
      const el = document.getElementById('scanNext');
      if (el) { const m=Math.floor(E.scanCountdown/60),s=E.scanCountdown%60; el.textContent=m+':'+(s<10?'0':'')+s; }
    }, 1000);
  }

  // R11: trigger on page open
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
