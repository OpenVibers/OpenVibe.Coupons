'use strict';

/**
 * Coupons' own SQLite database, created on boot, idempotently. Nothing here is shared with another
 * service.
 *
 * The nine charter tables (roadmap §15.13):
 *
 *   coupon_merchants            merchants: pending (member-proposed) | active | disabled
 *   coupon_merchant_domains     host rules: exact host or host + subdomains, optional path prefix
 *   coupons                     codes: status unknown|reported_working|reported_failed|expired|disabled,
 *                               confidence (NULL = no recent reports), expiry (NULL = unknown)
 *   coupon_sources              evidence: member submissions, OpenVibe.Sources items, staff entries
 *   coupon_restrictions         min spend, categories, new customers only, regions, other
 *   coupon_validation_reports   worked/failed reports, one row per (reporter, coupon, UTC day);
 *                               the reporter is an HMAC of the person's subject, never returned
 *   coupon_status_history       every status/confidence change with its reason and actor
 *   coupon_application_hints    where and how to apply a code, per merchant or per code
 *   coupon_watches              members watching a merchant
 *
 * Also here: extension_installs (cpx_ install tokens, hashed), import_state and
 * coupon_import_holds (the OpenVibe.Sources importer), the SDK's event_outbox, and
 * <coupons>_index_revisions (openvibe-publishing index sequencer).
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createIndexSequencer } = require('openvibe-publishing/index-hooks');

const STATUSES = Object.freeze(['unknown', 'reported_working', 'reported_failed', 'expired', 'disabled']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS coupon_merchants (
    id            TEXT PRIMARY KEY,                     -- mer_<ULID>
    slug          TEXT NOT NULL UNIQUE,                 -- /m/:slug
    name          TEXT NOT NULL,
    homepage_url  TEXT,                                 -- https://<registrable domain>/ unless staff set another
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
    created_by    TEXT,                                 -- usr_… | svc:<id> | system
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coupon_merchant_domains (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_id         TEXT NOT NULL REFERENCES coupon_merchants(id),
    host                TEXT NOT NULL,                  -- normalized (lowercase, punycode, no port, no trailing dot)
    registrable_domain  TEXT NOT NULL,                  -- eTLD+1 of host (bundled public-suffix subset)
    include_subdomains  INTEGER NOT NULL DEFAULT 1,
    path_prefix         TEXT NOT NULL DEFAULT '',       -- '' = the whole host; '/shop/x' matches only with a path
    created_by          TEXT,
    created_at          INTEGER NOT NULL,
    UNIQUE (host, path_prefix)
);
CREATE INDEX IF NOT EXISTS coupon_merchant_domains_registrable ON coupon_merchant_domains (registrable_domain);
CREATE INDEX IF NOT EXISTS coupon_merchant_domains_merchant ON coupon_merchant_domains (merchant_id);

CREATE TABLE IF NOT EXISTS coupons (
    id                  TEXT PRIMARY KEY,               -- cpn_<ULID>
    merchant_id         TEXT NOT NULL REFERENCES coupon_merchants(id),
    code                TEXT NOT NULL,                  -- as the merchant writes it
    code_key            TEXT NOT NULL,                  -- uppercase, for duplicate detection
    title               TEXT NOT NULL,
    description         TEXT,
    status              TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (status IN ('unknown','reported_working','reported_failed','expired','disabled')),
    status_reason       TEXT,
    confidence          REAL,                           -- NULL: no report in the window (validity unknown)
    review_state        TEXT NOT NULL DEFAULT 'published' CHECK (review_state IN ('pending','published')),
    origin              TEXT NOT NULL CHECK (origin IN ('member','staff','source','ai')),
    expires_at          INTEGER,                        -- NULL: expiry unknown (never guessed)
    expires_precision   TEXT CHECK (expires_precision IN ('instant','date')),
    expiry_basis        TEXT CHECK (expiry_basis IN ('evidence','submitter','source','staff')),
    expired_at          INTEGER,                        -- when it left active results as expired
    disabled_at         INTEGER,
    last_report_at      INTEGER,
    last_worked_at      INTEGER,
    last_failed_at      INTEGER,
    created_by          TEXT,                           -- usr_… | svc:<id>; never returned by the API
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    CHECK (expires_at IS NULL OR expires_precision IS NOT NULL),
    UNIQUE (merchant_id, code_key)
);
CREATE INDEX IF NOT EXISTS coupons_active ON coupons (merchant_id, status, review_state, expires_at);
CREATE INDEX IF NOT EXISTS coupons_expiry ON coupons (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS coupons_recent ON coupons (created_at);

CREATE TABLE IF NOT EXISTS coupon_sources (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_id           TEXT NOT NULL REFERENCES coupons(id),
    kind                TEXT NOT NULL CHECK (kind IN ('member','staff','source','ai')),
    evidence_url        TEXT,                           -- where the code was published (never fetched by Coupons)
    merchant_evidence   INTEGER NOT NULL DEFAULT 0,     -- evidence_url is on one of the merchant's own domains
    sources_item_id     TEXT,                           -- itm_… (OpenVibe.Sources)
    sources_item_rev    INTEGER,
    source_key          TEXT,
    retrieved_at        INTEGER,                        -- Sources' observation time
    ai_run_id           TEXT,                           -- OpenVibe.AI run (coupons.extract_coupon), when origin is ai
    submitted_by        TEXT,                           -- usr_… | svc:<id>; never returned by the API
    removed_at          INTEGER,
    removed_reason      TEXT,
    created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS coupon_sources_coupon ON coupon_sources (coupon_id);
CREATE UNIQUE INDEX IF NOT EXISTS coupon_sources_item ON coupon_sources (coupon_id, sources_item_id) WHERE sources_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS coupon_sources_submitter ON coupon_sources (submitted_by, created_at);

CREATE TABLE IF NOT EXISTS coupon_restrictions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_id     TEXT NOT NULL REFERENCES coupons(id),
    kind          TEXT NOT NULL CHECK (kind IN ('min_spend','category','new_customers_only','region','other')),
    value         TEXT,                                 -- category name, ISO 3166-1 alpha-2 region, free text
    amount_minor  INTEGER,                              -- min_spend in minor units
    currency      TEXT,                                 -- ISO 4217
    created_at    INTEGER NOT NULL,
    CHECK (kind <> 'min_spend' OR (amount_minor IS NOT NULL AND currency IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS coupon_restrictions_coupon ON coupon_restrictions (coupon_id);

CREATE TABLE IF NOT EXISTS coupon_validation_reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_id     TEXT NOT NULL REFERENCES coupons(id),
    reporter_key  TEXT NOT NULL,                        -- HMAC(COUPONS_REPORTER_KEY_SECRET, subject)
    channel       TEXT NOT NULL CHECK (channel IN ('site','extension','api')),
    install_id    TEXT,                                 -- cpi_… when reported through the extension
    day           TEXT NOT NULL,                        -- UTC YYYY-MM-DD: one report per reporter, coupon and day
    outcome       TEXT NOT NULL CHECK (outcome IN ('worked','failed')),
    reason        TEXT CHECK (reason IN ('invalid','expired','min_spend_not_met','not_eligible','other')),
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE (coupon_id, reporter_key, day)
);
CREATE INDEX IF NOT EXISTS coupon_reports_coupon ON coupon_validation_reports (coupon_id, updated_at);
CREATE INDEX IF NOT EXISTS coupon_reports_reporter ON coupon_validation_reports (reporter_key, created_at);

CREATE TABLE IF NOT EXISTS coupon_status_history (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_id          TEXT NOT NULL REFERENCES coupons(id),
    from_status        TEXT,
    to_status          TEXT NOT NULL,
    confidence_before  REAL,
    confidence_after   REAL,
    reason             TEXT NOT NULL,                   -- created | report | decay | expiry | staff:<note> | service:<id>
    actor              TEXT NOT NULL,                   -- system | usr_… | svc:<id>
    created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS coupon_status_history_coupon ON coupon_status_history (coupon_id, id);

CREATE TABLE IF NOT EXISTS coupon_application_hints (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_id  TEXT NOT NULL REFERENCES coupon_merchants(id),
    coupon_id    TEXT REFERENCES coupons(id),           -- NULL: applies to every code of the merchant
    text         TEXT NOT NULL,
    created_by   TEXT,
    created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS coupon_hints_merchant ON coupon_application_hints (merchant_id);

CREATE TABLE IF NOT EXISTS coupon_watches (
    subject      TEXT NOT NULL,                         -- usr_…
    merchant_id  TEXT NOT NULL REFERENCES coupon_merchants(id),
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (subject, merchant_id)
);

CREATE TABLE IF NOT EXISTS extension_installs (
    id            TEXT PRIMARY KEY,                     -- cpi_<ULID>
    subject       TEXT NOT NULL,                        -- usr_… who connected it
    token_hash    TEXT NOT NULL UNIQUE,                 -- sha256 of the cpx_ token (the token is shown once)
    token_hint    TEXT NOT NULL,                        -- first characters, to recognise it in the list
    label         TEXT NOT NULL,
    scopes        TEXT NOT NULL,                        -- JSON array: coupons.lookup, coupons.report
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    last_used_at  INTEGER,
    revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS extension_installs_subject ON extension_installs (subject, revoked_at);

CREATE TABLE IF NOT EXISTS import_state (
    key          TEXT PRIMARY KEY,
    cursor       INTEGER NOT NULL DEFAULT 0,
    last_run_at  INTEGER,
    last_ok_at   INTEGER,
    last_error   TEXT
);

CREATE TABLE IF NOT EXISTS coupon_import_holds (
    item_id      TEXT PRIMARY KEY,                      -- itm_… held, never silently dropped
    source_key   TEXT,
    reason       TEXT NOT NULL,                         -- no_merchant | not_a_coupon | no_code | invalid
    detail       TEXT,
    item         TEXT NOT NULL,                         -- the item as Sources returned it (JSON)
    attempts     INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    resolved_at  INTEGER
);
`;

/**
 * Open (or create) the database.
 * opts.now — injectable clock (epoch ms), so tests and replays are deterministic.
 */
function openStore(dbPath, { now = () => Date.now() } = {}) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    return {
        db,
        now,
        sequencer: createIndexSequencer(db, { prefix: 'coupons', now }),
        tx: (fn) => db.transaction(fn)(),
        close: () => db.close(),
    };
}

const CHARTER_TABLES = ['coupon_merchants', 'coupon_merchant_domains', 'coupons', 'coupon_sources', 'coupon_restrictions',
    'coupon_validation_reports', 'coupon_status_history', 'coupon_application_hints', 'coupon_watches'];

module.exports = { openStore, CHARTER_TABLES, STATUSES };
