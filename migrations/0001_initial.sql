-- phase: expand
-- OpenVibe.Coupons on PostgreSQL (ADR-035, roadmap WS-X2): the tables as they were on SQLite (converted by openvibe-sdk
-- tools/asyncify/sqlite-schema-to-pg: text COLLATE "C" compares like SQLite, integers are bigint, identities keep their ids),
-- then the openvibe-publishing stores and the openvibe-sdk inbox and outbox. Generated once on 2026-09-28; never edited after it runs.

CREATE TABLE coupon_merchants (
    id            text COLLATE "C" PRIMARY KEY,                     -- mer_<ULID>
    slug          text COLLATE "C" NOT NULL UNIQUE,                 -- /m/:slug
    name          text COLLATE "C" NOT NULL,
    homepage_url  text COLLATE "C",                                 -- https://<registrable domain>/ unless staff set another
    description   text COLLATE "C",
    status        text COLLATE "C" NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
    created_by    text COLLATE "C",                                 -- usr_… | svc:<id> | system
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL
);

CREATE TABLE coupon_merchant_domains (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    merchant_id         text COLLATE "C" NOT NULL REFERENCES coupon_merchants(id),
    host                text COLLATE "C" NOT NULL,                  -- normalized (lowercase, punycode, no port, no trailing dot)
    registrable_domain  text COLLATE "C" NOT NULL,                  -- eTLD+1 of host (bundled public-suffix subset)
    include_subdomains  bigint NOT NULL DEFAULT 1,
    path_prefix         text COLLATE "C" NOT NULL DEFAULT '',       -- '' = the whole host; '/shop/x' matches only with a path
    created_by          text COLLATE "C",
    created_at          bigint NOT NULL,
    UNIQUE (host, path_prefix)
);
CREATE INDEX coupon_merchant_domains_registrable ON coupon_merchant_domains (registrable_domain);
CREATE INDEX coupon_merchant_domains_merchant ON coupon_merchant_domains (merchant_id);

CREATE TABLE coupons (
    id                  text COLLATE "C" PRIMARY KEY,               -- cpn_<ULID>
    merchant_id         text COLLATE "C" NOT NULL REFERENCES coupon_merchants(id),
    code                text COLLATE "C" NOT NULL,                  -- as the merchant writes it
    code_key            text COLLATE "C" NOT NULL,                  -- uppercase, for duplicate detection
    title               text COLLATE "C" NOT NULL,
    description         text COLLATE "C",
    status              text COLLATE "C" NOT NULL DEFAULT 'unknown'
                        CHECK (status IN ('unknown','reported_working','reported_failed','expired','disabled')),
    status_reason       text COLLATE "C",
    confidence          double precision,                           -- NULL: no report in the window (validity unknown)
    review_state        text COLLATE "C" NOT NULL DEFAULT 'published' CHECK (review_state IN ('pending','published')),
    origin              text COLLATE "C" NOT NULL CHECK (origin IN ('member','staff','source','ai')),
    expires_at          bigint,                        -- NULL: expiry unknown (never guessed)
    expires_precision   text COLLATE "C" CHECK (expires_precision IN ('instant','date')),
    expiry_basis        text COLLATE "C" CHECK (expiry_basis IN ('evidence','submitter','source','staff')),
    expired_at          bigint,                        -- when it left active results as expired
    disabled_at         bigint,
    last_report_at      bigint,
    last_worked_at      bigint,
    last_failed_at      bigint,
    created_by          text COLLATE "C",                           -- usr_… | svc:<id>; never returned by the API
    created_at          bigint NOT NULL,
    updated_at          bigint NOT NULL,
    CHECK (expires_at IS NULL OR expires_precision IS NOT NULL),
    UNIQUE (merchant_id, code_key)
);
CREATE INDEX coupons_active ON coupons (merchant_id, status, review_state, expires_at);
CREATE INDEX coupons_expiry ON coupons (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX coupons_recent ON coupons (created_at);

CREATE TABLE coupon_sources (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    coupon_id           text COLLATE "C" NOT NULL REFERENCES coupons(id),
    kind                text COLLATE "C" NOT NULL CHECK (kind IN ('member','staff','source','ai')),
    evidence_url        text COLLATE "C",                           -- where the code was published (never fetched by Coupons)
    merchant_evidence   bigint NOT NULL DEFAULT 0,     -- evidence_url is on one of the merchant's own domains
    sources_item_id     text COLLATE "C",                           -- itm_… (OpenVibe.Sources)
    sources_item_rev    bigint,
    source_key          text COLLATE "C",
    retrieved_at        bigint,                        -- Sources' observation time
    ai_run_id           text COLLATE "C",                           -- OpenVibe.AI run (coupons.extract_coupon), when origin is ai
    submitted_by        text COLLATE "C",                           -- usr_… | svc:<id>; never returned by the API
    removed_at          bigint,
    removed_reason      text COLLATE "C",
    created_at          bigint NOT NULL
);
CREATE INDEX coupon_sources_coupon ON coupon_sources (coupon_id);
CREATE UNIQUE INDEX coupon_sources_item ON coupon_sources (coupon_id, sources_item_id) WHERE sources_item_id IS NOT NULL;
CREATE INDEX coupon_sources_submitter ON coupon_sources (submitted_by, created_at);

CREATE TABLE coupon_restrictions (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    coupon_id     text COLLATE "C" NOT NULL REFERENCES coupons(id),
    kind          text COLLATE "C" NOT NULL CHECK (kind IN ('min_spend','category','new_customers_only','region','other')),
    value         text COLLATE "C",                                 -- category name, ISO 3166-1 alpha-2 region, free text
    amount_minor  bigint,                              -- min_spend in minor units
    currency      text COLLATE "C",                                 -- ISO 4217
    created_at    bigint NOT NULL,
    CHECK (kind <> 'min_spend' OR (amount_minor IS NOT NULL AND currency IS NOT NULL))
);
CREATE INDEX coupon_restrictions_coupon ON coupon_restrictions (coupon_id);

CREATE TABLE coupon_validation_reports (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    coupon_id     text COLLATE "C" NOT NULL REFERENCES coupons(id),
    reporter_key  text COLLATE "C" NOT NULL,                        -- HMAC(COUPONS_REPORTER_KEY_SECRET, subject)
    channel       text COLLATE "C" NOT NULL CHECK (channel IN ('site','extension','api')),
    install_id    text COLLATE "C",                                 -- cpi_… when reported through the extension
    day           text COLLATE "C" NOT NULL,                        -- UTC YYYY-MM-DD: one report per reporter, coupon and day
    outcome       text COLLATE "C" NOT NULL CHECK (outcome IN ('worked','failed')),
    reason        text COLLATE "C" CHECK (reason IN ('invalid','expired','min_spend_not_met','not_eligible','other')),
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL,
    UNIQUE (coupon_id, reporter_key, day)
);
CREATE INDEX coupon_reports_coupon ON coupon_validation_reports (coupon_id, updated_at);
CREATE INDEX coupon_reports_reporter ON coupon_validation_reports (reporter_key, created_at);

CREATE TABLE coupon_status_history (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    coupon_id          text COLLATE "C" NOT NULL REFERENCES coupons(id),
    from_status        text COLLATE "C",
    to_status          text COLLATE "C" NOT NULL,
    confidence_before  double precision,
    confidence_after   double precision,
    reason             text COLLATE "C" NOT NULL,                   -- created | report | decay | expiry | staff:<note> | service:<id>
    actor              text COLLATE "C" NOT NULL,                   -- system | usr_… | svc:<id>
    created_at         bigint NOT NULL
);
CREATE INDEX coupon_status_history_coupon ON coupon_status_history (coupon_id, id);

CREATE TABLE coupon_application_hints (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    merchant_id  text COLLATE "C" NOT NULL REFERENCES coupon_merchants(id),
    coupon_id    text COLLATE "C" REFERENCES coupons(id),           -- NULL: applies to every code of the merchant
    text         text COLLATE "C" NOT NULL,
    created_by   text COLLATE "C",
    created_at   bigint NOT NULL
);
CREATE INDEX coupon_hints_merchant ON coupon_application_hints (merchant_id);

CREATE TABLE coupon_watches (
    subject      text COLLATE "C" NOT NULL,                         -- usr_…
    merchant_id  text COLLATE "C" NOT NULL REFERENCES coupon_merchants(id),
    created_at   bigint NOT NULL,
    PRIMARY KEY (subject, merchant_id)
);

CREATE TABLE extension_installs (
    id            text COLLATE "C" PRIMARY KEY,                     -- cpi_<ULID>
    subject       text COLLATE "C" NOT NULL,                        -- usr_… who connected it
    token_hash    text COLLATE "C" NOT NULL UNIQUE,                 -- sha256 of the cpx_ token (the token is shown once)
    token_hint    text COLLATE "C" NOT NULL,                        -- first characters, to recognise it in the list
    label         text COLLATE "C" NOT NULL,
    scopes        text COLLATE "C" NOT NULL,                        -- JSON array: coupons.lookup, coupons.report
    created_at    bigint NOT NULL,
    expires_at    bigint NOT NULL,
    last_used_at  bigint,
    revoked_at    bigint
);
CREATE INDEX extension_installs_subject ON extension_installs (subject, revoked_at);

CREATE TABLE import_state (
    key          text COLLATE "C" PRIMARY KEY,
    cursor       bigint NOT NULL DEFAULT 0,
    last_run_at  bigint,
    last_ok_at   bigint,
    last_error   text COLLATE "C"
);

CREATE TABLE coupon_import_holds (
    item_id      text COLLATE "C" PRIMARY KEY,                      -- itm_… held, never silently dropped
    source_key   text COLLATE "C",
    reason       text COLLATE "C" NOT NULL,                         -- no_merchant | not_a_coupon | no_code | invalid
    detail       text COLLATE "C",
    item         text COLLATE "C" NOT NULL,                         -- the item as Sources returned it (JSON)
    attempts     bigint NOT NULL DEFAULT 1,
    created_at   bigint NOT NULL,
    updated_at   bigint NOT NULL,
    resolved_at  bigint
);

-- openvibe-publishing/index-hooks (prefix coupons)
CREATE TABLE IF NOT EXISTS coupons_index_revisions (
    owner      text COLLATE "C" NOT NULL,
    type       text COLLATE "C" NOT NULL,
    id         text COLLATE "C" NOT NULL,
    revision   integer NOT NULL,
    hash       text NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (owner, type, id)
);

-- openvibe-sdk/events inbox: one receipt per (consumer, event) handled
CREATE TABLE IF NOT EXISTS idempotency_receipts (
    consumer     text NOT NULL,
    event_id     text NOT NULL,
    processed_at bigint NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

-- openvibe-sdk/events PostgreSQL outbox
CREATE TABLE IF NOT EXISTS event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;
