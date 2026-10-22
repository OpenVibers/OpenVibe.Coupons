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
        const c = await t.ctx.store.db.prepare("SELECT * FROM coupons WHERE code = 'READ20'").get();
        assert.strictEqual(c.status, 'unknown');
        assert.strictEqual(c.confidence, null);
        assert.strictEqual(c.expires_at, null);
        assert.strictEqual(c.origin, 'source');
        assert.strictEqual(c.review_state, 'pending');
        const v = await t.ctx.coupons.view(c);
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
        const holds = (await t.ctx.importer.holds()).map((h) => h.reason).sort();
        assert.deepStrictEqual(holds, ['expired', 'no_code', 'no_merchant', 'not_a_coupon']);
        const staff = await t.get('/staff', { as: t.staff });
        assert.match(staff.text, /itm_01K0000000000000000000000B from staff-coupon-codes: no_merchant/);
    });

    await check('a no_merchant hold is imported once staff add the shop', async () => {
        await t.merchant({ name: 'Unknown Shop', host: 'unknown-shop.com' });
        const r = await t.ctx.importer.run();
        assert.deepStrictEqual(r.outcomes, { 'retry:imported': 1 });
        assert.ok(await t.ctx.store.db.prepare("SELECT 1 FROM coupons WHERE code = 'NOPE'").get());
        assert.ok(!(await t.ctx.importer.holds()).some((h) => h.reason === 'no_merchant'));
    });

    await check('a stated expiry is kept with basis "source"; a new revision of the same item updates the evidence, not a second code', async () => {
        t.sources.put(item('itm_01K0000000000000000000000A', { revision: 2, fields: { code: 'READ20', expires: '2026-12-31', min_spend: 25, currency: 'EUR' } }));
        await t.ctx.importer.run();
        const rows = await t.ctx.store.db.prepare("SELECT * FROM coupons WHERE code = 'READ20'").all();
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].expiry_basis, 'source');
        assert.strictEqual(new Date(rows[0].expires_at).toISOString(), '2026-12-31T23:59:59.999Z');
        const src = await t.ctx.store.db.prepare('SELECT * FROM coupon_sources WHERE coupon_id = ?').all(rows[0].id);
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
        const id = (await t.ctx.store.db.prepare("SELECT id FROM coupons WHERE code = 'READ20'").get()).id;
        t.sources.put(item('itm_01K0000000000000000000000A', { revision: 3, removed: { at: '2026-09-23T00:00:00.000Z', reason: 'merchant asked' } }));
        const r = await t.ctx.importer.run();
        assert.strictEqual(r.outcomes.withdrawn, 1);
        const c = await t.ctx.coupons.get(id);
        assert.strictEqual(c.status, 'disabled');
        assert.strictEqual(c.status_reason, 'source_removed');
    });

    await check('a source that names the shop (DealNews): the code goes to the one active merchant of that name, never as merchant evidence', async () => {
        const amazon = await t.merchant({ name: 'Amazon', host: 'amazon.com' });
        t.sources.put(item('itm_01K0000000000000000000000N', { source_key: 'dealnews-coupon-codes', canonical_url: 'https://www.dealnews.com/x/1.html', fields: { code: 'UXBMXG9V', merchant: 'amazon', expires: '2026-12-20' } }));
        t.sources.put(item('itm_01K0000000000000000000000P', { source_key: 'dealnews-coupon-codes', canonical_url: 'https://www.dealnews.com/x/2.html', fields: { code: 'ZZZZ1234', merchant: 'Nowhere Shop' } }));
        const r = await t.ctx.importer.run();
        assert.strictEqual(r.outcomes.imported, 1, JSON.stringify(r.outcomes));
        assert.strictEqual(r.outcomes['held:no_merchant'], 1, JSON.stringify(r.outcomes));
        const c = await t.ctx.store.db.prepare("SELECT * FROM coupons WHERE code = 'UXBMXG9V'").get();
        assert.strictEqual(c.merchant_id, amazon.id);
        assert.strictEqual(c.status, 'unknown');
        const v = await t.ctx.coupons.view(c);
        assert.strictEqual(v.evidence[0].merchant_page, false, 'a DealNews page is not the shop\'s own');
        assert.strictEqual(v.evidence[0].url, 'https://www.dealnews.com/x/1.html');
        const hold = (await t.ctx.importer.holds()).find((h) => h.item_id === 'itm_01K0000000000000000000000P');
        assert.match(hold.detail, /the source names "Nowhere Shop"/);
    });

    await check('DealNews\' feed terms: its codes say "via DealNews" on the site and never reach a browser extension', async () => {
        const c = await t.ctx.store.db.prepare("SELECT * FROM coupons WHERE code = 'UXBMXG9V'").get();
        await t.ctx.store.db.prepare("UPDATE coupons SET review_state = 'published' WHERE id = ?").run(c.id);
        const v = await t.ctx.coupons.view(c);
        assert.deepStrictEqual([v.attribution, v.extension_excluded], [{ text: 'DealNews', url: 'https://www.dealnews.com/' }, true]);
        const page = await t.get(`/c/${c.id}`);
        assert.ok(page.text.includes('Code via <a href="https://www.dealnews.com/" rel="nofollow noopener">DealNews</a>'), 'attributed on its page');
        assert.ok((await t.get('/')).text.includes('via <a href="https://www.dealnews.com/" rel="nofollow noopener">DealNews</a>'), 'and on the front page');
        const site = (await t.get(`/api/v1/merchants/${c.merchant_id}/coupons`)).json();
        assert.ok(site.coupons.some((x) => x.code === 'UXBMXG9V') && site.merchant.active_codes === 1, 'a server or page caller gets it');
        for (const headers of [{ origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }, { origin: 'moz-extension://0d3c5e2a-1111-2222-3333-444455556666' }]) {
            const ext = await t.get(`/api/v1/merchants/${c.merchant_id}/coupons`, { headers });
            assert.strictEqual(ext.status, 200);
            assert.ok(!ext.json().coupons.some((x) => x.code === 'UXBMXG9V') && ext.json().merchant.active_codes === 0, `an extension never does (${headers.origin})`);
            assert.strictEqual((await t.get(`/api/v1/coupons/${c.id}`, { headers })).status, 404);
            assert.match(ext.headers.get('vary') || '', /Origin/);
        }
    });

    await check('a failed fetch changes nothing and is recorded', async () => {
        const before = (await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM coupons').get()).n;
        const cursor = (await t.ctx.importer.state()).cursor;
        t.sources.setDown(true);
        const r = await t.ctx.importer.run();
        assert.match(r.error, /503/);
        assert.strictEqual((await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM coupons').get()).n, before);
        assert.strictEqual((await t.ctx.importer.state()).cursor, cursor);
        assert.match((await t.ctx.importer.state()).last_error, /503/);
        const ready = (await t.get('/api/ready')).json();
        assert.match(JSON.stringify(ready), /last run failed/);
        t.sources.setDown(false);
    });

    await t.close();
    done();
})();
