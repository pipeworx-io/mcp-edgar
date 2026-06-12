interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * EDGAR MCP — SEC EDGAR public APIs (free, no auth)
 *
 * Tools:
 * - edgar_search_filings: full-text search across all SEC filings
 * - edgar_company_filings: get filings for a specific company by CIK or ticker
 * - edgar_company_facts: get structured XBRL financial data for a company
 * - edgar_company_concept: get a specific financial metric over time
 * - edgar_ticker_to_cik: look up CIK from ticker symbol
 *
 * Note: SEC requires a descriptive User-Agent header per their guidelines.
 */


const EFTS_BASE = 'https://efts.sec.gov/LATEST';
const DATA_BASE = 'https://data.sec.gov';
const SEC_HEADERS: Record<string, string> = {
  'User-Agent': 'Pipeworx/1.0 (support@pipeworx.io)',
  Accept: 'application/json',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'edgar_search_filings',
    description:
      'PREFER OVER WEB SEARCH for "what did $COMPANY say about X in their SEC filings" or "find filings that mention Y". AUTHORITATIVE full-text search across every SEC filing — EDGAR\'s own search index. Filter by form type ("10-K" annual, "10-Q" quarterly, "8-K" current event, "DEF 14A" proxy) and date range. Returns filing metadata + accession numbers + document links. Use when you need to find filings matching a topic across the whole market, not for a specific company (for that use edgar_company_filings).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (e.g., "artificial intelligence", "Tesla revenue")' },
        form_type: {
          type: 'string',
          description: 'Filter by SEC form type (e.g., "10-K", "10-Q", "8-K", "DEF 14A"). Omit for all types.',
        },
        start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format (e.g., "2024-01-01")' },
        end_date: { type: 'string', description: 'End date in YYYY-MM-DD format (e.g., "2024-12-31")' },
        limit: { type: 'number', description: 'Number of results to return (1-40, default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'edgar_company_filings',
    description:
      'AUTHORITATIVE list of recent SEC filings for a specific US public company. Pass a ticker ("AAPL") or CIK ("320193"). Filter by form type — "10-K" (annual report), "10-Q" (quarterly), "8-K" (material event — but for severity-classified 8-Ks specifically, prefer sec_8k_recent), "DEF 14A" (proxy), "S-1" (IPO registration), etc. Returns filing dates, form types, accession numbers, document links. Use for "what did $TICKER recently file" or "show me the last N proxy statements for $TICKER". For specific financial metrics over time use edgar_company_concept; for the full XBRL dump use edgar_company_facts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker_or_cik: {
          type: 'string',
          description: 'Ticker symbol (e.g., "AAPL") or CIK number (e.g., "320193")',
        },
        form_type: {
          type: 'string',
          description: 'Filter by SEC form type (e.g., "10-K", "10-Q", "8-K"). Omit for all types.',
        },
        limit: { type: 'number', description: 'Max filings to return (1-40, default 20)' },
      },
      required: ['ticker_or_cik'],
    },
  },
  {
    name: 'edgar_company_facts',
    description:
      'AUTHORITATIVE full XBRL fundamentals dump for a US public company by CIK. Returns every reported financial metric (hundreds of concepts: revenue, net income, assets, liabilities, EPS, cash flow lines, segment breakdowns) with annual and historical values pulled straight from the company\'s SEC filings — the official numbers, not estimates. Use when you need the complete fundamental picture vs. one metric (for one metric use edgar_company_concept). Large payload; agents typically use this once to discover available concepts then narrow to edgar_company_concept for follow-up queries.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cik: {
          type: 'string',
          description: 'Company CIK number (e.g., "320193" for Apple). Use edgar_ticker_to_cik to look up if needed.',
        },
      },
      required: ['cik'],
    },
  },
  {
    name: 'edgar_company_concept',
    description:
      'AUTHORITATIVE historical financials for any US public company. Source: SEC XBRL filings (the official numbers companies file, not third-party scrapes). Pass a ticker or CIK plus a friendly metric name — Revenue, NetIncomeLoss, Cash, LongTermDebt, EarningsPerShareDiluted — and the tool resolves the right XBRL tag for that filer (post-ASC-606 companies use RevenueFromContractWithCustomerExcludingAssessedTax instead of "Revenues", etc.). Returns annual values with fiscal years, period ends, filing types. Use for "what was AAPL\'s revenue in 2024", "show me NVDA\'s long-term debt trend", anything where you need the SEC-filed number rather than an estimate.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cik: {
          type: 'string',
          description: 'Ticker (e.g., "AAPL") or CIK number (e.g., "320193"). Tickers are auto-resolved.',
        },
        concept: {
          type: 'string',
          description:
            'Metric name. Common: "Revenue" / "Revenues", "NetIncomeLoss", "Cash", "Assets", "Liabilities", "StockholdersEquity", "EarningsPerShareDiluted", "LongTermDebt".',
        },
      },
      required: ['cik', 'concept'],
    },
  },
  {
    name: 'edgar_insider_transactions',
    description:
      'AUTHORITATIVE insider trading activity (SEC Form 3/4/5) for a US public company — who bought or sold, how many shares, at what price, and what they hold now. Pass a ticker ("TSLA") or CIK. Returns each recent Form 4 filing parsed into structured transactions: reporting owner + role (director/officer/10% holder), transaction code (P=open-market purchase, S=sale, A=grant/award, M=option exercise, G=gift, F=tax-withholding), shares, price per share, acquired/disposed, and shares owned after. Use for "insider buying at $TICKER", "did executives sell recently", "latest Form 4 activity". Open-market purchases (code P) are the strongest conviction signal; awards (code A) are routine comp. For the raw filing list use edgar_company_filings with form_type:"4".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker_or_cik: {
          type: 'string',
          description: 'Ticker symbol (e.g., "TSLA") or CIK number (e.g., "1318605")',
        },
        limit: { type: 'number', description: 'Max Form 4/3/5 filings to parse (1-25, default 10)' },
        include_derivatives: {
          type: 'boolean',
          description: 'Also include derivative (options/RSU) transactions. Default false (non-derivative common-stock only).',
        },
      },
      required: ['ticker_or_cik'],
    },
  },
  {
    name: 'edgar_institutional_holdings',
    description:
      "AUTHORITATIVE stock portfolio of a large institutional investor (SEC Form 13F-HR) — what a fund/manager owns, share counts, and position values. Pass the MANAGER's ticker or CIK (e.g. \"BRK-B\" or CIK \"1067983\" for Berkshire Hathaway; \"1350694\" for Bridgewater). Returns the latest quarterly 13F: top holdings aggregated by issuer with value (USD), shares, and % of portfolio, plus the report period. Use for \"what does Berkshire own\", \"Bridgewater's biggest positions\", \"which funds hold $TICKER\" (run per manager). Note: 13F covers US-listed long equity + options held by managers with >$100M AUM, filed ~45 days after quarter-end; it excludes shorts, cash, and non-US holdings. Values are whole USD for filings since 2023; older ones are in thousands.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker_or_cik: {
          type: 'string',
          description: 'The institutional manager\'s ticker (e.g. "BRK-B") or CIK (e.g. "1067983"). NOT the held stock — the fund/manager doing the filing.',
        },
        limit: { type: 'number', description: 'Top N holdings by value to return (1-100, default 25)' },
      },
      required: ['ticker_or_cik'],
    },
  },
  {
    name: 'edgar_ticker_to_cik',
    description:
      'Resolve a US stock ticker (e.g. "TSLA") to the SEC\'s 10-digit CIK identifier — required by every other SEC tool. Call THIS FIRST when you have a ticker and need to use edgar_company_concept, edgar_company_filings, edgar_company_facts, sec_8k_recent, or any other SEC-keyed tool. Returns {cik, cik_padded, company_name}. Cheap, no rate limit concerns. Most other tools also accept tickers directly and call this internally — only use it explicitly when you want the CIK as data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker: {
          type: 'string',
          description: 'Stock ticker symbol (e.g., "AAPL", "MSFT", "TSLA")',
        },
      },
      required: ['ticker'],
    },
  },
];

// ── Helpers ─────────────────────────────────────────────────────────

function padCik(cik: string): string {
  return cik.replace(/\D/g, '').padStart(10, '0');
}

function isNumericCik(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

// ── Tool implementations ────────────────────────────────────────────

async function searchFilings(
  query: string,
  formType?: string,
  startDate?: string,
  endDate?: string,
  limit?: number,
) {
  const count = Math.min(40, Math.max(1, limit ?? 10));
  const params = new URLSearchParams({ q: query, from: '0', size: String(count) });

  if (formType) params.set('forms', formType);
  if (startDate || endDate) {
    params.set('dateRange', 'custom');
    if (startDate) params.set('startdt', startDate);
    if (endDate) params.set('enddt', endDate);
  }

  const res = await fetch(`${EFTS_BASE}/search-index?${params}`, { headers: SEC_HEADERS });
  if (!res.ok) throw new Error(`SEC EDGAR search error: ${res.status}`);

  const data = (await res.json()) as {
    hits: {
      hits: {
        _source: {
          entity_name: string;
          entity_id: string;
          file_num: string;
          form_type: string;
          file_date: string;
          period_of_report: string;
          biz_location: string;
          category: string;
        };
        _id: string;
      }[];
      total: { value: number };
    };
  };

  const results = (data.hits?.hits ?? []).map((hit) => {
    const s = hit._source;
    return {
      entity_name: s.entity_name,
      cik: s.entity_id,
      form_type: s.form_type,
      filing_date: s.file_date,
      period_of_report: s.period_of_report,
      location: s.biz_location,
      filing_id: hit._id,
    };
  });

  return {
    query,
    form_type_filter: formType ?? 'all',
    date_range: { start: startDate ?? null, end: endDate ?? null },
    total_hits: data.hits?.total?.value ?? 0,
    results,
  };
}

async function tickerToCik(ticker: string) {
  if (typeof ticker !== 'string' || !ticker.trim()) {
    throw new Error('Required argument "ticker" is missing or empty. Pass a ticker symbol like "AAPL" or "MSFT".');
  }
  const res = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS });
  if (!res.ok) throw new Error(`SEC ticker lookup error: ${res.status}`);

  const data = (await res.json()) as Record<
    string,
    { cik_str: number; ticker: string; title: string }
  >;

  const upperTicker = ticker.toUpperCase().trim();
  for (const entry of Object.values(data)) {
    if (entry.ticker === upperTicker) {
      return {
        ticker: entry.ticker,
        cik: String(entry.cik_str),
        cik_padded: String(entry.cik_str).padStart(10, '0'),
        company_name: entry.title,
      };
    }
  }

  throw new Error(`Ticker "${ticker}" not found in SEC company tickers`);
}

async function resolveCik(tickerOrCik: string): Promise<string> {
  if (typeof tickerOrCik !== 'string' || !tickerOrCik.trim()) {
    throw new Error(
      'Required argument "ticker_or_cik" is missing or empty. ' +
      'Try one of: edgar_company_filings({ticker_or_cik: "AAPL"}) by ticker, ' +
      'or edgar_company_filings({ticker_or_cik: "320193"}) by CIK number (Apple\'s CIK). ' +
      'Tickers are auto-resolved to CIKs internally.'
    );
  }
  if (isNumericCik(tickerOrCik)) return tickerOrCik.trim();
  const result = await tickerToCik(tickerOrCik);
  return result.cik;
}

async function companyFilings(tickerOrCik: string, formType?: string, limit?: number) {
  const cik = await resolveCik(tickerOrCik);
  const paddedCik = padCik(cik);
  const count = Math.min(40, Math.max(1, limit ?? 20));

  const res = await fetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
  if (!res.ok) throw new Error(`SEC EDGAR submissions error: ${res.status}`);

  const data = (await res.json()) as {
    cik: string;
    name: string;
    sic: string;
    sicDescription: string;
    stateOfIncorporation: string;
    fiscalYearEnd: string;
    tickers: string[];
    filings: {
      recent: {
        accessionNumber: string[];
        filingDate: string[];
        form: string[];
        primaryDocument: string[];
        items: string[];
        size: number[];
      };
    };
  };

  const recent = data.filings.recent;
  const filings: {
    accession_number: string;
    filing_date: string;
    form: string;
    primary_document: string;
    document_url: string;
  }[] = [];

  for (let i = 0; i < recent.accessionNumber.length && filings.length < count; i++) {
    const form = recent.form[i];
    if (formType && form !== formType) continue;

    const accession = recent.accessionNumber[i];
    const accessionPath = accession.replace(/-/g, '');
    filings.push({
      accession_number: accession,
      filing_date: recent.filingDate[i],
      form,
      primary_document: recent.primaryDocument[i],
      document_url: `https://www.sec.gov/Archives/edgar/data/${data.cik}/${accessionPath}/${recent.primaryDocument[i]}`,
    });
  }

  return {
    cik: data.cik,
    company_name: data.name,
    tickers: data.tickers ?? [],
    sic_description: data.sicDescription,
    state_of_incorporation: data.stateOfIncorporation,
    fiscal_year_end: data.fiscalYearEnd,
    filter_form_type: formType ?? 'all',
    filings,
  };
}

async function companyFacts(cik: string) {
  const paddedCik = padCik(cik);
  const res = await fetch(`${DATA_BASE}/api/xbrl/companyfacts/CIK${paddedCik}.json`, {
    headers: SEC_HEADERS,
  });
  if (!res.ok) throw new Error(`SEC EDGAR company facts error: ${res.status}`);

  const data = (await res.json()) as {
    cik: number;
    entityName: string;
    facts: {
      'us-gaap'?: Record<
        string,
        {
          label: string;
          description: string;
          units: Record<
            string,
            { end: string; val: number; accn: string; fy: number; fp: string; form: string; filed: string; frame?: string }[]
          >;
        }
      >;
    };
  };

  const usGaap = data.facts?.['us-gaap'] ?? {};
  const KEY_METRICS = [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'NetIncomeLoss',
    'Assets',
    'Liabilities',
    'StockholdersEquity',
    'CashAndCashEquivalentsAtCarryingValue',
    'EarningsPerShareBasic',
    'EarningsPerShareDiluted',
    'CommonStockSharesOutstanding',
    'OperatingIncomeLoss',
    'GrossProfit',
    'ResearchAndDevelopmentExpense',
  ];

  const metrics: Record<
    string,
    { label: string; most_recent_annual: { year: number; value: number; filed: string } | null }
  > = {};

  for (const key of KEY_METRICS) {
    const fact = usGaap[key];
    if (!fact) continue;

    const usdEntries = fact.units['USD'] ?? fact.units['shares'] ?? [];
    // Same fix as companyConcept: don't gate on `frame !== undefined`;
    // off-calendar filers (NVDA, AAPL) get their modern annuals dropped.
    // Sort by period end (desc) to surface the actual most-recent 10-K.
    const annual = usdEntries
      .filter((e) => e.form === '10-K' || e.form === '10-K/A')
      .sort((a, b) => (b.end ?? '').localeCompare(a.end ?? ''));

    metrics[key] = {
      label: fact.label,
      most_recent_annual: annual[0]
        ? { year: annual[0].fy, value: annual[0].val, filed: annual[0].filed }
        : null,
    };
  }

  return {
    cik: String(data.cik),
    company_name: data.entityName,
    key_financials: metrics,
    available_concepts: Object.keys(usGaap).length,
  };
}

// Friendly-name → XBRL candidate tags. Same versioning issue as compare_entities:
// ASC 606 (2018) forced most filers from "Revenues" to
// "RevenueFromContractWithCustomerExcludingAssessedTax"; older companies
// still use SalesRevenueNet, etc.
//
// Two flavors of key in this table:
//
//   1. Friendly names ("revenue", "cash", "longtermdebt") — what an LLM
//      naturally types in prose. Maps to a list of XBRL candidates that
//      cover the common ASC-606 / pre-ASC-606 / pre-IFRS variants.
//
//   2. Literal XBRL concept names lowercased — what a more sophisticated
//      LLM types after looking up a "real" GAAP tag. These are the ones
//      that showed up in production analytics as the top 80-of-84 errors
//      on edgar_company_concept: filers reported the same metric under a
//      sibling concept the LLM didn't pick. We map each known-failing
//      XBRL name back to its own list (itself first, then the realistic
//      siblings) so the call walks the fallback before throwing.
//
// Anything not in the table still falls through to [concept] (the bare
// literal), so we don't regress for niche concepts not yet observed in
// failures.
const CONCEPT_CANDIDATES: Record<string, string[]> = {
  // ── friendly names ────────────────────────────────────────────────
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
  revenues: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
  netincome: ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
  netincomeloss: ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
  cash: [
    'CashAndCashEquivalentsAtCarryingValue',
    'Cash',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
  ],
  longtermdebt: ['LongTermDebt', 'LongTermDebtNoncurrent'],
  // ── XBRL-name fallbacks (drove 80-of-84 EDGAR errors in 48h analytics) ──
  longtermdebtnoncurrent: ['LongTermDebtNoncurrent', 'LongTermDebt'],
  salesrevenuenet: ['SalesRevenueNet', 'Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax'],
  revenuefromcontractwithcustomerexcludingassessedtax: [
    'RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet',
  ],
  revenuefromcontractwithcustomerincludingassessedtax: [
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet',
  ],
  netincomelossavailabletocommonstockholdersbasic: [
    'NetIncomeLossAvailableToCommonStockholdersBasic', 'NetIncomeLoss', 'ProfitLoss',
  ],
  netincomelossavailabletocommonstockholdersdiluted: [
    'NetIncomeLossAvailableToCommonStockholdersDiluted',
    'NetIncomeLossAvailableToCommonStockholdersBasic', 'NetIncomeLoss', 'ProfitLoss',
  ],
  profitloss: ['ProfitLoss', 'NetIncomeLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
  cashcashequivalentsrestrictedcashandrestrictedcashequivalents: [
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    'CashAndCashEquivalentsAtCarryingValue', 'Cash',
  ],
  cashandcashequivalentsatcarryingvalue: [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'Cash',
  ],
};

async function companyConcept(cikOrTicker: string, concept: string) {
  // Auto-resolve ticker → CIK so callers can pass "AAPL" not "320193".
  // Production analytics: 11% errors on edgar largely from LLMs passing
  // tickers as cik (then padCik strips letters → 0000000000 → 404).
  const cik = await resolveCik(cikOrTicker);
  const paddedCik = padCik(cik);

  const candidates = CONCEPT_CANDIDATES[concept.trim().toLowerCase()] ?? [concept];

  type ConceptDoc = {
    cik: number;
    entityName: string;
    tag: string;
    taxonomy: string;
    label: string;
    description: string;
    units: Record<
      string,
      { end: string; val: number; accn: string; fy: number; fp: string; form: string; filed: string; frame?: string }[]
    >;
  };

  // Fetch EVERY candidate that exists, then pick the one with the most recent
  // 10-K data — not the first non-empty one. Filers switch revenue tags over
  // time: NVDA reports current revenue under "Revenues" (through FY2026) while
  // its older "RevenueFromContractWithCustomerExcludingAssessedTax" tag is
  // frozen at FY2022 but still returns 200. First-non-empty returned the stale
  // $26.9B/FY2022 figure; freshest-data-wins returns the correct $215.9B.
  let lastStatus = 0;
  const found: { doc: ConceptDoc; latestEnd: string }[] = [];
  for (const candidate of candidates) {
    const r = await fetch(
      `${DATA_BASE}/api/xbrl/companyconcept/CIK${paddedCik}/us-gaap/${encodeURIComponent(candidate)}.json`,
      { headers: SEC_HEADERS },
    );
    if (!r.ok) { lastStatus = r.status; continue; }
    const doc = (await r.json()) as ConceptDoc;
    let latestEnd = '';
    for (const values of Object.values(doc.units)) {
      for (const e of values) {
        if (e.form !== '10-K' && e.form !== '10-K/A') continue;
        if ((e.end ?? '') > latestEnd) latestEnd = e.end ?? '';
      }
    }
    found.push({ doc, latestEnd });
  }
  if (found.length === 0) {
    throw new Error(
      `SEC EDGAR company concept error: ${lastStatus} — none of the candidate concepts ${JSON.stringify(candidates)} exist for CIK ${paddedCik}. Use edgar_company_facts({cik: "${cikOrTicker}"}) to see every concept this filer reports.`,
    );
  }
  found.sort((a, b) => (b.latestEnd ?? '').localeCompare(a.latestEnd ?? ''));
  const data = found[0].doc;

  // Return annual (10-K) values sorted by fiscal year / period_end DESC.
  //
  // Filter notes:
  //   - DON'T filter on `frame !== undefined`. SEC populates `frame` only
  //     when a fact aligns to a calendar quarter (e.g. CY2020Q4). Off-
  //     calendar filers like NVDA (fiscal year ends late January) have no
  //     frame on most facts; the prior filter dropped their modern annual
  //     values entirely, leaving only the few entries that happened to
  //     align by accident. Result: NVDA "Revenues" returned FY2019-2022
  //     and the current $130B annual revenue was invisible. Run 6 audit
  //     caught this.
  //   - DO dedupe: a 10-K and its 10-K/A amendments both report the same
  //     (fy, fp, end) tuple. Keep the most-recently-filed version.
  type Raw = { end: string; val: number; accn: string; fy: number; fp: string; form: string; filed: string; frame?: string };
  const dedup = new Map<string, { entry: Raw; unit: string }>();
  for (const [unit, values] of Object.entries(data.units)) {
    for (const e of values) {
      if (e.form !== '10-K' && e.form !== '10-K/A') continue;
      const key = `${unit}|${e.fy ?? ''}|${e.fp ?? 'FY'}|${e.end ?? ''}`;
      const prior = dedup.get(key);
      if (!prior || (e.filed ?? '') > (prior.entry.filed ?? '')) {
        dedup.set(key, { entry: e, unit });
      }
    }
  }
  const entries = [...dedup.values()]
    .map(({ entry, unit }) => ({
      fiscal_year: entry.fy,
      period_end: entry.end,
      value: entry.val,
      filed: entry.filed,
      unit,
    }))
    .sort((a, b) => (b.period_end ?? '').localeCompare(a.period_end ?? ''));

  return {
    cik: String(data.cik),
    company_name: data.entityName,
    concept: data.tag,
    label: data.label,
    description: data.description,
    annual_values: entries,
  };
}

// ── Insider transactions (Form 3/4/5) ───────────────────────────────

// SEC Form 4 transaction codes (Table I / II). Open-market buys (P) and
// sells (S) are the real signal; A/M/F/G are comp & mechanical.
const TXN_CODE_MEANING: Record<string, string> = {
  P: 'Open-market or private purchase',
  S: 'Open-market or private sale',
  A: 'Grant/award (e.g. RSU/option grant)',
  D: 'Disposition to the issuer (e.g. forfeiture)',
  F: 'Shares withheld to pay exercise price or tax',
  M: 'Exercise/conversion of derivative security',
  C: 'Conversion of derivative security',
  X: 'Exercise of in/at-the-money derivative',
  G: 'Bona fide gift',
  J: 'Other acquisition or disposition',
  V: 'Transaction voluntarily reported early',
};

// Form 4 XML is small and flat; Workers have no DOMParser, so pull values
// with anchored regex. SEC wraps most leaf values in <tag><value>X</value></tag>,
// but plain <tag>X</tag> also occurs (e.g. <rptOwnerName>, <officerTitle>).
function xmlVal(block: string, tag: string): string | null {
  const wrapped = new RegExp(`<${tag}>\\s*<value>([\\s\\S]*?)</value>`, 'i').exec(block);
  if (wrapped) return wrapped[1].trim();
  const plain = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return plain ? plain[1].trim() : null;
}

function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function parseForm4Transactions(xml: string, includeDerivatives: boolean) {
  const owner = xmlVal(xml, 'rptOwnerName');
  const rel = xmlBlocks(xml, 'reportingOwnerRelationship')[0] ?? '';
  const roles: string[] = [];
  if (/<isDirector>\s*(1|true)/i.test(rel)) roles.push('Director');
  const officerTitle = xmlVal(rel, 'officerTitle');
  if (/<isOfficer>\s*(1|true)/i.test(rel)) roles.push(officerTitle ? `Officer (${officerTitle})` : 'Officer');
  if (/<isTenPercentOwner>\s*(1|true)/i.test(rel)) roles.push('10% owner');
  if (/<isOther>\s*(1|true)/i.test(rel)) roles.push('Other');

  const txnTags = includeDerivatives
    ? ['nonDerivativeTransaction', 'derivativeTransaction']
    : ['nonDerivativeTransaction'];

  const transactions: {
    security: string | null;
    date: string | null;
    code: string | null;
    code_meaning: string | null;
    shares: number | null;
    price_per_share: number | null;
    acquired_disposed: string | null;
    value_usd: number | null;
    shares_owned_after: number | null;
    derivative: boolean;
  }[] = [];

  for (const tag of txnTags) {
    for (const b of xmlBlocks(xml, tag)) {
      const code = xmlVal(b, 'transactionCode');
      const shares = numOrNull(xmlVal(b, 'transactionShares'));
      const price = numOrNull(xmlVal(b, 'transactionPricePerShare'));
      const ad = xmlVal(b, 'transactionAcquiredDisposedCode');
      transactions.push({
        security: xmlVal(b, 'securityTitle'),
        date: xmlVal(b, 'transactionDate'),
        code,
        code_meaning: code ? TXN_CODE_MEANING[code] ?? null : null,
        shares,
        price_per_share: price,
        acquired_disposed: ad === 'A' ? 'acquired' : ad === 'D' ? 'disposed' : ad,
        value_usd: shares !== null && price !== null ? Math.round(shares * price * 100) / 100 : null,
        shares_owned_after: numOrNull(xmlVal(b, 'sharesOwnedFollowingTransaction')),
        derivative: tag === 'derivativeTransaction',
      });
    }
  }

  return { owner, roles, transactions };
}

function numOrNull(s: string | null): number | null {
  if (s === null) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function insiderTransactions(tickerOrCik: string, limit?: number, includeDerivatives?: boolean) {
  const cik = await resolveCik(tickerOrCik);
  const paddedCik = padCik(cik);
  const count = Math.min(25, Math.max(1, limit ?? 10));

  const res = await fetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
  if (!res.ok) throw new Error(`SEC EDGAR submissions error: ${res.status}`);
  const data = (await res.json()) as {
    cik: string;
    name: string;
    tickers: string[];
    filings: { recent: { accessionNumber: string[]; filingDate: string[]; form: string[]; primaryDocument: string[] } };
  };

  const recent = data.filings.recent;
  const targets: { accession: string; date: string; form: string; doc: string }[] = [];
  for (let i = 0; i < recent.form.length && targets.length < count; i++) {
    const form = recent.form[i];
    if (form === '3' || form === '4' || form === '5') {
      targets.push({
        accession: recent.accessionNumber[i],
        date: recent.filingDate[i],
        form,
        doc: recent.primaryDocument[i],
      });
    }
  }

  const filings = await Promise.all(
    targets.map(async (t) => {
      const accPath = t.accession.replace(/-/g, '');
      // primaryDocument for Form 4 is the XSL viewer path (e.g. "xslF345X06/foo.xml").
      // Strip the leading xsl*/ directory to fetch the raw machine-readable XML.
      const rawDoc = t.doc.replace(/^xsl[^/]*\//i, '');
      const url = `https://www.sec.gov/Archives/edgar/data/${data.cik}/${accPath}/${rawDoc}`;
      try {
        const r = await fetch(url, { headers: { 'User-Agent': SEC_HEADERS['User-Agent'] } });
        if (!r.ok) return { accession_number: t.accession, filing_date: t.date, form: t.form, error: `fetch ${r.status}`, filing_url: url };
        const xml = await r.text();
        const parsed = parseForm4Transactions(xml, includeDerivatives ?? false);
        return {
          accession_number: t.accession,
          filing_date: t.date,
          form: t.form,
          owner: parsed.owner,
          owner_roles: parsed.roles,
          transactions: parsed.transactions,
          filing_url: url,
        };
      } catch (e) {
        return { accession_number: t.accession, filing_date: t.date, form: t.form, error: String(e), filing_url: url };
      }
    }),
  );

  return {
    cik: data.cik,
    company_name: data.name,
    tickers: data.tickers ?? [],
    form_4_filings_parsed: filings.length,
    note: 'Transaction codes: P=open-market buy (strongest signal), S=sale, A=grant/award (routine comp), M=option exercise, F=tax withholding, G=gift.',
    filings,
  };
}

// ── Institutional holdings (Form 13F-HR) ────────────────────────────

// 13F info tables come with a namespace prefix (e.g. <ns1:infoTable>) that
// varies by filer/agent. Strip prefixes so the same regex works everywhere.
function stripNs(xml: string): string {
  return xml.replace(/<(\/?)[a-zA-Z0-9]+:/g, '<$1');
}

async function institutionalHoldings(tickerOrCik: string, limit?: number) {
  const cik = await resolveCik(tickerOrCik);
  const paddedCik = padCik(cik);
  const topN = Math.min(100, Math.max(1, limit ?? 25));

  const subRes = await fetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
  if (!subRes.ok) throw new Error(`SEC EDGAR submissions error: ${subRes.status}`);
  const sub = (await subRes.json()) as {
    cik: string;
    name: string;
    filings: { recent: { accessionNumber: string[]; filingDate: string[]; form: string[]; reportDate: string[] } };
  };

  const r = sub.filings.recent;
  let target: { accession: string; filed: string; period: string } | null = null;
  for (let i = 0; i < r.form.length; i++) {
    if (r.form[i] === '13F-HR' || r.form[i] === '13F-HR/A') {
      target = { accession: r.accessionNumber[i], filed: r.filingDate[i], period: r.reportDate?.[i] ?? '' };
      break;
    }
  }
  if (!target) {
    throw new Error(
      `No 13F-HR filing found for "${tickerOrCik}" (CIK ${paddedCik}). This filer may not be a 13F institutional manager (>$100M AUM). Pass the manager's CIK directly, e.g. "1067983" for Berkshire Hathaway.`,
    );
  }

  // Find the information-table XML in the accession folder: the .xml file that
  // is neither primary_doc.xml (cover page) nor an xsl-rendered viewer copy.
  const accPath = target.accession.replace(/-/g, '');
  const folder = `https://www.sec.gov/Archives/edgar/data/${sub.cik}/${accPath}`;
  const idxRes = await fetch(`${folder}/index.json`, { headers: SEC_HEADERS });
  if (!idxRes.ok) throw new Error(`SEC EDGAR filing index error: ${idxRes.status}`);
  const idx = (await idxRes.json()) as { directory: { item: { name: string }[] } };
  const infoFile = idx.directory.item.find(
    (it) => it.name.toLowerCase().endsWith('.xml') && it.name !== 'primary_doc.xml' && !/^xsl/i.test(it.name),
  );
  if (!infoFile) {
    throw new Error(`13F information table not found in filing ${target.accession}.`);
  }

  const tableRes = await fetch(`${folder}/${infoFile.name}`, { headers: { 'User-Agent': SEC_HEADERS['User-Agent'] } });
  if (!tableRes.ok) throw new Error(`SEC EDGAR 13F table error: ${tableRes.status}`);
  const xml = stripNs(await tableRes.text());

  // Aggregate rows by issuer+cusip+putCall (managers file multiple sub-portfolio
  // rows per security; sum them). Value is reported in whole USD post-2023.
  type Agg = { issuer: string; cusip: string; put_call: string | null; value_usd: number; shares: number };
  const byKey = new Map<string, Agg>();
  for (const b of xmlBlocks(xml, 'infoTable')) {
    const issuer = xmlVal(b, 'nameOfIssuer') ?? 'UNKNOWN';
    const cusip = xmlVal(b, 'cusip') ?? '';
    const putCall = xmlVal(b, 'putCall');
    const value = numOrNull(xmlVal(b, 'value')) ?? 0;
    const shares = numOrNull(xmlVal(b, 'sshPrnamt')) ?? 0;
    const key = `${cusip}|${putCall ?? ''}`;
    const prior = byKey.get(key);
    if (prior) {
      prior.value_usd += value;
      prior.shares += shares;
    } else {
      byKey.set(key, { issuer, cusip, put_call: putCall, value_usd: value, shares });
    }
  }

  const all = [...byKey.values()].sort((a, b) => b.value_usd - a.value_usd);
  const totalValue = all.reduce((s, h) => s + h.value_usd, 0);
  const holdings = all.slice(0, topN).map((h) => ({
    issuer: h.issuer,
    cusip: h.cusip,
    put_call: h.put_call,
    value_usd: h.value_usd,
    shares: h.shares,
    pct_of_portfolio: totalValue > 0 ? Math.round((h.value_usd / totalValue) * 10000) / 100 : null,
  }));

  return {
    cik: sub.cik,
    manager_name: sub.name,
    form: '13F-HR',
    report_period: target.period,
    filed_date: target.filed,
    total_portfolio_value_usd: totalValue,
    total_positions: all.length,
    holdings_returned: holdings.length,
    holdings,
  };
}

// ── callTool router ─────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'edgar_search_filings':
      return searchFilings(
        args.query as string,
        args.form_type as string | undefined,
        args.start_date as string | undefined,
        args.end_date as string | undefined,
        args.limit as number | undefined,
      );
    case 'edgar_company_filings':
      return companyFilings(
        args.ticker_or_cik as string,
        args.form_type as string | undefined,
        args.limit as number | undefined,
      );
    case 'edgar_company_facts':
      return companyFacts(args.cik as string);
    case 'edgar_insider_transactions':
      return insiderTransactions(
        args.ticker_or_cik as string,
        args.limit as number | undefined,
        args.include_derivatives as boolean | undefined,
      );
    case 'edgar_institutional_holdings':
      return institutionalHoldings(
        args.ticker_or_cik as string,
        args.limit as number | undefined,
      );
    case 'edgar_company_concept':
      return companyConcept(args.cik as string, args.concept as string);
    case 'edgar_ticker_to_cik':
      return tickerToCik(args.ticker as string);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 10 } } satisfies McpToolExport;
