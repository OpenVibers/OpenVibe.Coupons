'use strict';
/**
 * IndexNow (openvibe-shared/indexnow, mounted in server/app.js, pinged from
 * server/domain/publication.js): off without a key — no key file, nothing sent; with a key the file
 * answers text/plain and an indexable publish pings the page path and the sitemap. A draft never pings.
 */
const assert = require('assert');
const { createIndexNow } = require('openvibe-shared/indexnow');
const { boot, check, done } = require('./helpers/boot');

const KEY = 'k'.repeat(32); // 8–128 hex/alphanumeric, what IndexNow's own tools generate

/** A real key file, but pingSoon records its calls instead of debouncing and POSTing. */
function spy() {
    const calls = [];
    const real = createIndexNow({ host: 'https://openvibe.coupons', key: KEY, fetch: async () => ({ status: 200 }), log() {} });
    return { ...real, calls, pingSoon: (urls) => { calls.push(urls); return real.pingSoon(urls); } };
}

(async () => {
    await check('without a key: no key route, nothing sent', async () => {
        const t = await boot();
        try {
            assert.strictEqual(t.ctx.indexnow.enabled, false, 'IndexNow is off without INDEXNOW_KEY');
            const probe = await t.get(`/${KEY}.txt`);
            assert.strictEqual(probe.status, 404, 'no key file is mounted without a key');
            assert.strictEqual(t.ctx.indexnow.pingSoon(['https://openvibe.coupons/c/cpn_x']), 0, 'nothing is queued');
            // A member publish still works (nothing is pinged, and nothing throws).
            const shop = await t.merchant({ name: 'Off Shop', host: 'offshop.co.uk' });
            const alice = t.network.addUser('alice');
            const r = await t.submit(alice, { merchant_id: shop.id, code: 'OFF10', title: 'Ten off' });
            assert.strictEqual(r.status, 201, r.text.slice(0, 300));
        } finally { await t.close(); }
    });

    await check('with a key: the key file answers text/plain with the key', async () => {
        const t = await boot({ env: { INDEXNOW_KEY: KEY }, indexnow: spy() });
        try {
            assert.strictEqual(t.ctx.indexnow.enabled, true);
            const r = await t.get(`/${KEY}.txt`);
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /text\/plain/);
            assert.strictEqual(r.text, KEY);
            assert.strictEqual((await t.get('/not-the-key.txt')).status, 404);
        } finally { await t.close(); }
    });

    await check('a publish pings the page path and the sitemap; a draft does not', async () => {
        const inw = spy();
        const t = await boot({ env: { INDEXNOW_KEY: KEY }, indexnow: inw });
        try {
            // A shop with no codes is thin (noindex): creating it pings nothing.
            const shop = await t.merchant({ name: 'On Shop', host: 'onshop.co.uk' });
            assert.deepStrictEqual(inw.calls, [], 'a merchant with no active codes never pings');

            // A member submission is published at once → its code page and its shop page are indexable.
            const alice = t.network.addUser('alice');
            const r = await t.submit(alice, { merchant_id: shop.id, code: 'ON5', title: 'Five off' });
            assert.strictEqual(r.status, 201, r.text.slice(0, 300));
            const id = (await t.ctx.store.db.prepare("SELECT id FROM coupons WHERE code = 'ON5'").get()).id;
            const flat = inw.calls.flat();
            assert.ok(flat.includes(`https://openvibe.coupons/c/${id}`), `pinged the code path: ${JSON.stringify(inw.calls)}`);
            assert.ok(flat.includes(`https://openvibe.coupons/m/${shop.slug}`), 'pinged the shop path (its first active code)');
            assert.ok(flat.includes('https://openvibe.coupons/sitemap.xml'), 'pinged the sitemap');

            // The code is taken down: its page leaves the index, so the path is pinged again.
            const beforeDisable = inw.calls.length;
            const off = await t.get(`/api/v1/coupons/${id}/status`, { as: t.staffToken(), json: { status: 'disabled' } });
            assert.strictEqual(off.status, 200, off.text.slice(0, 300));
            assert.ok(inw.calls.length > beforeDisable, 'a page that leaves the index pings');
            assert.ok(inw.calls.slice(beforeDisable).flat().includes(`https://openvibe.coupons/c/${id}`));

            // A code waiting for review (a pending shop) is a draft: no ping.
            const before = inw.calls.length;
            const pending = await t.get('/api/v1/merchants', { as: t.staffToken(), json: { name: 'Pending Shop', domains: [{ host: 'pending-shop.co.uk' }], status: 'pending' } });
            assert.strictEqual(pending.status, 201, pending.text.slice(0, 300));
            const shop2 = pending.json().merchant;
            const draft = await t.submit(alice, { merchant_id: shop2.id, code: 'SOON', title: 'Waiting for review' });
            assert.strictEqual(draft.status, 201);
            assert.strictEqual(inw.calls.length, before, 'a draft never pings');
        } finally { await t.close(); }
    });

    done();
})();
