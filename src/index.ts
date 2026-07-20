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

// Reusable entity-resolution helpers for MCP packs. SELF-CONTAINED — no internal
// imports — so publish-pack.sh can inline it into standalone pack builds the same
// way it inlines the McpToolExport type.
//
// Recurring failure mode across financial packs: callers pass a company NAME
// ("Apple", "apple inc") where a ticker / CIK / provider symbol is expected, and
// the pack 404s or throws "not found". `rankMatches` is a generic name-ranker any
// pack can run over its OWN list (US tickers, B3 tickers, drug names, airports…);
// `resolveSecEntity` wraps it around the SEC company_tickers.json universe, shared
// by the packs that key on CIK (edgar, sec).

type MatchKind = 'exact' | 'prefix' | 'word' | 'substring';

interface RankedMatch<T> {
  item: T;
  kind: MatchKind;
  score: number;
}

const normalize = (s: string): string =>
  s.toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Rank `items` by how well their name matches `query`:
 * exact (4) > prefix (3) > whole-word (2) > substring (1). Ties break by shortest
 * name — the primary entity (e.g. "Apple Inc." over "Apple Hospitality REIT").
 * Returns only items that match at all, best first. Pure (no I/O).
 */
function rankMatches<T>(
  query: string,
  items: T[],
  getName: (item: T) => string,
): RankedMatch<T>[] {
  const q = normalize(query);
  if (!q) return [];
  const scored: { item: T; kind: MatchKind; score: number; len: number }[] = [];
  for (const item of items) {
    const name = getName(item);
    const n = normalize(name);
    let kind: MatchKind | null = null;
    let score = 0;
    if (n === q) { kind = 'exact'; score = 4; }
    else if (n.startsWith(q)) { kind = 'prefix'; score = 3; }
    else if (n.includes(` ${q} `) || n.endsWith(` ${q}`)) { kind = 'word'; score = 2; }
    else if (n.includes(q)) { kind = 'substring'; score = 1; }
    if (kind) scored.push({ item, kind, score, len: name.length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  return scored.map(({ item, kind, score }) => ({ item, kind, score }));
}

interface SecTickerRow { cik_str: number; ticker: string; title: string }

interface SecEntity {
  ticker: string;
  cik: string;
  cik_padded: string;
  company_name: string;
  matched_by: 'ticker' | 'company_name';
  alternatives?: { ticker: string; company_name: string; cik: string }[];
}

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

/**
 * Resolve a ticker OR company name to its SEC identity (CIK + canonical name).
 * Exact ticker first (the common, unambiguous case), then fuzzy company-name
 * fallback so "Apple" / "APPLE" → AAPL's CIK. Throws if nothing matches.
 *
 * `headers` lets callers pass their pack's SEC User-Agent — www.sec.gov requires
 * a UA. `fetchImpl` defaults to global fetch (override in tests).
 */
async function resolveSecEntity(
  query: string,
  opts: { fetchImpl?: typeof fetch; headers?: Record<string, string> } = {},
): Promise<SecEntity> {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('Required argument is missing or empty. Pass a ticker like "AAPL" or a company name like "Apple".');
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(SEC_TICKERS_URL, { headers: opts.headers });
  if (!res.ok) throw new Error(`SEC ticker lookup error: ${res.status}`);
  const data = (await res.json()) as Record<string, SecTickerRow>;
  const rows = Object.values(data);

  // 1) Exact ticker match — the common, unambiguous case.
  const q = query.toUpperCase().trim();
  for (const r of rows) {
    if (r.ticker === q) return toEntity(r, 'ticker');
  }

  // 2) Company-name fallback.
  const ranked = rankMatches(query, rows, (r) => r.title);
  if (ranked.length) {
    const best = toEntity(ranked[0].item, 'company_name');
    const alts = ranked.slice(1, 4).map((m) => ({
      ticker: m.item.ticker,
      company_name: m.item.title,
      cik: String(m.item.cik_str),
    }));
    if (alts.length) best.alternatives = alts;
    return best;
  }

  throw new Error(`No SEC company matches "${query}". Pass a ticker like "AAPL" or a company name like "Apple Inc.".`);
}

function toEntity(r: SecTickerRow, matched_by: 'ticker' | 'company_name'): SecEntity {
  return {
    ticker: r.ticker,
    cik: String(r.cik_str),
    cik_padded: String(r.cik_str).padStart(10, '0'),
    company_name: r.title,
    matched_by,
  };
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
 * - edgar_filing_documents: list the documents inside one filing by accession number
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
          description: 'Ticker ("NVDA") or CIK number ("320193"). Tickers are auto-resolved to CIKs internally.',
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
    name: 'edgar_fund_holdings',
    description:
      "AUTHORITATIVE portfolio holdings of a US ETF or mutual fund (SEC Form N-PORT) — what the fund actually owns. Pass the FUND's ticker (e.g. \"ARKK\", \"QQQ\", \"VTI\", \"VOO\", \"IVV\"). Returns the latest monthly portfolio: net assets, holdings count, and top positions by weight — each with name, CUSIP, value (USD), and % of fund. Use for \"what does ARKK hold\", \"top holdings of QQQ\", \"is $STOCK in VTI\". Distinct from edgar_institutional_holdings (13F = what an investment MANAGER like Berkshire owns); this is a registered fund's own N-PORT. Covers US-registered open-end funds + ETFs; data is ~30-60 days delayed. Note: a few legacy ETFs structured as unit investment trusts (e.g. SPY, DIA) don't file N-PORT and won't resolve — use IVV or VOO for S&P 500 exposure.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker: { type: 'string', description: 'ETF or mutual-fund ticker (e.g. "ARKK", "SPY", "QQQ"). Fund tickers, not company stock tickers.' },
        limit: { type: 'number', description: 'Top N holdings by weight to return (1-100, default 25)' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'edgar_ticker_to_cik',
    description:
      'Resolve a US stock ticker (e.g. "TSLA") OR a company name (e.g. "Tesla", "Apple Inc") to the SEC\'s 10-digit CIK identifier — required by every other SEC tool. Call THIS FIRST when you have a ticker/name and need to use edgar_company_concept, edgar_company_filings, edgar_company_facts, sec_8k_recent, or any other SEC-keyed tool. Returns {cik, cik_padded, company_name, ticker, matched_by}; when matched by name it also returns `alternatives` for disambiguation. Cheap, no rate limit concerns. Most other tools also accept tickers/names directly and call this internally — only use it explicitly when you want the CIK as data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker: {
          type: 'string',
          description: 'Stock ticker symbol (e.g., "AAPL", "MSFT", "TSLA") or company name (e.g., "Apple", "Microsoft")',
        },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'edgar_xbrl_frames',
    description:
      'Compare ONE financial metric across ALL public companies for a single period (SEC XBRL "frames"). PREFER OVER WEB SEARCH for "which companies had the most revenue/net income/assets in <year>", "rank companies by <metric>", cross-company financial comparison. concept is a US-GAAP tag (e.g. "Revenues", "NetIncomeLoss", "Assets", "ResearchAndDevelopmentExpense", "CashAndCashEquivalentsAtCarryingValue"). period is a calendar frame: "CY2023" (annual), "CY2023Q1" (quarter), or "CY2023Q1I" (instant/balance-sheet, period-end). Returns companies + values, sorted descending by default. Differs from edgar_company_concept (one company over time) — this is one period across every filer.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        concept: { type: 'string', description: 'US-GAAP (or dei) tag, e.g. "Revenues", "NetIncomeLoss", "Assets", "ResearchAndDevelopmentExpense".' },
        period: { type: 'string', description: 'Calendar frame: "CY2023" (annual duration), "CY2023Q1" (quarterly duration), or "CY2023Q1I" (instant, balance-sheet items at period end).' },
        unit: { type: 'string', description: 'Unit of measure (default "USD"). Use "shares" for share counts, "USD-per-shares" for per-share.' },
        taxonomy: { type: 'string', description: 'Taxonomy: "us-gaap" (default) or "dei".' },
        sort: { type: 'string', description: '"desc" (default, largest first) or "asc".', enum: ['desc', 'asc'] },
        limit: { type: 'number', description: 'Max companies to return (1-200, default 25).' },
      },
      required: ['concept', 'period'],
    },
  },
  {
    name: 'edgar_filing_documents',
    description:
      'AUTHORITATIVE list of the SEC filing documents inside ONE specific filing, by accession number. Retrieve a filing / its contents / attachments: pass the accession (e.g. "0000320193-25-000079", with or without dashes) plus the filer\'s ticker ("AAPL") or CIK ("320193"). Returns every document in the filing folder — the primary document (10-K / 10-Q / 8-K body), all exhibits, and XBRL files — each with name, type, size, and a direct https URL, plus the filing\'s form type, filing date, and human -index.html page. Set include_primary_text:true to also pull the primary document\'s text (HTML stripped to plaintext, ~40k chars). Use to list a 10-K / 10-Q / 8-K\'s exhibits by accession number, retrieve filing contents/attachments, or fetch the text of a known filing. Get accession numbers from edgar_company_filings or edgar_search_filings. Example: edgar_filing_documents({accession: "0000320193-25-000079", ticker: "AAPL"}).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        accession: {
          type: 'string',
          description: 'SEC accession number of the filing, with or without dashes (e.g. "0000320193-25-000079" or "000032019325000079"). 18 digits shaped 10-2-6.',
        },
        ticker: {
          type: 'string',
          description: 'The filer\'s ticker (e.g. "AAPL") or company name. Provide this OR cik — needed to build the filing archive path. Tickers are auto-resolved to CIKs.',
        },
        cik: {
          type: 'string',
          description: 'The filer\'s CIK number (e.g. "320193"). Provide this OR ticker.',
        },
        include_primary_text: {
          type: 'boolean',
          description: 'When true, also fetch the primary document and return its text (HTML stripped to plaintext, truncated to ~40,000 chars). Default false.',
        },
      },
      required: ['accession'],
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

// Resolves a ticker OR company name ("AAPL", "Apple", "apple inc") to its SEC
// identity. Delegates to the shared resolver so the ticker/name-resolution logic
// stays consistent across every SEC-keyed pack (edgar, sec).
async function tickerToCik(ticker: string) {
  return resolveSecEntity(ticker, { headers: SEC_HEADERS });
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

// ── Filing documents (list docs inside one filing by accession) ─────

// Normalize an accession number (dashed or undashed) to both forms.
// SEC accessions are 18 digits shaped 10-2-6 (e.g. 0000320193-25-000079).
function normalizeAccession(raw: string): { dashed: string; nodash: string } | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length !== 18) return null;
  const dashed = `${digits.slice(0, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`;
  return { dashed, nodash: digits };
}

// Strip an HTML document to readable plaintext. Workers have no DOMParser;
// drop script/style blocks, remove tags, decode entities, collapse whitespace.
function htmlToText(html: string): string {
  return (decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ) ?? '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function filingDocuments(
  accession: string,
  tickerOrCik: string,
  includePrimaryText?: boolean,
) {
  const acc = normalizeAccession(accession);
  if (!acc) {
    throw new Error(
      `Invalid accession "${accession}". A SEC accession number is 18 digits shaped 10-2-6 (e.g. "0000320193-25-000079" or "000032019325000079", with or without dashes). Get accession numbers from edgar_company_filings or edgar_search_filings.`,
    );
  }
  if (typeof tickerOrCik !== 'string' || !tickerOrCik.trim()) {
    throw new Error(
      'A ticker or CIK is required to build the filing archive path. Pass ticker ("AAPL") or cik ("320193"), e.g. edgar_filing_documents({accession: "' +
        acc.dashed + '", ticker: "AAPL"}).',
    );
  }
  const cik = await resolveCik(tickerOrCik);
  const cikNoZeros = String(Number(cik.replace(/\D/g, ''))); // archive path uses CIK with no leading zeros
  const paddedCik = padCik(cik);

  // Match the accession in the filer's submissions to enrich with form/date/primaryDoc.
  let company: string | null = null;
  let formType: string | null = null;
  let filingDate: string | null = null;
  let primaryDocument: string | null = null;
  let primaryDocDescription: string | null = null;
  try {
    const subRes = await fetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
    if (subRes.ok) {
      const sub = (await subRes.json()) as {
        name?: string;
        filings?: {
          recent?: {
            accessionNumber?: string[];
            form?: string[];
            filingDate?: string[];
            primaryDocument?: string[];
            primaryDocDescription?: string[];
          };
        };
      };
      company = sub.name ?? null;
      const r = sub.filings?.recent;
      if (r?.accessionNumber) {
        const i = r.accessionNumber.indexOf(acc.dashed);
        if (i >= 0) {
          formType = r.form?.[i] ?? null;
          filingDate = r.filingDate?.[i] ?? null;
          primaryDocument = r.primaryDocument?.[i] ?? null;
          primaryDocDescription = r.primaryDocDescription?.[i] ?? null;
        }
      }
    }
  } catch {
    // Metadata enrichment is best-effort; the document directory below is the core payload.
  }

  const folder = `https://www.sec.gov/Archives/edgar/data/${cikNoZeros}/${acc.nodash}`;
  const idxRes = await fetch(`${folder}/index.json`, { headers: SEC_HEADERS });
  if (idxRes.status === 404) {
    throw new Error(
      `No filing found for accession ${acc.dashed} — that accession number does not exist in SEC EDGAR (double-check the digits; it may belong to a different filer). Use edgar_company_filings({ticker_or_cik: "${tickerOrCik}"}) to list this company's real accession numbers.`,
    );
  }
  if (!idxRes.ok) throw new Error(`SEC EDGAR filing index error: ${idxRes.status}`);
  const idx = (await idxRes.json()) as {
    directory?: { item?: { name: string; type?: string; size?: string | number; 'last-modified'?: string }[] };
  };

  const items = idx.directory?.item ?? [];
  const documents = items.map((it) => ({
    name: it.name,
    type: it.type ?? null,
    ...(it.name === primaryDocument && primaryDocDescription ? { description: primaryDocDescription } : {}),
    size: it.size !== undefined && it.size !== '' ? Number(it.size) : null,
    last_modified: it['last-modified'] ?? null,
    url: `${folder}/${it.name}`,
  }));

  const result: Record<string, unknown> = {
    accession: acc.dashed,
    cik: cikNoZeros,
    company,
    form_type: formType,
    filing_date: filingDate,
    primary_document: primaryDocument,
    filing_url: `${folder}/${acc.dashed}-index.html`,
    documents,
  };

  if (includePrimaryText && primaryDocument) {
    try {
      const docUrl = `${folder}/${primaryDocument}`;
      const docRes = await fetch(docUrl, { headers: { 'User-Agent': SEC_HEADERS['User-Agent'] } });
      if (docRes.ok) {
        const body = await docRes.text();
        const isHtml = /\.x?html?$/i.test(primaryDocument) || /^\s*</.test(body);
        const text = isHtml ? htmlToText(body) : body;
        result.primary_text = text.length > 40000 ? text.slice(0, 40000) + '\n…[truncated]' : text;
      } else {
        result.primary_text = null;
        result.primary_text_error = `fetch ${docRes.status}`;
      }
    } catch (e) {
      result.primary_text = null;
      result.primary_text_error = String(e);
    }
  }

  return result;
}

async function companyFacts(cikOrTicker: string) {
  // Was the only EDGAR tool that skipped resolveCik() — it called padCik()
  // directly, so a ticker ("NVDA") got its letters stripped -> "0000000000" ->
  // 404, and a missing arg crashed on .replace of undefined. Route through
  // resolveCik like every sibling: validates the arg and resolves tickers.
  const cik = await resolveCik(cikOrTicker);
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
  // Common concepts an LLM asks for that were MISSING → 404 (net income was
  // covered but these weren't). Keys are bare-alphanumeric (the lookup strips
  // spaces/punctuation), so "total assets"/"earnings per share" etc. all match.
  assets: ['Assets'],
  totalassets: ['Assets'],
  liabilities: ['Liabilities'],
  totalliabilities: ['Liabilities'],
  stockholdersequity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  eps: ['EarningsPerShareDiluted', 'EarningsPerShareBasic'],
  earningspershare: ['EarningsPerShareDiluted', 'EarningsPerShareBasic'],
  earningspersharediluted: ['EarningsPerShareDiluted', 'EarningsPerShareBasic'],
  earningspersharebasic: ['EarningsPerShareBasic', 'EarningsPerShareDiluted'],
  grossprofit: ['GrossProfit'],
  operatingincome: ['OperatingIncomeLoss'],
  operatingincomeloss: ['OperatingIncomeLoss'],
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

// Annual-report forms. 10-K/10-K/A = domestic; 20-F/40-F (+ amendments) =
// foreign private issuers (IFRS filers). The concept reader filtered to 10-K
// only, which silently dropped every foreign filer's data even when the tag
// existed → 404s / empty results.
const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A']);

// ifrs-full taxonomy fallback for foreign private issuers (they report under
// ifrs-full, not us-gaap). Keyed by the same normalized metric name; tried only
// when the us-gaap candidates all miss, so domestic lookups pay no extra call.
const IFRS_FALLBACK: Record<string, string[]> = {
  revenue: ['Revenue', 'RevenueFromContractsWithCustomers'],
  revenues: ['Revenue', 'RevenueFromContractsWithCustomers'],
  revenuefromcontractwithcustomerexcludingassessedtax: ['Revenue', 'RevenueFromContractsWithCustomers'],
  salesrevenuenet: ['Revenue', 'RevenueFromContractsWithCustomers'],
  netincome: ['ProfitLoss', 'ProfitLossAttributableToOwnersOfParent'],
  netincomeloss: ['ProfitLoss', 'ProfitLossAttributableToOwnersOfParent'],
  profitloss: ['ProfitLoss', 'ProfitLossAttributableToOwnersOfParent'],
  cash: ['CashAndCashEquivalents'],
  cashandcashequivalentsatcarryingvalue: ['CashAndCashEquivalents'],
  assets: ['Assets'],
  liabilities: ['Liabilities'],
  stockholdersequity: ['Equity', 'EquityAttributableToOwnersOfParent'],
  equity: ['Equity', 'EquityAttributableToOwnersOfParent'],
};

async function companyConcept(cikOrTicker: string, concept: string) {
  // Auto-resolve ticker → CIK so callers can pass "AAPL" not "320193".
  // Production analytics: 11% errors on edgar largely from LLMs passing
  // tickers as cik (then padCik strips letters → 0000000000 → 404).
  const cik = await resolveCik(cikOrTicker);
  const paddedCik = padCik(cik);

  // Normalize the lookup key to bare alphanumerics so natural-language input
  // ("net income", "Long-Term Debt", "earnings per share") matches the no-space
  // map keys — the #1 edgar_company_concept error was "net income" (with a space)
  // missing the `netincome` key → 404.
  const candidates = CONCEPT_CANDIDATES[concept.trim().toLowerCase().replace(/[^a-z0-9]/g, '')] ?? [concept];

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
  const tryNamespace = async (ns: string, tags: string[]) => {
    for (const candidate of tags) {
      const r = await fetch(
        `${DATA_BASE}/api/xbrl/companyconcept/CIK${paddedCik}/${ns}/${encodeURIComponent(candidate)}.json`,
        { headers: SEC_HEADERS },
      );
      if (!r.ok) { lastStatus = r.status; continue; }
      const doc = (await r.json()) as ConceptDoc;
      let latestEnd = '';
      for (const values of Object.values(doc.units)) {
        for (const e of values) {
          if (!ANNUAL_FORMS.has(e.form)) continue;
          if ((e.end ?? '') > latestEnd) latestEnd = e.end ?? '';
        }
      }
      found.push({ doc, latestEnd });
    }
  };
  await tryNamespace('us-gaap', candidates);
  // Only try the ifrs-full taxonomy when us-gaap returned nothing — foreign
  // private issuers file under ifrs-full (form 20-F/40-F). Domestic (us-gaap)
  // lookups short-circuit here and pay no extra request.
  if (found.length === 0) {
    const ifrs = IFRS_FALLBACK[concept.trim().toLowerCase().replace(/[^a-z0-9]/g, '')] ?? [];
    if (ifrs.length) await tryNamespace('ifrs-full', ifrs);
  }
  // Fallback: the filer tags this metric under a name not in our candidate list
  // (very common for debt / lease / segment concepts — e.g. Ford dropped
  // LongTermDebtNoncurrent, many filers use LongTermDebtAndCapitalLease...). Pull
  // the full facts once and find the freshest us-gaap tag whose NAME matches the
  // concept keywords, preferring balance-sheet stock tags over cash-flow tags.
  if (found.length === 0) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const tokens = candidates.map(norm).filter((t) => t.length >= 3);
    const factsRes = await fetch(`${DATA_BASE}/api/xbrl/companyfacts/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
    if (factsRes.ok && tokens.length) {
      const facts = (await factsRes.json()) as { entityName?: string; facts?: { 'us-gaap'?: Record<string, { label?: string; description?: string; units: Record<string, ConceptDoc['units'][string]> }> } };
      const gaap = facts.facts?.['us-gaap'] ?? {};
      const FLOW = /^(ProceedsFrom|RepaymentsOf|PaymentsOf|IncreaseDecrease|AmortizationOf|Gain|Loss)/;
      const matches: { isFlow: boolean; latestEnd: string; doc: ConceptDoc }[] = [];
      for (const [tag, entry] of Object.entries(gaap)) {
        if (!tokens.some((t) => norm(tag).includes(t))) continue;
        let latestEnd = '';
        for (const values of Object.values(entry.units)) {
          for (const e of values) {
            if (e.form !== '10-K' && e.form !== '10-K/A') continue;
            if ((e.end ?? '') > latestEnd) latestEnd = e.end ?? '';
          }
        }
        matches.push({
          isFlow: FLOW.test(tag),
          latestEnd,
          doc: { cik: Number(cik), entityName: facts.entityName ?? '', tag, taxonomy: 'us-gaap', label: entry.label ?? tag, description: entry.description ?? '', units: entry.units },
        });
      }
      matches.sort((a, b) => Number(a.isFlow) - Number(b.isFlow) || (b.latestEnd ?? '').localeCompare(a.latestEnd ?? ''));
      if (matches.length) found.push({ doc: matches[0].doc, latestEnd: matches[0].latestEnd });
    }
  }
  if (found.length === 0) {
    throw new Error(
      `SEC EDGAR company concept error: ${lastStatus} — none of the candidate concepts ${JSON.stringify(candidates)} exist for CIK ${paddedCik}, and no us-gaap tag matched. Use edgar_company_facts({cik: "${cikOrTicker}"}) to see every concept this filer reports.`,
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
      if (!ANNUAL_FORMS.has(e.form)) continue; // 10-K (+/A) domestic, 20-F/40-F (+/A) foreign
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

// ── Fund / ETF holdings (Form N-PORT) ───────────────────────────────

function decodeEntities(s: string | null): string | null {
  if (s == null) return null;
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

// ETF/mutual-fund ticker → {cik, seriesId}. The MF ticker file (~28k rows) is
// separate from company_tickers.json; cache it in-isolate after first fetch.
let mfTickerCache: Map<string, { cik: string; seriesId: string }> | null = null;
async function resolveFundTicker(ticker: string): Promise<{ cik: string; seriesId: string } | null> {
  if (!mfTickerCache) {
    const res = await fetch('https://www.sec.gov/files/company_tickers_mf.json', { headers: SEC_HEADERS });
    if (!res.ok) throw new Error(`SEC fund-ticker lookup error: ${res.status}`);
    const data = (await res.json()) as { fields: string[]; data: Array<[number, string, string, string]> };
    // fields: [cik, seriesId, classId, symbol]
    mfTickerCache = new Map();
    for (const [cik, seriesId, , symbol] of data.data) {
      if (symbol && !mfTickerCache.has(symbol)) mfTickerCache.set(symbol, { cik: String(cik), seriesId });
    }
  }
  return mfTickerCache.get(ticker.toUpperCase().trim()) ?? null;
}

async function fundHoldings(ticker: string, limit?: number) {
  const t = String(ticker ?? '').trim();
  if (!t) throw new Error('Required argument "ticker" is missing. Pass an ETF/fund ticker like "ARKK" or "SPY".');
  const topN = Math.min(100, Math.max(1, limit ?? 25));

  const resolved = await resolveFundTicker(t);
  if (!resolved) {
    return { ticker: t.toUpperCase(), error: 'not_found', message: `"${t}" is not a known N-PORT-filing fund/ETF ticker. Use a fund ticker like "ARKK", "QQQ", "VTI", or "VOO". (Some legacy ETFs structured as unit investment trusts — SPY, DIA — don't file N-PORT; use IVV or VOO for S&P 500.)` };
  }
  const { cik, seriesId } = resolved;
  const paddedCik = padCik(cik);

  const subRes = await fetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
  if (!subRes.ok) throw new Error(`SEC submissions error: ${subRes.status}`);
  const sub = (await subRes.json()) as {
    cik: string; name: string;
    filings: { recent: { accessionNumber: string[]; filingDate: string[]; form: string[] } };
  };
  const r = sub.filings.recent;
  const nports: { accession: string; date: string }[] = [];
  for (let i = 0; i < r.form.length && nports.length < 12; i++) {
    if (r.form[i] === 'NPORT-P') nports.push({ accession: r.accessionNumber[i], date: r.filingDate[i] });
  }
  if (nports.length === 0) {
    return { ticker: t.toUpperCase(), cik, error: 'no_nport', message: `No N-PORT filings found for ${sub.name}.` };
  }

  // A trust files one N-PORT per series; fetch recent candidates in parallel and
  // match the series. Newest-first order means .find() returns the latest match.
  const candidates = await Promise.all(
    nports.map(async (f) => {
      const accPath = f.accession.replace(/-/g, '');
      const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accPath}/primary_doc.xml`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': SEC_HEADERS['User-Agent'] } });
        if (!res.ok) return null;
        return { date: f.date, accession: f.accession, xml: stripNs(await res.text()) };
      } catch {
        return null;
      }
    }),
  );
  const match = candidates.find((c) => c && xmlVal(c.xml, 'seriesId') === seriesId);
  if (!match) {
    return { ticker: t.toUpperCase(), cik, series_id: seriesId, error: 'series_not_matched', message: `Found N-PORT filings for ${sub.name} but none of the ${nports.length} most recent matched series ${seriesId}.` };
  }

  const xml = match.xml;
  const holdings = xmlBlocks(xml, 'invstOrSec')
    .map((h) => ({
      name: decodeEntities(xmlVal(h, 'name')),
      title: decodeEntities(xmlVal(h, 'title')),
      cusip: xmlVal(h, 'cusip'),
      balance: numOrNull(xmlVal(h, 'balance')),
      units: xmlVal(h, 'units'),
      value_usd: numOrNull(xmlVal(h, 'valUSD')),
      pct_of_fund: numOrNull(xmlVal(h, 'pctVal')),
    }))
    .sort((a, b) => (b.pct_of_fund ?? 0) - (a.pct_of_fund ?? 0));

  return {
    ticker: t.toUpperCase(),
    fund_name: xmlVal(xml, 'seriesName'),
    series_id: seriesId,
    cik,
    report_period_end: xmlVal(xml, 'repPdDate') ?? match.date,
    net_assets_usd: numOrNull(xmlVal(xml, 'netAssets')),
    total_holdings: holdings.length,
    holdings_returned: Math.min(holdings.length, topN),
    holdings: holdings.slice(0, topN),
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
    case 'edgar_fund_holdings':
      return fundHoldings(args.ticker as string, args.limit as number | undefined);
    case 'edgar_company_concept':
      // Accept `ticker_or_cik` too: the schema/handler use `cik` (which takes a
      // ticker or CIK) but the sibling tools use `ticker_or_cik` and the error
      // message names it — agents naturally pass it and were rejected.
      return companyConcept((args.cik ?? args.ticker_or_cik) as string, args.concept as string);
    case 'edgar_filing_documents':
      return filingDocuments(
        args.accession as string,
        (args.cik ?? args.ticker ?? args.ticker_or_cik) as string,
        args.include_primary_text as boolean | undefined,
      );
    case 'edgar_ticker_to_cik':
      return tickerToCik(args.ticker as string);
    case 'edgar_xbrl_frames':
      return xbrlFrames(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

interface FrameDatum { cik?: number; entityName?: string; val?: number; start?: string; end?: string; fy?: number; fp?: string; form?: string }

async function xbrlFrames(args: Record<string, unknown>) {
  const concept = String(args.concept ?? '').trim().replace(/[^A-Za-z0-9]/g, '');
  if (!concept) throw new Error('Required argument "concept" is missing (a US-GAAP tag, e.g. "Revenues", "NetIncomeLoss", "Assets").');
  const period = String(args.period ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^CY\d{4}(Q[1-4]I?)?$/.test(period)) {
    throw new Error('Required argument "period" must be a calendar frame: "CY2023" (annual), "CY2023Q1" (quarter), or "CY2023Q1I" (instant). Got: ' + (args.period ?? ''));
  }
  const taxonomy = String(args.taxonomy ?? 'us-gaap').trim().toLowerCase() === 'dei' ? 'dei' : 'us-gaap';
  const unit = String(args.unit ?? 'USD').trim() || 'USD';
  const sortDesc = String(args.sort ?? 'desc').toLowerCase() !== 'asc';
  const limit = Math.min(200, Math.max(1, Number(args.limit) || 25));

  const url = `${DATA_BASE}/api/xbrl/frames/${taxonomy}/${encodeURIComponent(concept)}/${encodeURIComponent(unit)}/${period}.json`;
  const res = await fetch(url, { headers: SEC_HEADERS });
  if (res.status === 404) {
    return { error: 'not_found', concept, period, unit, taxonomy, message: `No SEC frame for ${taxonomy}/${concept}/${unit}/${period}. Check the tag spelling/casing, unit (USD vs shares), and period type (add "I" for balance-sheet/instant items like Assets).` };
  }
  if (!res.ok) throw new Error(`SEC frames error: ${res.status}`);
  const data = (await res.json()) as { taxonomy?: string; tag?: string; uom?: string; label?: string; description?: string; data?: FrameDatum[] };
  const rows = (data.data ?? []).slice().sort((a, b) => sortDesc ? (b.val ?? 0) - (a.val ?? 0) : (a.val ?? 0) - (b.val ?? 0));

  return {
    concept,
    period,
    unit,
    taxonomy,
    label: data.label ?? null,
    companies_reporting: rows.length,
    returned: Math.min(rows.length, limit),
    sort: sortDesc ? 'desc' : 'asc',
    source: 'SEC EDGAR XBRL frames (data.sec.gov)',
    note: 'Values are AS-FILED in each company\'s XBRL submission for this calendar frame. Extreme outliers are often filer reporting errors (wrong units/scale) — cross-check surprising top values with edgar_company_concept before treating a ranking as authoritative.',
    companies: rows.slice(0, limit).map((r) => ({
      cik: r.cik ?? null,
      entity: r.entityName ?? null,
      value: r.val ?? null,
      period_start: r.start ?? null,
      period_end: r.end ?? null,
      form: r.form ?? null,
    })),
  };
}

export default { tools, callTool, meter: { credits: 10 } } satisfies McpToolExport;
