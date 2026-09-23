# OpenVibe.Coupons

> Coupon codes with merchant matching, restrictions, expiry and real-people validity reports.

**Status:** alpha (roadmap Wave 18, Coupons part). The service runs and its tests pass. It is **not
deployed**, `openvibe.coupons` still shows its placeholder from OpenVibe.Sites, it holds **no codes**
(nothing is seeded), and its capabilities and service manifest are proposals that the next
openvibe-contracts release has to include.
**Domain:** `openvibe.coupons` · **Port:** 4850 · **Service id:** `coupons`
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.10; roadmap §4.2 D, §15.13, §29, §32.
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Coupons keeps merchants and their normalized domains, codes, restrictions, validity reports,
expiry and confidence, and the public API the OpenVibe browser helper
([OpenVibers/OpenVibe.Extensions](https://github.com/OpenVibers/OpenVibe.Extensions)) uses. It is
distinct from Deals even where they cross-link.

Four rules shape everything here:

- **No code is "working" because a model guessed it.** A code's status comes only from recent
  reports by people. A submission, a source, staff and AI output can't set it.
- **Unknown stays unknown.** An expiry nobody stated is "Expiry unknown" (`null` in JSON). No
  recent reports means no confidence number. "No restrictions stated" is never shown as "no
  restrictions".
- **Expired codes leave active results predictably.** They leave at the instant their known
  expiry passes, in the API, pages, feeds, sitemaps and Search.
- **A merchant page (or any page) can't obtain anyone's data.** Lookups return the same bytes to
  every caller. The API ignores cookies. The extension holds no OpenVibe session.

## Owns

The nine charter tables live in Coupons' own SQLite (`COUPONS_DB_PATH`):

| Charter table | What it is |
|---|---|
| `coupon_merchants` | Merchants: `pending` (proposed by a member's submission, invisible until staff approve), `active`, `disabled`. |
| `coupon_merchant_domains` | Domain rules: a normalized host, its registrable domain (eTLD+1), whether subdomains are included, and an optional path prefix. |
| `coupons` | Codes. Status is exactly `unknown\|reported_working\|reported_failed\|expired\|disabled`. Confidence is `NULL` when nobody reported recently. `expires_at` is `NULL` when the expiry is unknown, with its precision (`instant`/`date`) and basis (`evidence`/`submitter`/`source`/`staff`). Review state is `pending\|published`. Origin is `member\|staff\|source\|ai`. |
| `coupon_sources` | Evidence: member and staff submissions (with the evidence URL, and whether it's on the merchant's own domain), OpenVibe.Sources items (id, revision, retrieval time) and AI runs. |
| `coupon_restrictions` | Min spend (minor units and ISO 4217 currency), categories, new customers only, regions (ISO 3166-1), other. |
| `coupon_validation_reports` | Worked/failed reports. One row per (reporter, code, UTC day). The reporter is an HMAC of the person's subject. |
| `coupon_status_history` | Every status and confidence change, with its reason (`created`, `report`, `decay`, `expiry`, `evidence`, `staff:…`, `service:…`) and actor. |
| `coupon_application_hints` | How to apply a code, for one code or for all of a merchant's codes. |
| `coupon_watches` | Members watching a merchant. Private. |

Other tables in the same database:

- `extension_installs`: browser-helper tokens, stored as hashes.
- `import_state` and `coupon_import_holds`: the Sources importer.
- `event_outbox`: the SDK transactional outbox.
- `coupons_index_revisions`: the openvibe-publishing index sequencer.

Nothing is seeded, and no code, merchant or report is invented for a demo.

## Does not own

- **Deal offers.** They belong to OpenVibe.Deals.
- **Discussion.** It belongs to OpenVibe.Community. Code pages have no comment thread yet (see
  "Known gaps").
- **Identity.** It belongs to OpenVibe.Network: SSO, subjects and service principals.
- **Notifications.** They belong to the Network's notification store. Watches are recorded, but
  nothing is sent yet.
- **Search.** OpenVibe.Search indexes what Coupons sends through Events.
- **Ingestion.** It belongs to OpenVibe.Sources. Coupons only reads the `coupons` category.
- **The browser helper.** It lives in OpenVibe.Extensions (ADR-023).

## Statuses and confidence

The formula lives in `server/domain/confidence.js`. `test/confidence.test.js` pins it with numbers,
and `/about` explains it on the site.

- **Deduplication:** one stored report per (person, code, UTC day). Every channel shares one
  reporter key per person: the site, each extension install and the API. Of a person's reports,
  only the **most recent** counts.
- **Recency:** a report of age *a* days weighs `0.5^(a/7)`. It weighs 0 after 30 days.
- With *W* the weight of "worked" and *F* the weight of "didn't work" reports, and *e* = 0.5 when
  the code was published on one of the merchant's own domains (merchant evidence), otherwise 0:

  ```
  confidence = null                          if W + F = 0   (no counted report in 30 days)
             = (1 + e + W) / (2 + e + W + F)  otherwise, rounded to 2 decimals
  ```

- **Status:**
  - `disabled` if staff or a service took the code down.
  - Otherwise `expired` if a known expiry has passed, or staff recorded that it ended.
  - Otherwise `unknown` if W + F < 0.5.
  - Otherwise `reported_working` if confidence ≥ 0.6, `reported_failed` if confidence ≤ 0.4, and
    `unknown` in between.

So:

- One fresh "worked" report gives 0.67 and `reported_working`.
- One fresh "didn't work" report gives 0.33 and `reported_failed` (0.43 and still `unknown` for a
  code with merchant evidence).
- One of each gives 0.5 and `unknown`.
- A lone report stops deciding the status after a week. After 30 days there is no confidence at
  all.

The sweep records the decay: status history, `coupons.confidence.changed`, and a new Search document.

- **Expiry:**
  - A date without a time means the end of that day in UTC. The merchant's time zone isn't known,
    and the page says so.
  - A time needs an offset. A zone-less time is refused as ambiguous.
  - Every active list filters on `expires_at > now` in the query itself. A code leaves the API,
    pages, feeds and sitemaps at that instant, whether or not the sweep has run yet. The sweep then
    records `expired` at the stated instant, with history, `coupons.coupon.expired` and a Search
    tombstone. Running it again changes nothing.
- **Nobody sets working or failed:**
  - A submission carrying `status`, `confidence`, `verified`, `working`, `valid` or `validity` is
    refused (422 `coupon.status_not_accepted`). That applies to people, services and AI output
    alike.
  - Staff and services with `coupons.status.update` can only disable a code, mark it expired, or
    return it to active. Returning it recomputes the status from reports and time.
  - Reports marked `X-OV-Origin: ai` are refused.
  - A person who submitted a code, or added evidence for it, can't report on it (403
    `report.own_submission`). Otherwise one account could submit a made-up code and mark it working.
  - AI-extracted codes (`coupons.extract_coupon` output) are held for staff review. They start
    `unknown` and carry an on-page disclosure.

## Merchant and domain resolution

The code is in `server/domain/hosts.js` and `server/domain/psl.js`. The tests are in
`test/domains.test.js`.

- **Hosts:**
  - Hosts are lowercased, converted to punycode (IDNA), and stripped of their trailing dot and
    port.
  - A host needs at least two valid labels.
  - IP literals, `localhost` and special-use names (`.local`, `.internal`, `.invalid`, `.test`,
    `.example`, `.arpa` …) are refused.
- **Registrable domain (eTLD+1):**
  - It comes from a small **bundled subset of the Public Suffix List**. That includes multi-label
    ccTLD suffixes, wildcard and exception rules (`*.ck`, `!www.ck`), and private-section platforms
    such as `myshopify.com`, `github.io` and `netlify.app`, so each customer's subdomain there is
    its own site.
  - A suffix missing from the subset makes a registrable domain one label too short. Only staff
    create domain rules (members' submissions only propose a pending merchant), so a gap can't make
    an unrelated site resolve by itself. Update the subset when a real merchant needs a suffix.
- **Rules:**
  - A rule names a host at or below a registrable domain. A rule on a public suffix is refused.
  - `include_subdomains` covers every subdomain, but never across the looked-up host's registrable
    domain.
  - A `path_prefix` matches only at a segment boundary, and only when a path is known.
  - **Host-only lookups never match path rules.** The browser helper sends only a hostname, so it
    gets the host's own rule.
  - The most specific rule wins: the longest host, then the longest path.
  - One (host, path) belongs to one merchant.

## Routes (server-rendered, useful without JavaScript)

| Route | What |
|---|---|
| `/` | Shops with their active-code counts, recently added codes, and search (`?q=`, noindex). |
| `/about` | Statuses, the confidence formula, expiry, privacy and the browser helper. |
| `/m/:slug`, `/m/:slug.json` | A shop, and the same as data. The page shows active codes with status, confidence, the last report time (to the hour), restrictions, expiry or "unknown", evidence and hints. Recently ended codes are listed apart. |
| `/c/:id`, `/c/:id.json` | One code, with its status history. Expired: served but noindex. Taken down: 410. |
| `POST /c/:id/report` | Worked or didn't work, with an optional reason. Needs sign-in and a form token. |
| `POST /m/:slug/watch` | Watch or stop watching a shop. |
| `/submit` | Submit a code: shop, code, what it gives, details, evidence link, expiry (empty means unknown) and whether the evidence page states it, restrictions, and how to apply. |
| `/connect-extension` | Create, list and revoke browser-helper tokens. |
| `/watching` | Your watched shops. Private. |
| `/staff` | Add shops, approve or reject pending shops and codes, take down, expire or re-enable a code, and see the import holds. |
| `/feed.xml`, `/atom.xml`, `/feed.json`, `/m/:slug/feed.xml` | Feeds of active codes. |
| `/sitemap.xml` → `/sitemaps/merchants.xml`, `/sitemaps/coupons.xml` | Sitemaps with active, indexable entries only. |
| `/robots.txt`, `/llms.txt` | The automated-consumer policy and orientation for language models. |
| `/auth/*` | Network SSO, the same session layer as Blog and Community. |
| `/api/health`, `/api/ready`, `/release.json`, `/metrics` | `/metrics` is loopback only. |

### Discoverability (roadmap §32)

- Every page gets its robots meta, canonical and `X-Robots-Tag` from the `openvibe-publishing/seo`
  gate:
  - A shop with no active code is `thin`: served, but noindex and left out of the sitemap.
  - An expired code is `expired`: noindex.
  - A taken-down code or shop is `takedown` (410).
  - Pending codes and shops are hidden.
- JSON-LD is `BreadcrumbList` and `WebPage` only, built from real fields. There is no `Offer`,
  `validThrough` or rating, because a code has no price and its validity isn't a fact to mark up.
- Feeds and sitemaps start from the active-results query. They are never built for a viewer.

### Caching

- Pages rendered for anonymous visitors are `public, max-age=60`. Signed-in pages (which carry
  form tokens) are `private, no-store`. Everything varies on Cookie and Authorization.
- Lookup API answers are `public, max-age=60`, because they are identical for every caller.
  Everything else in the API is `private, no-store`.

## API (`/api/v1`)

Identity comes from the `Authorization` header **only**. Cookies are ignored here, so a page can't
use a visitor's session against the API. Errors are RFC 9457 problems.

| Route | Who | Capability or install scope |
|---|---|---|
| `GET /merchants/resolve?host=` | Anyone. Anonymous callers are rate-limited per IP, installs per install. | `coupons.merchant.resolve` / `coupons.lookup` |
| `GET /merchants/:id/coupons` | Anyone (as above). | `coupons.coupon.lookup` / `coupons.lookup` |
| `GET /merchants/:id`, `GET /coupons/:id` | Anyone. | `coupons.coupon.lookup` / `coupons.lookup` |
| `POST /coupons/:id/report` `{outcome, reason?}` | A person: a Bearer Network token, an install token with `coupons.report`, or a service acting for `X-OV-Subject`. | `coupons.report.create` / `coupons.report` |
| `POST /coupons/submit` `{merchant_id \| host \| url, code, title, description?, evidence_url?, expires?, expiry_basis?, restrictions?, hint?, ai_run_id?}` | A person, or `X-OV-Origin: ai` (held for review). Install tokens can't submit. | `coupons.coupon.submit` |
| `POST /coupons/:id/status` `{status: disabled\|expired\|active, note?}` | Staff (Network admin, or `COUPONS_STAFF_SUBJECTS`) or a service. | `coupons.status.update` |
| `POST /merchants`, `POST /merchants/:id/domains`, `POST /merchants/:id/status` | Staff or a service. | `coupons.merchant.manage` |

- **CORS:**
  - Only the two lookup routes send CORS headers, and only to origins in
    `COUPONS_EXTENSION_ORIGINS`. Those are exact `chrome-extension://<id>` origins, and optionally
    the literal `moz-extension://*`, because Firefox gives every install a random origin.
  - No credentials header is ever sent.
  - Reports, submissions, pages and everything else send no CORS headers.
  - The extension doesn't depend on CORS, because its host permission for this origin covers it.
- **Rate limits:**
  - Lookups: `COUPONS_LOOKUP_ANON_PER_MIN` (30) per IP, `COUPONS_LOOKUP_TOKEN_PER_MIN` (120) per
    install, and `COUPONS_LOOKUP_SERVICE_PER_MIN` (600) per service.
  - Reports: `COUPONS_REPORTS_PER_HOUR` (20) and `COUPONS_REPORTS_PER_DAY` (60) new reports per
    person, across all channels. Deduplicated repeats don't count.
  - Submissions: `COUPONS_SUBMISSIONS_PER_HOUR` (10) and `_PER_DAY` (30) per person, ×10 for
    services.
  - Plus a per-IP ceiling in Express and the nginx zones.
- **Privacy:**
  - No response, page or event names a submitter or reporter.
  - Report times are published to the hour.
  - Events always have the service as actor.

## Extension credentials (the browser helper)

- A signed-in person creates a token on `/connect-extension` and pastes it into the helper's
  settings.
- The token is `cpx_` followed by 256 random bits. It is **shown once** and stored as a SHA-256
  hash.
- It has one or both scopes: `coupons.lookup` (always) and `coupons.report` (optional). It can't
  submit, moderate or read anything private.
- It isn't a Network session. Pages treat it as anonymous, and it's refused wherever a Network
  token is expected.
- **Revocation is immediate:** every request reads the row, so the next request after "Revoke"
  gets `401 token.revoked`.
- Tokens expire after `COUPONS_INSTALL_TTL_DAYS` (365). A person can have at most
  `COUPONS_INSTALLS_PER_SUBJECT` (10) active tokens.
- Lookups work without any token, with tighter limits.

## Events (SDK outbox, same transaction as the change)

| Event | When |
|---|---|
| `coupons.coupon.created` | A code is created. It is `public` only when it's listed at once. |
| `coupons.coupon.updated` | Approval, re-enable, a status change among unknown, working and failed, or an expiry change. |
| `coupons.coupon.expired` | The code leaves active results as expired. |
| `coupons.coupon.disabled` | The code is taken down (by staff, a service, or because its last Sources evidence was removed). |
| `coupons.report.created` | A new report (not a deduplicated repeat). The payload is the outcome, reason, channel and day only. |
| `coupons.confidence.changed` | The confidence moved, because of reports or decay. The payload is from, to and status. |
| `coupons.index_document.upserted` / `.deleted` | `search.index-document@1` documents for `coupon` and `merchant`, and tombstones when a code leaves active results. A resource that was never indexed gets no tombstone. |

The charter's `coupons.created|updated|expired|disabled` are these `coupons.coupon.*` 3-segment
types. Every envelope validates as `events.event-envelope@1` (tested), with actor
`{type: service, id: coupons}`.

## Capabilities (proposed: `docs/capabilities-proposal/`)

Service tokens use audience `openvibe.coupons`, with one capability per route:

- `coupons.coupon.submit` (the charter's `coupons.submit`)
- `coupons.report.create` (the charter's `coupons.report`)
- `coupons.merchant.resolve`
- `coupons.coupon.lookup` (the charter's `coupons.lookup`)
- `coupons.status.update`
- `coupons.merchant.manage` (new: the staff and service merchant administration the lookups
  depend on)

Until the proposals are released, grants for these ids are decided locally with the contracts
library's matching rule (`server/auth/capabilities.js`). Nothing changes when they are released.
Install scopes (`coupons.lookup`, `coupons.report`) are Coupons-local and aren't capabilities. The
service manifest proposal is `docs/service-manifest-proposal.json`.

## Depends on

- **Packages** (all pinned by release tarball): `openvibe-publishing` v0.2.0 (seo gate, ssr,
  index-hooks), `openvibe-contracts` v0.19.0, `openvibe-shared` v1.3.0 (chrome, app icon, footer,
  legal, release, metrics, ready, seo), `openvibe-sdk` v0.2.2 (events outbox, service tokens).
- **OpenVibe.Network:**
  - SSO: an OAuth client `coupons` with redirect `https://openvibe.coupons/auth/callback`. It is
    **not seeded yet**.
  - JWKS.
- **OpenVibe.Sources:** `sources.item.read`, category `coupons`. The seeded `staff-coupon-codes`
  source is disabled until a person enables it.
- **OpenVibe.Events:** `events.event.publish`.
- **OpenVibe.Search:** consumes `coupons.index_document.*`. `coupons` has to be in Search's
  `SEARCH_EVENT_OWNERS`.

### Grants the Network must hold

Each grant is `[client, capability, audience]`:

- `[coupons, events.event.publish, openvibe.events]`
- `[coupons, sources.item.read, openvibe.sources]` (only if the Sources import is turned on)
- For OpenVibe.AI to deliver `coupons.extract_coupon` drafts:
  `[ai, coupons.coupon.submit, openvibe.coupons]`
- Optional, for services that look up or moderate:
  `[<client>, coupons.coupon.lookup, openvibe.coupons]`,
  `[<client>, coupons.merchant.resolve, openvibe.coupons]`,
  `[<client>, coupons.status.update, openvibe.coupons]` and
  `[<client>, coupons.merchant.manage, openvibe.coupons]`

## Acceptance (automated: `npm test`)

| Charter / roadmap requirement | Test |
|---|---|
| Unknown stays unknown: no expiry means "Expiry unknown" and `null`, no reports means no confidence, no stated restrictions means "none stated". Nothing changes across time and sweeps. There's no Offer or validity in JSON-LD. | `test/lifecycle.test.js` |
| No code is labelled working because a model guessed it: status fields are refused from everyone, AI codes are held for review, AI reports are refused, and nobody can set working or failed. | `test/lifecycle.test.js` |
| Expired codes leave active results at the instant of expiry: API, page, feed and sitemap agree at `t-1ms` and at `t`. The expired page is noindex. The sweep records the status, history, event and tombstone once. | `test/lifecycle.test.js` |
| Reports are deduplicated per person, code and day across site, extension and API. Only the latest per person counts. They're rate-limited per hour and day, never anonymous, never cookie-authenticated on the API, and decay back to unknown. | `test/reports.test.js` |
| The confidence formula, with numbers. | `test/confidence.test.js` |
| Token revocation is immediate, tokens are hashed at rest, scopes are enforced, and expired or unknown tokens are refused. | `test/extension-privacy.test.js` |
| A lookup response never leaks anyone's data: the same bytes for anonymous callers and any two people, CORS only for the extension origin on lookups, and a malicious merchant page riding the visitor's cookies gets nothing. The connect page can't be framed. | `test/extension-privacy.test.js` |
| Domain normalization: PSL subset, wildcards and exceptions, platform subdomains, path rules, never across sites. | `test/domains.test.js` |
| Sources import: evidence with provenance, holds with reasons (never dropped), retries, withdrawal, and a failed fetch changes nothing. | `test/sources.test.js` |
| Useful without JavaScript: every flow is a plain form. Caching, robots, llms.txt, sitemaps, feeds, JSON twins, readiness and staff-only pages. | `test/pages-discovery.test.js` |
| The contract proposals are valid against the released schemas and match the code and its events. | `test/contracts.test.js` |

## Security and threat review

- **Identity:**
  - Only verified Network JWTs (offline RS256 against JWKS), service tokens for audience
    `openvibe.coupons`, and `cpx_` install tokens.
  - A presented credential that fails is refused, never downgraded to anonymous.
  - Identity never comes from a body or query.
- **Malicious merchant pages:**
  - The API ignores cookies.
  - Every form needs an HMAC form token (`COUPONS_FORM_SECRET`) on top of the SameSite=Lax session
    cookie.
  - No CORS for web origins.
  - Lookups hold no personal data and are identical for every caller.
  - The connect page is `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
  - The browser helper never exposes an interface to pages: it has no content scripts, no
    `externally_connectable` and no web-accessible resources (see OpenVibe.Extensions).
- **Privacy:**
  - Reporter keys are HMACs (`COUPONS_REPORTER_KEY_SECRET`).
  - Submitters and reporters are never returned or emitted.
  - Report times are published to the hour.
  - Watches are private.
- **XSS:** every value goes through `openvibe-publishing/ssr` auto-escaping. There's no page script
  of Coupons' own beyond the shared navbar init, and CSP comes from helmet. Evidence links are
  `rel="nofollow ugc noopener"`.
- **SSRF:** Coupons never fetches a user-supplied URL. Evidence URLs are stored and linked, never
  requested. The only outbound calls go to the configured Network, Sources and Events hosts.
- **Abuse:**
  - Per-person report and submission limits, per-install and per-IP lookup limits, and nginx
    zones.
  - Members can't create merchants that resolve: new sites are pending until staff approve them.
  - A taken-down code can't be resubmitted.
- **Known gaps:**
  - No Community discussion on code pages yet. The charter lists comments, and none are
    implemented.
  - Watches don't notify: there's no Network notification grant yet.
  - There's no staff UI to edit a code's text or restrictions. Staff can take a code down and ask
    for a resubmission.
  - The public-suffix subset needs maintenance as merchants are added.
  - Report moderation (voiding one person's reports) isn't built. Rate limits and "latest per
    person counts" bound the damage.

## Launch rule

This repository alone doesn't make the product live. `openvibe.coupons` keeps its placeholder on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of plan §12.12
holds. Status against each point:

1. **Runtime, health, readiness, observability:** done.
2. **Canonical identity and auth:** done. The OAuth client still has to be seeded in the Network.
3. **SSR public routes useful without JS:** done.
4. **Persistence and end-to-end workflows:** done.
5. **Capability and event registration against OpenVibe.Contracts:** proposals are in `docs/`,
   waiting on the release.
6. **Migration and seed strategy, threat review, sitemap/robots/feed behaviour:**
   - There's nothing to migrate and nothing is seeded.
   - Codes come from members, staff and the Sources `coupons` category.
   - The threat review and the sitemap, robots and feed behaviour are done.
7. **Acceptance tests:** done.

**The launch release does all of these in one release:**

- Removes `openvibe.coupons` from `OpenVibe.Sites/sites.json`.
- Switches routing: nginx vhost, DNS and TLS.
- Flips the Network hub entry (`server/chrome/sites.js`, `status: 'soon'`).
- Registers maturity in the ecosystem registry.

A placeholder never counts as an implemented service, and this README doesn't call the service
live.

## Development

```bash
fnm exec --using=22.22.1 npm install
fnm exec --using=22.22.1 npm test          # temp databases and in-process mocks, no network
fnm exec --using=22.22.1 npm run dev       # http://localhost:4850 (set OV_OAUTH_CLIENT_SECRET to sign in)
```

## Deploy (for the lead)

1. **Network:**
   - Create the service principal and OAuth client `coupons` (`server/setup/service-principal.js`),
     and put the secret in the env file.
   - Add the redirect `https://openvibe.coupons/auth/callback` to the Network's seeded OAuth
     clients.
   - Add the grants above.
2. **Code and config:**
   - Put the code at `/opt/openvibe.coupons` and run `npm ci --omit=dev` on Node 22.
   - Create `/etc/openvibe/coupons.env` (0600) from `.env.example`. Set these values:
     - `OV_OAUTH_CLIENT_SECRET`
     - `COUPONS_FORM_SECRET`
     - `COUPONS_REPORTER_KEY_SECRET`
     - `COUPONS_STAFF_SUBJECTS` (optional)
     - `EVENTS_URL=http://127.0.0.1:4300`
     - `BASE_URL=https://openvibe.coupons`
   - Optionally set `OV_SOURCES_INTERNAL_URL=http://127.0.0.1:4720`.
   - Once the extension has a store id, set `COUPONS_EXTENSION_ORIGINS`.
3. **systemd:** install `deploy/systemd/openvibe-coupons.service` (port 4850,
   `StateDirectory=openvibe-coupons`).
4. **nginx:** install `deploy/nginx/openvibe.coupons.conf`. `/metrics` is never proxied.
5. **Search:** add `coupons` to `SEARCH_EVENT_OWNERS`.
6. **Contracts:** release the capability and manifest proposals in openvibe-contracts. Then CI's
   contracts check can drop `continue-on-error`.
7. **Launch:** in the same release, remove `openvibe.coupons` from OpenVibe.Sites and flip the
   Network hub entry (see the launch rule above).

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
