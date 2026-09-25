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
 * Place name -> coordinates, ranked so the answer is the city the asker meant.
 *
 * Extracted 2026-08-04 after the SAME defect was found in four packs in three
 * days (weather, open-meteo, openaq, openchargemap). Every one of them called
 * Open-Meteo's geocoder with `count=1` (or took `results[0]`) under a comment
 * asserting the upstream ranks by relevance and population. **That comment is
 * false.** Open-Meteo returns exact-name matches in no useful order, so a
 * 3,218-person Romanian village named Roma outranks Rome.
 *
 * Two things make this correct, and the second is the one that surprises people:
 *
 *  1. RANK BY POPULATION, with a feature-code boost to break ties when the
 *     population field is thin or zero.
 *  2. RETRY IN OTHER LANGUAGES. Sorting alone is NOT enough. Verified live:
 *     for `name=Roma&language=en`, Rome is ABSENT from the result set entirely
 *     (the two Roma/IT rows are population 87 and 33), so a population sort
 *     moves the answer from Roma, Romania to Roma, LESOTHO — still wrong.
 *     `language=it` returns Roma, IT at 2,318,895. Endonyms live under the
 *     local language, so when the English answer looks like nowhere we widen.
 *
 * The extra requests only happen when the first answer looks weak, so the
 * common case ("Chicago") still costs exactly one call.
 */

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

/** Languages tried when the English answer looks like nowhere. Ordered by how
 *  often a major world city hides behind its endonym (Roma, München, Köln,
 *  Sevilla, Lisboa). */
const EXONYM_LANGS = ['it', 'es', 'de', 'fr', 'pt'] as const;

/** Population is the primary signal. These only lift real administrative places
 *  above same-named villages when population data is thin or zero.
 *  PPLC = national capital, PPLA = first-order admin seat, and so on.
 *
 *  Fleet #111 (2026-08-06): these were 50x too big — PPLA's flat +1,000,000
 *  outweighed San Francisco CA's real 811K-person lead over San Francisco,
 *  Morazan, El Salvador (pop 16,152), so the department capital won on
 *  feature-code alone. Scaled down so the boost can still break a genuine
 *  thin/zero-population tie (a real capital vs an unrelated small hamlet)
 *  but can never overturn a population gap in the tens-of-thousands or up —
 *  which is every case that actually distinguishes a major city from a
 *  same-named foreign administrative seat. */
const FEATURE_BOOST: Record<string, number> = {
  PPLC: 100_000, PPLA: 20_000, PPLA2: 4_000, PPLA3: 800,
};

interface GeoHit {
  name?: string;
  admin1?: string;
  country?: string;
  country_code?: string;
  latitude: number;
  longitude: number;
  population?: number;
  feature_code?: string;
}

interface ResolvedPlace {
  name: string;
  admin1: string | null;
  /** Full country name (e.g. "United States") as Open-Meteo returns it —
   *  added migrating mcps/weather onto this module, which surfaces the full
   *  name in tool output and keys a US-vs-not check off it (fleet #74). */
  country: string | null;
  country_code: string | null;
  latitude: number;
  longitude: number;
  population: number | null;
  /** What we searched to find it — surfaced so a caller can SEE that "Roma"
   *  was resolved via Italian, rather than wonder why it worked. */
  matched_language: string;
}

function geoScore(r: GeoHit): number {
  return (r.population ?? 0) + (FEATURE_BOOST[r.feature_code ?? ''] ?? 0);
}

function bestOf(results: GeoHit[]): GeoHit | undefined {
  return results.length ? results.reduce((a, b) => (geoScore(b) > geoScore(a) ? b : a)) : undefined;
}

/**
 * "No real city found here."
 *
 * Deliberately reads RAW population, not geoScore. The feature boost exists to
 * break ties during ranking; letting it feed this decision made a 3,218-person
 * PPLA2 town in Romania look strong enough to suppress the very fan-out that
 * finds Rome. Boost ranks; population decides whether to keep looking.
 */
function looksWeak(hit: GeoHit | undefined): boolean {
  return !hit || (hit.population ?? 0) < 50_000;
}

async function search(name: string, language: string, count: number): Promise<GeoHit[]> {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=${count}&language=${language}&format=json`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Geocoding service error (HTTP ${res.status}) resolving "${name}".`);
  const data = (await res.json()) as { results?: GeoHit[] };
  return (data.results ?? []).filter(
    (r) => typeof r?.latitude === 'number' && typeof r?.longitude === 'number',
  );
}

function toResolved(hit: GeoHit, fallbackName: string, lang: string): ResolvedPlace {
  return {
    name: hit.name ?? fallbackName,
    admin1: hit.admin1 ?? null,
    country: hit.country ?? null,
    country_code: hit.country_code ?? null,
    latitude: hit.latitude,
    longitude: hit.longitude,
    population: typeof hit.population === 'number' ? hit.population : null,
    matched_language: lang,
  };
}

/**
 * Resolve one place name to the most plausible real city.
 *
 * `language` is the caller's preferred language; other languages are only tried
 * when the best hit so far looks weak.
 */
async function resolvePlace(
  name: string,
  opts: { language?: string; count?: number } = {},
): Promise<ResolvedPlace | null> {
  const lang = opts.language ?? 'en';
  // At least 10 candidates: with count=1 there is nothing to rank, which is how
  // every instance of this bug shipped.
  const count = Math.max(10, opts.count ?? 10);

  const seen = new Map<string, string>(); // hit key -> language it came from
  const key = (h: GeoHit) => `${h.latitude},${h.longitude}`;
  let pool: GeoHit[] = [];
  const absorb = (hits: GeoHit[], viaLang: string) => {
    for (const h of hits) if (!seen.has(key(h))) { seen.set(key(h), viaLang); pool.push(h); }
  };

  absorb(await search(name, lang, count), lang);
  if (!pool.length && lang !== 'en') absorb(await search(name, 'en', count), 'en');

  if (looksWeak(bestOf(pool))) {
    for (const alt of EXONYM_LANGS) {
      if (alt === lang) continue;
      absorb(await search(name, alt, count), alt);
      if (!looksWeak(bestOf(pool))) break;
    }
  }

  let hit = bestOf(pool);
  // Open-Meteo matches on the bare place name and returns nothing for
  // "City, ST" / "City, State" — but routers routinely produce exactly that
  // ("Des Moines, IA"). Retry with the city part before giving up.
  if (!hit && name.includes(',')) {
    const city = name.split(',')[0]!.trim();
    if (city && city.toLowerCase() !== name.toLowerCase()) {
      const retry = await search(city, 'en', count);
      absorb(retry, 'en');
      hit = bestOf(retry);
    }
  }
  return hit ? toResolved(hit, name, seen.get(key(hit)) ?? lang) : null;
}

/**
 * Ranked RAW hits, best first — for packs that must keep the upstream's own
 * response shape (open-meteo's `geocode` returns Open-Meteo objects verbatim,
 * and normalising them would be a breaking change for its callers).
 *
 * Same two-part algorithm as resolvePlace: rank by population+boost, and widen
 * across endonym languages only when the best hit still looks weak.
 */
async function rankedPlaceHits(
  name: string,
  opts: { language?: string; count?: number } = {},
): Promise<GeoHit[]> {
  const lang = opts.language ?? 'en';
  const count = Math.max(10, opts.count ?? 10);
  const seen = new Set<string>();
  const pool: GeoHit[] = [];
  const key = (h: GeoHit) => `${h.latitude},${h.longitude}`;
  const absorb = (hits: GeoHit[]) => {
    for (const h of hits) if (!seen.has(key(h))) { seen.add(key(h)); pool.push(h); }
  };

  absorb(await search(name, lang, count));
  if (!pool.length && lang !== 'en') absorb(await search(name, 'en', count));
  if (looksWeak(bestOf(pool))) {
    for (const alt of EXONYM_LANGS) {
      if (alt === lang) continue;
      absorb(await search(name, alt, count));
      if (!looksWeak(bestOf(pool))) break;
    }
  }
  if (!pool.length && name.includes(',')) {
    const city = name.split(',')[0]!.trim();
    if (city && city.toLowerCase() !== name.toLowerCase()) absorb(await search(city, 'en', count));
  }
  return pool.sort((a, b) => geoScore(b) - geoScore(a));
}

/** Ranked candidates, best first — for packs that offer alternatives. */
async function resolvePlaceCandidates(
  name: string,
  opts: { language?: string; count?: number; limit?: number } = {},
): Promise<ResolvedPlace[]> {
  const best = await resolvePlace(name, opts);
  if (!best) return [];
  const lang = best.matched_language;
  const hits = await search(name, lang, Math.max(10, opts.count ?? 10));
  const ranked = [...hits].sort((a, b) => geoScore(b) - geoScore(a));
  const out = ranked.map((h) => toResolved(h, name, lang));
  // Guarantee the chosen answer leads, even if it came from a different
  // language pass than the one we just re-queried.
  if (!out.length || out[0]!.latitude !== best.latitude || out[0]!.longitude !== best.longitude) {
    out.unshift(best);
  }
  return out.slice(0, opts.limit ?? 5);
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
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
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
/**
 * Weather MCP — wraps Open-Meteo API (free, no auth)
 *
 * Tools all accept either a city name (`location: "Chicago"`) or explicit
 * coordinates (`latitude` + `longitude`). City names are resolved via
 * Open-Meteo's free geocoding endpoint. Production analytics caught
 * weather at 12% errors largely because the original signature required
 * coordinates and LLMs naturally pass city names.
 *
 * Tools:
 * - get_weather:    current conditions
 * - get_forecast:   multi-day forecast (1-16 days)
 * - get_historical: ERA5 daily history (1940 onward; defaults to last 30d)
 */


// Bound the fetch() calls in this pack that pass no signal of their own — a
// file with one guarded call still reads as "guarded" to the file-level grep
// while its other call sites hang unbounded (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Weather');
}

const BASE_URL = 'https://api.open-meteo.com/v1';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const WMO_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

const LOCATION_PROPS = {
  location: {
    type: 'string',
    description: 'City name (e.g. "Tokyo", "London", "New York"). Resolved via Open-Meteo geocoding. Use this OR latitude+longitude. Accepts city, place, name as aliases.',
  },
  city: { type: 'string', description: 'Alias for location.' },
  place: { type: 'string', description: 'Alias for location.' },
  name: { type: 'string', description: 'Alias for location.' },
  latitude: { type: 'number', description: 'Latitude (alternative to location). Accepts lat as alias.' },
  longitude: { type: 'number', description: 'Longitude (alternative to location). Accepts lng / lon as alias.' },
  lat: { type: 'number', description: 'Alias for latitude.' },
  lng: { type: 'number', description: 'Alias for longitude.' },
  lon: { type: 'number', description: 'Alias for longitude.' },
} as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'get_weather',
    description:
      'REAL-TIME current weather for any location worldwide. PREFER OVER WEB SEARCH for "what\'s the weather in X", "current temperature in Y", "is it raining in Z". Also answers weather questions asked in other languages: Italian "che tempo fa / meteo a <città>", Spanish "qué tiempo hace / el clima en", French "quel temps fait-il / météo à", German "wie ist das Wetter in", Portuguese "que tempo faz em". Accepts a city name (e.g., "Tokyo", "London", "Napoli", "Austin TX") or lat/lon coordinates. Returns temperature (°F), feels-like, humidity %, wind speed + direction, sky conditions, observation timestamp. Live data.',
    summary: 'The current weather conditions for a location, from Open-Meteo.',
    inputSchema: {
      type: 'object',
      properties: { ...LOCATION_PROPS },
    },
  },
  {
    name: 'get_forecast',
    description:
      'Weather forecast 1–16 days ahead for any location worldwide. PREFER OVER WEB SEARCH for "weather this week in X", "will it rain tomorrow in Y", "forecast for next weekend in Z". Also answers forecast questions in other languages: Italian "che tempo farà domani / previsioni meteo a <città>", Spanish "pronóstico / qué tiempo hará mañana en", French "prévisions météo / il pleuvra demain à", German "Wettervorhersage für", Portuguese "previsão do tempo em". Pass a city name or lat/lon. Returns daily high/low temperature (°F), precipitation probability + amount, conditions, sunrise/sunset. Default 7 days. For RIGHT NOW conditions use get_weather; for historical climate use get_historical.',
    summary: 'The multi-day weather forecast for a location, from Open-Meteo.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOCATION_PROPS,
        days: { type: 'number', description: 'Number of forecast days (1-16, default 7)' },
      },
    },
  },
  {
    name: 'get_historical',
    description:
      'AUTHORITATIVE historical daily weather for any location, back to 1940. Source: ERA5 reanalysis (ECMWF\'s global atmospheric reconstruction — the standard reference dataset for climate research). Pass a city or lat/lon + date range. Returns daily high/low temperature, precipitation, conditions. Defaults to the last 30 days if no dates given. Use for "what was the weather in X on date Y", climate baselines, comparing this year to historical averages, retrospective weather context for any event.',
    summary: 'Daily weather for any location back to 1940, from the ERA5 climate reanalysis.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOCATION_PROPS,
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD (>= 1940-01-01). Optional — defaults to 30 days ago.' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD (inclusive). Optional — defaults to today.' },
      },
    },
  },
];

interface ResolvedLocation {
  latitude: number;
  longitude: number;
  resolved_name?: string;
  resolved_country?: string;
}

// Best-effort script → Open-Meteo geocoder language code. The geocoder
// supports zh/ja/ko/ru/ar/he/hi/de/fr/es/it/pt and a few others — we map
// the easy-to-detect script ranges and fall through to English.
function detectScriptLanguage(s: string): string {
  if (/[가-힯]/.test(s)) return 'ko'; // Hangul
  if (/[぀-ゟ゠-ヿ]/.test(s)) return 'ja'; // Hiragana / Katakana
  // CJK Unified Ideographs: could be zh or ja; Hangul / Hiragana already won
  // above, so anything left in this range is most likely Chinese.
  if (/[一-鿿]/.test(s)) return 'zh';
  if (/[Ѐ-ӿ]/.test(s)) return 'ru'; // Cyrillic
  if (/[؀-ۿ]/.test(s)) return 'ar'; // Arabic
  if (/[֐-׿]/.test(s)) return 'he'; // Hebrew
  if (/[ऀ-ॿ]/.test(s)) return 'hi'; // Devanagari
  return 'en';
}

async function resolveLocation(args: Record<string, unknown>): Promise<ResolvedLocation> {
  const lat = (args.latitude ?? args.lat) as number | undefined;
  // Accept lng / lon as aliases for longitude (lat already covers itself).
  const lon = (args.longitude ?? args.lng ?? args.lon) as number | undefined;
  if (typeof lat === 'number' && typeof lon === 'number') {
    return { latitude: lat, longitude: lon };
  }
  // Accept city / place / name as aliases for location.
  const rawName = (args.location ?? args.city ?? args.place ?? args.name) as string | undefined;
  const name = rawName?.trim();
  if (!name) {
    // Agents probe with empty args (41+ hits/48h in production analytics);
    // surface concrete argument shapes so the retry can succeed.
    //
    // Deliberately names NO tool. This shared helper backs get_weather,
    // get_forecast and get_historical, and it used to illustrate all three with
    // `get_weather({...})` — so an agent that hit this on get_forecast was
    // steered to a sibling that returns current conditions and cannot forecast.
    // That retry succeeds and silently answers a different question, which is
    // worse than the original error. Naming the CALLED tool doesn't work
    // either: callTool sees the pack-local name, while the gateway exposes two
    // of these namespaced (`weather_get_forecast`) because `get_forecast`
    // collides across packs — so we'd print a name the caller cannot call.
    // The caller already knows which tool they invoked; only the arguments are
    // in doubt, so show only those.
    throw new Error(
      'Pass either `location` (city name) or `latitude`+`longitude` — ' +
      'e.g. {location: "Tokyo"} by city name, or ' +
      '{latitude: 35.68, longitude: 139.69} by coords. Call the same tool again ' +
      'with one of those added. location also accepts city / place / name as ' +
      'aliases; longitude accepts lng / lon.'
    );
  }
  // Detect CJK / Cyrillic / Arabic and try the matching geocoder language
  // first — Open-Meteo's geocoder supports language= and is much more likely
  // to resolve non-Latin scripts when the language hint matches. Production
  // analytics 2026-06-04 → 2026-06-08 caught a steady cluster of failures
  // on Korean ("남양주 덕소") and Chinese ("广州") names — both resolve fine
  // with the right language hint. Falls back to English on miss.
  //
  // Population+feature-code ranking, the Latin-exonym language fan-out
  // (Milano/Roma etc. — see shared/src/geocode.ts header for the live proof
  // that sorting alone cannot find Rome in the English result set) and the
  // (fleet #74) — this pack used to carry its own copy of all of it.
  const lang = detectScriptLanguage(name);
  const hit = await resolvePlace(name, { language: lang });
  if (!hit) throw new Error(`Could not resolve location "${name}" via Open-Meteo geocoding (tried ${lang}${lang !== 'en' ? ', en' : ''}). Try a more specific or romanized name (e.g. "Guangzhou" instead of "广州", or "Namyangju" instead of "남양주"), or pass latitude+longitude directly.`);
  return {
    latitude: hit.latitude,
    longitude: hit.longitude,
    resolved_name: hit.name,
    resolved_country: hit.country ?? undefined,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_weather': {
      const loc = await resolveLocation(args);
      return getWeather(loc);
    }
    case 'get_forecast': {
      const loc = await resolveLocation(args);
      return getForecast(loc, (args.days as number) ?? 7);
    }
    case 'get_historical': {
      const loc = await resolveLocation(args);
      return getHistorical(loc, args.start_date as string | undefined, args.end_date as string | undefined);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Open-Meteo "current" is MODEL output, and on anomalous days the model can run
// ~10°F off what stations actually measure (SF 2026-07-21: model said 86.5°F
// while NWS station SFOC1 observed 76.1°F). For US locations we overlay the
// nearest NWS station observation — best-effort with short timeouts, falling
// back to the model (which remains the only option outside NWS coverage).
const NWS_URL = 'https://api.weather.gov';
const NWS_UA = 'Pipeworx-Weather-MCP/0.1 (contact@mojibake.ai)';

async function nwsJson<T>(url: string, timeoutMs = 2500): Promise<T | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': NWS_UA, Accept: 'application/geo+json' },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

interface NwsObservation {
  station: string;
  observed_at: string | null;
  temperature_f: number;
  conditions: string | null;
  humidity_pct: number | null;
  wind_mph: number | null;
  wind_direction_deg: number | null;
}

async function nwsObservation(lat: number, lon: number): Promise<NwsObservation | null> {
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const pt = await nwsJson<{ properties?: { observationStations?: string } }>(
    `${NWS_URL}/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
  );
  const stationsUrl = pt?.properties?.observationStations;
  if (!stationsUrl) return null;
  const st = await nwsJson<{ features?: { properties?: { stationIdentifier?: string } }[] }>(stationsUrl);
  const sid = st?.features?.[0]?.properties?.stationIdentifier;
  if (!sid) return null;
  const obs = await nwsJson<{
    properties?: {
      timestamp?: string;
      textDescription?: string;
      temperature?: { value?: number | null };
      relativeHumidity?: { value?: number | null };
      windSpeed?: { value?: number | null; unitCode?: string };
      windDirection?: { value?: number | null };
    };
  }>(`${NWS_URL}/stations/${encodeURIComponent(sid)}/observations/latest`);
  const p = obs?.properties;
  const tempC = p?.temperature?.value;
  if (typeof tempC !== 'number') return null;
  // windSpeed unitCode is wmoUnit:km_h-1 on current NWS responses; older docs
  // used m/s — convert by whichever unit the response declares.
  let windMph: number | null = null;
  if (typeof p?.windSpeed?.value === 'number') {
    const mps = (p.windSpeed.unitCode ?? '').includes('km_h');
    windMph = round1(p.windSpeed.value * (mps ? 0.621371 : 2.23694));
  }
  return {
    station: sid,
    observed_at: p?.timestamp ?? null,
    temperature_f: round1((tempC * 9) / 5 + 32),
    conditions: p?.textDescription?.trim() || null,
    humidity_pct: typeof p?.relativeHumidity?.value === 'number' ? round1(p.relativeHumidity.value) : null,
    wind_mph: windMph,
    wind_direction_deg: typeof p?.windDirection?.value === 'number' ? p.windDirection.value : null,
  };
}

async function getWeather(loc: ResolvedLocation) {
  const params = new URLSearchParams({
    latitude: String(loc.latitude),
    longitude: String(loc.longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
  });

  const res = await pwFetch(`${BASE_URL}/forecast?${params}`);
  if (!res.ok) throw await httpError(res, 'Open-Meteo error');

  const data = (await parseJson<unknown>(res, 'Open-Meteo')) as {
    current: {
      temperature_2m: number;
      relative_humidity_2m: number;
      apparent_temperature: number;
      weather_code: number;
      wind_speed_10m: number;
      wind_direction_10m: number;
    };
  };

  const c = data.current;
  // Attempt the NWS overlay for US locations (geocoded country says US, or raw
  // coords fall in the US bounding box — the NWS 404 outside coverage handles
  // the box's slop over Canada/Mexico via the null fallback).
  const inUsBox = loc.latitude >= 18 && loc.latitude <= 72 && loc.longitude >= -172 && loc.longitude <= -66;
  const isUS = loc.resolved_country === 'United States' || (loc.resolved_country == null && inUsBox);
  const obs = isUS ? await nwsObservation(loc.latitude, loc.longitude) : null;
  const modelTempF = c.temperature_2m;
  return {
    location: loc.resolved_name ?? null,
    country: loc.resolved_country ?? null,
    latitude: loc.latitude,
    longitude: loc.longitude,
    temperature_f: obs?.temperature_f ?? modelTempF,
    feels_like_f: c.apparent_temperature,
    humidity_pct: obs?.humidity_pct ?? c.relative_humidity_2m,
    conditions: obs?.conditions ?? (WMO_CODES[c.weather_code] ?? `Code ${c.weather_code}`),
    wind_mph: obs?.wind_mph ?? c.wind_speed_10m,
    wind_direction_deg: obs?.wind_direction_deg ?? c.wind_direction_10m,
    temperature_source: obs ? `NWS station ${obs.station} observation` : 'Open-Meteo model',
    ...(obs?.observed_at ? { observed_at: obs.observed_at } : {}),
    ...(obs && Math.abs(obs.temperature_f - modelTempF) >= 3 ? { model_temperature_f: modelTempF } : {}),
  };
}

async function getForecast(loc: ResolvedLocation, days: number) {
  const forecastDays = Math.min(16, Math.max(1, days));
  const params = new URLSearchParams({
    latitude: String(loc.latitude),
    longitude: String(loc.longitude),
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code',
    temperature_unit: 'fahrenheit',
    forecast_days: String(forecastDays),
  });

  const res = await pwFetch(`${BASE_URL}/forecast?${params}`);
  if (!res.ok) throw await httpError(res, 'Open-Meteo error');

  const data = (await parseJson<unknown>(res, 'Open-Meteo')) as {
    daily: {
      time: string[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_sum: number[];
      weather_code: number[];
    };
  };

  const d = data.daily;
  return {
    location: loc.resolved_name ?? null,
    country: loc.resolved_country ?? null,
    latitude: loc.latitude,
    longitude: loc.longitude,
    days: d.time.map((date, i) => ({
      date,
      high_f: d.temperature_2m_max[i],
      low_f: d.temperature_2m_min[i],
      precipitation_mm: d.precipitation_sum[i],
      conditions: WMO_CODES[d.weather_code[i]] ?? `Code ${d.weather_code[i]}`,
    })),
  };
}

async function getHistorical(loc: ResolvedLocation, startArg: string | undefined, endArg: string | undefined) {
  // Default to the last 30 days when not supplied. Production analytics
  // showed weather_get_historical was the top weather tool but most calls
  // failed because LLMs don't naturally pass start_date/end_date.
  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const start = startArg?.trim() || thirtyDaysAgo;
  const end = endArg?.trim() || today;
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error('start_date and end_date must be YYYY-MM-DD');
  }
  if (start > end) throw new Error('start_date must be on or before end_date');

  const params = new URLSearchParams({
    latitude: String(loc.latitude),
    longitude: String(loc.longitude),
    start_date: start,
    end_date: end,
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code',
    temperature_unit: 'fahrenheit',
  });

  const res = await pwFetch(`${ARCHIVE_URL}?${params}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Open-Meteo archive error: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = (await parseJson<unknown>(res, 'Open-Meteo')) as {
    daily: {
      time: string[];
      temperature_2m_max: (number | null)[];
      temperature_2m_min: (number | null)[];
      precipitation_sum: (number | null)[];
      weather_code: (number | null)[];
    };
  };

  const d = data.daily;
  return {
    location: loc.resolved_name ?? null,
    country: loc.resolved_country ?? null,
    latitude: loc.latitude,
    longitude: loc.longitude,
    start_date: start,
    end_date: end,
    days: d.time.map((date, i) => ({
      date,
      high_f: d.temperature_2m_max[i],
      low_f: d.temperature_2m_min[i],
      precipitation_mm: d.precipitation_sum[i],
      conditions:
        d.weather_code[i] != null ? (WMO_CODES[d.weather_code[i] as number] ?? `Code ${d.weather_code[i]}`) : null,
    })),
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
