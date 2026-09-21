# OpenVibe.Coupons

> Coupon codes with merchant matching, restrictions, expiry and real-people validity reports.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `openvibe.coupons`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.10.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Merchants, normalised domains, codes, restrictions, validity reports, expiry/confidence and the API a future browser helper will use. Distinct from Deals even where they cross-link.

## Owns

- `coupon_merchants`, `coupon_merchant_domains`, `coupons`, `coupon_sources`, `coupon_restrictions`, `coupon_validation_reports`, `coupon_status_history`, `coupon_application_hints`, `coupon_watches`
- status model `unknown|reported_working|reported_failed|expired|disabled`

## Does not own

- deal offers (Deals)
- discussion (Community)

## Planned surfaces

- ingest/submit, merchant/domain normalisation, restriction parsing, community validity reports with abuse controls, confidence from evidence only, expiry cleanup
- `GET /api/v1/merchants/resolve?host=`, `GET /api/v1/merchants/:id/coupons`, `POST /api/v1/coupons/:id/report`, `POST /api/v1/coupons/submit`; scoped extension credentials

## Data (authority tables / families)

- see above

## Capabilities and events

- `coupons.submit`, `coupons.report`, `coupons.merchant.resolve`, `coupons.lookup`, `coupons.status.update`

Events: ``coupons.created|updated|expired|disabled``, ``coupons.report.created``, ``coupons.confidence.changed``

## Depends on

- source registry
- OpenVibe.Community
- Notifications
- Search
- OpenVibe.Events

## Acceptance (must be true before "done")

- expired/dead codes leave active results predictably
- reports are deduplicated and rate-limited
- a malicious merchant page cannot obtain another user's account data
- no code is labelled working because a model guessed it

## Bootstrap / extraction source

No current implementation; Wave 16.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
