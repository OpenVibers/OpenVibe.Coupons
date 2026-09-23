'use strict';
/**
 * Import from OpenVibe.Sources (category coupons): items become codes with evidence and status
 * unknown, wait for staff review by default, anything that cannot be imported is HELD with a
 * reason (never dropped), no_merchant holds resolve once staff add the shop, a removed item
 * withdraws its evidence, and a failed fetch changes nothing.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const shop = await t.merchant({ name: 'River Books', host: 'riverbooks.com' });
    const item = (id, extra = {}) => ({
        id, source_key: 'staff-coupon-codes', identity: `https://riverbooks.com/promo#${id}`, canonical_url: 'https://riverbooks.com/promo',
        title: 'Autumn reading sale', fields: { code: 'READ20', expires: null }, ...extra,
    });

    await check('an item becomes a code: status unknown, expiry unknown, evidence with the Sources item and its retrieval time, pending review', async () => {
        t.sources.put(item('itm_01K0000000000000000000000A'));
        const r = await t.ctx.importer.run();
        assert.deepStrictEqual(r.outcomes, { imported: 1 });
        const c = t.ctx.store.db.prepare("SELECT * FROM coupons WHERE code = 'READ20'").get();
        assert.strictEqual(c.status, 'unknown');
        assert.strictEqual(c.confidence, null);
        assert.strictEqual(c.expires_at, null);
        assert.strictEqual(c.origin, 'source');
        assert.strictEqual(c.review_state, 'pending');
        const v = t.ctx.coupons.view(c);
        assert.deepStrictEqual(v.evidence, [{ kind: 'source', url: 'https://riverbooks.com/promo', merchant_page: true, sources_item: 'itm_01K0000000000000000000000A', retrieved_at: '2026-09-22T10:00:00.000Z' }]);
        assert.strictEqual((await t.get(`/api/v1/merchants/${shop.id}/coupons`)).json().coupons.length, 0, 'not listed before review');
        assert.strictEqual(t.sources.calls.length, 1);
        assert.match(t.network.grants.find((g) => g.audience === 'openvibe.sources').scope, /sources\.item\.read/);
    });

    await check('the cursor advances: a second run fetches from where the first stopped and imports nothing new', async () => {
        const r = await t.ctx.importer.run();
        assert.deepStrictEqual(r.outcomes, {});
        assert.match(t.sources.calls[t.sources.calls.length - 1], /after=1/);
    });

    await check('items that cannot become a code are held with a reason, and listed for staff', async () => {
        t.sources.put(item('itm_01K0000000000000000000000B', { canonical_url: 'https://unknown-shop.com/x', fields: { code: 'NOPE' } }));
        t.sources.put(item('itm_01K0000000000000000000000C', { kind: 'record' }));
        t.sources.put(item('itm_01K0000000000000000000000D', { fields: { expires: '2026-12-01' } }));
        t.sources.put(item('itm_01K0000000000000000000000E', { fields: { code: 'OLD', expires: '2026-01-01' } }));
        const r = await t.ctx.importer.run();
        assert.deepStrictEqual(r.outcomes, { 'held:no_merchant': 1, 'held:not_a_coupon': 1, 'held:no_code': 1, 'held:expired': 1, 'retry:held:no_merchant': 1 });
        const holds = t.ctx.importer.holds().map((h) => h.reason).sort();
        assert.deepStrictEqual(holds, ['expired', 'no_code', 'no_merchant', 'not_a_coupon']);
        const staff = await t.get('/staff', { as: t.staff });
        assert.match(staff.text, /itm_01K0000000000000000000000B from staff-coupon-codes: no_merchant/);
    });

    await check('a no_merchant hold is imported once staff add the shop', async () => {
        await t.merchant({ name: 'Unknown Shop', host: 'unknown-shop.com' });
        const r = await t.ctx.importer.run();
        assert.deepStrictEqual(r.outcomes, { 'retry:imported': 1 });
        assert.ok(t.ctx.store.db.prepare("SELECT 1 FROM coupons WHERE code = 'NOPE'").get());
        assert.ok(!t.ctx.importer.holds().some((h) => h.reason === 'no_merchant'));
    });

    await check('a stated expiry is kept with basis "source"; a new revision of the same item updates the evidence, not a second code', async () => {
        t.sources.put(item('itm_01K0000000000000000000000A', { revision: 2, fields: { code: 'READ20', expires: '2026-12-31', min_spend: 25, currency: 'EUR' } }));
        await t.ctx.importer.run();
        const rows = t.ctx.store.db.prepare("SELECT * FROM coupons WHERE code = 'READ20'").all();
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].expiry_basis, 'source');
        assert.strictEqual(new Date(rows[0].expires_at).toISOString(), '2026-12-31T23:59:59.999Z');
        const src = t.ctx.store.db.prepare('SELECT * FROM coupon_sources WHERE coupon_id = ?').all(rows[0].id);
        assert.strictEqual(src.length, 1);
        assert.strictEqual(src[0].sources_item_rev, 2);
    });

    await check('with COUPONS_SOURCES_AUTO_PUBLISH=true imported codes are listed at once — still unknown', async () => {
        const t2 = await boot({ env: { COUPONS_SOURCES_AUTO_PUBLISH: 'true' } });
        const s2 = await t2.merchant({ name: 'River Books', host: 'riverbooks.com' });
        t2.sources.put(item('itm_01K0000000000000000000000F'));
        await t2.ctx.importer.run();
        const list = (await t2.get(`/api/v1/merchants/${s2.id}/coupons`)).json().coupons;
        assert.deepStrictEqual(list.map((c) => [c.code, c.status, c.confidence]), [['READ20', 'unknown', null]]);
        await t2.close();
    });

    await check('a removed item withdraws its evidence; a code with no evidence left is taken down', async () => {
        const id = t.ctx.store.db.prepare("SELECT id FROM coupons WHERE code = 'READ20'").get().id;
        t.sources.put(item('itm_01K0000000000000000000000A', { revision: 3, removed: { at: '2026-09-23T00:00:00.000Z', reason: 'merchant asked' } }));
        const r = await t.ctx.importer.run();
        assert.strictEqual(r.outcomes.withdrawn, 1);
        const c = t.ctx.coupons.get(id);
        assert.strictEqual(c.status, 'disabled');
        assert.strictEqual(c.status_reason, 'source_removed');
    });

    await check('a failed fetch changes nothing and is recorded', async () => {
        const before = t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM coupons').get().n;
        const cursor = t.ctx.importer.state().cursor;
        t.sources.setDown(true);
        const r = await t.ctx.importer.run();
        assert.match(r.error, /503/);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM coupons').get().n, before);
        assert.strictEqual(t.ctx.importer.state().cursor, cursor);
        assert.match(t.ctx.importer.state().last_error, /503/);
        const ready = (await t.get('/api/ready')).json();
        assert.match(JSON.stringify(ready), /last run failed/);
        t.sources.setDown(false);
    });

    await t.close();
    done();
})();
