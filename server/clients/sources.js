'use strict';

/**
 * Import from OpenVibe.Sources, category `coupons` (the seeded source is `staff-coupon-codes`, a
 * manual source: codes a merchant published itself, entered by staff with the evidence URL).
 *
 * The generic half — the Sources HTTP client, the change cursor and the page/savepoint pull loop — is
 * openvibe-publishing/ingest (plan T9): the client is created with the client-credentials token
 * (audience openvibe.sources, scope sources.item.read), pullChanges reads the feed in change order
 * from coupons_ingest_cursor (the old import_state cursor was copied there by migration 0002) and runs
 * one transaction per page with one savepoint per item. What stays here is the coupons policy: what an
 * item means for a code, the holds, and the run bookkeeping.
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
const { createSourcesClient, createChangeCursor, pullChanges, hosts } = require('openvibe-publishing/ingest');

const STATE_KEY = 'sources:coupons';
const CURSOR_NAME = 'sources';

function createSourcesImporter({ store, config, merchants, coupons, fetchImpl = globalThis.fetch, log = console }) {
    const { db } = store;
    const source = createSourcesClient({
        config: {
            networkInternalUrl: config.networkInternalUrl,
            oauth: { clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret },
            sources: { internalUrl: config.sources.internalUrl, category: 'coupons' },
        },
        fetchImpl, now: store.now,
    });
    const enabled = source.enabled;
    const cursor = createChangeCursor(db, { prefix: 'coupons', now: store.now });
    const q = {
        state: db.prepare('SELECT * FROM import_state WHERE key = ?'),
        ensure: db.prepare('INSERT INTO import_state (key, cursor) VALUES (?, 0) ON CONFLICT DO NOTHING'),
        ok: db.prepare('UPDATE import_state SET last_run_at = ?, last_ok_at = ?, last_error = NULL WHERE key = ?'),
        failed: db.prepare('UPDATE import_state SET last_run_at = ?, last_error = ? WHERE key = ?'),
        hold: db.prepare(`INSERT INTO coupon_import_holds (item_id, source_key, reason, detail, item, attempts, created_at, updated_at)
                          VALUES (@item_id, @source_key, @reason, @detail, @item, 1, @now, @now)
                          ON CONFLICT (item_id) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, item = excluded.item,
                                                               attempts = coupon_import_holds.attempts + 1, updated_at = excluded.updated_at, resolved_at = NULL`),
        resolve: db.prepare('UPDATE coupon_import_holds SET resolved_at = ?, updated_at = ? WHERE item_id = ? AND resolved_at IS NULL'),
        retryable: db.prepare("SELECT item FROM coupon_import_holds WHERE resolved_at IS NULL AND reason = 'no_merchant' ORDER BY updated_at LIMIT 100"),
        open: db.prepare('SELECT item_id, source_key, reason, detail, attempts, created_at, updated_at FROM coupon_import_holds WHERE resolved_at IS NULL ORDER BY updated_at DESC LIMIT 200'),
        openCount: db.prepare('SELECT COUNT(*) AS n FROM coupon_import_holds WHERE resolved_at IS NULL'),
    };
    let ensured = false;   // the state row, written on the first run (not at construction: the factory stays synchronous)
    const ensureState = async () => { if (!ensured) { await q.ensure.run(STATE_KEY); ensured = true; } };

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

    /** Handle one item on the caller's transaction/savepoint handle `t`. → 'imported' | 'updated' | 'withdrawn' | 'held:<reason>' */
    async function handle(item, t) {
        const now = store.now();
        const held = async (reason, detail = null) => {
            await q.hold.run({ item_id: item.id, source_key: item.source_key || null, reason, detail: detail ? String(detail).slice(0, 300) : null, item: JSON.stringify(item), now });
            return `held:${reason}`;
        };
        if (item.removed) {
            await coupons.withdrawSourceItem(item.id, item.removed.reason);
            await q.resolve.run(now, now, item.id);
            return 'withdrawn';
        }
        if (config.sources.keys.length && !config.sources.keys.includes(item.source_key)) return await held('not_selected', `source ${item.source_key} is not in COUPONS_SOURCES_KEYS`);
        if (item.kind !== 'coupon') return await held('not_a_coupon', `kind ${item.kind}`);
        if (!item.fields || typeof item.fields.code !== 'string' || !item.fields.code.trim()) return await held('no_code');
        let parsed;
        try { parsed = parseItem(item); } catch (err) {
            return await held(err.code === 'coupon.already_expired' ? 'expired' : 'invalid', err.message);
        }
        const at = hosts.hostOfUrl(item.canonical_url);
        const found = at ? await merchants.resolve(at.host, { path: at.path, includeStatuses: ['active', 'pending'] }) : null;
        if (!found) return await held('no_merchant', at ? at.host : 'no canonical URL');
        const r = await coupons.importFromSource(found.merchant, item, parsed, { autoPublish: config.sources.autoPublish });
        await q.resolve.run(now, now, item.id);
        return r.created ? 'imported' : 'updated';
    }

    /** Coupons' outcome → the chassis' per-item contract. */
    const chassisOutcome = (o) => (o === 'withdrawn' ? 'removed' : o.startsWith('held:') ? 'hold' : 'applied');

    /** One import run. → { outcomes: {…}, cursor } or { error } */
    async function run({ maxPages = 10 } = {}) {
        await ensureState();
        if (!enabled) return { disabled: true };
        const outcomes = {};
        const count = (o) => { outcomes[o] = (outcomes[o] || 0) + 1; };
        try {
            const r = await pullChanges({
                db, cursor, source, name: CURSOR_NAME, maxPages, pageSize: 100,
                apply: async (item, t) => { const o = await handle(item, t); count(o); return chassisOutcome(o); },
            });
            for (const { item } of await q.retryable.all()) count(`retry:${await store.tx(async (t) => await handle(JSON.parse(item), t))}`);
            await q.ok.run(store.now(), store.now(), STATE_KEY);
            return { outcomes, cursor: r.after };
        } catch (err) {
            await q.failed.run(store.now(), String(err.message).slice(0, 300), STATE_KEY);
            log.warn('[Coupons] Sources import failed (nothing changed):', err.message);
            return { error: err.message, outcomes, cursor: await cursor.get(CURSOR_NAME) };
        }
    }

    return {
        enabled,
        run,
        state: async () => ({ ...(await q.state.get(STATE_KEY) || { key: STATE_KEY }), cursor: await cursor.get(CURSOR_NAME) }),
        holds: async () => await q.open.all(),
        holdCount: async () => (await q.openCount.get()).n,
    };
}

module.exports = { createSourcesImporter };
