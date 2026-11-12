# AGENTS.md — OpenVibe.Coupons

## Project overview

Coupon codes with merchant matching, restrictions, expiry and real-people validity reports, plus the
public API the OpenVibe browser helper uses. Distinct from Deals even where they cross-link. Node.js/
Express, PostgreSQL (`ov_coupons`), server-rendered, CommonJS, **no build step**.

- Service id `coupons`, port `4850`, origin `https://openvibe.coupons`, unit `openvibe-coupons.service`,
  release root `/opt/openvibe.coupons`.
- It holds **no codes** today: nothing is seeded and no coupon source is enabled.

## The four rules

1. **No code is "working" because a model guessed it.** Status comes only from recent reports by
   people; a submission, a source, staff or AI output cannot set it.
2. **Unknown stays unknown.** An unstated expiry is "Expiry unknown" (`null` in JSON); no recent reports
   means no confidence number; "no restrictions stated" is never "no restrictions".
3. **Expired codes leave active results predictably** — at the instant their known expiry passes, in
   the API, pages, feeds, sitemaps and Search.
4. **A merchant page (or any page) cannot obtain anyone's data.** Lookups return the same bytes to
   every caller; the API ignores cookies; the extension holds no OpenVibe session.

## What it owns

The nine charter tables in [migrations/](migrations/):

| Table | What |
|---|---|
| `coupon_merchants` | `pending` (member proposal, invisible until staff approve), `active`, `disabled` |
| `coupon_merchant_domains` | normalized host, registrable domain (eTLD+1), subdomain rule, optional path prefix |
| `coupons` | code; status exactly `unknown\|reported_working\|reported_failed\|expired\|disabled`; confidence `NULL` when no recent reports; `expires_at` `NULL` with precision (`instant`/`date`) and basis (`evidence`/`submitter`/`source`/`staff`); review state `pending\|published`; origin `member\|staff\|source\|ai` |
| `coupon_sources` | evidence: member/staff submissions (URL, own-domain flag), Sources items (id, revision, retrieval time), AI runs |
| `coupon_restrictions` | min spend (minor units + ISO 4217), categories, new customers only, ISO 3166-1 regions, other |
| `coupon_validation_reports` | worked/failed; one per (reporter, code, UTC day); reporter is an HMAC of the subject |
| `coupon_status_history` | every status/confidence change with reason and actor |
| `coupon_application_hints` | how to apply a code (one code or all of a merchant's) |
| `coupon_watches` | private member watches |

Plus `extension_installs` (browser-helper tokens, hashes only), the Sources importer state/holds, the
SDK outbox and the publishing index sequencer.

Not owned: the merchant's real terms, the browser extension itself
([OpenVibe.Extensions](https://github.com/OpenVibers/OpenVibe.Extensions)), identity, the Search index.

## Who calls it, and whom it calls

- Callers: people in the browser; the **browser helper** with an extension token; OpenVibe.Sources'
  importer; services with a Network service token audience `openvibe.coupons` and the route's
  capability; staff moderation.
- Depends on: **Network** (SSO client `coupons`, JWKS, account export/deletion); **Sources**
  (`sources.item.read`, category `coupons`; the seeded `staff-coupon-codes` source is disabled until a
  person enables it); **Events** (SDK outbox); **Search** (consumes `coupons.index_document.*`);
  `openvibe-publishing` (seo gate, ssr, index hooks); PostgreSQL and Valkey; `openvibe-contracts`/
  `openvibe-sdk`/`openvibe-shared` pins.

## Repository map

- **Entry:** [server/index.js](server/index.js) — app, worker (expiry sweep, importer), outbox;
  graceful stop.
- **App:** [server/app.js](server/app.js) — helmet/CSP, `/auth`, `/shared`, `/api/v1` (API),
  `/api`, pages, discovery, health/ready.
- **Config/db:** [server/config.js](server/config.js), [server/db.js](server/db.js).
- **Domain:** [server/domain/](server/domain/) — `publication.js`, `merchants.js`, `coupons.js`,
  `reports.js`, `installs.js`, `watches.js`, `facts.js`, `moderation.js`.
- **Clients:** [server/clients/sources.js](server/clients/sources.js).
- **HTTP/render:** [server/http/api.js](server/http/api.js), `public.js`, `discovery.js`,
  `actor-limits.js`; [server/render/](server/render/) — pages, home, offer, store, short, layout.
- **Auth:** [server/auth/viewer.js](server/auth/viewer.js); [server/sharing.js](server/sharing.js).
- **Worker/importer:** [server/worker.js](server/worker.js), `server/events/consumer.js`.
- **Deploy:** [deploy/systemd/openvibe-coupons.service](deploy/systemd/openvibe-coupons.service),
  [deploy/nginx/openvibe.coupons.conf](deploy/nginx/openvibe.coupons.conf).

## Commands

```bash
npm ci
npm run dev                # NODE_ENV=development node server/index.js
npm start                  # node server/index.js, http://127.0.0.1:4850
npm test                   # test/run.js, PGlite, mock Network/Sources/Events
npm run test:pg            # same on PostgreSQL (COUPONS_TEST_STORE=pg)
npm test -- lifecycle      # filter by file name; --strict makes a skip fail
ov test                    # the harness's sharded run of what the change reaches
```

## Database and migrations

`ov_coupons` on the host's data role (ADR-035); PGlite in development/tests. Async through
`openvibe-sdk/db`; migrations `migrations/NNNN_*.sql` applied at boot; never edit an applied migration,
add a new number. The status/confidence history is append-only in spirit: a change writes
`coupon_status_history` and the outbox in the same transaction, and the expiry sweep records the event
and tombstone once.

## Auth and privacy

- People sign in through Network SSO for submissions, watches and reports. The **public API takes an
  `Authorization` header only**; it ignores cookies and returns the same bytes to every caller, so a
  merchant page cannot read a visitor's data.
- The browser helper authenticates with an **extension token**: stored as a hash, scoped, revocable,
  and refused immediately on revocation; no OpenVibe session lives in the extension.
- Reports are never anonymous, deduplicated per (reporter, code, UTC day), only the latest per person
  counts, and rate-limited per hour/day; the reporter is an HMAC, not a subject id.
- Service callers need the route's capability (`coupons.*`); staff actions are audited.

## Frontend loading model

Every page is server-rendered and **useful without JavaScript**; there is no SPA, bundler or
transpiler. `openvibe-shared` supplies the Frame, legal/SEO and `/shared/*` from the pinned
node_modules; `openvibe-publishing` supplies the SSR/index helpers. Discovery (robots, sitemap, feeds,
`llms.txt`, IndexNow) is generated from the same data. CSP and cache policy are in
[server/app.js](server/app.js) and `openvibe-shared/cache-policy`.

## Deploy

`sudo ovhost deploy coupons` (git-checkout: fetch, fast-forward `/opt/openvibe.coupons`, install on a
lockfile change, restart, wait for `/api/ready`). Unit `openvibe-coupons.service` on
`127.0.0.1:4850`, env `/etc/openvibe/coupons.env`; the release migrates `ov_coupons` at boot; vhost
[deploy/nginx/openvibe.coupons.conf](deploy/nginx/openvibe.coupons.conf). Rollback
`sudo ovhost rollback coupons --to <sha>`. No secret in a command line, file or log.

## Tests

`npm test` runs each `test/*.test.js` in its own process with PGlite and in-process Network/Sources/
Events mocks. The README's acceptance table maps each rule to its test: `lifecycle.test.js` (unknown
stays unknown, status fields refused from everyone, AI held for review, expiry at the instant, the
sweep once), `reports.test.js` (dedupe, latest-per-person, rate limits, no cookies/anonymous),
`confidence.test.js` (the formula), `extension-privacy.test.js` (hashing, revocation, scopes) and more.
`ov test` runs the same.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; domain in `server/domain/`, HTTP in
  `server/http/`, no SQL in routes.
- Ids/errors/capabilities from `openvibe-contracts`; errors are problem+json with stable codes.
- Dates are UTC; an expiry carries its precision and basis, and an unknown one stays `null`.
- Escape all rendered text; no personal data in URLs, JSON-LD, feeds or the API.

## Pitfalls

- **A model, a source or staff cannot mark a code working.** Only recent people's reports move the
  status; an AI-origin code is `pending` review. Do not add an admin "set working" path.
- **Unknown is not zero/false.** No expiry → `null`, no reports → `confidence: null`, no stated
  restriction → "none stated". Do not substitute defaults.
- **Expiry is instantaneous.** API/page/feed/sitemap/Search must agree at `t-1ms` and `t`; an expired
  page is noindex.
- **The public API is cookie-blind.** Do not add session-based personalisation or per-caller bytes.
- **Reports are per person per code per day**, latest wins; a second report does not add a second
  count, and no anonymous report is accepted.
- **Tracking/affiliate links are not introduced here**; a source's link policy is explicit, and the
  code's evidence URL must be on the merchant's own domain where the rule says so.
- **The extension token is a secret**: hash at rest, never returned after creation, revocation immediate.
- **No Offer/validity JSON-LD** — the README deliberately omits it; do not add price/validity markup.

## Documentation

- [README.md](README.md) — the rules, tables, statuses/confidence, routes, API, extension credentials,
  events, capabilities, acceptance, security and deploy.
- [docs/capabilities-proposal/](docs/capabilities-proposal/), [docs/service-manifest-proposal.json](docs/service-manifest-proposal.json).
- OpenVibe.Contracts holds the `coupons.*` shapes; Sources owns the item contract.
