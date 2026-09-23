'use strict';

/**
 * Import from OpenVibe.Sources, category `coupons` (the seeded source is `staff-coupon-codes`, a
 * manual source: codes a merchant published itself, entered by staff with the evidence URL).
 *
 *   GET {OV_SOURCES_INTERNAL_URL}/api/v1/items?category=coupons&after=<cursor>&include_removed=1
 *   with a client-credentials token: [coupons, sources.item.read, openvibe.sources]
 *
 * For each item, in change order:
 *   removed               its evidence is withdrawn; a code left with no evidence is disabled
 *   kind 'coupon' + fields.code on a host a merchant covers
 *                         a code (status unknown — an item is evidence that a code was published,
 *                         never that it works), or new evidence on the same code; its expiry is
 *                         fields.expires when the item states one, otherwise unknown
 *   anything else         HELD in coupon_import_holds with the reason (no_merchant, not_a_coupon,
 *                         no_code, expired, invalid, not_selected) — never silently dropped;
 *                         no_merchant holds are retried every run (staff add the merchant)
 * Imported codes wait for staff review unless COUPONS_SOURCES_AUTO_PUBLISH=true.
 * A failed fetch changes nothing and is recorded in import_state.last_error.
 */
const { serviceAuth } = require('openvibe-contracts');
const hosts = require('../domain/hosts');

const STATE_KEY = 'sources:coupons';

function createSourcesImporter({ store, config, merchants, coupons, fetchImpl = globalThis.fetch, log = console }) {
    const { db } = store;
    const enabled = Boolean(config.sources.internalUrl && config.oauth.clientSecret);
    const tokens = enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.sources', scope: 'sources.item.read', fetchImpl,
    }) : null;
    const q = {
        state: db.prepare('SELECT * FROM import_state WHERE key = ?'),
        ensure: db.prepare('INSERT OR IGNORE INTO import_state (key, cursor) VALUES (?, 0)'),
        cursor: db.prepare('UPDATE import_state SET cursor = ?, last_run_at = ?, last_ok_at = ?, last_error = NULL WHERE key = ?'),
        failed: db.prepare('UPDATE import_state SET last_run_at = ?, last_error = ? WHERE key = ?'),
        hold: db.prepare(`INSERT INTO coupon_import_holds (item_id, source_key, reason, detail, item, attempts, created_at, updated_at)
                          VALUES (@item_id, @source_key, @reason, @detail, @item, 1, @now, @now)
                          ON CONFLICT (item_id) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, item = excluded.item,
                                                               attempts = attempts + 1, updated_at = excluded.updated_at, resolved_at = NULL`),
        resolve: db.prepare('UPDATE coupon_import_holds SET resolved_at = ?, updated_at = ? WHERE item_id = ? AND resolved_at IS NULL'),
        retryable: db.prepare("SELECT item FROM coupon_import_holds WHERE resolved_at IS NULL AND reason = 'no_merchant' ORDER BY updated_at LIMIT 100"),
        open: db.prepare('SELECT item_id, source_key, reason, detail, attempts, created_at, updated_at FROM coupon_import_holds WHERE resolved_at IS NULL ORDER BY updated_at DESC LIMIT 200'),
        openCount: db.prepare('SELECT COUNT(*) AS n FROM coupon_import_holds WHERE resolved_at IS NULL'),
    };
    q.ensure.run(STATE_KEY);

    function parseItem(item) {
        const f = item.fields && typeof item.fields === 'object' ? item.fields : {};
        const code = typeof f.code === 'string' ? f.code.trim() : '';
        const title = typeof item.title === 'string' && item.title.trim().length >= 3 && item.title.trim().toUpperCase() !== code.toUpperCase()
            ? item.title : `Code ${code}`;
        const restrictions = {};
        if (f.min_spend != null && f.currency) restrictions.min_spend = { amount: String(f.min_spend), currency: f.currency };
        if (f.new_customers_only === true) restrictions.new_customers_only = true;
        if (typeof f.region === 'string') restrictions.regions = f.region;
        if (typeof f.category === 'string') restrictions.categories = f.category;
        return coupons.parseSubmission({ code, title, description: item.summary || null, expires: f.expires || f.expires_at || null, restrictions }, store.now());
    }

    /** Handle one item inside a transaction. → 'imported' | 'updated' | 'withdrawn' | 'held:<reason>' */
    function handle(item) {
        const now = store.now();
        const held = (reason, detail = null) => {
            q.hold.run({ item_id: item.id, source_key: item.source_key || null, reason, detail: detail ? String(detail).slice(0, 300) : null, item: JSON.stringify(item), now });
            return `held:${reason}`;
        };
        return store.tx(() => {
            if (item.removed) {
                coupons.withdrawSourceItem(item.id, item.removed.reason);
                q.resolve.run(now, now, item.id);
                return 'withdrawn';
            }
            if (config.sources.keys.length && !config.sources.keys.includes(item.source_key)) return held('not_selected', `source ${item.source_key} is not in COUPONS_SOURCES_KEYS`);
            if (item.kind !== 'coupon') return held('not_a_coupon', `kind ${item.kind}`);
            if (!item.fields || typeof item.fields.code !== 'string' || !item.fields.code.trim()) return held('no_code');
            let parsed;
            try { parsed = parseItem(item); } catch (err) {
                return held(err.code === 'coupon.already_expired' ? 'expired' : 'invalid', err.message);
            }
            const at = hosts.hostOfUrl(item.canonical_url);
            const found = at ? merchants.resolve(at.host, { path: at.path, includeStatuses: ['active', 'pending'] }) : null;
            if (!found) return held('no_merchant', at ? at.host : 'no canonical URL');
            const r = coupons.importFromSource(found.merchant, item, parsed, { autoPublish: config.sources.autoPublish });
            q.resolve.run(now, now, item.id);
            return r.created ? 'imported' : 'updated';
        });
    }

    async function getPage(after) {
        const url = `${config.sources.internalUrl}/api/v1/items?category=coupons&include_removed=1&limit=100&after=${after}`;
        const res = await fetchImpl(url, { headers: { Accept: 'application/json', ...(await tokens.authHeaders()) }, signal: AbortSignal.timeout(10000) });
        if (res.status === 401 && tokens.invalidate) tokens.invalidate();
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || !Array.isArray(body.items)) throw new Error(`Sources answered ${res.status}`);
        return body;
    }

    /** One import run. → { outcomes: {…}, cursor } or { error } */
    async function run({ maxPages = 10 } = {}) {
        if (!enabled) return { disabled: true };
        const outcomes = {};
        const count = (o) => { outcomes[o] = (outcomes[o] || 0) + 1; };
        let cursor = q.state.get(STATE_KEY).cursor;
        try {
            for (let i = 0; i < maxPages; i++) {
                const page = await getPage(cursor);
                for (const item of page.items) count(handle(item));
                cursor = page.next_after != null ? Number(page.next_after) : cursor;
                q.cursor.run(cursor, store.now(), store.now(), STATE_KEY);
                if (!page.more) break;
            }
            for (const { item } of q.retryable.all()) count(`retry:${handle(JSON.parse(item))}`);
            q.cursor.run(cursor, store.now(), store.now(), STATE_KEY);
            return { outcomes, cursor };
        } catch (err) {
            q.failed.run(store.now(), String(err.message).slice(0, 300), STATE_KEY);
            log.warn('[Coupons] Sources import failed (nothing changed):', err.message);
            return { error: err.message, outcomes, cursor };
        }
    }

    return {
        enabled,
        run,
        handle,
        state: () => q.state.get(STATE_KEY),
        holds: () => q.open.all(),
        holdCount: () => q.openCount.get().n,
    };
}

module.exports = { createSourcesImporter };
