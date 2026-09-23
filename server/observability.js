'use strict';
/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready, Track O).
 *
 *   db              required  a real query on Coupons' SQLite (the nine charter tables answer)
 *   network_jwks    optional  the Network signing key has loaded; without it pages, lookups and
 *                             feeds still serve, but nobody can sign in and service tokens get 503
 *   events_relay    optional  the outbox relay is configured and has no rejected rows
 *   sweep           optional  the expiry/decay sweep ran without error in the last 5 minutes
 *                             (active lists do not depend on it: they filter on expiry at query time)
 *   sources_import  optional  the Sources import is configured and its last run succeeded
 *   reporter_key    optional  COUPONS_REPORTER_KEY_SECRET is set (otherwise a development key)
 */
const { createReadiness } = require('openvibe-shared/ready');
const { CHARTER_TABLES } = require('./db');

function createCouponsReadiness({ store, auth, outbox, worker, importer, reports, config, release = null }) {
    const { db } = store;
    return createReadiness({
        service: 'coupons',
        release,
        checks: [
            {
                name: 'db', required: true,
                check: () => {
                    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
                    const missing = CHARTER_TABLES.filter((t) => !names.has(t));
                    return missing.length ? `missing ${missing.join(', ')}` : true;
                },
            },
            {
                name: 'network_jwks', required: false,
                check: () => {
                    if (auth.client.publicKey) return true;
                    auth.ensureKey().catch(() => {});
                    return 'Network signing key not loaded yet: sign-in and service calls are unavailable';
                },
            },
            {
                name: 'events_relay', required: false,
                check: () => {
                    const s = outbox.status();
                    if (!s.enabled) return `relay off (EVENTS_URL or OV_OAUTH_CLIENT_SECRET unset); ${s.pending} events waiting`;
                    if (s.rejected) return `${s.rejected} events rejected by OpenVibe.Events`;
                    return { ok: true, detail: { pending: s.pending } };
                },
            },
            {
                name: 'sweep', required: false,
                check: () => {
                    if (!config.worker.enabled) return 'worker off (COUPONS_WORKER=off): expiries are still enforced at query time, but not recorded';
                    const s = worker.lastSweep();
                    if (!s) return 'no sweep yet';
                    if (s.error) return `last sweep failed: ${s.error}`;
                    if (Date.now() - s.at > 5 * 60 * 1000) return 'last sweep is more than 5 minutes old';
                    return true;
                },
            },
            {
                name: 'sources_import', required: false,
                check: () => {
                    if (!importer.enabled) return 'off (OV_SOURCES_INTERNAL_URL or OV_OAUTH_CLIENT_SECRET unset)';
                    const st = importer.state();
                    if (st && st.last_error) return `last run failed: ${st.last_error}`;
                    return { ok: true, detail: { cursor: st ? st.cursor : 0, held: importer.holdCount() } };
                },
            },
            {
                name: 'reporter_key', required: false,
                check: () => (reports.usingDevKey ? 'COUPONS_REPORTER_KEY_SECRET unset: reporter keys use the development key' : true),
            },
        ],
    });
}

module.exports = { createCouponsReadiness };
