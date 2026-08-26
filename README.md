# SEC EDGAR — Public Company Filings

The Securities and Exchange Commission's filings database. Every public company in the US files here, every filing is timestamped and immutable, and every disclosure (revenue, debt, risk factors, executive compensation, M&A activity, insider trading) is structured for machine retrieval. Free and authoritative.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Why this matters for AI agents

If your agent is answering anything about a US public company — financials, legal exposure, IP, executive turnover, recent material events — the answer is in EDGAR. The data is structured (XBRL), so you don't have to parse PDFs.

The two key flows:

**1. Filings flow.** "Show me Apple's recent 10-Q." → `edgar_ticker_to_cik("AAPL")` → `edgar_company_filings(cik)` → list of filings with accession numbers, form types, filing dates.

**2. Concepts flow.** "What was Apple's revenue trend the last 4 quarters?" → `edgar_company_concept(cik, "Revenues")` → time series of XBRL-tagged values across periods.

Both are usually preceded by `edgar_ticker_to_cik` or `resolve_entity({type: "company", value: "AAPL"})` to get the canonical 10-digit CIK.

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

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

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
