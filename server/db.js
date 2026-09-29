'use strict';

/**
 * Coupons' own PostgreSQL database (ADR-035, roadmap WS-X2): the schema is migrations/NNNN_*.sql, applied at boot.
 * Nothing here is shared with another
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
 * Also here: extension_installs (cpx_ install tokens, hashed), import_state (the importer's run
 * bookkeeping) and coupon_import_holds, coupons_ingest_cursor (the openvibe-publishing/ingest change
 * cursor, migration 0002), the SDK's event_outbox, and coupons_index_revisions (index sequencer).
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { createIndexSequencer } = require('openvibe-publishing/index-hooks');

const STATUSES = Object.freeze(['unknown', 'reported_working', 'reported_failed', 'expired', 'disabled']);

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

/**
 * The serving handle (ADR-035): DATABASE_URL through PgBouncer; in development without it, an embedded PGlite database
 * in data/pglite. Migrations run first, as the owner (DATABASE_DIRECT_URL), or on the embedded handle.
 */
async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh coupons)');
        const dir = config.db.pgliteDir || DEV_PGLITE;
        log.warn(`[Coupons] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir, service: 'coupons', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'coupons-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'coupons', registry, log });
}

/**
 * Every store on a migrated database handle. opts.now — injectable clock (epoch ms), so tests and replays are
 * deterministic. store.tx(fn) is a transaction; inside it, plain db calls join it (ambient).
 */
function createStore(db, { now = () => Date.now() } = {}) {
    return {
        db,
        now,
        sequencer: createIndexSequencer(db, { prefix: 'coupons', now }),
        tx: async (fn) => await db.tx(() => fn()),
        close: () => db.close(),
    };
}

/** openDb + createStore. */
async function openStore(config, { now, log } = {}) {
    return createStore(await openDb(config, { log }), { now });
}

const CHARTER_TABLES = ['coupon_merchants', 'coupon_merchant_domains', 'coupons', 'coupon_sources', 'coupon_restrictions',
    'coupon_validation_reports', 'coupon_status_history', 'coupon_application_hints', 'coupon_watches'];

module.exports = { openDb, openStore, createStore, MIGRATIONS, CHARTER_TABLES, STATUSES };
