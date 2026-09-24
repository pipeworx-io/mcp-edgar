interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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

interface SecTickerRow$shared { cik_str: number; ticker: string; title: string }

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
  const data = (await res.json()) as Record<string, SecTickerRow$shared>;
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

  throw new Error(`No SEC company matches "${query}". Pass a US-listed ticker ("AAPL") or the exact listed-company name ("Apple Inc."). If this is a clinical-trial sponsor, an operating subsidiary (e.g. "Merck Sharp & Dohme" → Merck & Co), or a foreign/private entity, call sponsor_to_filer({sponsor}) instead — it resolves subsidiaries to the listed parent and honestly reports when no US-listed filer exists.`);
}

function toEntity(r: SecTickerRow$shared, matched_by: 'ticker' | 'company_name'): SecEntity {
  return {
    ticker: r.ticker,
    cik: String(r.cik_str),
    cik_padded: String(r.cik_str).padStart(10, '0'),
    company_name: r.title,
    matched_by,
  };
}

const GENERIC_CORP_WORDS = new Set([
  'THE', 'A', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED',
  'LLC', 'LP', 'PLC', 'SA', 'AG', 'NV', 'GMBH', 'AB', 'AS', 'OY', 'SPA',
  'GROUP', 'HOLDINGS', 'HOLDING', 'AND', 'OF', 'US', 'USA', 'INTERNATIONAL',
  'GLOBAL',
]);

/**
 * Split a corporate/organization name into its SIGNIFICANT tokens — words
 * that aren't generic corporate boilerplate (Inc, Co, Ltd, Group, ...) or
 * punctuation — sorted LONGEST FIRST. Built for cross-registry name joins
 * where the two registries anchor on different words of the same name: SEC
 * lists Eli Lilly as "ELI LILLY & Co", but Drugs@FDA's sponsor_name field
 * uses "LILLY" — the longer, more distinctive token, not the first one
 * ("ELI" alone is short and matches too loosely). Pure (no I/O); callers
 * typically try tokens in order until one call to their OWN registry
 * returns a result.
 */
function significantNameTokens(name: string): string[] {
  const tokens = name
    .toUpperCase()
    .replace(/[.,&/()-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !GENERIC_CORP_WORDS.has(t));
  return [...new Set(tokens)].sort((a, b) => b.length - a.length);
}


/**
 * Pick "the most recent annual value" out of SEC companyfacts XBRL data —
 * the one operation every company-facts tool does, and the one that shipped
 * wrong twice (sec + edgar packs, identical code) for the largest filers.
 *
 * Two traps in the raw companyfacts feed, both confirmed live 2026-08-28
 * (fleet #594):
 *
 *   1. `fy` is the fiscal year of the FILING, not of the reported period. A
 *      10-K carries two or three prior years as comparatives, and every one of
 *      them is stamped with the filing's fy. Amazon's FY2020 net income
 *      ($21.3B, period 2020-01-01..2020-12-31) appears with fy=2022 because it
 *      was restated in the FY2022 10-K — and Amazon's actual FY2022 figure is a
 *      $2.7B LOSS. Sorting by fy therefore mislabels the year AND can pick a
 *      comparative over the current period. The period is `start`/`end`; the
 *      year has to be derived from `end`.
 *
 *   2. `frame` is assigned to the LAST-FILED fact for a calendar period, not to
 *      the 10-K that first reported it. Since proxies (DEF 14A) began carrying
 *      XBRL, Amazon's CY2021..CY2025 annual frames all sit on the 2026 proxy,
 *      so a `form === '10-K' && frame` filter sees no 10-K annual fact newer
 *      than CY2020 and confidently returns that.
 *
 * And one presentation trap: a concept the filer has RETIRED (Microsoft's
 * `Revenues` stops at FY2010 — it moved to
 * RevenueFromContractWithCustomerExcludingAssessedTax under ASC 606) is
 * accurate per-concept but wrong the moment it is presented under
 * "most recent" beside concepts that are genuinely current. The fix is
 * labelling and precedence, not deletion: a caller building a long series
 * legitimately wants the retired concept, so it stays — flagged `stale`,
 * sorted last, with the current concept surfaced in `latest_annual`.
 *
 * Kept dependency-free on purpose: publish-pack.sh inlines this file into the
 * standalone npm build of any pack that imports it.
 */

interface XbrlFactEntry {
  start?: string;
  end: string;
  val: number;
  accn?: string;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
}

interface XbrlConcept {
  label: string;
  description?: string;
  units: Record<string, XbrlFactEntry[]>;
}

type XbrlConceptMap = Record<string, XbrlConcept>;

interface AnnualValue {
  /** Fiscal year the period ENDS in (derived from period_end — see fiscalYearOf). */
  year: number;
  value: number;
  filed: string;
  /** Present for duration concepts (income statement); absent for instants (balance sheet). */
  period_start?: string;
  period_end: string;
  form: string;
  unit: string;
  concept: string;
}

interface KeyFinancial {
  label: string;
  most_recent_annual: Omit<AnnualValue, 'concept'> | null;
  /**
   * true when this concept's latest annual value ends before the filer's latest
   * annual report period — i.e. the filer stopped reporting it. The number is
   * real history, not the company's current figure.
   */
  stale: boolean;
  stale_note?: string;
}

/** Annual-report forms. 10-KT (transition period) is deliberately excluded. */
const ANNUAL_FORMS$shared = new Set(['10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A']);
/** Preferred unit per concept, in order. Anything else falls back to the first unit present. */
const UNIT_PREFERENCE = ['USD', 'USD/shares', 'shares', 'pure'];
const DAY_MS = 86_400_000;

/**
 * Fiscal year a period belongs to, by the near-universal convention of naming
 * the year the period ENDS in (Apple FY2025 ends 2025-09-27, Walmart FY2026
 * ends 2026-01-31). The one exception handled: 52/53-week years that end in
 * the first days of January belong to the prior year (a year ending
 * 2027-01-02 is fiscal 2026).
 */
function fiscalYearOf(periodEnd: string): number {
  const y = Number(periodEnd.slice(0, 4));
  const m = Number(periodEnd.slice(5, 7));
  const d = Number(periodEnd.slice(8, 10));
  return m === 1 && d <= 7 ? y - 1 : y;
}

function preferredUnit(units: Record<string, XbrlFactEntry[]>): string | null {
  for (const u of UNIT_PREFERENCE) if (units[u]?.length) return u;
  const first = Object.keys(units).find((u) => units[u]?.length);
  return first ?? null;
}

function isAnnualPeriod(e: XbrlFactEntry): boolean {
  if (!e.start) return true; // instant (balance-sheet) fact
  const days = (Date.parse(e.end) - Date.parse(e.start)) / DAY_MS;
  return days >= 340 && days <= 380; // 52/53-week years included, quarters/YTD excluded
}

/**
 * The most recent annual value for one concept: latest period_end among
 * annual-report facts, ties broken by latest filed (a restated figure from a
 * later 10-K wins over the original).
 */
function latestAnnual(concepts: XbrlConceptMap, concept: string): AnnualValue | null {
  const fact = concepts[concept];
  if (!fact?.units) return null;
  const unit = preferredUnit(fact.units);
  if (!unit) return null;
  let best: XbrlFactEntry | null = null;
  for (const e of fact.units[unit]) {
    if (!e.form || !ANNUAL_FORMS$shared.has(e.form) || !e.end || typeof e.val !== 'number') continue;
    if (!isAnnualPeriod(e)) continue;
    if (
      !best ||
      e.end > best.end ||
      (e.end === best.end && (e.filed ?? '') > (best.filed ?? ''))
    ) best = e;
  }
  if (!best) return null;
  return {
    year: fiscalYearOf(best.end),
    value: best.val,
    filed: best.filed ?? '',
    ...(best.start ? { period_start: best.start } : {}),
    period_end: best.end,
    form: best.form ?? '',
    unit,
    concept,
  };
}

/**
 * Among alternative concepts for the same line item (filers migrate tags —
 * Revenues → RevenueFromContractWithCustomerExcludingAssessedTax under ASC
 * 606), the one with the most recent period wins; ties go to list order.
 */
function freshestOf(concepts: XbrlConceptMap, candidates: string[]): AnnualValue | null {
  let best: AnnualValue | null = null;
  for (const c of candidates) {
    const hit = latestAnnual(concepts, c);
    if (hit && (!best || hit.period_end > best.period_end)) best = hit;
  }
  return best;
}

/** Canonical line items → the us-gaap concepts filers use for them, most-current-first. */
const LINE_ITEM_CONCEPTS: Record<string, string[]> = {
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueGoodsNet',
    'RevenuesNetOfInterestExpense',
  ],
  net_income: ['NetIncomeLoss', 'ProfitLoss'],
  operating_income: ['OperatingIncomeLoss'],
  gross_profit: ['GrossProfit'],
  total_assets: ['Assets'],
  total_liabilities: ['Liabilities'],
  stockholders_equity: [
    'StockholdersEquity',
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
  ],
  cash_and_equivalents: [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    'Cash',
  ],
  eps_basic: ['EarningsPerShareBasic'],
  eps_diluted: ['EarningsPerShareDiluted'],
  shares_outstanding: ['CommonStockSharesOutstanding'],
  research_and_development: ['ResearchAndDevelopmentExpense'],
};

interface AnnualFinancialsSummary {
  /** Fiscal year of the filer's most recent annual report, across every concept examined. */
  latest_fiscal_year: number | null;
  latest_period_end: string | null;
  /** One entry per canonical line item, choosing whichever concept the filer currently reports under. */
  latest_annual: Record<string, AnnualValue | null>;
  /** Per-concept detail. Current concepts first, retired (stale) concepts last. */
  key_financials: Record<string, KeyFinancial>;
  /** Concepts the filer has stopped reporting — present in key_financials, flagged, never in latest_annual. */
  stale_concepts: string[];
  year_note: string;
}

/**
 * Build the whole "key financials" view: canonical line items resolved to the
 * concept the filer currently uses, plus per-concept detail with staleness
 * flagged at the point of use and stale concepts sorted last.
 */
function summarizeAnnualFinancials(concepts: XbrlConceptMap): AnnualFinancialsSummary {
  // Every concept any line item could draw from, in a stable order.
  const perConcept: { concept: string; label: string; value: AnnualValue | null }[] = [];
  const seen = new Set<string>();
  for (const candidates of Object.values(LINE_ITEM_CONCEPTS)) {
    for (const c of candidates) {
      if (seen.has(c) || !concepts[c]) continue;
      seen.add(c);
      perConcept.push({ concept: c, label: concepts[c].label, value: latestAnnual(concepts, c) });
    }
  }

  let latestEnd: string | null = null;
  for (const row of perConcept) {
    if (row.value && (!latestEnd || row.value.period_end > latestEnd)) latestEnd = row.value.period_end;
  }
  const latestFy = latestEnd ? fiscalYearOf(latestEnd) : null;

  // A concept whose latest annual period ends more than ~100 days before the
  // filer's latest annual period has been retired by the filer. (Instants and
  // durations in the same 10-K share an end date, so anything beyond a few
  // days is a genuinely older report.)
  const isStale = (v: AnnualValue | null) =>
    !!v && !!latestEnd && (Date.parse(latestEnd) - Date.parse(v.period_end)) / DAY_MS > 100;

  // Canonical line items: the freshest NON-STALE concept per item. A line the
  // filer only ever reported under a since-retired concept (Amazon's
  // GrossProfit stops at FY2009) is null here — the stale value stays in
  // key_financials, flagged, where it cannot be read as current.
  const latest_annual: Record<string, AnnualValue | null> = {};
  for (const [item, candidates] of Object.entries(LINE_ITEM_CONCEPTS)) {
    const v = freshestOf(concepts, candidates);
    latest_annual[item] = v && !isStale(v) ? v : null;
  }

  const itemOf = (concept: string) =>
    Object.entries(LINE_ITEM_CONCEPTS).find(([, cs]) => cs.includes(concept))?.[0];

  const current = perConcept.filter((r) => !isStale(r.value));
  const stale = perConcept.filter((r) => isStale(r.value));
  const key_financials: Record<string, KeyFinancial> = {};
  for (const r of [...current, ...stale]) {
    const entry: KeyFinancial = {
      label: r.label,
      most_recent_annual: r.value ? stripConcept(r.value) : null,
      stale: isStale(r.value),
    };
    if (entry.stale && r.value) {
      const item = itemOf(r.concept);
      const replacement = item ? latest_annual[item] : null;
      const successor =
        replacement && replacement.concept !== r.concept
          ? ` The filer now reports this line under ${replacement.concept} (FY${replacement.year}) — see latest_annual.${item}.`
          : ' No current concept for this line item was found in the filer\'s us-gaap facts.';
      entry.stale_note =
        `STALE: this concept's latest annual value is for FY${r.value.year} (period ending ${r.value.period_end}), ` +
        `but the filer's most recent annual report covers FY${latestFy}. The number is real history, not the company's current figure.` +
        successor;
    }
    key_financials[r.concept] = entry;
  }

  return {
    latest_fiscal_year: latestFy,
    latest_period_end: latestEnd,
    latest_annual,
    key_financials,
    stale_concepts: stale.map((r) => r.concept),
    year_note:
      '`year` is the fiscal year the reporting period ENDS in, derived from period_end. It is NOT the SEC `fy` field, ' +
      'which stamps prior-year comparatives with the year of the filing that restated them.',
  };
}

function stripConcept(v: AnnualValue): Omit<AnnualValue, 'concept'> {
  const { concept: _concept, ...rest } = v;
  return rest;
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
 * - edgar_company_snapshot: CIK + recent filings + headline XBRL figures in ONE call
 *   (the resolve -> filings -> concept chain, collapsed; fleet #2182)
 * - edgar_filing_documents: list the documents inside one filing by accession number
 * - edgar_filing_text: full/paged plaintext of a filing's primary document (by section optional)
 *
 * Note: SEC requires a descriptive User-Agent header per their guidelines.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Edgar');
}


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
      'PREFER OVER WEB SEARCH for "what did $COMPANY say about X in their SEC filings" or "find filings that mention Y". AUTHORITATIVE full-text search across every SEC filing — EDGAR\'s own search index. Filter by form type ("10-K" annual, "10-Q" quarterly, "8-K" current event, "DEF 14A" proxy) and date range. Returns entity name, CIK, form type, filing/period dates, location, accession number (feed straight into edgar_filing_text / edgar_filing_documents — no second lookup), and — for 8-K results — the `items` array of item codes (e.g. "3.01" listing deficiency vs "1.01" material agreement vs "3.02" unregistered sale), which carry the actual signal. Use when you need to find filings matching a topic across the whole market, not for a specific company (for that use edgar_company_filings).',
    summary: 'Full-text search across every SEC filing, using EDGAR\'s own search index.',
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
      'AUTHORITATIVE list of recent SEC filings for a specific US public company. Send the company as `ticker_or_cik` — that argument takes a ticker ("AAPL") or a CIK ("320193"), and `cik` / `ticker` are accepted as aliases for it. Filter by form type — "10-K" (annual report), "10-Q" (quarterly), "8-K" (material event — but for severity-classified 8-Ks specifically, prefer sec_8k_recent), "DEF 14A" (proxy), "S-1" (IPO registration), etc. Returns filing dates, form types, accession numbers, document links. Use for "what did $TICKER recently file" or "show me the last N proxy statements for $TICKER". For specific financial metrics over time use edgar_company_concept; for the full XBRL dump use edgar_company_facts. If you also need the headline financials alongside the filings, edgar_company_snapshot returns both in one call.',
    summary: 'Every SEC filing a US public company has made, newest first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker_or_cik: {
          type: 'string',
          description: 'REQUIRED (or one of its aliases `cik` / `ticker`). Ticker symbol (e.g., "AAPL") or CIK number (e.g., "320193")',
        },
        form_type: {
          type: 'string',
          description: 'Filter by SEC form type (e.g., "10-K", "10-Q", "8-K"). Omit for all types.',
        },
        limit: { type: 'number', description: 'Max filings to return (1-40, default 20)' },
        cik: {
          type: 'string',
          description: 'Alias for `ticker_or_cik` — the spelling edgar_company_concept and edgar_company_facts use for the same thing. Takes a ticker or a CIK.',
        },
        ticker: {
          type: 'string',
          description: 'Alias for `ticker_or_cik` — the spelling edgar_fund_holdings and edgar_ticker_to_cik use for the same thing. Takes a ticker or a CIK.',
        },
      },
      // Deliberately empty, with the check done in the handler instead. A flat
      // `required` list cannot express "ticker_or_cik OR cik OR ticker", so
      // declaring the aliases above and keeping the canonical name required
      // would reject every call that used one — the gateway's pre-flight
      // refuses before the pack ever runs (fleet #2058, swept in #2069).
      required: [],

    },
  },
  {
    name: 'edgar_company_facts',
    description:
      'AUTHORITATIVE full XBRL fundamentals dump for a US public company. Send the company as `cik` — that argument takes a TICKER ("NVDA") or a CIK ("320193"), and `ticker` / `ticker_or_cik` are accepted as aliases for it. Returns every reported financial metric (hundreds of concepts: revenue, net income, assets, liabilities, EPS, cash flow lines, segment breakdowns) with annual and historical values pulled straight from the company\'s SEC filings — the official numbers, not estimates. Use when you need the complete fundamental picture vs. one metric (for one metric use edgar_company_concept). Leads with latest_annual — revenue, net income, assets, cash, EPS for the most recent fiscal year, resolved to whichever XBRL concept the filer currently reports under — and flags retired concepts (e.g. a pre-ASC-606 Revenues tag) as stale so a 2010 figure is never mistaken for current. Large payload; agents typically use this once to discover available concepts then narrow to edgar_company_concept for follow-up queries. For just the headline figures plus the recent filings list, edgar_company_snapshot is the smaller one-call answer.',
    summary: 'Every figure a US public company has reported to the SEC in XBRL, annual and quarterly.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cik: {
          type: 'string',
          description: 'REQUIRED (or one of its aliases `ticker` / `ticker_or_cik`). Ticker ("NVDA") or CIK number ("320193"). Tickers are auto-resolved to CIKs internally.',
        },
        ticker: {
          type: 'string',
          description: 'Alias for `cik` — same thing, a ticker or a CIK. The spelling edgar_fund_holdings and edgar_ticker_to_cik use.',
        },
        ticker_or_cik: {
          type: 'string',
          description: 'Alias for `cik` — the spelling edgar_company_filings, edgar_insider_transactions and edgar_product_revenue use.',
        },
      },
      // Deliberately empty, with the check done in the handler instead. A flat
      // `required` list cannot express "ticker_or_cik OR cik OR ticker", so
      // declaring the aliases above and keeping the canonical name required
      // would reject every call that used one — the gateway's pre-flight
      // refuses before the pack ever runs (fleet #2058, swept in #2069).
      required: [],

    },
  },
  {
    name: 'edgar_company_concept',
    description:
      'AUTHORITATIVE historical financials for any US public company. Source: SEC XBRL filings (the official numbers companies file, not third-party scrapes). Send the company as `cik` — that argument takes a TICKER ("AAPL") or a CIK ("320193"), and `ticker` / `ticker_or_cik` are accepted as aliases for it — plus the metric as `concept` (alias `metric`), which takes a friendly name: Revenue, NetIncomeLoss, Cash, LongTermDebt, EarningsPerShareDiluted. The tool resolves the right XBRL tag for that filer (post-ASC-606 companies use RevenueFromContractWithCustomerExcludingAssessedTax instead of "Revenues", etc.). Returns both ANNUAL (10-K) and QUARTERLY (10-Q) values by default, each labeled with fiscal_period (FY/Q1/Q2/Q3/Q4) and form, newest first, PLUS a `latest` field holding the single freshest data point. Q4 rows are DERIVED (FY minus Q1-Q3, marked derived:true) because SEC filers never report a standalone Q4 fact — so "revenue Q4 2024" questions are answerable directly from `values`. For one specific period, pass `fiscal_year` and/or `fiscal_period` as ARGUMENTS and the values array comes back filtered to it (they are also the names of the fields on each returned row, which is what to match on if you ask for every period instead); do not default to `latest` for a period question. Use `latest` for point-in-time metrics like cash, runway, and debt — it is the newest 10-Q when one is more recent than the last 10-K, so a stale annual figure never masks a newer quarter. Use for "what was AAPL\'s revenue in 2024", "NVDA\'s latest cash position", "show me long-term debt trend", anything where you need the SEC-filed number rather than an estimate.',
    summary: 'One financial metric for a US public company across every period it has reported, from SEC XBRL.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cik: {
          type: 'string',
          description: 'REQUIRED (or one of its aliases `ticker` / `ticker_or_cik`). Ticker (e.g., "AAPL") or CIK number (e.g., "320193"). Tickers are auto-resolved.',
        },
        concept: {
          type: 'string',
          description:
            'REQUIRED (alias `metric`). Metric name. Common: "Revenue" / "Revenues", "NetIncomeLoss", "Cash", "Assets", "Liabilities", "StockholdersEquity", "EarningsPerShareDiluted", "LongTermDebt".',
        },
        period: {
          type: 'string',
          description: 'Which reporting periods to return: "all" (default — annual 10-K + quarterly 10-Q), "annual" (10-K/20-F/40-F only), or "quarterly" (10-Q only). Point-in-time metrics (cash/runway/debt) usually want the default so the freshest quarter is included; use "annual" for clean year-over-year trends.',
          enum: ['all', 'annual', 'quarterly'],
        },
        fiscal_year: {
          type: 'string',
          description: 'Optional filter: return only rows for this fiscal year, e.g. "2024". This is the filer\'s OWN fiscal year label (NVDA\'s FY2024 ended Jan 2024), not a calendar year. Unmatched years are reported with the years that ARE available rather than as an empty result.',
        },
        fiscal_period: {
          type: 'string',
          description: 'Optional filter: return only rows for this period within the fiscal year — "FY" (annual), "Q1", "Q2", "Q3", or "Q4" (derived: FY minus Q1-Q3). Combine with fiscal_year for a single figure.',
          enum: ['FY', 'Q1', 'Q2', 'Q3', 'Q4'],
        },
        ticker: {
          type: 'string',
          description: 'Alias for `cik` — same thing, a ticker or a CIK. Declared because sibling SEC tools name this argument differently (edgar_fund_holdings uses `ticker`, edgar_company_filings uses `ticker_or_cik`) and a caller filling arguments from prose reaches for whichever it read; all three spellings work here.',
        },
        ticker_or_cik: {
          type: 'string',
          description: 'Alias for `cik` — the spelling used by edgar_company_filings, edgar_insider_transactions and edgar_product_revenue.',
        },
        metric: {
          type: 'string',
          description: 'Alias for `concept` — the word this tool\'s own description uses for the thing you are asking about.',
        },
      },
      // Deliberately empty, with the check done in companyConcept() instead —
      // the same pattern edgar_filing_text/edgar_filing_documents already use.
      // A flat `required` list cannot express "cik OR ticker OR ticker_or_cik",
      // so declaring the aliases above and keeping `cik` required would reject
      // every call that used one, which is exactly the production failure this
      // replaces: 12 of 12 `partial` outcomes on this tool over 3 days had the
      // adjudicator fill `ticker` (4 of them `metric` too), and the gateway's
      // pre-flight rejected them with "cik is required" before the pack ran
      // (fleet #2058). The pack-side check below names all accepted spellings.
      required: [],
    },
  },
  {
    name: 'edgar_insider_transactions',
    description:
      'AUTHORITATIVE insider trading activity (SEC Form 3/4/5) for a US public company — who bought or sold, how many shares, at what price, and what they hold now. Send the company as `ticker_or_cik` — a ticker ("TSLA") or a CIK — and `cik` / `ticker` are accepted as aliases for it. Returns each recent Form 4 filing parsed into structured transactions: reporting owner + role (director/officer/10% holder), transaction code (P=open-market purchase, S=sale, A=grant/award, M=option exercise, G=gift, F=tax-withholding), shares, price per share, acquired/disposed, and shares owned after. Use for "insider buying at $TICKER", "did executives sell recently", "latest Form 4 activity". Open-market purchases (code P) are the strongest conviction signal; awards (code A) are routine comp. For the raw filing list use edgar_company_filings with form_type:"4".',
    summary: 'Who bought or sold a company\'s stock as an insider, from SEC Forms 3, 4 and 5.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker_or_cik: {
          type: 'string',
          description: 'REQUIRED (or one of its aliases `cik` / `ticker`). Ticker symbol (e.g., "TSLA") or CIK number (e.g., "1318605")',
        },
        limit: { type: 'number', description: 'Max Form 4/3/5 filings to parse (1-25, default 10)' },
        include_derivatives: {
          type: 'boolean',
          description: 'Also include derivative (options/RSU) transactions. Default false (non-derivative common-stock only).',
        },
        cik: {
          type: 'string',
          description: 'Alias for `ticker_or_cik` — the spelling edgar_company_concept and edgar_company_facts use for the same thing. Takes a ticker or a CIK.',
        },
        ticker: {
          type: 'string',
          description: 'Alias for `ticker_or_cik` — the spelling edgar_fund_holdings and edgar_ticker_to_cik use for the same thing. Takes a ticker or a CIK.',
        },
      },
      // Deliberately empty, with the check done in the handler instead. A flat
      // `required` list cannot express "ticker_or_cik OR cik OR ticker", so
      // declaring the aliases above and keeping the canonical name required
      // would reject every call that used one — the gateway's pre-flight
      // refuses before the pack ever runs (fleet #2058, swept in #2069).
      required: [],

    },
  },
  {
    name: 'edgar_institutional_holdings',
    description:
      "AUTHORITATIVE stock portfolio of a large institutional investor (SEC Form 13F-HR) — what a fund/manager owns, share counts, and position values. Pass the MANAGER's ticker or CIK (e.g. \"BRK-B\" or CIK \"1067983\" for Berkshire Hathaway; \"1350694\" for Bridgewater). Returns the latest quarterly 13F: top holdings aggregated by issuer with value (USD), shares, and % of portfolio, plus the report period. Use for \"what does Berkshire own\", \"Bridgewater's biggest positions\", \"which funds hold $TICKER\" (run per manager). Note: 13F covers US-listed long equity + options held by managers with >$100M AUM, filed ~45 days after quarter-end; it excludes shorts, cash, and non-US holdings. Values are whole USD for filings since 2023; older ones are in thousands. IMPORTANT: rows carry a `put_call` field and a plain-English `direction`. A `put` row is a BEARISH bet AGAINST that issuer — never report it as a holding the manager owns — and for option rows the value is the underlying's notional, not premium or capital at risk. Rank real holdings by `pct_of_long_equity`, and read `position_summary` + `interpretation_note` before summarising.",
    summary: 'What a large institutional investor holds, from its SEC Form 13F filing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker_or_cik: {
          type: 'string',
          description: 'REQUIRED (or one of its aliases `cik` / `ticker`). The institutional manager\'s ticker (e.g. "BRK-B") or CIK (e.g. "1067983"). NOT the held stock — the fund/manager doing the filing.',
        },
        limit: { type: 'number', description: 'Top N holdings by value to return (1-100, default 25)' },
        cik: {
          type: 'string',
          description: 'Alias for `ticker_or_cik` — the spelling edgar_company_concept and edgar_company_facts use for the same thing. Takes a ticker or a CIK.',
        },
        ticker: {
          type: 'string',
          description: 'Alias for `ticker_or_cik` — the spelling edgar_fund_holdings and edgar_ticker_to_cik use for the same thing. Takes a ticker or a CIK.',
        },
      },
      // Deliberately empty, with the check done in the handler instead. A flat
      // `required` list cannot express "ticker_or_cik OR cik OR ticker", so
      // declaring the aliases above and keeping the canonical name required
      // would reject every call that used one — the gateway's pre-flight
      // refuses before the pack ever runs (fleet #2058, swept in #2069).
      required: [],

    },
  },
  {
    name: 'edgar_fund_holdings',
    description:
      "AUTHORITATIVE portfolio holdings of a US ETF or mutual fund (SEC Form N-PORT) — what the fund actually owns. Pass the FUND's ticker (e.g. \"ARKK\", \"QQQ\", \"VTI\", \"VOO\", \"IVV\"). Returns the latest monthly portfolio: net assets, holdings count, and top positions by weight — each with name, CUSIP, value (USD), and % of fund. Use for \"what does ARKK hold\", \"top holdings of QQQ\", \"is $STOCK in VTI\". Distinct from edgar_institutional_holdings (13F = what an investment MANAGER like Berkshire owns); this is a registered fund's own N-PORT. Covers US-registered open-end funds + ETFs; data is ~30-60 days delayed. Note: a few legacy ETFs structured as unit investment trusts (e.g. SPY, DIA) don't file N-PORT and won't resolve — use IVV or VOO for S&P 500 exposure.",
    summary: 'What a US ETF or mutual fund owns, from its monthly SEC Form N-PORT filing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker: { type: 'string', description: 'REQUIRED (or its alias `ticker_or_cik`). ETF or mutual-fund ticker (e.g. "ARKK", "SPY", "QQQ"). Fund tickers, not company stock tickers.' },
        limit: { type: 'number', description: 'Top N holdings by weight to return (1-100, default 25)' },
        ticker_or_cik: {
          type: 'string',
          description: 'Alias for `ticker` — the spelling sibling SEC tools (edgar_company_filings, edgar_insider_transactions) use. Must still be a FUND ticker: N-PORT funds are keyed by ticker, so a bare CIK will not resolve here.',
        },
      },
      // Deliberately empty, with the check done in fundHoldings() instead —
      // a flat `required` list cannot express "ticker OR ticker_or_cik", so
      // keeping `ticker` required would reject every aliased call at the
      // gateway's pre-flight before the pack ran (fleet #2069).
      required: [],
    },
  },
  {
    name: 'edgar_company_snapshot',
    description:
      'ONE CALL for "give me the SEC picture on $TICKER" / "what has $COMPANY filed recently and what are its numbers" / "pull the filings and financials for X". Resolves a ticker, company name or CIK and returns, from SEC EDGAR, the three things callers otherwise chain by hand across edgar_ticker_to_cik -> edgar_company_filings -> edgar_company_concept: the identity (cik, company_name, tickers, SIC code, fiscal year end), the recent filings list (accession numbers, form types, filing dates, document links — by default the substantive forms 10-K/10-Q/8-K/20-F/40-F/6-K/DEF 14A, so insider Form 4 noise is excluded; pass `form_type` for one form or "all"), and the headline XBRL figures from the latest annual report (revenue, net income, operating income, gross profit, assets, liabilities, equity, cash, EPS, shares, R&D — each resolved to the concept the filer CURRENTLY reports under, with retired concepts listed separately as stale). Send the company as `ticker_or_cik`; `cik` / `ticker` are accepted aliases. A filer with no XBRL facts (a fund, a trust, a foreign private issuer on paper forms) still returns its filings, with `financials_status: "unavailable"` and a reason, not an error. Drill down from here: edgar_filing_text for a filing\'s text, edgar_company_concept for one metric\'s multi-year history, edgar_company_facts for every concept. For a cross-source view (patents, contracts, hiring, news) use entity_profile instead.',
    summary: 'A US public company\'s SEC identity, recent filings and headline financials in one call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker_or_cik: {
          type: 'string',
          description: 'REQUIRED (or one of its aliases `cik` / `ticker`). Ticker ("AAPL"), company name ("Apple Inc") or CIK ("320193"). Tickers and names are resolved to a CIK internally.',
        },
        cik: {
          type: 'string',
          description: 'Alias for `ticker_or_cik` — same thing. The spelling edgar_company_facts and edgar_company_concept use.',
        },
        ticker: {
          type: 'string',
          description: 'Alias for `ticker_or_cik` — same thing. The spelling edgar_ticker_to_cik uses.',
        },
        form_type: {
          type: 'string',
          description: 'Which filings to list. Omit for the substantive default set (10-K, 10-K/A, 10-Q, 10-Q/A, 8-K, 20-F, 40-F, 6-K, DEF 14A). Pass one form ("10-K") to list only that form, or "all" for every form including Form 4 insider filings.',
        },
        filings_limit: {
          type: 'number',
          description: 'How many filings to return after the form filter (1-40, default 10).',
        },
      },
      // Deliberately empty — a flat `required` list cannot express
      // "ticker_or_cik OR cik OR ticker"; the handler refuses with a message
      // that names all three (fleet #2058 / #2069).
      required: [],
    },
  },
  {
    name: 'edgar_ticker_to_cik',
    description:
      'Resolve a US stock ticker (e.g. "TSLA") OR a company name (e.g. "Tesla", "Apple Inc") to the SEC\'s 10-digit CIK identifier — required by every other SEC tool. Call THIS FIRST when you have a ticker/name and need to use edgar_company_concept, edgar_company_filings, edgar_company_facts, sec_8k_recent, or any other SEC-keyed tool. Returns {cik, cik_padded, company_name, ticker, matched_by}; when matched by name it also returns `alternatives` for disambiguation. Cheap, no rate limit concerns. Most other tools also accept tickers/names directly and call this internally — only use it explicitly when you want the CIK as data. The response carries a `next` hint: the usual NEXT step after resolving is edgar_company_snapshot({ticker_or_cik}), which returns the recent filings list AND the headline XBRL financials in one call — do not chain edgar_company_filings then edgar_company_concept by hand to get that.',
    summary: 'The SEC CIK number for a stock ticker or company name, from EDGAR\'s company list.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker: {
          type: 'string',
          description: 'REQUIRED (or one of its aliases `ticker_or_cik` / `company`). Stock ticker symbol (e.g., "AAPL", "MSFT", "TSLA") or company name (e.g., "Apple", "Microsoft")',
        },
        ticker_or_cik: {
          type: 'string',
          description: 'Alias for `ticker` — the spelling edgar_company_filings and edgar_insider_transactions use. A ticker or company name; this tool RESOLVES to a CIK, so passing a bare CIK has nothing to look up.',
        },
        company: {
          type: 'string',
          description: 'Alias for `ticker` — use it when what you have is a company NAME ("Apple Inc.") rather than a symbol. Same argument, same behaviour.',
        },
      },
      // Deliberately empty, with the check done in tickerToCik() instead —
      // a flat `required` list cannot express "ticker OR ticker_or_cik OR
      // company" (fleet #2069).
      required: [],
    },
  },
  {
    name: 'sponsor_to_filer',
    description:
      'Resolve an organization NAME — especially a clinical-trial sponsor, drug developer, or operating subsidiary — to the US-listed public FILER that reports it (ticker + SEC CIK). Built for the join that plain ticker/name lookup fails: trial registries (ClinicalTrials.gov) name operating subsidiaries ("Merck Sharp and Dohme"), while SEC names the listed parent ("Merck & Co", MRK). This tool bridges that gap and, crucially, tells you WHY a name does not resolve instead of collapsing every miss to "not found". Returns a `status`: "resolved" (name is itself a US-listed filer), "resolved_via_parent" (name is a subsidiary; resolved to its listed parent, with evidence + confidence), "us_registrant_unlisted" (has an SEC CIK but no public listing and no listed parent — typically a private company that filed a Form D or draft registration), or "no_us_registrant" (no US SEC presence at all — typically a non-US-listed or foreign private company). Use before joining trial sponsors to public financials, ownership, or filings.',
    summary: 'The SEC filer entities linked to a plan sponsor, from EDGAR Form 5500 filings.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sponsor: {
          type: 'string',
          description: 'Organization name to resolve — a trial sponsor, drug developer, or company name, e.g. "Merck Sharp and Dohme", "Lexeo Therapeutics", "Dizal Pharmaceuticals".',
        },
      },
      required: ['sponsor'],
    },
  },
  {
    name: 'filer_to_sponsors',
    description:
      'The REVERSE of sponsor_to_filer: given a US-listed public FILER (parent company), list its operating subsidiaries as disclosed in Exhibit 21 of its most recent 10-K (Item 601(b)(21) — "significant subsidiaries"). Built for the same trial-sponsor/entity-resolution join, run the other direction: instead of ~10 calls guessing candidate subsidiary names and confirming each via sponsor_to_filer, get the parent\'s full disclosed subsidiary list (with jurisdiction of incorporation) in one call, straight from SEC — e.g. Merck (MRK/CIK 310158) -> "Merck Sharp & Dohme LLC" among hundreds of others. Pass `name_filter` (case-insensitive substring) to check whether a specific candidate name is among the subsidiaries without reading the whole list. Every result carries provenance (accession number, filing date, exhibit URL) so the join is auditable. Smaller filers or ones with no significant subsidiaries can genuinely have no Exhibit 21 — status distinguishes that from a lookup failure. Foreign private issuers (20-F filers) are not yet covered.',
    summary: 'The plan sponsors linked to an SEC filer entity, from EDGAR Form 5500 filings.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker_or_cik: {
          type: 'string',
          description: 'REQUIRED (or one of its aliases `cik` / `ticker`). The PARENT company\'s ticker (e.g. "MRK") or CIK (e.g. "310158"). Tickers are auto-resolved to CIKs.',
        },
        name_filter: {
          type: 'string',
          description: 'Optional case-insensitive substring to filter subsidiary names by, e.g. "Sharp & Dohme" to check whether that entity is among the parent\'s disclosed subsidiaries. Subsidiary names in Exhibit 21 use "&", not "and".',
        },
        limit: { type: 'number', description: 'Max subsidiaries to return (1-500, default 200). Large parents can disclose 500+.' },
        cik: {
          type: 'string',
          description: 'Alias for `ticker_or_cik` — the spelling edgar_company_concept and edgar_company_facts use for the same thing. Takes a ticker or a CIK.',
        },
        ticker: {
          type: 'string',
          description: 'Alias for `ticker_or_cik` — the spelling edgar_fund_holdings and edgar_ticker_to_cik use for the same thing. Takes a ticker or a CIK.',
        },
      },
      // Deliberately empty, with the check done in the handler instead. A flat
      // `required` list cannot express "ticker_or_cik OR cik OR ticker", so
      // declaring the aliases above and keeping the canonical name required
      // would reject every call that used one — the gateway's pre-flight
      // refuses before the pack ever runs (fleet #2058, swept in #2069).
      required: [],

    },
  },
  {
    name: 'edgar_xbrl_frames',
    description:
      'Compare ONE financial metric across ALL public companies for a single period (SEC XBRL "frames"). PREFER OVER WEB SEARCH for "which companies had the most revenue/net income/assets in <year>", "rank companies by <metric>", cross-company financial comparison. concept is a US-GAAP tag (e.g. "Revenues", "NetIncomeLoss", "Assets", "ResearchAndDevelopmentExpense", "CashAndCashEquivalentsAtCarryingValue"). period is a calendar frame: "CY2023" (annual), "CY2023Q1" (quarter), or "CY2023Q1I" (instant/balance-sheet, period-end). Returns companies + values, sorted descending by default. Differs from edgar_company_concept (one company over time) — this is one period across every filer.',
    summary: 'One XBRL financial concept\'s reported value across every US public company for one period, from EDGAR.',
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
    name: 'edgar_companies_by_sic',
    description:
      'AUTHORITATIVE peer / competitor lookup: find every SEC filer classified under one SIC (Standard Industrial Classification) industry code. PREFER OVER WEB SEARCH for "who are $COMPANY\'s public competitors/peers", "list companies in <industry>", "which filers are in SIC <code>". Pass EITHER `sic` directly (a 2-4 digit code, e.g. "3571" = Electronic Computers) OR `ticker_or_cik` for a company whose own SIC should be looked up first and then used to find its peers (self excluded by default). Returns each peer\'s CIK, and ticker + company_name when the filer has a listed ticker — results are sorted so currently-listed peers come first, since an SIC bucket covers every filer that EVER filed the form (many delisted/defunct); unlisted registrants still appear after them with ticker:null rather than being dropped. Source: SEC EDGAR company-search (browse-edgar), filtered to filers who have filed the given form_type (default "10-K", i.e. active public reporters — omitting this filter is unreliable upstream). Note: SIC is a broad, sometimes dated bucket assigned once at registration — treat this as a peer-set STARTING POINT, not a precise competitor list.',
    summary: 'Every SEC filer classified under one industry code — a company\'s public peers.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sic: { type: 'string', description: 'SIC code to search directly, e.g. "3571" (Electronic Computers), "2836" (Biological Products), "6021" (National Commercial Banks). Provide this OR ticker_or_cik.' },
        ticker_or_cik: { type: 'string', description: 'Ticker (e.g. "AAPL") or CIK of a company whose SIC should be resolved first, then used to find its peers. Provide this OR sic. Aliases: `cik`, `ticker`.' },
        cik: { type: 'string', description: 'Alias for `ticker_or_cik` — takes a ticker or a CIK. Declared because sibling SEC tools spell this argument differently.' },
        ticker: { type: 'string', description: 'Alias for `ticker_or_cik` — takes a ticker or a CIK. Declared because sibling SEC tools spell this argument differently.' },
        form_type: { type: 'string', description: 'Only include filers who have filed this form type (default "10-K" — active public reporters). SEC\'s upstream search is unreliable with this left blank.' },
        exclude_self: { type: 'boolean', description: 'When resolving via ticker_or_cik, exclude that company itself from the peer list. Default true.' },
        limit: { type: 'number', description: 'Max peers to return (1-100, default 25).' },
      },
    },
  },
  {
    name: 'edgar_product_revenue',
    description:
      'PRODUCT-LEVEL or segment-level revenue as STRUCTURED data — e.g. "how much revenue did Keytruda generate", "AAPL revenue by product line". Regular XBRL tools (edgar_company_concept, edgar_company_facts) only expose UNDIMENSIONED totals; a filer\'s product/segment breakdown is tagged with an XBRL dimension (e.g. a "Keytruda [Member]"), which those APIs cannot see no matter which concept is requested. This tool reads SEC\'s own standardized "Financial Report" rendering of that dimensional data straight out of the annual or quarterly segment-reporting / revenue-disaggregation note — 10-K and 10-Q for US filers, 20-F for foreign private issuers (Novartis, AstraZeneca, GSK, Sanofi, Novo Nordisk, Takeda) and 40-F for Canadian MJDS filers, resolved automatically and reported back as `resolved_form` — the same note human analysts read, but pre-parsed into rows. Pass `product_filter` (case-insensitive substring, matched against the dimension breadcrumb, e.g. "Keytruda") to get just one product/segment instead of the whole table. Every result carries a citation (accession, filing date, exact report + URL it came from). Not every filer discloses product-level revenue in XBRL, and a small fraction use a non-standard table layout this parser can\'t read — both are reported as an explicit status rather than a silent empty array, with a fallback to edgar_filing_text for the prose note.',
    summary: 'A US public company\'s revenue broken out by product or segment, from its EDGAR XBRL filings.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticker_or_cik: { type: 'string', description: 'REQUIRED (or one of its aliases `cik` / `ticker`). Ticker (e.g. "MRK") or CIK (e.g. "310158"). Tickers are auto-resolved.' },
        product_filter: { type: 'string', description: 'Optional case-insensitive substring to match against the product/segment dimension, e.g. "Keytruda". Omit to get every disaggregated row in the table.' },
        form_type: { type: 'string', description: 'Filing type to read the note from. Omit it to try 10-K, then 20-F, then 40-F automatically — foreign private issuers (NVS, AZN, GSK, SNY, NVO, TAK) file 20-F and Canadian MJDS filers file 40-F. "10-Q" also works for filers that disaggregate revenue quarterly. The form actually used comes back as `resolved_form`.' },
        accession: { type: 'string', description: 'Optional exact accession number (from edgar_company_filings) to read a specific past filing instead of the latest matching form_type.' },
        limit: { type: 'number', description: 'Max rows to return (1-200, default 100).' },
        cik: {
          type: 'string',
          description: 'Alias for `ticker_or_cik` — the spelling edgar_company_concept and edgar_company_facts use for the same thing. Takes a ticker or a CIK.',
        },
        ticker: {
          type: 'string',
          description: 'Alias for `ticker_or_cik` — the spelling edgar_fund_holdings and edgar_ticker_to_cik use for the same thing. Takes a ticker or a CIK.',
        },
      },
      // Deliberately empty, with the check done in the handler instead. A flat
      // `required` list cannot express "ticker_or_cik OR cik OR ticker", so
      // declaring the aliases above and keeping the canonical name required
      // would reject every call that used one — the gateway's pre-flight
      // refuses before the pack ever runs (fleet #2058, swept in #2069).
      required: [],

    },
  },
  {
    name: 'edgar_filing_documents',
    description:
      'AUTHORITATIVE list of the SEC filing documents inside ONE specific filing, by accession number. Retrieve a filing / its contents / attachments: pass the accession (e.g. "0000320193-25-000079", with or without dashes) plus the filer\'s ticker ("AAPL") or CIK ("320193"). Returns every document in the filing folder — the primary document (10-K / 10-Q / 8-K body), all exhibits, and XBRL files — each with name, type, size, and a direct https URL, plus the filing\'s form type, filing date, and human -index.html page. Set include_primary_text:true to also pull the primary document\'s text (HTML stripped to plaintext, ~40k chars). Use to list a 10-K / 10-Q / 8-K\'s exhibits, retrieve filing contents/attachments, or fetch the text of a filing. You can pass an exact accession, OR just a ticker + form_type to auto-resolve the latest matching filing (no accession lookup needed). Examples: edgar_filing_documents({ticker: "NVDA", form_type: "10-K"}) for the documents in NVIDIA\'s latest annual report; edgar_filing_documents({accession: "0000320193-25-000079", ticker: "AAPL", include_primary_text: true}) for a specific filing\'s text.',
    summary: 'The documents and attachments inside one SEC filing, by accession number.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        accession: {
          type: 'string',
          description: 'Optional SEC accession number of a specific filing, with or without dashes (e.g. "0000320193-25-000079"). Omit it to auto-resolve the latest filing — pass form_type instead.',
        },
        ticker: {
          type: 'string',
          description: 'The filer\'s ticker (e.g. "AAPL", "NVDA") or company name. Provide this OR cik. Tickers are auto-resolved to CIKs.',
        },
        cik: {
          type: 'string',
          description: 'The filer\'s CIK number (e.g. "320193"). Provide this OR ticker.',
        },
        form_type: {
          type: 'string',
          description: 'When accession is omitted, the form type of the latest filing to fetch, e.g. "10-K", "10-Q", "8-K", "DEF 14A". Omit both accession and form_type to get the single most recent filing of any type.',
        },
        include_primary_text: {
          type: 'boolean',
          description: 'When true, also fetch the primary document and return its text (HTML stripped to plaintext, truncated to ~40,000 chars). Default false. For the FULL, pageable document text — or just one section like going-concern/liquidity — use edgar_filing_text instead.',
        },
        ticker_or_cik: {
          type: 'string',
          description: 'Alias for `ticker` / `cik` — the single-argument spelling edgar_company_filings and edgar_insider_transactions use. Takes either a ticker or a CIK.',
        },
      },
      required: [],
    },
  },
  {
    name: 'edgar_filing_text',
    description:
      'AUTHORITATIVE full text of a SEC filing\'s primary document (10-K / 10-Q / 8-K body), HTML stripped to clean plaintext — the source for disclosures that live in prose, not XBRL: going-concern language, ATM / at-the-market equity facilities, committed-equity share caps, public-float figures, subsequent events, and the liquidity footnote. Pass an accession (from edgar_search_filings / edgar_company_filings) plus the filer\'s ticker or CIK; OR omit accession and pass ticker + form_type to auto-resolve the latest matching filing. Optionally set `section` to return just one part (going_concern | liquidity | capital_resources | subsequent_events). Large docs (a 10-Q is ~100k+ chars of text) are PAGED, not spilled: the result caps at `max_chars` (default 50000) from `offset`, and returns `truncated` + `next_offset` — pass next_offset back as `offset` to read the next window. An especially large filing (e.g. an S-1 with heavy inline-XBRL tagging can exceed 10MB of raw HTML) is also capped on the READ side — the response sets `raw_truncated:true` when only the first portion of the document was read at all, which bounds how far `offset` can page and can make a late `section` (e.g. subsequent_events) come back not-found even though it exists further in. Use for "does $TICKER disclose substantial doubt / going concern", "what ATM facility does $TICKER have", "read the liquidity section of the latest 10-Q". For the list of documents/exhibits in a filing use edgar_filing_documents; for structured financial numbers use edgar_company_concept.',
    summary: 'The full text of an SEC filing\'s main document, HTML stripped to clean plaintext.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        accession: {
          type: 'string',
          description: 'SEC accession number, dashed or not (e.g. "0001683168-26-003909"). Omit to auto-resolve the latest filing of form_type for the given ticker/cik.',
        },
        ticker: {
          type: 'string',
          description: 'Filer ticker (e.g. "ACTU"). Provide this OR cik. ONLY pass a ticker you are CERTAIN of — a wrong remembered ticker silently retrieves a DIFFERENT company\'s filing as a clean success (a "SpaceX" question filled with SPCE returns Virgin Galactic\'s S-1). For a recent IPO or any uncertain ticker, resolve first: edgar_company_filings accepts the company NAME and returns the cik — pass that cik here.',
        },
        cik: {
          type: 'string',
          description: 'Filer CIK number (e.g. "1652935"). Provide this OR ticker.',
        },
        form_type: {
          type: 'string',
          description: 'When accession is omitted, the form type of the latest filing to fetch — "10-K", "10-Q", "8-K", "DEF 14A", etc.',
        },
        section: {
          type: 'string',
          enum: ['going_concern', 'liquidity', 'capital_resources', 'subsequent_events'],
          description: 'Return only this section (located by heading). Omit for the whole document. Unmatched sections fall back to the whole document (section_found:false).',
        },
        max_chars: {
          type: 'number',
          description: 'Max characters to return in this page (1000–100000, default 50000). Doc text past this is available via next_offset.',
        },
        offset: {
          type: 'number',
          description: 'Character offset to start from (default 0). Pass the prior result\'s next_offset to page forward.',
        },
        ticker_or_cik: {
          type: 'string',
          description: 'Alias for `ticker` / `cik` — the single-argument spelling edgar_company_filings and edgar_insider_transactions use. Takes either a ticker or a CIK.',
        },
      },
      required: [],
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

  const res = await pwFetch(`${EFTS_BASE}/search-index?${params}`, { headers: SEC_HEADERS });
  if (!res.ok) throw await httpError(res, 'SEC EDGAR search error');

  const data = (await res.json()) as {
    hits: {
      hits: {
        _source: {
          ciks?: string[];
          display_names?: string[];
          form?: string;
          file_type?: string;
          root_forms?: string[];
          file_date?: string;
          period_ending?: string;
          biz_locations?: string[];
          biz_states?: string[];
          adsh?: string;
          items?: string[];
          file_description?: string;
        };
        _id: string;
      }[];
      total: { value: number };
    };
  };

  // EFTS `_source` field names (verified against efts.sec.gov): display_names
  // ["Name (TICKER) (CIK 000...)"], ciks[], form, period_ending, biz_locations[],
  // adsh (accession), and — for 8-Ks — items[] (e.g. "3.01"). The prior mapper
  // read entity_name/form_type/biz_location, which do NOT exist in this payload,
  // so every field but the date/id serialized as undefined and dropped.
  const results = (data.hits?.hits ?? []).map((hit) => {
    const s = hit._source;
    const display = s.display_names?.[0] ?? '';
    // display_names is "NAME  (TICKER)  (CIK 000...)" (double-space before each
    // paren group; TICKER paren is absent for non-tickered filers). Take the name
    // before the first double-space-paren so both shapes strip cleanly.
    const entityName = display.split(/\s{2,}\(/)[0].trim() || display;
    const cik = s.ciks?.[0] ? String(parseInt(s.ciks[0], 10)) : undefined;
    return {
      entity_name: entityName || undefined,
      cik,
      form_type: s.form ?? s.file_type ?? s.root_forms?.[0],
      // 8-K item codes — the signal (3.01 delisting vs 1.01 agreement). Empty for non-8-Ks.
      items: s.items && s.items.length ? s.items : undefined,
      filing_date: s.file_date,
      period_of_report: s.period_ending,
      location: s.biz_locations?.[0] ?? s.biz_states?.[0],
      // Accession — feed straight into edgar_filing_documents/edgar_filing_text, no second lookup.
      accession: s.adsh,
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
  if (typeof ticker !== 'string' || !ticker.trim()) {
    throw new Error(
      'A company is required: pass `ticker`, or its aliases `ticker_or_cik` / `company` — ' +
      'all three take a stock ticker ("AAPL") or a company name ("Apple Inc."). ' +
      'Example: edgar_ticker_to_cik({ticker: "AAPL"}).'
    );
  }
  let entity: Awaited<ReturnType<typeof resolveSecEntity>> | FilerNameMatch;
  try {
    entity = await resolveSecEntity(ticker, { headers: SEC_HEADERS });
  } catch (err) {
    if (!/No SEC company matches/.test(String((err as Error)?.message))) throw err;
    entity = await resolveAnyFilerByName(ticker, err as Error);
  }
  // Measured (docs/edgar-cohort-retention-2026-09-17.md, fleet #2182): 66% of
  // one-shot EDGAR callers call this tool and nothing else — they resolved a
  // ticker and had no signal about what to do next — while 90%+ of depth
  // callers go on to chain edgar_company_filings + edgar_company_concept by
  // hand. Name the one-call path in the response, where a direct-tool caller
  // actually sees it (a meta-tool's description is invisible to them).
  return {
    ...entity,
    next: {
      tool: 'edgar_company_snapshot',
      args: { ticker_or_cik: entity.cik },
      why: 'Returns the recent filings list AND the headline XBRL financials for this CIK in one call — the usual next step, instead of chaining edgar_company_filings then edgar_company_concept.',
    },
  };
}

// --- delisted / non-listed filers by name (fleet #2305) ---------------------
// company_tickers.json lists only CURRENTLY-listed companies, so a bankrupt or
// delisted filer — exactly the ones people research — resolved to "No SEC
// company matches" by name even though EDGAR holds all its filings under a
// CIK (Amyris, CIK 1365916, tickers: []). EDGAR's own entity typeahead
// (efts search-index, the box on efts full-text search) covers every filer.
// Accept a hit only when its distinctive name tokens EQUAL the query's: a
// looser match would hand back a different entity ("WNA Private Equity Fund
// B-Amyris LLC" for "Amyris") as a clean success.

interface FilerNameMatch {
  ticker: null;
  cik: string;
  cik_padded: string;
  company_name: string;
  matched_by: 'edgar_entity_search';
  note: string;
  alternatives?: { company_name: string; cik: string }[];
}

async function resolveAnyFilerByName(name: string, original: Error): Promise<FilerNameMatch> {
  const q = name.trim();
  const url = `https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(q)}`;
  const res = await pwFetch(url, { headers: SEC_HEADERS }).catch(() => null);
  if (!res || !res.ok) throw original;
  const data = (await res.json().catch(() => null)) as
    | { hits?: { hits?: { _id: string; _source?: { entity?: string; rank?: number } }[] } }
    | null;
  const hits = (data?.hits?.hits ?? [])
    .filter((h) => /^\d+$/.test(h._id) && h._source?.entity)
    .map((h) => ({ cik: String(Number(h._id)), company_name: h._source!.entity!, rank: h._source!.rank ?? 0 }));
  const key = (s: string) => [...new Set(significantTokens(s))].sort().join(' ');
  const want = key(q);
  const exact = want ? hits.filter((h) => key(h.company_name) === want).sort((a, b) => b.rank - a.rank) : [];
  if (!exact.length) {
    const seen = hits.slice(0, 5).map((h) => `${h.company_name} (CIK ${h.cik})`).join('; ');
    throw new Error(
      `${original.message}${seen ? ` EDGAR's all-filer name index (which includes delisted and unlisted filers) has no exact match either; nearest: ${seen}. Pass one of those CIKs as ticker_or_cik.` : ''} ` +
      'A delisted company\'s OLD ticker cannot be resolved (SEC keeps no ticker history) — pass the company name or CIK instead.'
    );
  }
  const best = exact[0];
  const alts = exact.slice(1, 4).map((h) => ({ company_name: h.company_name, cik: h.cik }));
  return {
    ticker: null,
    cik: best.cik,
    cik_padded: best.cik.padStart(10, '0'),
    company_name: best.company_name,
    matched_by: 'edgar_entity_search',
    note: 'Not a currently-listed company (no ticker on SEC\'s current list) — likely delisted, acquired, bankrupt or never listed. Resolved by name from EDGAR\'s all-filer index; its full filing history is still available under this CIK.',
    ...(alts.length ? { alternatives: alts } : {}),
  };
}

// --- sponsor_to_filer -------------------------------------------------------
// Resolve a sponsor/subsidiary NAME to the US-listed filer that reports it.
// The hard case: trial registries name operating subsidiaries ("Merck Sharp
// and Dohme"); SEC names the listed parent ("Merck & Co", MRK). We also refuse
// to collapse every miss to "not found" — the status distinguishes listed /
// subsidiary-of-listed / SEC-registered-but-unlisted / no-US-registrant.

interface SecTickerRow { cik_str: number; ticker: string; title: string }

// Generic corporate/industry words that don't distinguish one biotech from
// another — excluded when picking a sponsor's "distinctive" token.
const GENERIC_NAME_TOKENS = new Set([
  'THE', 'A', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED',
  'LLC', 'LP', 'PLC', 'SA', 'AG', 'NV', 'GMBH', 'AB', 'AS', 'OY', 'SPA',
  'PHARMACEUTICALS', 'PHARMACEUTICAL', 'PHARMA', 'THERAPEUTICS', 'THERAPEUTIC',
  'BIOSCIENCES', 'BIOSCIENCE', 'BIO', 'BIOPHARMA', 'BIOPHARMACEUTICALS',
  'BIOTECH', 'BIOTECHNOLOGY', 'MEDICAL', 'MEDICINE', 'MEDICINES', 'SCIENCES',
  'SCIENCE', 'HEALTH', 'HEALTHCARE', 'GROUP', 'HOLDINGS', 'HOLDING',
  'LABORATORIES', 'LABS', 'AND', 'OF', 'US', 'USA', 'INTERNATIONAL', 'GLOBAL',
]);

const normName = (s: string): string =>
  s.toUpperCase().replace(/[.,&/()-]/g, ' ').replace(/\s+/g, ' ').trim();

function significantTokens(name: string): string[] {
  return normName(name).split(' ').filter((t) => t.length > 1 && !GENERIC_NAME_TOKENS.has(t));
}

function distinctiveToken(name: string): string {
  return significantTokens(name)[0] ?? normName(name).split(' ')[0] ?? '';
}

// SEC company names use "&", not "and". Produce query variants: &-normalized
// full name first, then progressively drop trailing generic words (browse-edgar
// matches on a name prefix and a too-specific full name can return nothing).
function secQueryVariants(name: string): string[] {
  const amp = name.replace(/\band\b/gi, '&').replace(/\s+/g, ' ').trim();
  const out = [amp];
  const words = amp.split(' ');
  for (let end = words.length; end > 1; end--) {
    const last = words[end - 1].toUpperCase().replace(/[.,&]/g, '');
    if (GENERIC_NAME_TOKENS.has(last)) out.push(words.slice(0, end - 1).join(' '));
    else break;
  }
  return [...new Set(out.filter(Boolean))];
}

async function fetchCompanyTickers(): Promise<SecTickerRow[]> {
  const res = await pwFetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS });
  if (!res.ok) throw await httpError(res, 'SEC ticker lookup error');
  const data = (await res.json()) as Record<string, SecTickerRow>;
  return Object.values(data);
}

/** Does the sponsor name have its OWN SEC filer CIK (registered entity — a
 * subsidiary, or a private co that filed a Form D / draft S-1)? browse-edgar
 * orders by relevance so the leading <cik> tags are the closest matches; each
 * candidate is validated against its real name from the submissions API
 * (which doubles as the entity profile). Returns {cik, profile} or null. */
async function edgarOwnCik(sponsor: string): Promise<{ cik: string; profile: EntityProfile } | null> {
  const sig = significantTokens(sponsor);
  const need = Math.min(2, sig.length || 1);
  for (const q of secQueryVariants(sponsor)) {
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?company=${encodeURIComponent(q)}&action=getcompany&type=&dateb=&owner=include&count=10&output=atom`;
    const res = await pwFetch(url, { headers: { 'User-Agent': SEC_HEADERS['User-Agent'] } }).catch(() => null);
    if (!res || !res.ok) continue;
    const xml = await res.text();
    const ciks = [...xml.matchAll(/<cik>(\d+)<\/cik>/gi)].map((m) => String(Number(m[1])));
    for (const cik of [...new Set(ciks)].slice(0, 3)) {
      const profile = await edgarEntityProfile(cik);
      if (!profile?.name) continue;
      const nameToks = new Set(significantTokens(profile.name));
      const overlap = sig.filter((t) => nameToks.has(t)).length;
      if (overlap >= need) return { cik, profile };
    }
    if (ciks.length) break; // first variant that returned candidates is authoritative
  }
  return null;
}

interface ListedFiler { name: string; ticker: string; cik: string; hits: number }

/** EDGAR full-text: LISTED filers (display_name carries a ticker) whose 10-Ks
 * mention the sponsor, ranked by mention count. */
async function fullTextListedFilers(sponsor: string): Promise<{ candidates: ListedFiler[]; total: number }> {
  // SEC filings write "&", not "and" — normalize so "Merck Sharp and Dohme"
  // matches the same volume as "Merck Sharp & Dohme".
  const phrase = sponsor.replace(/\band\b/gi, '&').replace(/\s+/g, ' ').trim();
  const params = new URLSearchParams({ q: `"${phrase}"`, forms: '10-K', from: '0', size: '100' });
  const res = await pwFetch(`${EFTS_BASE}/search-index?${params}`, { headers: SEC_HEADERS });
  if (!res.ok) return { candidates: [], total: 0 };
  const data = (await res.json()) as {
    hits?: { total?: { value?: number }; hits?: { _source?: { display_names?: string[] } }[] };
  };
  const byCik = new Map<string, ListedFiler>();
  for (const h of data.hits?.hits ?? []) {
    for (const dn of h._source?.display_names ?? []) {
      // "Merck & Co. Inc.  (MRK)  (CIK 0000310158)" — parse name, ticker?, cik.
      const parens = [...dn.matchAll(/\(([^)]+)\)/g)].map((m) => m[1].trim());
      const cikPart = parens.find((p) => /^CIK\s*\d+/i.test(p));
      const cik = cikPart ? String(Number(cikPart.replace(/CIK\s*/i, ''))) : '';
      const ticker = parens.find((p) => /^[A-Z][A-Z.]{0,5}$/.test(p) && !/^CIK/i.test(p));
      if (!cik || !ticker) continue; // listed filers only
      const name = dn.slice(0, dn.indexOf('(')).trim();
      const cur = byCik.get(cik);
      if (cur) cur.hits += 1;
      else byCik.set(cik, { name, ticker, cik, hits: 1 });
    }
  }
  const candidates = [...byCik.values()].sort((a, b) => b.hits - a.hits);
  return { candidates, total: data.hits?.total?.value ?? 0 };
}

interface EntityProfile { name?: string; state?: string; recent_forms?: string[] }

/** Best-effort entity profile for a bare CIK — forms filed + state, to explain
 * an "unlisted" verdict (e.g. "only Form D" ⇒ private placement). */
async function edgarEntityProfile(cik: string): Promise<EntityProfile | null> {
  try {
    const padded = cik.padStart(10, '0');
    const res = await pwFetch(`${DATA_BASE}/submissions/CIK${padded}.json`, { headers: SEC_HEADERS });
    if (!res.ok) return null;
    const d = (await res.json()) as { name?: string; stateOfIncorporation?: string; filings?: { recent?: { form?: string[] } } };
    const forms = [...new Set(d.filings?.recent?.form ?? [])].slice(0, 8);
    return { name: d.name, state: d.stateOfIncorporation, recent_forms: forms };
  } catch {
    return null;
  }
}

function filerOut(r: SecTickerRow) {
  return { company_name: r.title, ticker: r.ticker, cik: String(r.cik_str), cik_padded: String(r.cik_str).padStart(10, '0') };
}

async function sponsorToFiler(sponsor: string): Promise<unknown> {
  if (typeof sponsor !== 'string' || !sponsor.trim()) {
    return {
      error: 'Required argument "sponsor" is missing or empty.',
      retry_hint: 'Pass an organization name, e.g. sponsor_to_filer({ sponsor: "Merck Sharp and Dohme" }).',
    };
  }
  const name = sponsor.trim();
  const disc = distinctiveToken(name);
  const tickers = await fetchCompanyTickers();

  // 1) Direct listed match (exact / prefix / whole-word — not loose substring).
  const ranked = rankMatches(name, tickers, (r) => r.title);
  if (ranked.length && ranked[0].score >= 2) {
    const m = ranked[0].item;
    return {
      status: 'resolved',
      method: 'direct',
      confidence: ranked[0].score >= 3 ? 'high' : 'medium',
      sponsor: name,
      filer: filerOut(m),
      alternatives: ranked.slice(1, 4).map((x) => filerOut(x.item)),
    };
  }

  // Own SEC CIK? (registered filer entity — subsidiary or private that filed)
  const own = await edgarOwnCik(name).catch(() => null);
  if (own) {
    const listedSelf = tickers.find((t) => String(t.cik_str) === own.cik);
    if (listedSelf) {
      return { status: 'resolved', method: 'direct_cik', confidence: 'high', sponsor: name, filer: filerOut(listedSelf) };
    }
  }

  // 3) Full-text: listed filers referencing the sponsor; confirm a parent by
  // requiring the sponsor's distinctive token in the filer's name (kills
  // "merely mentioned by an unrelated filer" false positives).
  const ft = await fullTextListedFilers(name).catch(() => ({ candidates: [] as ListedFiler[], total: 0 }));
  const confirmed = ft.candidates.find((c) => normName(c.name).split(' ').includes(disc));
  if (confirmed) {
    return {
      status: 'resolved_via_parent',
      method: 'subsidiary_fulltext',
      confidence: confirmed.hits >= 10 ? 'high' : 'medium',
      sponsor: name,
      filer: { company_name: confirmed.name, ticker: confirmed.ticker, cik: confirmed.cik, cik_padded: confirmed.cik.padStart(10, '0') },
      evidence: {
        parent_mention_filings: confirmed.hits,
        distinctive_token: disc,
        own_subsidiary_cik: own?.cik ?? null,
        own_subsidiary_name: own?.profile?.name ?? null,
        note: 'Sponsor appears to be an operating subsidiary. Resolved to the listed parent whose SEC filings reference it and whose name shares the sponsor\'s distinctive token.',
      },
      alternatives: ft.candidates.slice(0, 3).map((c) => ({ company_name: c.name, ticker: c.ticker, cik: c.cik, mention_filings: c.hits })),
    };
  }

  // 4) No confirmed parent — classify the miss honestly.
  const mentions = ft.candidates.slice(0, 3).map((c) => ({ company_name: c.name, ticker: c.ticker, cik: c.cik, mention_filings: c.hits }));
  if (own) {
    return {
      status: 'us_registrant_unlisted',
      confidence: 'high',
      sponsor: name,
      own_cik: own.cik,
      likely: 'private',
      message: `"${name}" is an SEC-registered entity (CIK ${own.cik}) but is not publicly listed (no ticker) and has no dominant listed parent in EDGAR filings. Most likely a private company (e.g. a Form D private placement or draft/withdrawn registration) or a subsidiary of a private or non-US parent.`,
      entity: own.profile,
      full_text_mentions: mentions,
    };
  }
  return {
    status: 'no_us_registrant',
    confidence: 'high',
    sponsor: name,
    likely: 'non_us_listed_or_private',
    message: `No US SEC registrant found for "${name}". The sponsor is not US-listed and has no US SEC CIK — most likely a non-US-listed company (foreign exchange) or a private company. Any full-text mentions below are other filers referencing the name, not the sponsor itself.`,
    full_text_mentions: mentions,
  };
}

async function resolveCik(tickerOrCik: string): Promise<string> {
  if (typeof tickerOrCik !== 'string' || !tickerOrCik.trim()) {
    // Names EVERY accepted spelling, because `required` is empty on these
    // schemas (a flat list cannot say "one of these three") so this is the
    // only place a caller is told what to send. The words "is required" are
    // load-bearing: error-class.ts books the refusal as user_error rather
    // than the `error` bucket that feeds Problem Tools (fleet #2069).
    // No tool name in the example: resolveCik() is shared by four tools, and a
    // refusal that says `edgar_company_filings(...)` to a caller of
    // edgar_company_facts hands it the wrong word to copy — which is the exact
    // failure this whole change exists to stop.
    throw new Error(
      'A company is required: pass `ticker_or_cik`, or its aliases `cik` / `ticker` — ' +
      'all three take a ticker ("AAPL") or a CIK ("320193"), and tickers are auto-resolved.'
    );
  }
  if (isNumericCik(tickerOrCik)) return tickerOrCik.trim();
  const result = await tickerToCik(tickerOrCik);
  return result.cik;
}

/**
 * A 404 from data.sec.gov/submissions/ means the CIK simply isn't a registrant —
 * that's a caller mistake, not an EDGAR outage, so say which CIK failed and how to
 * get a real one instead of surfacing a bare status code.
 */
function submissionsError(status: number, tickerOrCik: string, paddedCik: string): Error {
  if (status === 404) {
    return new Error(
      `No SEC registrant with CIK ${paddedCik} (resolved from "${tickerOrCik}"). ` +
      'That CIK does not exist in EDGAR — the company may be private, foreign-listed, or the ' +
      'identifier may be wrong. Resolve a real one with edgar_ticker_to_cik({ticker: "…"}), ' +
      'which also accepts company names and returns `alternatives` for disambiguation.'
    );
  }
  return new Error(`SEC EDGAR submissions error: ${status}`);
}

interface SubmissionsPayload {
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
}

interface FilingRow {
  accession_number: string;
  filing_date: string;
  form: string;
  items?: string[];
  primary_document: string;
  document_url: string;
}

async function fetchSubmissions(tickerOrCik: string, paddedCik: string): Promise<SubmissionsPayload> {
  const res = await pwFetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
  if (!res.ok) throw submissionsError(res.status, tickerOrCik, paddedCik);
  return (await res.json()) as SubmissionsPayload;
}

/**
 * Map the submissions payload's column-oriented `recent` block to filing rows.
 * `keep` decides per form; `count` caps the output after filtering.
 */
function recentFilingRows(data: SubmissionsPayload, keep: (form: string) => boolean, count: number): FilingRow[] {
  const recent = data.filings.recent;
  const filings: FilingRow[] = [];
  for (let i = 0; i < recent.accessionNumber.length && filings.length < count; i++) {
    const form = recent.form[i];
    if (!keep(form)) continue;

    const accession = recent.accessionNumber[i];
    const accessionPath = accession.replace(/-/g, '');
    // submissions payload carries `items` as a comma-joined string per filing,
    // populated for 8-Ks (e.g. "3.01,9.01"). Split to an array; the item code
    // (3.01 delisting vs 1.01 agreement) is the signal, so no second fetch needed.
    const rawItems = recent.items?.[i] ?? '';
    const items = rawItems
      ? rawItems.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    filings.push({
      accession_number: accession,
      filing_date: recent.filingDate[i],
      form,
      ...(items && items.length ? { items } : {}),
      primary_document: recent.primaryDocument[i],
      document_url: `https://www.sec.gov/Archives/edgar/data/${data.cik}/${accessionPath}/${recent.primaryDocument[i]}`,
    });
  }
  return filings;
}

async function companyFilings(tickerOrCik: string, formType?: string, limit?: number) {
  const cik = await resolveCik(tickerOrCik);
  const paddedCik = padCik(cik);
  const count = Math.min(40, Math.max(1, limit ?? 20));

  const data = await fetchSubmissions(tickerOrCik, paddedCik);
  const filings = recentFilingRows(data, (form) => !formType || form === formType, count);

  return {
    cik: data.cik,
    company_name: data.name,
    tickers: data.tickers ?? [],
    // The NUMERIC code as well as the prose (fleet #2124). `sic_description`
    // was already returned but is free text ("Biological Products, (No
    // Diagnostic Substances)"), so every consumer that wants to branch on
    // industry has to pattern-match prose that SEC is free to reword. The code
    // is the fact. entity_profile uses it to decide whether asking the FDA
    // Purple Book about this filer can possibly return anything; it is already
    // in the submissions payload, so this costs no extra request.
    sic: data.sic,
    sic_description: data.sicDescription,
    state_of_incorporation: data.stateOfIncorporation,
    fiscal_year_end: data.fiscalYearEnd,
    filter_form_type: formType ?? 'all',
    filings,
  };
}

// --- edgar_company_snapshot --------------------------------------------------
// The resolve -> list filings -> pull financials chain, collapsed into one call.
// Measured in docs/edgar-cohort-retention-2026-09-17.md (fleet #2114 / #2182):
// 90%+ of depth EDGAR callers assemble edgar_company_filings +
// edgar_company_concept by hand after edgar_ticker_to_cik, three calls every
// time; 66% of one-shot callers stop after ticker resolution. Neither
// edgar_company_facts (concepts, no filings) nor entity_profile (a cross-source
// meta-tool outside this pack, five unfiltered filings, three concepts) gave
// a direct-tool caller that result from inside the pack.

/** Forms listed by default: the substantive periodic/current/proxy reports. Form 4 insider filings dominate a raw feed for any large cap and are what callers filter out first. */
const SNAPSHOT_DEFAULT_FORMS = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '20-F', '40-F', '6-K', 'DEF 14A']);

async function companySnapshot(tickerOrCik: string, formType?: string, filingsLimit?: number) {
  const cik = await resolveCik(tickerOrCik);
  const paddedCik = padCik(cik);
  const count = Math.min(40, Math.max(1, filingsLimit ?? 10));
  const filter = (formType ?? '').trim();
  const keep = !filter
    ? (form: string) => SNAPSHOT_DEFAULT_FORMS.has(form)
    : filter.toLowerCase() === 'all'
      ? () => true
      : (form: string) => form === filter;

  // Both legs are keyed on the same CIK and independent of each other, so run
  // them together — this call exists to save round-trips, not to serialize them.
  const [data, factsRes] = await Promise.all([
    fetchSubmissions(tickerOrCik, paddedCik),
    pwFetch(`${DATA_BASE}/api/xbrl/companyfacts/CIK${paddedCik}.json`, { headers: SEC_HEADERS }),
  ]);

  let filings = recentFilingRows(data, keep, count);
  let filingsFilter = filter ? filter : 'default (10-K, 10-K/A, 10-Q, 10-Q/A, 8-K, 20-F, 40-F, 6-K, DEF 14A)';
  // The default set is tuned for operating companies. A fund, trust or ABS
  // issuer files N-CSR / 485BPOS / 10-D and none of the above, so the default
  // would hand back an empty list for a registrant with hundreds of filings —
  // a zero that reads as "nothing filed" (silent-zero policy). Fall back to
  // every form and SAY so in `filings_filter`, rather than return the empty set.
  if (!filter && filings.length === 0 && data.filings.recent.accessionNumber.length > 0) {
    filings = recentFilingRows(data, () => true, count);
    const forms = [...new Set(filings.map((f) => f.form))].join(', ');
    filingsFilter = `all — this filer's recent forms (${forms}) include none of the default set, so every form is listed`;
  }

  // The financials leg degrades on its own: a registrant with no XBRL facts
  // (funds, trusts, paper-form foreign filers) still has filings worth
  // returning. The gap is STATED — `financials_status` plus a reason — never
  // an empty object that reads as "reported nothing" (silent-zero policy).
  let financials: {
    financials_status: 'ok' | 'unavailable';
    financials_note?: string;
    latest_fiscal_year: number | null;
    latest_period_end: string | null;
    key_concepts: Record<string, unknown>;
    stale_concepts: string[];
    year_note?: string;
  };
  if (factsRes.ok) {
    const facts = (await factsRes.json()) as {
      facts: { 'us-gaap'?: Parameters<typeof summarizeAnnualFinancials>[0] };
    };
    const usGaap = facts.facts?.['us-gaap'] ?? {};
    const summary = summarizeAnnualFinancials(usGaap);
    const reported = Object.values(summary.latest_annual).some((v) => v !== null);
    financials = reported
      ? {
          financials_status: 'ok',
          latest_fiscal_year: summary.latest_fiscal_year,
          latest_period_end: summary.latest_period_end,
          key_concepts: summary.latest_annual,
          stale_concepts: summary.stale_concepts,
          year_note: summary.year_note,
        }
      : {
          financials_status: 'unavailable',
          financials_note: `EDGAR has XBRL facts for CIK ${paddedCik} but none under the us-gaap headline concepts (revenue, net income, assets, ...). Common for filers reporting under IFRS or dei-only tags. edgar_company_facts lists whatever concepts it does report.`,
          latest_fiscal_year: null,
          latest_period_end: null,
          key_concepts: {},
          stale_concepts: [],
        };
  } else {
    // Drain the body so the connection is released; the status is the fact.
    await factsRes.text().catch(() => undefined);
    financials = {
      financials_status: 'unavailable',
      financials_note:
        factsRes.status === 404
          ? `EDGAR has no XBRL company-facts record for CIK ${paddedCik}. That is normal for funds, trusts, ABS issuers and filers that have never submitted an XBRL-tagged 10-K/10-Q/20-F — the filings above are still complete.`
          : `SEC EDGAR company-facts returned HTTP ${factsRes.status}; the filings list above is complete, the financials are not. Retry, or call edgar_company_facts directly.`,
      latest_fiscal_year: null,
      latest_period_end: null,
      key_concepts: {},
      stale_concepts: [],
    };
  }

  return {
    cik: data.cik,
    cik_padded: paddedCik,
    company_name: data.name,
    tickers: data.tickers ?? [],
    sic: data.sic,
    sic_description: data.sicDescription,
    state_of_incorporation: data.stateOfIncorporation,
    fiscal_year_end: data.fiscalYearEnd,
    filings_filter: filingsFilter,
    filings_count: filings.length,
    filings,
    ...financials,
    resources: {
      edgar_filings: `pipeworx://edgar/company/${paddedCik}/filings`,
      edgar_facts: `pipeworx://edgar/company/${paddedCik}/facts`,
    },
    next: {
      filing_text: 'edgar_filing_text({accession, section}) — the text of one filing above (section: "risk_factors", "mdna", ...).',
      concept_history: 'edgar_company_concept({cik, concept: "Revenues"}) — one metric across every reported period.',
      all_concepts: 'edgar_company_facts({cik}) — every XBRL concept the filer reports.',
    },
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

// Read at most maxBytes of a filing document, then stop reading and cancel
// the rest of the response body.
//
// Not a nicety: a SpaceX S-1 primary document is 11.8 MB of raw HTML (fleet
// #440 — confirmed by fetching it directly), and SEC's archive server does
// not honor Range requests (measured: a `Range: bytes=0-999` GET still comes
// back 200 with the full 11.8 MB, not 206). materialising that and then
// running htmlToText's regex passes over all of it inside one Worker
// invocation is what hits the CPU/isolate ceiling and gets the whole request
// killed with a bare Cloudflare 1102 — no JS exception, so a try/catch
// around the fetch (see filingDocuments' includePrimaryText path) does NOT
// protect against this failure mode. The cap has to be enforced on OUR side
// of the socket. Mirrors mcps/legislation-uk/src/index.ts's getTextBounded,
// which fixed the identical shape of bug for a 5.9 MB Act.
async function fetchTextBounded(url: string, headers: Record<string, string>, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const res = await pwFetch(url, { headers });
  if (!res.ok) throw new Error(`Failed to fetch primary document (HTTP ${res.status}): ${url}`);
  if (!res.body) {
    const whole = await res.text();
    return { text: whole.length > maxBytes ? whole.slice(0, maxBytes) : whole, truncated: whole.length > maxBytes };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      chunks.push(value);
      if (total >= maxBytes) { truncated = true; await reader.cancel(); break; }
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return { text: new TextDecoder().decode(buf), truncated };
}
// Cap on RAW HTML bytes read, not plaintext chars — HTML markup overhead in
// SEC filings (heavy inline styling/XBRL tagging) means this yields roughly
// 1.5-3x fewer plaintext chars, comfortably above FILING_TEXT_CAP for the
// front-loaded sections (Business, Risk Factors, MD&A) most questions ask
// about. A doc capped here is flagged `raw_truncated: true` — an honest
// stated limit, not a silent gap — rather than never answering at all.
const FILING_DOC_MAX_BYTES = 4_000_000;

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
  accession: string | undefined,
  tickerOrCik: string,
  includePrimaryText?: boolean,
  wantFormTypeArg?: string,
) {
  if (typeof tickerOrCik !== 'string' || !tickerOrCik.trim()) {
    throw new Error(
      'A company is required: pass `ticker` ("AAPL"), `cik` ("320193") or their alias `ticker_or_cik` — plus either an accession or a form_type (e.g. edgar_filing_documents({ticker: "NVDA", form_type: "10-K"}) for the latest 10-K).',
    );
  }
  const cik = await resolveCik(tickerOrCik);
  // Accession is optional: when omitted, resolve the latest filing matching
  // form_type (or the single most recent filing of any type) so one-shot
  // questions like "documents in NVIDIA's latest 10-K" work without the caller
  // first having to look up an accession number.
  let acc = accession ? normalizeAccession(accession) : null;
  if (accession && !acc) {
    throw new Error(
      `Invalid accession "${accession}". A SEC accession number is 18 digits shaped 10-2-6 (e.g. "0000320193-25-000079", with or without dashes). Get accession numbers from edgar_company_filings, or omit accession and pass form_type to auto-resolve the latest.`,
    );
  }
  if (!acc) {
    const wantForm = wantFormTypeArg?.trim().toUpperCase();
    const subRes = await pwFetch(`${DATA_BASE}/submissions/CIK${padCik(cik)}.json`, { headers: SEC_HEADERS });
    if (!subRes.ok) throw new Error(`SEC submissions lookup failed (HTTP ${subRes.status}) resolving the latest filing for ${tickerOrCik}.`);
    const sub = (await subRes.json()) as { filings?: { recent?: { accessionNumber?: string[]; form?: string[] } } };
    const r = sub.filings?.recent;
    const forms = r?.form ?? [];
    const accs = r?.accessionNumber ?? [];
    const idx = wantForm ? forms.findIndex((f) => f.toUpperCase() === wantForm) : 0;
    if (idx < 0 || !accs[idx]) {
      throw new Error(
        `No ${wantForm ?? 'recent'} filing found for ${tickerOrCik} in the recent index. Use edgar_company_filings({ticker:"${tickerOrCik}"${wantForm ? `, form_type:"${wantForm}"` : ''}}) to list available filings, then pass an accession.`,
      );
    }
    acc = normalizeAccession(accs[idx]);
    if (!acc) throw new Error('Failed to resolve a valid accession from the submissions index.');
  }
  const cikNoZeros = String(Number(cik.replace(/\D/g, ''))); // archive path uses CIK with no leading zeros
  const paddedCik = padCik(cik);

  // Match the accession in the filer's submissions to enrich with form/date/primaryDoc.
  let company: string | null = null;
  let formType: string | null = null;
  let filingDate: string | null = null;
  let primaryDocument: string | null = null;
  let primaryDocDescription: string | null = null;
  try {
    const subRes = await pwFetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
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
  const idxRes = await pwFetch(`${folder}/index.json`, { headers: SEC_HEADERS });
  if (idxRes.status === 404) {
    throw new Error(
      `No filing found for accession ${acc.dashed} — that accession number does not exist in SEC EDGAR (double-check the digits; it may belong to a different filer). Use edgar_company_filings({ticker_or_cik: "${tickerOrCik}"}) to list this company's real accession numbers.`,
    );
  }
  if (!idxRes.ok) throw await httpError(idxRes, 'SEC EDGAR filing index error');
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
      const { text: body, truncated: rawTruncated } = await fetchTextBounded(docUrl, { 'User-Agent': SEC_HEADERS['User-Agent'] }, FILING_DOC_MAX_BYTES);
      const isHtml = /\.x?html?$/i.test(primaryDocument) || /^\s*</.test(body);
      const text = isHtml ? htmlToText(body) : body;
      result.primary_text = text.length > 40000 ? text.slice(0, 40000) + '\n…[truncated]' : text;
      if (rawTruncated) result.primary_text_raw_truncated = true;
    } catch (e) {
      result.primary_text = null;
      result.primary_text_error = String(e);
    }
  }

  return result;
}

// Heading patterns for the `section` slice of edgar_filing_text. Each filing's
// MD&A / notes carry these standard headings; we locate the LAST occurrence
// (the body, not the table-of-contents entry) and return a window from there.
// Each section: an anchor regex plus whether to take the FIRST match (the actual
// disclosure body — used where the phrase is rare and meaningful) or the LAST
// (used where the heading also appears in the table of contents, so the body is
// the later occurrence). going_concern anchors on "substantial doubt" — the
// ASC 205-40 trigger phrase — because "going concern" alone recurs in boilerplate.
const FILING_SECTION_PATTERNS: Record<string, { anchor: RegExp; pick: 'first' | 'last' }> = {
  going_concern: { anchor: /substantial doubt|going concern/gi, pick: 'first' },
  liquidity: { anchor: /liquidity and capital resources|liquidity/gi, pick: 'last' },
  capital_resources: { anchor: /capital resources/gi, pick: 'last' },
  subsequent_events: { anchor: /subsequent events/gi, pick: 'last' },
};

const FILING_TEXT_DEFAULT_MAX = 50000;
const FILING_TEXT_CAP = 100000;

// Fetch ONE filing's primary-document text, HTML-stripped, paged. Splitting this
// out (rather than piggybacking edgar_filing_documents' include_primary_text,
// which caps at 40k and can't page) lets the register pull deep disclosures —
// going-concern language, ATM facilities, share caps — that live past 40k.
async function filingText(
  accession: string | undefined,
  tickerOrCik: string,
  section?: string,
  maxChars?: number,
  offset?: number,
  wantFormTypeArg?: string,
) {
  if (typeof tickerOrCik !== 'string' || !tickerOrCik.trim()) {
    throw new Error('A company is required: pass `ticker` ("ACTU"), `cik` or their alias `ticker_or_cik` — plus either an accession or a form_type (e.g. edgar_filing_text({ticker:"ACTU", form_type:"10-Q"})).');
  }
  const cik = await resolveCik(tickerOrCik);
  const paddedCik = padCik(cik);
  const cikNoZeros = String(Number(cik.replace(/\D/g, '')));

  let acc = accession ? normalizeAccession(accession) : null;
  if (accession && !acc) {
    throw new Error(`Invalid accession "${accession}". A SEC accession is 18 digits shaped 10-2-6 (e.g. "0001683168-26-003909"). Get one from edgar_company_filings, or omit accession and pass form_type to auto-resolve the latest.`);
  }

  // One submissions fetch serves both auto-resolution and metadata enrichment.
  const subRes = await pwFetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
  if (!subRes.ok) throw new Error(`SEC submissions lookup failed (HTTP ${subRes.status}) for ${tickerOrCik}.`);
  const sub = (await subRes.json()) as {
    name?: string;
    filings?: { recent?: { accessionNumber?: string[]; form?: string[]; filingDate?: string[]; primaryDocument?: string[] } };
  };
  const r = sub.filings?.recent;
  const accs = r?.accessionNumber ?? [];
  const forms = r?.form ?? [];

  if (!acc) {
    const wantForm = wantFormTypeArg?.trim().toUpperCase();
    const idx = wantForm ? forms.findIndex((f) => f.toUpperCase() === wantForm) : 0;
    if (idx < 0 || !accs[idx]) {
      throw new Error(`No ${wantForm ?? 'recent'} filing found for ${tickerOrCik}. Use edgar_company_filings({ticker_or_cik:"${tickerOrCik}"${wantForm ? `, form_type:"${wantForm}"` : ''}}) to list filings, then pass an accession.`);
    }
    acc = normalizeAccession(accs[idx]);
    if (!acc) throw new Error('Failed to resolve a valid accession from the submissions index.');
  }

  const i = accs.indexOf(acc.dashed);
  const formType = i >= 0 ? forms[i] ?? null : null;
  const filingDate = i >= 0 ? r?.filingDate?.[i] ?? null : null;
  let primaryDocument = i >= 0 ? r?.primaryDocument?.[i] ?? null : null;

  const folder = `https://www.sec.gov/Archives/edgar/data/${cikNoZeros}/${acc.nodash}`;
  // If the accession wasn't in the recent index (older filing), fall back to the
  // folder index to find the primary document.
  if (!primaryDocument) {
    const idxRes = await pwFetch(`${folder}/index.json`, { headers: SEC_HEADERS });
    if (idxRes.status === 404) throw new Error(`No filing found for accession ${acc.dashed} — it does not exist in SEC EDGAR for this filer. Use edgar_company_filings({ticker_or_cik:"${tickerOrCik}"}) to list real accessions.`);
    if (!idxRes.ok) throw await httpError(idxRes, 'SEC EDGAR filing index error');
    const idxJson = (await idxRes.json()) as { directory?: { item?: { name: string; type?: string }[] } };
    const docs = idxJson.directory?.item ?? [];
    // Prefer the main htm document that isn't an exhibit/XBRL artifact.
    primaryDocument =
      docs.find((d) => /\.htm/i.test(d.name) && !/^R\d|_cal|_def|_lab|_pre|_htm\.xml|-index/i.test(d.name))?.name ?? null;
    if (!primaryDocument) throw new Error(`Could not identify the primary document for accession ${acc.dashed}. Use edgar_filing_documents to list the filing's files and fetch one by URL.`);
  }

  const docUrl = `${folder}/${primaryDocument}`;
  const { text: body, truncated: rawTruncated } = await fetchTextBounded(docUrl, { 'User-Agent': SEC_HEADERS['User-Agent'] }, FILING_DOC_MAX_BYTES);
  const isHtml = /\.x?html?$/i.test(primaryDocument) || /^\s*</.test(body);
  let fullText = isHtml ? htmlToText(body) : body;

  // Optional section slice: locate the section heading (last occurrence = the
  // real body, past any table-of-contents mention) and reframe the text to start
  // there. `section` is best-effort — an unmatched section returns the whole doc.
  let sectionApplied: string | null = null;
  let sectionFound: string | boolean | null = null;
  const sec = (section ?? '').trim().toLowerCase();
  if (sec) {
    const conf = FILING_SECTION_PATTERNS[sec];
    if (!conf) {
      sectionFound = `unknown_section:${sec}`;
    } else {
      const idxs: number[] = [];
      for (const m of fullText.matchAll(conf.anchor)) if (m.index !== undefined) idxs.push(m.index);
      const chosen = idxs.length === 0 ? -1 : conf.pick === 'first' ? idxs[0] : idxs[idxs.length - 1];
      if (chosen >= 0) {
        // Back up a little so the section heading itself is included, not clipped mid-phrase.
        fullText = fullText.slice(Math.max(0, chosen - 120));
        sectionApplied = sec;
        sectionFound = true;
      } else {
        sectionFound = false;
      }
    }
  }

  const total = fullText.length;
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const cap = Math.min(FILING_TEXT_CAP, Math.max(1000, Math.floor(Number(maxChars) || FILING_TEXT_DEFAULT_MAX)));
  const slice = fullText.slice(off, off + cap);
  const end = off + slice.length;
  const truncated = end < total;

  return {
    accession: acc.dashed,
    cik: cikNoZeros,
    company: sub.name ?? null,
    form: formType,
    filed: filingDate,
    document: primaryDocument,
    document_url: docUrl,
    section: sectionApplied,
    ...(sectionFound !== null ? { section_found: sectionFound } : {}),
    total_chars: total,
    offset: off,
    returned_chars: slice.length,
    truncated,
    // When truncated, pass this back as `offset` to page forward; do NOT spill the
    // whole doc to disk — request the next window instead.
    next_offset: truncated ? end : null,
    ...(rawTruncated
      ? {
          raw_truncated: true,
          raw_truncated_note: `This document's raw HTML exceeds the ${(FILING_DOC_MAX_BYTES / 1_000_000).toFixed(0)}MB this tool reads in one call, so total_chars/text above reflect only the portion read — NOT the whole filing. A section search (going_concern/liquidity/capital_resources/subsequent_events) that picks the LAST occurrence may miss content past this cutoff, since large filings' later sections (financial statement notes, subsequent events) can fall beyond it. Treat section_found:false as inconclusive, not "absent", for a raw_truncated document.`,
        }
      : {}),
    text: slice,
  };
}

// data.sec.gov answers a bare 404 both when no filer has the CIK at all and when
// the filer exists but has never submitted XBRL financial data (investment funds,
// trusts, individuals, most pre-2011 foreign private issuers). "SEC EDGAR company
// facts error: 404" told the caller neither, and booked as `error` (the tier
// meaning a Pipeworx defect) instead of the caller's CIK being the problem. The
// sibling `sec` pack fixed this same shape (fleet #586); ported here — the two
// packs cover the same upstream and had silently drifted. `not_found:` is the
// classifier token: the gateway books it as user_error and strips it before the
// caller sees it.
async function companyFactsNotFound(input: string, paddedCik: string): Promise<Error> {
  const lookup = 'Resolve a real one with edgar_ticker_to_cik({ticker: "…"}) — it accepts a ticker or a company name.';
  const sub = await pwFetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS }).catch(
    () => null,
  );
  if (sub?.ok) {
    const filer = (await sub.json().catch(() => null)) as { name?: string } | null;
    const name = filer?.name ? `"${filer.name}"` : 'a filer';
    return new Error(
      `not_found: SEC EDGAR knows CIK ${paddedCik} as ${name}, but it has no XBRL financial facts — this filer does not submit XBRL financial statements (typical for investment funds, trusts and individuals). If you meant an operating company, look up its CIK first: ${lookup}`,
    );
  }
  return new Error(
    `not_found: SEC EDGAR has no company at CIK ${paddedCik} (resolved from "${input}"). EDGAR covers companies registered with the US SEC only. ${lookup}`,
  );
}

async function companyFacts(cikOrTicker: string) {
  // Was the only EDGAR tool that skipped resolveCik() — it called padCik()
  // directly, so a ticker ("NVDA") got its letters stripped -> "0000000000" ->
  // 404, and a missing arg crashed on .replace of undefined. Route through
  // resolveCik like every sibling: validates the arg and resolves tickers.
  const cik = await resolveCik(cikOrTicker);
  const paddedCik = padCik(cik);
  const res = await pwFetch(`${DATA_BASE}/api/xbrl/companyfacts/CIK${paddedCik}.json`, {
    headers: SEC_HEADERS,
  });
  if (res.status === 404) throw await companyFactsNotFound(cikOrTicker, paddedCik);
  if (!res.ok) throw await httpError(res, 'SEC EDGAR company facts error');

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

  // Most-recent annual value per concept, with the filer's CURRENT concept
  // leading and retired concepts flagged stale — see shared/src/xbrl.ts for the
  // three traps this replaces (fy = filing year, frame on the last filer, and
  // Microsoft's FY2010 `Revenues` presented as "most recent"). Fleet #594.
  const usGaap = data.facts?.['us-gaap'] ?? {};
  const summary = summarizeAnnualFinancials(usGaap);

  return {
    cik: String(data.cik),
    company_name: data.entityName,
    latest_fiscal_year: summary.latest_fiscal_year,
    latest_period_end: summary.latest_period_end,
    latest_annual: summary.latest_annual,
    key_financials: summary.key_financials,
    stale_concepts: summary.stale_concepts,
    year_note: summary.year_note,
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
  // Without these, "shares outstanding" fell through to the fuzzy name scan,
  // which matched PreferredStockSharesOutstanding first — and most filers
  // report 0 preferred. Asking a plain question about Snowflake returned
  // "0 shares outstanding" for a company with ~330M. A confident zero about a
  // public company is the worst shape of wrong answer we produce, so the
  // common-stock tags are named explicitly and ordered.
  // EntityCommonStockSharesOutstanding is the dei cover-page tag, which is
  // often fresher than the us-gaap balance-sheet one.
  sharesoutstanding: ['CommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding', 'CommonStockSharesIssued'],
  commonsharesoutstanding: ['CommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding', 'CommonStockSharesIssued'],
  commonstocksharesoutstanding: ['CommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding'],
  cash: [
    'CashAndCashEquivalentsAtCarryingValue',
    'Cash',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
  ],
  longtermdebt: [
    'LongTermDebt', 'LongTermDebtNoncurrent',
    'LongTermDebtAndCapitalLeaseObligations', 'DebtAndCapitalLeaseObligations',
    // Post-ASC-842 (2019+) filers and combined-debt filers use different tags.
    // Also adds debtlongterm* to the company-facts scan token set so the name
    // scan catches tags where "Debt" precedes "Longterm" (e.g. Ford CIK 37996).
    'LongTermDebtAndFinanceLeaseLiability',
    'DebtLongtermAndShorttermCombinedAmount',
  ],
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
  longtermdebtnoncurrent: ['LongTermDebtNoncurrent', 'LongTermDebt', 'LongTermDebtAndFinanceLeaseLiability', 'DebtLongtermAndShorttermCombinedAmount'],
  longtermdebtandfinanceleaseliability: ['LongTermDebtAndFinanceLeaseLiability', 'LongTermDebt', 'LongTermDebtAndCapitalLeaseObligations'],
  debtlongtermandshorttermcombinedamount: ['DebtLongtermAndShorttermCombinedAmount', 'LongTermDebt', 'LongTermDebtNoncurrent'],
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
const QUARTERLY_FORMS = new Set(['10-Q', '10-Q/A']);
const ALL_PERIODIC_FORMS = new Set([...ANNUAL_FORMS, ...QUARTERLY_FORMS]);

/** Forms to include for a requested reporting period. Default "all" surfaces
 * quarterly (10-Q) alongside annual — a metric like Cash moves every quarter,
 * and returning only the annual 10-K value hid the fresher 10-Q figure
 * (published an 8-month runway off a 10-K when the 10-Q implied ~5). */
function formsForPeriod(period: string | undefined): Set<string> {
  const p = (period ?? 'all').trim().toLowerCase();
  if (p === 'annual' || p === 'yearly' || p === 'fy') return ANNUAL_FORMS;
  if (p === 'quarterly' || p === 'quarter' || p === 'q') return QUARTERLY_FORMS;
  return ALL_PERIODIC_FORMS;
}

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

async function companyConcept(
  cikOrTicker: string,
  concept: string,
  period?: string,
  fiscalYearArg?: string | number,
  fiscalPeriodArg?: string,
) {
  // Checked here rather than by the gateway's declared-`required` pre-flight,
  // because `cik` accepts three spellings and a flat required list cannot say
  // "one of these" (see the inputSchema note). Both messages say "is required"
  // so they classify as a caller error, not as our defect, and both name every
  // spelling that works — the old gateway refusal named only `cik`, which is
  // the word the caller had already decided not to use.
  if (typeof cikOrTicker !== 'string' || !cikOrTicker.trim()) {
    throw new Error(
      'A company is required: pass `cik` (it takes a ticker like "AAPL" or a CIK like "320193"), or its aliases `ticker` / `ticker_or_cik`. Example: edgar_company_concept({cik:"DOV", concept:"NetIncomeLoss"}).',
    );
  }
  if (typeof concept !== 'string' || !concept.trim()) {
    throw new Error(
      'A metric is required: pass `concept` (alias `metric`) — a friendly name like "Revenue", "NetIncomeLoss", "Cash", "LongTermDebt" or "EarningsPerShareDiluted". Example: edgar_company_concept({cik:"DOV", concept:"NetIncomeLoss"}).',
    );
  }
  const forms = formsForPeriod(period);
  // Auto-resolve ticker → CIK so callers can pass "AAPL" not "320193".
  // Production analytics: 11% errors on edgar largely from LLMs passing
  // tickers as cik (then padCik strips letters → 0000000000 → 404).
  const cik = await resolveCik(cikOrTicker);
  const paddedCik = padCik(cik);
  let resolvedEntityName = '';

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
  type ConceptFact = ConceptDoc['units'][string][number];

  // SEC's XBRL JSON is normally { units: { "USD": [ ...facts ] } }, but a small
  // fraction of documents carry a `units` bucket that is not an array (and a
  // handful omit `units` entirely). `for (const e of values)` on one of those
  // throws "values is not iterable" — an unguarded internal TypeError, so it
  // books as OUR defect rather than an upstream data problem, and the caller
  // gets a message that names a variable in our source and tells them nothing
  // they can act on. It was firing on roughly 1 call in 318 of
  // edgar_company_concept, the highest-volume tool on the platform, which is
  // exactly the kind of rate that never trips an alarm and never gets fixed.
  //
  // Skip the malformed bucket rather than failing the whole lookup: a company's
  // other units almost always still carry the answer, so a partial answer beats
  // a crash. If every bucket is malformed the caller falls through to the normal
  // no-data path, which already says something useful.
  const unitEntries = (units: ConceptDoc['units'] | undefined): [string, ConceptFact[]][] =>
    Object.entries(units ?? {}).filter((e): e is [string, ConceptFact[]] => Array.isArray(e[1]));

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
      const r = await pwFetch(
        `${DATA_BASE}/api/xbrl/companyconcept/CIK${paddedCik}/${ns}/${encodeURIComponent(candidate)}.json`,
        { headers: SEC_HEADERS },
      );
      if (!r.ok) { lastStatus = r.status; continue; }
      const doc = (await r.json()) as ConceptDoc;
      let latestEnd = '';
      for (const [, values] of unitEntries(doc.units)) {
        for (const e of values) {
          if (!ALL_PERIODIC_FORMS.has(e.form)) continue;
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
  // Also trigger when ALL found data is >3 years stale — filer changed tag.
  const THREE_YEARS_MS = 3 * 365 * 24 * 3600 * 1000;
  const bestFoundMs = found.length > 0 ? Math.max(...found.map(f => f.latestEnd ? new Date(f.latestEnd).getTime() : 0)) : 0;
  const foundIsStale = found.length > 0 && bestFoundMs > 0 && (Date.now() - bestFoundMs) > THREE_YEARS_MS;
  if (found.length === 0 || foundIsStale) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const tokens = candidates.map(norm).filter((t) => t.length >= 3);
    const factsRes = await pwFetch(`${DATA_BASE}/api/xbrl/companyfacts/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
    if (!factsRes.ok) {
      lastStatus = factsRes.status;
    } else if (tokens.length) {
      const facts = (await factsRes.json()) as { entityName?: string; facts?: { 'us-gaap'?: Record<string, { label?: string; description?: string; units: Record<string, ConceptDoc['units'][string]> }> } };
      resolvedEntityName = facts.entityName ?? '';
      const gaap = facts.facts?.['us-gaap'] ?? {};
      const FLOW = /^(ProceedsFrom|RepaymentsOf|PaymentsOf|IncreaseDecrease|AmortizationOf|Gain|Loss)/;
      const matches: { isFlow: boolean; latestEnd: string; doc: ConceptDoc }[] = [];
      for (const [tag, entry] of Object.entries(gaap)) {
        if (!tokens.some((t) => norm(tag).includes(t))) continue;
        let latestEnd = '';
        for (const [, values] of unitEntries(entry.units)) {
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
  // Still stale after the name scan — every tag we can see is >3y old and the
  // scan found nothing fresher. Don't hand back the old number. It is the worst
  // failure shape we ship: a well-formed, plausible, five-year-old answer with
  // no marker on it, so neither the caller nor any automatic check can tell it
  // apart from a current one.
  //
  // Ford is the reference case, measured 2026-08-01. companyconcept for
  // LongTermDebtNoncurrent serves 4 facts ending at end=2020-12-31 /
  // filed=2021-02-05, and LongTermDebt, LongTermDebtAndCapitalLeaseObligations
  // and DebtLongtermAndShorttermCombinedAmount all 404 — yet Ford filed a 10-Q
  // on 2026-07-29. The debt is right there in that filing, tagged
  // LongTermDebtAndCapitalLeaseObligations, but reported ONLY under
  // StatementBusinessSegmentsAxis (Company-excluding-Ford-Credit vs Ford
  // Credit) with no undimensioned consolidated total. companyfacts and
  // companyconcept expose dimensionless facts only, so the live value is
  // invisible to this API no matter which tag we ask for. Any filer that splits
  // a balance-sheet line across segments and never totals it has this hole; the
  // only real fix is a second ingestion path (inline XBRL / SEC's Financial
  // Statement Data Sets, whose num.txt carries the segments column).
  //
  // We still name the stale tag we found, so a caller who genuinely wants the
  // historical figure knows exactly where it is rather than being told nothing.
  if (found.length > 0) {
    const freshest = found.reduce((a, b) => ((b.latestEnd ?? '') > (a.latestEnd ?? '') ? b : a));
    const freshestMs = freshest.latestEnd ? new Date(freshest.latestEnd).getTime() : 0;
    if (freshestMs > 0 && Date.now() - freshestMs > THREE_YEARS_MS) {
      const years = Math.floor((Date.now() - freshestMs) / (365 * 24 * 3600 * 1000));
      return {
        cik: String(cik),
        company_name: resolvedEntityName || freshest.doc.entityName || null,
        concept,
        candidates_tried: candidates,
        period: (period ?? 'all').trim().toLowerCase(),
        reported: false,
        latest: null,
        values: [],
        stale_tag: { tag: freshest.doc.tag, latest_period_end: freshest.latestEnd, years_old: years },
        note: `No CURRENT value for "${concept}" is available from SEC's XBRL API for this filer. The freshest tag we can see, ${freshest.doc.tag}, stops at ${freshest.latestEnd} (~${years}y old) and every alternative name 404s — but the company may well still be filing. The usual cause is that the filer reports this line only under a dimension (most often segment breakdowns, e.g. Ford splits long-term debt into Company-vs-Ford-Credit and publishes no consolidated total); companyfacts and companyconcept expose UNDIMENSIONED facts only, so a dimension-only line is invisible here regardless of which tag is requested. latest is null, not zero, and deliberately not the ${freshest.latestEnd} figure — that number is real history but is NOT this company's current ${concept}. To get the current value, read the segment table in the latest filing directly: edgar_filings({cik:"${cikOrTicker}", form:"10-Q"}). To see every tag this filer does publish undimensioned, call edgar_company_facts({cik:"${cikOrTicker}"}).`,
      };
    }
  }
  if (found.length === 0) {
    // Distinguish a genuine "this filer doesn't report the concept" (every
    // lookup 404'd) from an upstream failure (SEC throttle / 5xx). Only the
    // latter should surface as an error the caller retries. A 404 after we've
    // exhausted us-gaap candidates + IFRS + a full company-facts name scan
    // means the concept is genuinely absent — for a balance-sheet item like
    // long-term debt on an equity-funded filer, that's the FACT "reports none",
    // not a failure. Return it as a clean not-reported result (usable answer,
    // and it stops mis-classifying as an error). Was the single largest edgar
    // error class (LongTermDebt on clinical-stage biotechs, 2026-07).
    if (lastStatus === 403 || lastStatus === 429 || lastStatus >= 500) {
      throw new Error(
        `SEC EDGAR company concept error: ${lastStatus} — SEC upstream ${lastStatus === 403 || lastStatus === 429 ? 'rate-limited' : 'unavailable'} while resolving "${concept}" for CIK ${paddedCik}. Retry shortly.`,
      );
    }
    // Nothing resolved the entity's NAME either, and companyfacts 404'd — so
    // this CIK is not a registrant, and the not-reported answer below would be
    // a statement about a company that does not exist ("this filer reports no
    // tag" implies a filer). Requires BOTH conditions: a real filer whose
    // companyfacts merely 404s still has resolvedEntityName from elsewhere and
    // keeps the deliberate not-reported behaviour.
    if (!resolvedEntityName && lastStatus === 404) {
      throw submissionsError(404, cikOrTicker, paddedCik);
    }
    return {
      cik: String(cik),
      company_name: resolvedEntityName || null,
      concept,
      candidates_tried: candidates,
      period: (period ?? 'all').trim().toLowerCase(),
      reported: false,
      latest: null,
      values: [],
      note: `This filer reports no XBRL tag matching "${concept}" under any recognized name — checked us-gaap candidates ${JSON.stringify(candidates)}, IFRS, and a full company-facts name scan. This means EITHER the company genuinely has none (common for e.g. long-term debt at equity-funded filers) OR it reports the item under a tag we didn't match (e.g. convertible/other debt lines). value is null, not zero — call edgar_company_facts({cik:"${cikOrTicker}"}) to see the exact tags this filer uses before treating it as absent.`,
    };
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
  type Raw = { start?: string; end: string; val: number; accn: string; fy: number; fp: string; form: string; filed: string; frame?: string };
  const spanDays = (a?: string, b?: string) => (a && b) ? Math.round((Date.parse(b) - Date.parse(a)) / 86400000) : NaN;
  // Does this fact's DURATION match its period label? A 10-Q files BOTH the
  // discrete 3-month quarter AND the year-to-date figure under the same
  // (fy, fp, end) tuple, filed the same day — so "most recently filed" was a
  // coin toss between them, and the YTD often won: "AAPL revenue Q3" answered
  // with NINE MONTHS of revenue labeled Q3 (found via fleet #250). Prefer the
  // fact whose span matches the label; fall back to filing recency only
  // between facts of the same shape.
  const labelFits = (e: Raw): boolean => {
    const span = spanDays(e.start, e.end);
    if (Number.isNaN(span)) return false; // instant concepts have no start; nothing to prefer
    return /^Q[123]$/.test(e.fp ?? '') ? (span >= 80 && span <= 100) : (span >= 330 && span <= 400);
  };
  const dedup = new Map<string, { entry: Raw; unit: string }>();
  for (const [unit, values] of unitEntries(data.units)) {
    for (const e of values) {
      if (!forms.has(e.form)) continue; // period-scoped: annual (10-K/20-F/40-F), quarterly (10-Q), or all
      const key = `${unit}|${e.fy ?? ''}|${e.fp ?? 'FY'}|${e.end ?? ''}`;
      const prior = dedup.get(key);
      if (!prior
        || (labelFits(e) && !labelFits(prior.entry))
        || (labelFits(e) === labelFits(prior.entry) && (e.filed ?? '') > (prior.entry.filed ?? ''))) {
        dedup.set(key, { entry: e, unit });
      }
    }
  }
  const entries = [...dedup.values()]
    .map(({ entry, unit }) => ({
      fiscal_year: entry.fy,
      fiscal_period: entry.fp ?? 'FY', // FY (annual) | Q1 | Q2 | Q3
      period_start: entry.start,
      period_end: entry.end,
      value: entry.val,
      form: entry.form, // 10-K / 10-Q / 20-F / 40-F (+ /A amendments)
      filed: entry.filed,
      unit,
      derived: false as boolean | undefined,
      note: undefined as string | undefined,
    }))
    .sort((a, b) => (b.period_end ?? '').localeCompare(a.period_end ?? ''));

  // Derive standalone Q4 rows. SEC filers report Q1-Q3 in 10-Qs and the full
  // year in the 10-K — a standalone Q4 fact does not exist in XBRL, so a
  // question like "Apple revenue Q4 2024" was structurally unanswerable from
  // this payload, and callers reached for `latest` instead (a confidently
  // wrong period — fleet #250). Q4 = FY − Q1 − Q2 − Q3, computed only when
  // the arithmetic is actually valid:
  //   - duration concepts only (rows carry period_start). Instant concepts
  //     (cash, assets) are point-in-time — the FY value IS the year-end
  //     reading and subtraction is meaningless.
  //   - not per-share/ratio units ("USD/shares"): EPS does not sum across
  //     quarters when the share count moves.
  //   - the FY row must span 330-400 days. 10-K comparative periods are
  //     reported under the FILING's fiscal year (a fy-2019 row can carry
  //     fiscal 2017 dates — the known contamination trap), so trusting `fy`
  //     alone subtracts quarters from the wrong year; the date window is
  //     what makes the row the year it claims to be.
  //   - exactly 3 distinct ~quarter-length (80-100d) windows inside the FY
  //     window. Fewer means a quarter is missing; more means duplicate or
  //     YTD rows slipped in, and either way the subtraction is garbage.
  const derivedQ4: typeof entries = [];
  for (const fyRow of entries) {
    if (fyRow.fiscal_period !== 'FY' || fyRow.unit.includes('/')) continue;
    const span = spanDays(fyRow.period_start, fyRow.period_end);
    if (!(span >= 330 && span <= 400)) continue;
    const quarters = new Map<string, typeof entries[number]>();
    for (const q of entries) {
      if (!/^Q[123]$/.test(q.fiscal_period) || q.unit !== fyRow.unit) continue;
      const qSpan = spanDays(q.period_start, q.period_end);
      if (!(qSpan >= 80 && qSpan <= 100)) continue;
      if (!q.period_start || !fyRow.period_start || q.period_start < fyRow.period_start || q.period_end > fyRow.period_end) continue;
      quarters.set(`${q.period_start}|${q.period_end}`, q);
    }
    if (quarters.size !== 3) continue;
    const qSum = [...quarters.values()].reduce((s, q) => s + q.value, 0);
    derivedQ4.push({
      fiscal_year: fyRow.fiscal_year,
      fiscal_period: 'Q4',
      period_start: undefined,
      period_end: fyRow.period_end,
      value: fyRow.value - qSum,
      form: 'derived',
      filed: fyRow.filed,
      unit: fyRow.unit,
      derived: true,
      note: 'Computed as FY minus Q1-Q3 — SEC filers do not report a standalone Q4 fact.',
    });
  }
  if (derivedQ4.length > 0) {
    // A fiscal year re-reported as a 10-K comparative period spans the same
    // dates as the original FY row and would mint a duplicate Q4 — keep one
    // derivation per (period_end, unit). Prefer the LOWEST fiscal_year label:
    // comparatives carry the FILING's fy over earlier dates (a fy-2026 row
    // spanning fiscal 2024), so the lowest label per window is the original
    // 10-K's, the one whose year actually names the window.
    const byWindow = new Map<string, typeof entries[number]>();
    for (const d of derivedQ4) {
      const k = `${d.period_end}|${d.unit}`;
      const prior = byWindow.get(k);
      if (!prior || (d.fiscal_year ?? Infinity) < (prior.fiscal_year ?? Infinity)) byWindow.set(k, d);
    }
    entries.push(...byWindow.values());
    entries.sort((a, b) => (b.period_end ?? '').localeCompare(a.period_end ?? ''));
  }

  // PERIOD FILTER (fleet #2058). `fiscal_year` and `fiscal_period` are the
  // names of two fields on every row below, and callers asking a one-period
  // question ("net income fiscal 2024") send them as ARGUMENTS — measured on
  // every partial-outcome call this tool logged over three days. They used to
  // be undeclared, so the gateway dropped them and the caller got all 89-230
  // periods back with no indication its filter had been ignored: the
  // dropped-filter-returns-too-much shape, where whichever period the
  // synthesizer happens to read becomes the answer. Honor them instead.
  //
  // An unmatched filter returns NO rows and says which periods exist, rather
  // than falling back to every period — a filter that silently widens is how a
  // confidently-wrong year gets reported, and `latest` is deliberately null so
  // there is no plausible number sitting there to be mistaken for the one
  // asked for.
  const fyWanted = fiscalYearArg === undefined || fiscalYearArg === null || String(fiscalYearArg).trim() === ''
    ? null
    : String(fiscalYearArg).trim();
  const fpWanted = typeof fiscalPeriodArg === 'string' && fiscalPeriodArg.trim()
    ? fiscalPeriodArg.trim().toUpperCase()
    : null;
  let periodFilter: Record<string, unknown> | undefined;
  let rows = entries;
  if (fyWanted || fpWanted) {
    const matched = entries.filter((e) =>
      (!fyWanted || String(e.fiscal_year) === fyWanted)
      && (!fpWanted || String(e.fiscal_period).toUpperCase() === fpWanted));
    const availableYears = [...new Set(entries.map((e) => e.fiscal_year).filter((y) => y != null))].sort((a, b) => Number(b) - Number(a));
    const availablePeriods = [...new Set(entries.map((e) => String(e.fiscal_period)))].sort();
    rows = matched;
    periodFilter = {
      fiscal_year: fyWanted,
      fiscal_period: fpWanted,
      matched: matched.length,
      of_periods_reported: entries.length,
      ...(matched.length === 0
        ? {
            available_fiscal_years: availableYears,
            available_fiscal_periods: availablePeriods,
            note:
              `No row matches ${[fyWanted ? `fiscal_year ${fyWanted}` : null, fpWanted ? `fiscal_period ${fpWanted}` : null].filter(Boolean).join(' + ')} for "${data.tag}". `
              + `values is EMPTY and latest is null on purpose — this filer's reported periods are ${availableYears.length ? `fiscal years ${availableYears.join(', ')}` : '(none)'}`
              + `${availablePeriods.length ? ` and periods ${availablePeriods.join(', ')}` : ''}, so no number here is the one you asked for. `
              + `fiscal_year is the FILER'S OWN label, not a calendar year (NVDA's FY2024 ended January 2024), and on a 10-K's comparative rows it carries the FILING's fiscal year rather than the year the dates fall in — if you need an exact window, drop the filter and match on period_end instead.`,
          }
        : {}),
      // A matched filter is not automatically an unambiguous one. A 10-K tags
      // its COMPARATIVE periods under the filing's own fiscal year, so
      // fiscal_year 2023 on ITW returns three rows all labeled 2023 with
      // period_end 2023-12-31, 2022-12-31 and 2021-12-31 (verified live).
      // Every one is a real filed fact; only the first is the year the label
      // names. `values` is sorted period_end DESC and `latest` is already that
      // first row, so the right answer is what a caller gets by default — but
      // say so here rather than leaving three same-labeled numbers to be
      // picked between, which is the confidently-wrong-period failure this
      // filter exists to prevent.
      ...((() => {
        if (matched.length < 2) return {};
        const ends = [...new Set(matched.map((e) => e.period_end))];
        if (ends.length < 2) return {};
        return {
          ambiguity_note:
            `${matched.length} rows carry the label fiscal_year ${matched[0].fiscal_year}, covering ${ends.length} different periods (${ends.join(', ')}). `
            + `That is a 10-K reporting its comparative years under the FILING's fiscal year, not ${matched[0].fiscal_year} being reported ${matched.length} times. `
            + `values[0] and latest are the row whose dates actually fall in the labeled year (period_end ${ends[0]}) — use those, and read period_end rather than fiscal_year if you need to be certain which window a figure covers.`,
        };
      })()),
    };
  }

  // SUBSTITUTION DISCLOSURE (fleet #219).
  //
  // The name-scan fallback above matches any us-gaap tag CONTAINING a candidate
  // token, which is what makes it useful — filers rename things constantly, and
  // finding LongTermDebtAndCapitalLeaseObligations when you asked for
  // LongTermDebt is the whole point. But containment cuts both ways: asking for
  // InterestExpense matches FinanceLeaseInterestExpense, and Delta then returns
  // $37M of finance-lease interest as though it were total interest expense —
  // off by an order of magnitude, well-formed, and with nothing on it to say so.
  // A credit analyst reads that number and misjudges the debt burden.
  //
  // `concept` already carries the tag actually served, so a careful caller
  // COULD notice. Nobody does: the synthesizing model reads a plausible number
  // under a plausible label and reports it. This file already refuses to hand
  // back a stale figure without a marker, for exactly the reason stated in the
  // comment above — "a well-formed, plausible answer with no marker on it, so
  // neither the caller nor any automatic check can tell it apart". A
  // substituted tag is the same shape, and gets the same treatment.
  const requested = concept.trim();
  const substituted = requested.length > 0
    && data.tag.toLowerCase().replace(/[^a-z0-9]/g, '') !== requested.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Coverage-bound disclosure (fleet #693). A returned value can be genuinely
  // CURRENT for this exact XBRL tag while a newer periodic filing exists that
  // simply doesn't reuse the tag — verified live on Brown-Forman (CIK 14693):
  // its FY2026 10-K (filed 2026-06-12) tags dozens of concepts but never
  // us-gaap:CommonStockSharesOutstanding, and dei:EntityCommonStockSharesOutstanding
  // is 404 across BF's ENTIRE XBRL history (confirmed via companyfacts — not a
  // one-year gap, this filer has never used that dei tag). SEC's own
  // companyconcept API is correct as far as it goes; the gap is upstream, in
  // what the filer chose to tag. That's invisible to the 3-year stale-tag
  // guard above (BF is ~15mo, not ~3y) and reads exactly like a current
  // answer with nothing on it to say otherwise — the same failure shape that
  // guard exists to prevent, just under its threshold. Flag it whenever the
  // freshest fact is older than one normal filing cycle for its own form
  // type. No extra fetch: compare the fact's own `filed` date to today.
  // Filtered rows, not every row: with fiscal_year/fiscal_period set, `latest`
  // must be the freshest fact WITHIN the period asked for, or the one field a
  // synthesizer reaches for first would answer a different year than the
  // question (fleet #2058).
  const latestFact = rows.find((e) => !e.derived) ?? null;
  let coverageBound: string | undefined;
  if (latestFact?.filed) {
    const daysSinceFiled = (Date.now() - Date.parse(latestFact.filed)) / 86400000;
    const isAnnual = ANNUAL_FORMS.has(latestFact.form);
    const cycleDays = isAnnual ? 400 : 120; // ~13mo (annual cadence + filing-lag grace) / ~4mo (quarterly + grace)
    if (Number.isFinite(daysSinceFiled) && daysSinceFiled > cycleDays) {
      coverageBound =
        `This is the freshest value SEC's XBRL API has for "${data.tag}" — from a ${latestFact.form} filed ` +
        `${latestFact.filed}, ${Math.floor(daysSinceFiled)} days ago, past the normal ${isAnnual ? 'annual' : 'quarterly'} filing cycle. ` +
        `If ${data.entityName} has filed a newer ${isAnnual ? '10-K' : '10-Q'} since then, it may simply not tag this specific concept in it ` +
        `(confirmed on Brown-Forman's FY2026 10-K: it tags hundreds of other concepts, not this one, and never tags the dei cover-page ` +
        `share count either) — this is not necessarily a gap in our data. Check edgar_company_filings({ticker_or_cik:"${cikOrTicker}"}) ` +
        `for filings newer than ${latestFact.filed}, and edgar_company_facts({cik:"${String(data.cik)}"}) for every tag the filer currently uses.`;
    }
  }

  return {
    cik: String(data.cik),
    company_name: data.entityName,
    concept: data.tag,
    ...(substituted
      ? {
          requested_concept: requested,
          concept_substituted: true,
          substitution_note:
            `You asked for "${requested}"; this filer does not report that exact tag, so the closest matching tag ` +
            `"${data.tag}" (${data.label}) is returned instead. These are NOT interchangeable — a narrower tag can be ` +
            `a small fraction of the concept you asked for. Do NOT present this as "${requested}" without saying which ` +
            `tag it came from. Call edgar_company_facts({cik:"${String(data.cik)}"}) to see every tag this filer uses.`,
        }
      : {}),
    label: data.label,
    description: data.description,
    period: (period ?? 'all').trim().toLowerCase(),
    // Freshest data point across the requested period — use THIS for
    // point-in-time metrics (cash, runway, debt); it is the latest 10-Q when
    // one is more recent than the last 10-K, so an annual figure never masks a
    // newer quarter. Always a REPORTED fact, never a derived Q4.
    latest: latestFact,
    ...(coverageBound ? { coverage_bound: coverageBound } : {}),
    ...(periodFilter ? { period_filter: periodFilter } : {}),
    values: rows,
    annual_values: rows, // deprecated alias; prefer `values` (now period-scoped)
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

// Tolerates an attribute-bearing opening tag (`<tr class="ro">`, `<Report
// instance="...">`) as well as a bare one — a strict superset of matching
// `<tag>` only, so every existing plain-XML caller (Form 4/N-PORT, no
// attributes) still matches exactly the same blocks it always did.
function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
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

  const res = await pwFetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
  if (!res.ok) throw submissionsError(res.status, tickerOrCik, paddedCik);
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
        const r = await pwFetch(url, { headers: { 'User-Agent': SEC_HEADERS['User-Agent'] } });
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

  const subRes = await pwFetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
  if (!subRes.ok) throw submissionsError(subRes.status, tickerOrCik, paddedCik);
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
  const idxRes = await pwFetch(`${folder}/index.json`, { headers: SEC_HEADERS });
  if (!idxRes.ok) throw await httpError(idxRes, 'SEC EDGAR filing index error');
  const idx = (await idxRes.json()) as { directory: { item: { name: string }[] } };
  const infoFile = idx.directory.item.find(
    (it) => it.name.toLowerCase().endsWith('.xml') && it.name !== 'primary_doc.xml' && !/^xsl/i.test(it.name),
  );
  if (!infoFile) {
    throw new Error(`13F information table not found in filing ${target.accession}.`);
  }

  const tableRes = await pwFetch(`${folder}/${infoFile.name}`, { headers: { 'User-Agent': SEC_HEADERS['User-Agent'] } });
  if (!tableRes.ok) throw await httpError(tableRes, 'SEC EDGAR 13F table error');
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

  // A 13F row for an OPTION is not ownership of the underlying, and a PUT is a
  // BEARISH position. Both facts are carried only by the `putCall` tag, which a
  // reader can easily skip — so a value-ranked list leads with "PALANTIR ...
  // 66.04%" for a manager who is in fact positioned AGAINST Palantir via puts.
  // Misreporting Scion's puts as top holdings is a well-known failure mode. We
  // already parse putCall; the job here is to make it impossible to miss —
  // label direction per row and total the legs separately so nothing sums
  // bullish and bearish notional into one "portfolio".
  const isPut = (pc: string | null) => (pc ?? '').toLowerCase() === 'put';
  const isCall = (pc: string | null) => (pc ?? '').toLowerCase() === 'call';
  const directionOf = (pc: string | null) =>
    isPut(pc) ? 'bearish (put option)' : isCall(pc) ? 'bullish (call option)' : 'long equity';

  const sumWhere = (pred: (h: Agg) => boolean) =>
    all.filter(pred).reduce((s, h) => s + h.value_usd, 0);
  const longEquityValue = sumWhere((h) => !isPut(h.put_call) && !isCall(h.put_call));
  const putValue = sumWhere((h) => isPut(h.put_call));
  const callValue = sumWhere((h) => isCall(h.put_call));

  const holdings = all.slice(0, topN).map((h) => ({
    issuer: h.issuer,
    cusip: h.cusip,
    put_call: h.put_call,
    direction: directionOf(h.put_call),
    value_usd: h.value_usd,
    shares: h.shares,
    // Retained for compatibility, but it divides by a total that mixes option
    // notional with equity; pct_of_long_equity is the one to rank holdings by.
    pct_of_portfolio: totalValue > 0 ? Math.round((h.value_usd / totalValue) * 10000) / 100 : null,
    pct_of_long_equity:
      !isPut(h.put_call) && !isCall(h.put_call) && longEquityValue > 0
        ? Math.round((h.value_usd / longEquityValue) * 10000) / 100
        : null,
  }));

  const hasOptions = putValue > 0 || callValue > 0;

  return {
    cik: sub.cik,
    manager_name: sub.name,
    form: '13F-HR',
    report_period: target.period,
    filed_date: target.filed,
    total_portfolio_value_usd: totalValue,
    // Split the single "portfolio value" into legs that mean different things.
    // For options these are the NOTIONAL value of the underlying shares, not
    // premium paid — a $912M put line is not $912M of capital at risk.
    position_summary: {
      long_equity_value_usd: longEquityValue,
      put_option_notional_usd: putValue,
      call_option_notional_usd: callValue,
      long_equity_positions: all.filter((h) => !isPut(h.put_call) && !isCall(h.put_call)).length,
      put_positions: all.filter((h) => isPut(h.put_call)).length,
      call_positions: all.filter((h) => isCall(h.put_call)).length,
    },
    interpretation_note: hasOptions
      ? 'This filing contains OPTION positions. A `put` row is a BEARISH bet against the issuer, not a holding of it — do not describe it as something the manager owns. For option rows, value_usd is the notional value of the underlying shares, not premium paid or capital at risk, so it is not comparable to an equity position of the same dollar size. Rank actual holdings by pct_of_long_equity; total_portfolio_value_usd sums all legs and is not a meaningful portfolio size.'
      : 'All positions are long equity (no options in this filing).',
    total_positions: all.length,
    holdings_returned: holdings.length,
    holdings,
  };
}

// ── Fund / ETF holdings (Form N-PORT) ───────────────────────────────

function decodeEntities(s: string | null): string | null {
  if (s == null) return null;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

// ETF/mutual-fund ticker → {cik, seriesId}. The MF ticker file (~28k rows) is
// separate from company_tickers.json; cache it in-isolate after first fetch.
let mfTickerCache: Map<string, { cik: string; seriesId: string }> | null = null;
async function resolveFundTicker(ticker: string): Promise<{ cik: string; seriesId: string } | null> {
  if (!mfTickerCache) {
    const res = await pwFetch('https://www.sec.gov/files/company_tickers_mf.json', { headers: SEC_HEADERS });
    if (!res.ok) throw await httpError(res, 'SEC fund-ticker lookup error');
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
  if (!t) throw new Error(
    'A fund ticker is required: pass `ticker`, or its alias `ticker_or_cik` — an ETF or ' +
    'mutual-fund ticker like "ARKK", "QQQ" or "VOO". N-PORT funds are keyed by ticker, so a ' +
    'bare CIK has nothing to match here. Example: edgar_fund_holdings({ticker: "ARKK"}).'
  );
  const topN = Math.min(100, Math.max(1, limit ?? 25));

  const resolved = await resolveFundTicker(t);
  if (!resolved) {
    return { ticker: t.toUpperCase(), error: 'not_found', message: `"${t}" is not a known N-PORT-filing fund/ETF ticker. Use a fund ticker like "ARKK", "QQQ", "VTI", or "VOO". (Some legacy ETFs structured as unit investment trusts — SPY, DIA — don't file N-PORT; use IVV or VOO for S&P 500.)` };
  }
  const { cik, seriesId } = resolved;
  const paddedCik = padCik(cik);

  const subRes = await pwFetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
  if (!subRes.ok) throw submissionsError(subRes.status, t, paddedCik);
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
        const res = await pwFetch(url, { headers: { 'User-Agent': SEC_HEADERS['User-Agent'] } });
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

// ── Companies by SIC (peer / competitor lookup) ─────────────────────
//
// EDGAR exposes an SIC (Standard Industrial Classification) code on every
// filer's submissions record, but nothing in this pack (or the sibling `sec`
// pack) could go the other direction — SIC -> list of filers. compare_entities
// only compares companies already named; there was no way to FIND the peer
// set. Fleet #689.
//
// Upstream: browse-edgar's `output=atom` company-search. Two upstream quirks,
// both verified live (curl, 2026-08-30):
//   1. Leaving `type` blank (or omitted) makes the endpoint hang/stall rather
//      than erroring — confirmed by a request that never returned inside 120s.
//      Always pass a non-empty `type`; default it to "10-K" (active reporters).
//   2. The atom feed's <entry title> and <company-info name> are both the
//      literal string "ARRAY(0x...)" — a long-standing bug on SEC's side where
//      the feed serializes a PHP/Perl array ref instead of the company name.
//      Only <cik> is usable from the feed itself, so names/tickers are joined
//      in afterward from the company_tickers.json bulk file (already used by
//      sponsor_to_filer) — which only covers filers with a listed ticker.
//      Filers without one still appear, with ticker/company_name left null
//      rather than silently dropped (SEC registrants that aren't equity-listed
//      are still real peers for some questions, e.g. "who else files in SIC X").

interface SicPeer { cik: string; ticker: string | null; company_name: string | null }

async function resolveEntitySic(tickerOrCik: string): Promise<{ cik: string; name: string | null; sic: string | null; sic_description: string | null }> {
  const cik = await resolveCik(tickerOrCik);
  const paddedCik = padCik(cik);
  const res = await pwFetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
  if (!res.ok) throw submissionsError(res.status, tickerOrCik, paddedCik);
  const data = (await res.json()) as { name?: string; sic?: string; sicDescription?: string };
  return {
    cik: String(Number(cik)),
    name: data.name ?? null,
    sic: data.sic && data.sic.trim() ? data.sic.trim() : null,
    sic_description: data.sicDescription ?? null,
  };
}

async function companiesBySic(
  sicArg: string | undefined,
  tickerOrCik: string | undefined,
  formTypeArg: string | undefined,
  excludeSelfArg: boolean | undefined,
  limitArg: number | undefined,
): Promise<unknown> {
  let sic = sicArg?.trim();
  let sicDescription: string | null = null;
  let selfCik: string | null = null;
  let selfName: string | null = null;

  if (!sic) {
    if (!tickerOrCik || !tickerOrCik.trim()) {
      return {
        error: 'An argument is required: pass either `sic` (a SIC code, e.g. "3571") or a company as `ticker_or_cik` — aliases `cik` / `ticker` — whose own SIC should be resolved first.',
        retry_hint: 'edgar_companies_by_sic({ticker_or_cik: "AAPL"}) or edgar_companies_by_sic({sic: "3571"}).',
      };
    }
    const resolved = await resolveEntitySic(tickerOrCik);
    if (!resolved.sic) {
      return {
        status: 'no_sic',
        cik: resolved.cik,
        company_name: resolved.name,
        message: `SEC EDGAR has no SIC code on file for CIK ${resolved.cik} (${resolved.name ?? tickerOrCik}) — cannot find peers by industry code. Try edgar_company_filings for this filer's own history instead.`,
      };
    }
    sic = resolved.sic;
    sicDescription = resolved.sic_description;
    selfCik = resolved.cik;
    selfName = resolved.name;
  }

  if (!/^\d{1,4}$/.test(sic)) {
    return {
      error: `Invalid SIC code "${sic}" — SEC SIC codes are 1-4 digits (e.g. "3571", "2836", "6021").`,
      retry_hint: 'Pass a numeric SIC code, or ticker_or_cik to resolve one from a company.',
    };
  }

  const formType = (formTypeArg?.trim() || '10-K').toUpperCase();
  const excludeSelf = excludeSelfArg !== false; // default true
  const limit = Math.min(100, Math.max(1, Math.floor(Number(limitArg) || 25)));

  // count=100 is SEC's max per page for this endpoint; no pagination beyond
  // that yet — an SIC bucket with >100 active 10-K filers returns only the
  // first 100 (flagged via `possibly_more`, not silently).
  const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&SIC=${encodeURIComponent(sic)}&type=${encodeURIComponent(formType)}&dateb=&owner=include&count=100&output=atom`;
  const res = await pwFetch(url, { headers: { 'User-Agent': SEC_HEADERS['User-Agent'] } });
  if (!res.ok) throw await httpError(res, 'SEC EDGAR company-search error');
  const xml = await res.text();
  const ciks = [...new Set([...xml.matchAll(/<cik>(\d+)<\/cik>/gi)].map((m) => String(Number(m[1]))))];

  if (ciks.length === 0) {
    return {
      sic,
      sic_description: sicDescription,
      form_type: formType,
      total_found: 0,
      peers: [],
      message: `No SEC filers found under SIC ${sic} with form type ${formType}. The code may be unused/retired, or try form_type:"" — though note the upstream search can stall with no type filter; retry rather than omitting it.`,
    };
  }

  const tickerRows = await fetchCompanyTickers().catch(() => [] as SecTickerRow[]);
  const byTickerCik = new Map<string, SecTickerRow>();
  for (const r of tickerRows) byTickerCik.set(String(r.cik_str), r);

  // Best-effort sic_description when we didn't already have it (direct `sic`
  // input, not resolved via a company) — pull it off the first listed peer's
  // submissions record rather than leaving it null.
  if (!sicDescription) {
    const firstListed = ciks.find((c) => byTickerCik.has(c)) ?? ciks[0];
    const one = await resolveEntitySic(firstListed).catch(() => null);
    if (one?.sic === sic) sicDescription = one.sic_description;
  }

  let peerCiks = ciks;
  if (excludeSelf && selfCik) peerCiks = peerCiks.filter((c) => c !== selfCik);

  // browse-edgar's own ordering mixes long-defunct/delisted filers in with
  // current ones (SIC covers everyone who EVER filed the form, not just
  // active reporters) — verified live on SIC 3571: 100 filers returned, only
  // 5 (AAPL, DELL, OMCL, OSS, SCKT) still carry a listed ticker. Sorting
  // ticker-matched filers first means `limit` actually returns the
  // currently-tradable peers a "who competes with X" question wants, instead
  // of truncating to whichever 25 happened to sort first upstream (mostly
  // nulls). Unlisted registrants are still real filers, just pushed after.
  const sortedCiks = [...peerCiks].sort((a, b) => Number(byTickerCik.has(b)) - Number(byTickerCik.has(a)));

  const peers: SicPeer[] = sortedCiks.slice(0, limit).map((c) => {
    const t = byTickerCik.get(c);
    return { cik: c, ticker: t?.ticker ?? null, company_name: t?.title ?? null };
  });

  return {
    sic,
    sic_description: sicDescription,
    ...(selfCik ? { resolved_from: { ticker_or_cik: tickerOrCik, cik: selfCik, company_name: selfName } } : {}),
    form_type: formType,
    exclude_self: excludeSelf,
    total_found: peerCiks.length,
    returned: peers.length,
    possibly_more: ciks.length >= 100,
    source: 'SEC EDGAR company search (browse-edgar), joined with company_tickers.json for name/ticker',
    note: 'SIC is a broad industry bucket assigned once at registration, not a live competitor analysis — some peers may be inactive or only loosely comparable. Filers with no listed ticker still appear (ticker/company_name: null) — they are real SEC registrants, just not equity-listed.',
    peers,
  };
}

// ── Filer subsidiaries (Exhibit 21) ─────────────────────────────────
// The reverse of sponsor_to_filer: given a PARENT filer, list its operating
// subsidiaries as filed in Exhibit 21 (Item 601(b)(21)) of its most recent
// 10-K. Fleet #690 — ZT was rebuilding this per-company via a chain of ~10
// trial-registry-candidate + sponsor_to_filer confirmation calls; this
// replaces that chain with a single authoritative list plus provenance
// (which filing, which exhibit, straight from SEC).

interface Subsidiary { name: string; jurisdiction: string | null }

const EX21_TYPE_RE = /^EX-?21(\.\d+)?$/i;

// Given a filing's -index.html (the human filing-summary page, which —
// unlike index.json — carries a "Type" column such as "EX-21"), find the
// Exhibit 21 document's URL. index.json's `type` field is a generic
// MIME-icon class (e.g. "text.gif" for every .htm file in the filing, exhibit
// 21 included), not the SEC exhibit type, so it can't be used to identify
// EX-21 among a filing's other .htm exhibits — verified live on Merck's
// 2026-02-24 10-K (accession 0000310158-26-000063).
function findExhibit21Url(indexHtml: string): string | null {
  for (const tr of xmlBlocks(indexHtml, 'tr')) {
    const href = /<a[^>]+href="([^"]+\.(?:htm|html|txt))"/i.exec(tr)?.[1];
    if (!href) continue;
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => (htmlToText(m[1]) ?? '').trim());
    if (cells.some((c) => EX21_TYPE_RE.test(c))) {
      return href.startsWith('http') ? href : `https://www.sec.gov${href}`;
    }
  }
  return null;
}

// Parse the EX-21 document into structured rows. SEC's typical layout is a
// 2-column HTML table (Name | Country or State of Incorporation) — verified
// live on Merck. Not every filer's EX-21 uses a table (smaller filers
// sometimes file a plain paragraph list), so this returns [] rather than
// throwing when no table rows parse; the caller falls back to the raw text.
function parseSubsidiaryTable(html: string): Subsidiary[] {
  const out: Subsidiary[] = [];
  for (const tr of xmlBlocks(html, 'tr')) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((m) => (decodeEntities(htmlToText(m[1]))?.trim()) ?? '')
      .filter((c) => c.length > 0);
    if (cells.length < 2) continue;
    const [name, jurisdiction] = cells;
    if (/^name$/i.test(name) || /^(country|state|jurisdiction)/i.test(jurisdiction)) continue; // header row
    if (name.length > 200) continue; // guard against a non-table paragraph blob matching by accident
    out.push({ name, jurisdiction: jurisdiction || null });
  }
  return out;
}

async function filerToSponsors(
  tickerOrCik: string | undefined,
  nameFilterArg: string | undefined,
  limitArg: number | undefined,
): Promise<unknown> {
  if (typeof tickerOrCik !== 'string' || !tickerOrCik.trim()) {
    return {
      error: 'A company is required: pass `ticker_or_cik`, or its aliases `cik` / `ticker` — all three take a ticker ("MRK") or a CIK ("310158").',
      retry_hint: 'filer_to_sponsors({ticker_or_cik: "MRK"}) or pass a CIK, e.g. "310158".',
    };
  }
  const cik = await resolveCik(tickerOrCik);
  const paddedCik = padCik(cik);
  const limit = Math.min(500, Math.max(1, Math.floor(Number(limitArg) || 200)));
  const nameFilter = nameFilterArg?.trim().toLowerCase();

  const subRes = await pwFetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
  if (!subRes.ok) throw submissionsError(subRes.status, tickerOrCik, paddedCik);
  const sub = (await subRes.json()) as {
    name?: string;
    filings?: { recent?: { accessionNumber?: string[]; form?: string[]; filingDate?: string[] } };
  };
  const r = sub.filings?.recent;
  const forms = r?.form ?? [];
  const accs = r?.accessionNumber ?? [];
  const dates = r?.filingDate ?? [];
  const cikNoZeros = String(Number(cik));

  // Walk the most recent annual filings looking for one that carries an
  // Exhibit 21 — almost always the latest 10-K, but Item 601(b)(21) only
  // requires listing SIGNIFICANT subsidiaries, so a small filer's most recent
  // 10-K can genuinely omit it even when an older one had it.
  const candidates: { idx: number; form: string }[] = [];
  for (let i = 0; i < forms.length && candidates.length < 5; i++) {
    if (forms[i] === '10-K' || forms[i] === '10-K/A') candidates.push({ idx: i, form: forms[i] });
  }
  if (candidates.length === 0) {
    return {
      cik: cikNoZeros,
      company_name: sub.name ?? null,
      status: 'no_10k',
      message: `No 10-K on file for CIK ${cikNoZeros} (${sub.name ?? tickerOrCik}) in the recent filings index — Exhibit 21 is filed as part of the annual report. Foreign private issuers file 20-F instead, which is not yet covered by this tool.`,
      subsidiaries: [],
    };
  }

  for (const c of candidates) {
    const accession = accs[c.idx];
    const accessionPath = accession.replace(/-/g, '');
    const folder = `https://www.sec.gov/Archives/edgar/data/${cikNoZeros}/${accessionPath}`;
    const idxRes = await pwFetch(`${folder}/${accession}-index.html`, { headers: SEC_HEADERS });
    if (!idxRes.ok) continue;
    const idxHtml = await idxRes.text();
    const exUrl = findExhibit21Url(idxHtml);
    if (!exUrl) continue;

    const exRes = await pwFetch(exUrl, { headers: { 'User-Agent': SEC_HEADERS['User-Agent'] } });
    if (!exRes.ok) continue;
    const exHtml = await exRes.text();
    const parsed = parseSubsidiaryTable(exHtml);

    const provenance = {
      source: 'SEC EDGAR Exhibit 21 (Item 601(b)(21))',
      cik: cikNoZeros,
      company_name: sub.name ?? null,
      form: c.form,
      accession,
      filing_date: dates[c.idx] ?? null,
      exhibit_url: exUrl,
    };

    if (parsed.length === 0) {
      // Exhibit exists but didn't parse as a table — return the raw text so
      // the caller isn't left with nothing, flagged as unstructured rather
      // than silently empty.
      const raw = htmlToText(exHtml);
      return {
        ...provenance,
        status: 'unstructured',
        message: 'Exhibit 21 was found but is not in the standard 2-column table format this parser expects — returning raw text instead of structured rows.',
        raw_text: raw.length > 20000 ? raw.slice(0, 20000) + '\n…[truncated]' : raw,
        subsidiaries: [],
      };
    }

    const filtered = nameFilter ? parsed.filter((s) => s.name.toLowerCase().includes(nameFilter)) : parsed;
    return {
      ...provenance,
      status: 'ok',
      total_subsidiaries: parsed.length,
      returned: Math.min(filtered.length, limit),
      ...(nameFilter ? { name_filter: nameFilter, name_filter_matches: filtered.length } : {}),
      subsidiaries: filtered.slice(0, limit),
    };
  }

  return {
    cik: cikNoZeros,
    company_name: sub.name ?? null,
    status: 'no_exhibit_21',
    message: `Checked the ${candidates.length} most recent 10-K/10-K/A filing(s) for CIK ${cikNoZeros} (${sub.name ?? tickerOrCik}) and none carried an Exhibit 21 — the filer may have no significant subsidiaries to disclose (common for smaller/single-entity companies), or files under a different form (foreign private issuers use 20-F, not covered here).`,
    checked_filings: candidates.map((c) => ({ form: c.form, accession: accs[c.idx], filing_date: dates[c.idx] ?? null })),
    subsidiaries: [],
  };
}

// ── Product-level / disaggregated revenue (10-K segment notes) ─────
// Fleet #691. XBRL companyfacts/companyconcept expose only UNDIMENSIONED
// facts (see the LongTermDebt/Ford note on companyConcept above) — product-
// level revenue is almost always tagged WITH a dimension (a custom segment
// axis with a "Keytruda [Member]", or srt:ProductOrServiceAxis), so it is
// invisible to those APIs no matter which tag is requested. It IS visible in
// SEC's own "Financial Report" R*.htm viewer pages, which render every
// dimensional breakdown as a standardized Arelle-generated HTML table — the
// SAME table markup across virtually every modern XBRL filer, because SEC's
// own renderer produces it, not the filer. Verified live on Merck's FY2025
// 10-K (accession 0000310158-26-000063): FilingSummary.xml names report
// "9955598 - Disclosure - Segment Reporting - Schedule of Sales of Company's
// Products (Details)" -> R119.htm -> a "Sales" row under the
// "Operating Segments | Pharmaceutical | Keytruda" dimension = $31,641M.

interface DisaggRow { dimension: string | null; concept: string; values: { period: string; value: string }[] }

// Ordered by specificity — the first PATTERN that matches ANY report wins,
// not the first report matching ANY pattern, so a precise "Sales of
// Products" report outranks a looser "revenue by segment" one when a filer
// has both. Geographic-only breakdowns are excluded explicitly: they use the
// same report-naming conventions but answer a different question.
// Report titles in FilingSummary.xml are structured `<num> - Disclosure - <Note>
// - <Subject> (Details)`. Matching on the SUBJECT (the text after the last
// " - ") rather than the whole string is what makes the geographic exclusion
// safe: ABBV files its product table as "Segment and Geographic Area
// Information - Disaggregation of Revenue (Details)", so a blanket
// /geographic/ skip on the full title threw away the very report we wanted,
// while PFE's genuinely geo-only "Revenues by Geographic Area (Detail)" must
// still be skipped. Both are decided correctly on the subject.
function reportSubject(longName: string): string {
  const parts = longName.split(' - ');
  return (parts.length > 1 ? parts[parts.length - 1] : longName).trim();
}

// Tier 1: the filer names a product/turnover breakdown outright.
const REPORT_NAME_PATTERNS: RegExp[] = [
  /sales of .*compan.*products/i,
  /revenues? by [\w\s,&]{0,40}product/i,
  /net sales by product/i,
  /product (net )?(sales|revenues?)/i,
  /(net |gross )?(sales|revenues?)[\w\s,&]{0,30}by product/i,
  /turnover by product/i,
  /major product/i,
  /disaggregat(ed|ion) of (net )?revenues?/i,
  /revenue.*by segment and product/i,
  /\btop \d+\b/i, // Novartis titles its per-product table "… - Top 20 (Details 5)"
];

// Tier 2: no product wording, but the report is still the revenue
// disaggregation note — its XBRL dimensions carry the products (verified:
// Novo Nordisk's "Business segments and geographical areas" rows are Ozempic /
// Rybelsus; Sanofi's are Dupixent / Aubagio; Incyte's bare "Revenues
// (Details)" is JAKAFI / OPZELURA). Only tried when tier 1 finds nothing.
const REPORT_NAME_PATTERNS_FALLBACK: RegExp[] = [
  /\bnet sales\b/i,
  /sales by segment/i,
  /\brevenues?\s*\(detail/i,
];

// Subjects that are about the mechanics of revenue (reserves, rebates,
// concentration) rather than the revenue breakdown itself. Without this,
// SRPT's "Reserves for Product Revenues" outranks its "Summary of Product
// Revenues", and UTHR's "Revenue Recognition" would match tier 2.
const REPORT_NOISE = /footnote|narrative|parenthetical|additional information|concentration|reconciliation|recognition|\breserves?\b|allowance|rebate|discount|deduction|milestone|receivable|contract balance|performance obligation|remaining|returns/i;

const REPORT_GEO_ONLY = /\bgeograph/i;
const REPORT_PRODUCT_SIGNAL = /product|segment|top \d+/i;

async function findRevenueReport(folder: string): Promise<{ url: string; report_name: string } | null> {
  const res = await pwFetch(`${folder}/FilingSummary.xml`, { headers: SEC_HEADERS });
  if (!res.ok) return null;
  const xml = await res.text();
  // FilingSummary.xml's <Report> elements carry an `instance="..."`
  // attribute (e.g. <Report instance="mrk-20251231.htm">) — xmlBlocks
  // tolerates that.
  const reports = xmlBlocks(xml, 'Report');

  const candidates = reports
    .map((rep) => {
      const longName = xmlVal(rep, 'LongName') ?? '';
      const html = xmlVal(rep, 'HtmlFileName');
      return { longName, subject: reportSubject(longName), html };
    })
    .filter((c) => {
      if (!c.html || !c.longName) return false;
      if (REPORT_NOISE.test(c.subject)) return false;
      // Geographic-only reports are the wrong axis — but a subject that also
      // names products or segments is the right one wearing a geo label.
      if (REPORT_GEO_ONLY.test(c.subject) && !REPORT_PRODUCT_SIGNAL.test(c.subject)) return false;
      return true;
    });

  // A filer publishes both the section-level report ("NET PRODUCT REVENUES")
  // and the rendered table ("… - Schedule of Net Product Revenues (Detail)").
  // Only the latter parses into rows, so it is tried first — ALNY and SRPT
  // both returned status "unparsed" because the section-level one won.
  const isDetails = (n: string) => /\(detail(s)?(\s+\d+)?\)\s*$/i.test(n.trim());
  for (const tier of [REPORT_NAME_PATTERNS, REPORT_NAME_PATTERNS_FALLBACK]) {
    for (const detailsOnly of [true, false]) {
      for (const pat of tier) {
        for (const c of candidates) {
          if (detailsOnly !== isDetails(c.longName)) continue;
          if (!pat.test(c.longName)) continue;
          return { url: `${folder}/${c.html}`, report_name: decodeEntities(c.longName) ?? c.longName };
        }
      }
    }
  }
  return null;
}

// Parse an SEC Financial-Report R*.htm page into dimensional rows. Standard
// Arelle-rendered structure (SEC's own viewer, consistent across filers):
//   - Header <tr>s carry <th class="th"><div>period label</div></th> cells
//     (e.g. "Dec. 31, 2025").
//   - A "context" row sets the dimension breadcrumb (e.g. "Operating
//     Segments | Pharmaceutical | Keytruda") for the data rows that follow
//     it, until the next context row — identified as a row whose concept
//     link references an XBRL Axis (`Axis=` in the href) and which carries
//     no numeric values itself.
//   - "[Line Items]" / "[Table]" / "[Abstract]" / "[Domain]" label rows are
//     structural noise (bolded headers with blank values) — skipped, never
//     treated as a context or a data row.
//   - A data row carries one value cell (`class="num"`/`"nump"`) per period
//     column alongside its own concept label (e.g. "Sales").
// Best-effort: filers occasionally deviate from this shape (older filings,
// non-Arelle renders) — an empty `rows` array means "didn't parse", not
// "reports zero", and is flagged as such by the caller.
function parseDisaggregatedRevenue(html: string): { periods: string[]; rows: DisaggRow[]; units_note: string | null } {
  const titleMatch = /<th[^>]*>\s*<div[^>]*>\s*<strong>([\s\S]*?)<\/strong>/i.exec(html);
  const titleText = titleMatch ? htmlToText(titleMatch[1]) : '';
  const unitsMatch = /\$\s*in\s*(Thousands|Millions|Billions)/i.exec(titleText);
  const unitsNote = unitsMatch ? `$ in ${unitsMatch[1]}` : null;

  // Period columns come from two header rows: an optional duration row
  // (<th class="th" colspan="3">12 Months Ended</th>, carrying no <div>) and
  // the date row. ABBV writes its date row as
  //   <th class="th">\n<div>Dec. 31, 2025 </div>\n<div>USD ($)</div>\n</th>
  // — a newline after the tag and several <div>s — which a single-line
  // "<th class=\"th\"><div>…</div></th>" pattern misses completely. That left
  // `periods` empty, so every row's `values` filtered down to nothing and the
  // tool returned status "ok" with 76 rows and not one dollar figure.
  const durations: string[] = [];
  const dateLabels: string[] = [];
  for (const m of html.matchAll(/<th class="th"([^>]*)>([\s\S]*?)<\/th>/gi)) {
    const divs = [...(m[2] ?? '').matchAll(/<div[^>]*>([\s\S]*?)<\/div>/gi)].map((d) => htmlToText(d[1]).trim());
    if (divs.length === 0) {
      const span = Math.max(1, Number(/colspan="(\d+)"/i.exec(m[1] ?? '')?.[1] ?? 1));
      const label = htmlToText(m[2] ?? '').trim();
      for (let i = 0; i < span; i++) durations.push(label);
      continue;
    }
    if (divs[0]) dateLabels.push(divs[0]); // later <div>s are the unit ("USD ($)") and axis qualifiers
  }
  // Two columns can carry the SAME date over different durations — ABBV reports
  // both "3 Months Ended Dec. 31, 2025" and "12 Months Ended Dec. 31, 2025", and
  // reading a quarter as the annual figure is the expensive mistake here. Qualify
  // only when the bare date is ambiguous, so single-duration filers keep the
  // period labels they have always returned.
  const ambiguous = new Set(dateLabels.filter((d, i) => dateLabels.indexOf(d) !== i));
  const periods = dateLabels.map((d, i) => (ambiguous.has(d) && durations[i] ? `${durations[i]} ${d}` : d));

  const rows: DisaggRow[] = [];
  let context: string | null = null;
  for (const tr of xmlBlocks(html, 'tr')) {
    const labelMatch = /<td[^>]*class="pl[^"]*"[^>]*>([\s\S]*?)<\/td>/i.exec(tr);
    if (!labelMatch) continue; // header/period row, no row label
    const label = htmlToText(labelMatch[1]).trim();
    if (!label) continue;
    if (/\[(Line Items|Table|Abstract|Domain|Axis)\]/i.test(label)) continue; // structural noise

    // Include the blank <td class="text"> cells: they hold a column's POSITION
    // when a row has no figure for that period. Collecting only the numeric
    // cells and zipping them against `periods` shifts every value left past a
    // gap, which silently files an annual figure under the quarterly column.
    const valueCells = [...tr.matchAll(/<td class="(num[a-z]*|text)"[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((m) => (m[1].toLowerCase() === 'text' ? '' : htmlToText(m[2]).trim()));
    const hasValues = valueCells.some((v) => v.length > 0);
    const referencesAxis = /Axis=/.test(tr);

    if (referencesAxis && !hasValues) {
      context = label;
      continue;
    }
    if (!hasValues) continue; // blank-value row that isn't a recognized axis header — skip

    rows.push({
      dimension: context,
      concept: label,
      values: periods.map((p, i) => ({ period: p, value: valueCells[i] ?? '' })).filter((v) => v.value !== ''),
    });
  }
  return { periods, rows, units_note: unitsNote };
}

async function productRevenue(
  tickerOrCik: string | undefined,
  productFilterArg: string | undefined,
  formTypeArg: string | undefined,
  accessionArg: string | undefined,
  limitArg: number | undefined,
): Promise<unknown> {
  if (typeof tickerOrCik !== 'string' || !tickerOrCik.trim()) {
    return {
      error: 'A company is required: pass `ticker_or_cik`, or its aliases `cik` / `ticker` — all three take a ticker ("MRK") or a CIK ("310158").',
      retry_hint: 'edgar_product_revenue({ticker_or_cik: "MRK", product_filter: "Keytruda"}).',
    };
  }
  const cik = await resolveCik(tickerOrCik);
  const paddedCik = padCik(cik);
  const cikNoZeros = String(Number(cik));
  // Foreign private issuers file 20-F and Canadian MJDS filers 40-F instead of
  // a 10-K, and their rendered R*.htm reports exist just the same. With no
  // form_type from the caller, walk 10-K -> 20-F -> 40-F rather than reporting
  // "no filing" for every non-US-domestic pharma (NVS, AZN, GSK, SNY, NVO, TAK).
  const explicitForm = formTypeArg?.trim() ? formTypeArg.trim().toUpperCase() : null;
  const FORM_FALLBACK_ORDER = ['10-K', '20-F', '40-F'];
  const formCandidates = explicitForm ? [explicitForm] : FORM_FALLBACK_ORDER;
  const productFilter = productFilterArg?.trim().toLowerCase();
  const limit = Math.min(200, Math.max(1, Math.floor(Number(limitArg) || 100)));

  const subRes = await pwFetch(`${DATA_BASE}/submissions/CIK${paddedCik}.json`, { headers: SEC_HEADERS });
  if (!subRes.ok) throw submissionsError(subRes.status, tickerOrCik, paddedCik);
  const sub = (await subRes.json()) as {
    name?: string;
    filings?: { recent?: { accessionNumber?: string[]; form?: string[]; filingDate?: string[] } };
  };
  const r = sub.filings?.recent;
  const forms = r?.form ?? [];
  const accs = r?.accessionNumber ?? [];
  const dates = r?.filingDate ?? [];

  let acc: string | undefined;
  let filingDate: string | null = null;
  let formType: string;
  if (accessionArg) {
    const norm = normalizeAccession(accessionArg);
    if (!norm) throw new Error(`Invalid accession "${accessionArg}" — expected 18 digits shaped 10-2-6.`);
    acc = norm.dashed;
    const i = accs.indexOf(acc);
    filingDate = i >= 0 ? dates[i] ?? null : null;
    formType = (i >= 0 ? forms[i] : null) ?? explicitForm ?? 'unknown';
  } else {
    let idx = -1;
    let picked: string | null = null;
    for (const want of formCandidates) {
      idx = forms.findIndex((f) => f.toUpperCase() === want);
      if (idx >= 0) { picked = want; break; }
    }
    if (idx < 0 || !picked) {
      return {
        cik: cikNoZeros,
        company_name: sub.name ?? null,
        status: 'no_filing',
        resolved_form: null,
        forms_checked: formCandidates,
        message: `No ${formCandidates.join(' / ')} on file for CIK ${cikNoZeros} (${sub.name ?? tickerOrCik}) in the recent filings index.`,
        rows: [],
      };
    }
    formType = picked;
    acc = accs[idx];
    filingDate = dates[idx] ?? null;
  }

  const accessionPath = acc!.replace(/-/g, '');
  const folder = `https://www.sec.gov/Archives/edgar/data/${cikNoZeros}/${accessionPath}`;
  const report = await findRevenueReport(folder);
  if (!report) {
    return {
      cik: cikNoZeros,
      company_name: sub.name ?? null,
      form: formType,
      resolved_form: formType,
      accession: acc,
      filing_date: filingDate,
      status: 'not_found',
      message: `No product/segment revenue disaggregation report was found in this filing's FilingSummary.xml (checked report titles for "sales of products", "disaggregation of revenue", "revenue by product", etc.). Either this filer doesn't disaggregate revenue by product in XBRL, or it uses a title this heuristic doesn't recognize — try edgar_filing_text({ticker_or_cik:"${tickerOrCik}", form_type:"${formType}"}) and read the segment/revenue footnote directly.`,
      rows: [],
    };
  }

  const repRes = await pwFetch(report.url, { headers: { 'User-Agent': SEC_HEADERS['User-Agent'] } });
  if (!repRes.ok) throw await httpError(repRes, 'SEC EDGAR financial report error');
  const repHtml = await repRes.text();
  const parsed = parseDisaggregatedRevenue(repHtml);

  const citation = {
    source: 'SEC EDGAR XBRL Financial Report (Arelle-rendered R.htm viewer)',
    cik: cikNoZeros,
    company_name: sub.name ?? null,
    form: formType,
    resolved_form: formType,
    accession: acc,
    filing_date: filingDate,
    report_name: report.report_name,
    report_url: report.url,
  };

  if (parsed.rows.length === 0) {
    return {
      ...citation,
      status: 'unparsed',
      message: 'Found a matching revenue-disaggregation report but could not parse it into rows with this parser (the filer\'s table structure deviates from the standard Arelle layout). Read report_url directly, or use edgar_filing_text for the prose segment note.',
      periods: parsed.periods,
      rows: [],
    };
  }

  const filtered = productFilter
    ? parsed.rows.filter((row) => (row.dimension ?? row.concept).toLowerCase().includes(productFilter))
    : parsed.rows;

  return {
    ...citation,
    status: 'ok',
    units_note: parsed.units_note,
    periods: parsed.periods,
    total_rows: parsed.rows.length,
    returned: Math.min(filtered.length, limit),
    ...(productFilter ? { product_filter: productFilter, product_filter_matches: filtered.length } : {}),
    note: 'Rows come from the filer\'s own disaggregated-revenue XBRL dimension (e.g. product/segment breakdown), rendered by SEC\'s standard viewer — not free-text extraction. `dimension` is the full breadcrumb (e.g. "Operating Segments | Pharmaceutical | Keytruda"); `concept` is the line-item label (usually "Sales" or "Revenues").',
    rows: filtered.slice(0, limit),
  };
}

// ── callTool router ─────────────────────────────────────────────────

/**
 * The one company argument, under any of the three names this pack uses for it.
 * `ticker_or_cik`, `cik` and `ticker` all mean "a ticker OR a CIK" here —
 * resolveCik() accepts either — so which word a caller reached for is not
 * information, it is noise. Coalesce rather than branch, first non-empty wins.
 */
function companyArg(args: Record<string, unknown>): string {
  for (const key of ['ticker_or_cik', 'cik', 'ticker'] as const) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number') return String(v);
  }
  return args.ticker_or_cik as string;
}

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
    // Every tool below takes the same thing — a company — and this pack spells
    // it three ways across its own tools (`ticker_or_cik`, `cik`, `ticker`), so
    // a model filling arguments from prose reaches for whichever word it read
    // last. All three are DECLARED in each inputSchema and coalesced here; an
    // undeclared argument is dropped today and would be rejected once
    // REJECT_UNKNOWN_ARGS is enforced (#2013), so declaring is what makes the
    // alias real. `required` is empty on those schemas for the same reason —
    // a flat list cannot say "one of these three" (fleet #2058, swept in #2069).
    case 'edgar_company_filings':
      return companyFilings(
        companyArg(args),
        args.form_type as string | undefined,
        args.limit as number | undefined,
      );
    case 'edgar_company_facts':
      return companyFacts(companyArg(args));
    case 'edgar_company_snapshot':
      return companySnapshot(
        companyArg(args),
        args.form_type as string | undefined,
        args.filings_limit as number | undefined,
      );
    case 'edgar_insider_transactions':
      return insiderTransactions(
        companyArg(args),
        args.limit as number | undefined,
        args.include_derivatives as boolean | undefined,
      );
    case 'edgar_institutional_holdings':
      return institutionalHoldings(
        companyArg(args),
        args.limit as number | undefined,
      );
    case 'edgar_fund_holdings':
      return fundHoldings((args.ticker ?? args.ticker_or_cik) as string, args.limit as number | undefined);
    case 'edgar_company_concept':
      // Accept `ticker` / `ticker_or_cik` / `metric` too. The canonical names
      // are `cik` (which takes a ticker OR a CIK) and `concept`, but this
      // pack's own sibling tools spell the company argument three different
      // ways and the description calls the metric a "metric" — so a caller
      // filling arguments from prose reaches for whichever word it just read.
      // Measured: every `partial` outcome recorded for this tool over three
      // days (12/12) sent `ticker`, and a third of those sent `metric` as
      // well; all were rejected before the pack ran (fleet #2058).
      return companyConcept(
        (args.cik ?? args.ticker ?? args.ticker_or_cik) as string,
        (args.concept ?? args.metric) as string,
        args.period as string | undefined,
        args.fiscal_year as string | number | undefined,
        args.fiscal_period as string | undefined,
      );
    case 'edgar_filing_documents':
      return filingDocuments(
        args.accession as string | undefined,
        (args.cik ?? args.ticker ?? args.ticker_or_cik) as string,
        args.include_primary_text as boolean | undefined,
        args.form_type as string | undefined,
      );
    case 'edgar_filing_text':
      return filingText(
        args.accession as string | undefined,
        (args.cik ?? args.ticker ?? args.ticker_or_cik) as string,
        args.section as string | undefined,
        args.max_chars as number | undefined,
        args.offset as number | undefined,
        args.form_type as string | undefined,
      );
    case 'edgar_ticker_to_cik':
      return tickerToCik((args.ticker ?? args.ticker_or_cik ?? args.company) as string);
    case 'sponsor_to_filer':
      return sponsorToFiler((args.sponsor ?? args.name ?? args.ticker) as string);
    case 'filer_to_sponsors':
      return filerToSponsors(
        companyArg(args) as string | undefined,
        args.name_filter as string | undefined,
        args.limit as number | undefined,
      );
    case 'edgar_xbrl_frames':
      return xbrlFrames(args);
    case 'edgar_companies_by_sic':
      return companiesBySic(
        args.sic as string | undefined,
        companyArg(args) as string | undefined,
        args.form_type as string | undefined,
        args.exclude_self as boolean | undefined,
        args.limit as number | undefined,
      );
    case 'edgar_product_revenue':
      return productRevenue(
        companyArg(args) as string | undefined,
        args.product_filter as string | undefined,
        args.form_type as string | undefined,
        args.accession as string | undefined,
        args.limit as number | undefined,
      );
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
  const res = await pwFetch(url, { headers: SEC_HEADERS });
  if (res.status === 404) {
    return { error: 'not_found', concept, period, unit, taxonomy, message: `No SEC frame for ${taxonomy}/${concept}/${unit}/${period}. Check the tag spelling/casing, unit (USD vs shares), and period type (add "I" for balance-sheet/instant items like Assets).` };
  }
  if (!res.ok) throw await httpError(res, 'SEC frames error');
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
