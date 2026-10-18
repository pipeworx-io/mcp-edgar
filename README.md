# SEC EDGAR — Public Company Filings

The Securities and Exchange Commission's filings database. Every public company in the US files here, every filing is timestamped and immutable, and every disclosure (revenue, debt, risk factors, executive compensation, M&A activity, insider trading) is structured for machine retrieval. Free and authoritative.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1837+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Why this matters for AI agents

If your agent is answering anything about a US public company — financials, legal exposure, IP, executive turnover, recent material events — the answer is in EDGAR. The data is structured (XBRL), so you don't have to parse PDFs.

The two key flows — and the one call that does both:

**0. Snapshot (one call).** "Give me the SEC picture on Apple." → `edgar_company_snapshot({ticker_or_cik: "AAPL"})` → CIK + the recent substantive filings (10-K/10-Q/8-K/20-F/40-F/6-K/DEF 14A by default; Form 4 noise excluded unless you ask for `form_type: "all"`) + the headline XBRL figures from the latest annual report (revenue, net income, assets, cash, EPS…). This is flows 1 and 2 collapsed: the resolve → list → pull chain that depth users otherwise assemble by hand three calls at a time. A filer with no XBRL (a fund or trust) still returns its filings with `financials_status: "unavailable"` and the reason. `edgar_ticker_to_cik` now returns a `next` hint pointing here.

**1. Filings flow.** "Show me Apple's recent 10-Q." → `edgar_ticker_to_cik("AAPL")` → `edgar_company_filings(cik)` → list of filings with accession numbers, form types, filing dates.

**2. Concepts flow.** "What was Apple's revenue trend the last 4 quarters?" → `edgar_company_concept(cik, "Revenues")` → time series of XBRL-tagged values across periods.

**3. Peer/competitor flow.** "Who competes with Apple?" → `edgar_companies_by_sic({ticker_or_cik: "AAPL"})` → resolves Apple's own SIC code (3571, Electronic Computers) and returns other SEC filers under that code, listed-ticker peers first. Pass a `sic` code directly instead of a company to browse an industry cold.

**4. Entity-resolution flow (parent ↔ subsidiary).** `sponsor_to_filer({sponsor: "Merck Sharp and Dohme"})` resolves a subsidiary/operating name up to its listed parent (MRK). `filer_to_sponsors({ticker_or_cik: "MRK"})` goes the other way — the parent's full disclosed subsidiary list from Exhibit 21 of its latest 10-K, with jurisdiction and filing provenance. Pass `name_filter` to check one candidate name without reading the whole list.

**5. Product-level revenue.** "How much revenue did Keytruda generate?" → `edgar_product_revenue({ticker_or_cik: "MRK", product_filter: "Keytruda"})`. `edgar_company_concept`/`edgar_company_facts` only expose undimensioned XBRL totals — a product/segment breakdown is tagged with an XBRL dimension (a "Keytruda [Member]"), invisible to those APIs. This reads SEC's own rendered Financial Report of that dimensional data straight out of the revenue-disaggregation note, with a citation (accession, filing date, report URL). With no `form_type` it resolves 10-K, then 20-F, then 40-F, so foreign private issuers work the same way (`edgar_product_revenue({ticker_or_cik: "NVS", product_filter: "Entresto"})` reads Novartis's 20-F); the form actually used comes back as `resolved_form`. Not every filer tags product-level revenue in XBRL — Neurocrine discloses revenue by major customer and United Therapeutics only its recognition policy, and both return an explicit `not_found` rather than an empty array.

Both flows are usually preceded by `edgar_ticker_to_cik` or `resolve_entity({type: "company", value: "AAPL"})` to get the canonical 10-digit CIK.

## Auth

None. SEC EDGAR is a free, public, no-auth service. Pipeworx forwards a polite User-Agent header to comply with SEC's API guidelines.

## Citable URIs

```
pipeworx://edgar/company/{cik}/filings
pipeworx://edgar/company/{cik}/facts
```

Embed in your output. Stable across reorganizations — companies rebrand, but their CIK doesn't change.

## Form types worth knowing

| Form | What it is | When |
|---|---|---|
| 10-K | Annual report | ~60 days after fiscal year-end |
| 10-Q | Quarterly report | ~45 days after quarter-end |
| 8-K | Material event (M&A, exec changes, earnings, etc.) | Within 4 business days |
| DEF 14A | Proxy statement (executive comp, governance) | ~6 weeks before annual meeting |
| Form 4 | Insider trading disclosure | Within 2 business days of trade |
| 13F | Institutional holdings (>$100M AUM funds) | 45 days after quarter-end |
| S-1 | IPO registration | When going public |
| 13D / 13G | >5% beneficial ownership disclosure | Within 10 days of crossing threshold |

For insider trades specifically, see the dedicated `insider-trading` pack — it surfaces Form 4 / 13D / 13G changes with cleaner schemas.

## Common pitfalls

- **Concept name drift.** SEC filers occasionally change the XBRL concept they tag for revenue. The default `Revenues` concept may be stale for newer fiscal years; try `RevenueFromContractWithCustomerExcludingAssessedTax` as a fallback.
- **Period mismatches.** Fiscal years end at different times across companies (Apple = Sept, Microsoft = June, Google = Dec). When comparing, always disclose the period.
- **CIK formatting.** Some endpoints want zero-padded 10-digit (`0000320193`), some want unpadded (`320193`). Pipeworx accepts either; the `cik_padded` field in `edgar_ticker_to_cik` is the canonical form for resource URIs.
- **Real-time-ish, not real-time.** Filings appear on EDGAR within minutes of submission, but Pipeworx caches results. For breaking-news-grade timeliness, set `Cache-Control: no-cache` (anonymous limit applies) or check the `_meta.cache.fresh_until` field.
- **Concept availability differs.** Smaller filers tag fewer XBRL concepts than large ones. `edgar_company_concept` may return empty arrays for valid concepts that the company simply doesn't report. Use `edgar_company_facts` to see which concepts a company DOES report.
- **The company argument is spelled three different ways across this pack, and `edgar_company_concept` accepts all of them.** `edgar_company_filings`/`edgar_insider_transactions`/`edgar_product_revenue` name it `ticker_or_cik`, `edgar_fund_holdings`/`edgar_ticker_to_cik` name it `ticker`, and `edgar_company_concept`/`edgar_company_facts` name it `cik` (which takes a ticker too). A model filling arguments reaches for whichever word it read last, so `edgar_company_concept` declares `ticker` and `ticker_or_cik` as aliases of `cik`, and `metric` as an alias of `concept`. Measured before that change (fleet #2058): of 11 times the ask_pipeworx adjudicator selected this tool over 16 never-before-asked questions, 9 calls were rejected by the gateway's required-argument pre-flight — every one of them because it had sent `ticker` or `ticker_or_cik` rather than `cik`, and a third of those sent `metric` rather than `concept` as well. Both calls that used `cik`+`concept` succeeded. The outcome recorded for the rejected ones was `partial`, not an error, because a single-tool selection that arrives as a one-element `tools` array runs the fan-out branch — so the word for "the only lookup never ran" was the same word used for "some of several lookups ran".
- **A filing you did not NAME is a filing we CHOSE, and the envelope now says which (fleet #3319).** `edgar_filing_text` and `edgar_filing_documents` auto-resolve the LATEST filing of `form_type` when `accession` is omitted, and every field then describes that filing as though it had been asked for. Measured live 2026-10-18: a grounded question about "Tesla's September 29 2026 8-K" reached `edgar_filing_text({ticker:"TSLA", form_type:"8-K", search:"credit facility"})`, resolved to the 2026-10-02 8-K — a different filing, 3,061 chars, zero matches — and refused `not_in_source` 5 tries out of 5, while the filing asked about sat one row further down the same index with all three credit tranches in it. So every response carries `accession_source` (`"caller"` | `"auto_selected"`) plus, when we chose, an `auto_selected` block naming what was requested, what was picked, what was read with its exact-match count, and the candidates that were not read. **Pass `filed`** ("2026-09-29", "2026-09", "September 29, 2026") whenever the question names a date; for an 8-K the newest filing is routinely not the one meant. When only a `search` is available, `edgar_filing_text` reads on past a candidate whose text contains no exact match (bounded to 4 documents, exact matches only), and if none match it falls back to the newest WITH a warning that a zero-match result there is inconclusive about the company rather than about that filing.
- **`edgar_company_filings` used to drop a named `accession` on the floor.** It declared neither `accession` nor `include_primary_text`, so a caller that named one filing got the same unnarrowed list as one that named nothing — HTTP 200, reads as a clean success. That is how the fleet #3319 question finally died: the grounded ladder's last attempt routed here with `{accession:"0001628280-26-063820", ticker:"TSLA", include_primary_text:true}` (AE `blob12` — the router had already resolved the right 8-K) and the extraction model received a generic 10-row filings list carrying no facility amounts. Both arguments are real now, plus `filed`; a one-row result says so in `narrowed_note`, and an accession the filer never filed is a loud `not_found:` error rather than an unfiltered list.
- **`fiscal_year` and `fiscal_period` are filters AND response fields.** They are the names of two fields on every row in `values`, and the description's advice to "match the requested fiscal_year and fiscal_period" used to make argument-fillers send them as arguments, where they were undeclared and silently dropped — so the caller got all 89-230 reported periods back with nothing saying its filter had been ignored. They are now real optional filters: pass either or both and `values`/`latest` come back scoped to it, with a `period_filter` block echoing what was applied. An unmatched filter returns NO rows plus the list of fiscal years and periods the filer actually reports, rather than falling back to every period — `fiscal_year` is the filer's OWN label (NVDA's FY2024 ended January 2024), so a caller thinking in calendar years needs to see the labels rather than be handed a neighbouring year's number.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "edgar": {
      "url": "https://gateway.pipeworx.io/edgar/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/edgar/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1837+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/edgar_search_filings \
  -H 'Content-Type: application/json' \
  -d '{"query":"artificial intelligence","form_type":"10-K","start_date":"2024-01-01","end_date":"2024-12-31","limit":20}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/edgar_search_filings`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "edgar": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-edgar"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-edgar
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Edgar data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
