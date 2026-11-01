'use strict';
/**
 * "Remind me" on a code's end (plan L48 R3): the link to openvibe.today/remind on the code's own page and on the cards
 * that show the end, with the right title, time and page — and no link at all once the end has passed.
 */
const assert = require('assert');

const { boot, check, done } = require('./helpers/boot');

/** Every "Remind me" link on a page, as the URL it points at. */
function remindLinks(html) {
    return [...String(html).matchAll(/href="(https:\/\/openvibe\.today\/remind\?[^"]+)"/g)]
        .map((m) => m[1].replace(/&amp;/g, '&'));
}
const query = (href) => Object.fromEntries(new URL(href).searchParams);

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const shop = await t.merchant({ name: 'Green Grocer', host: 'greengrocer.co.uk' });

    await check('a code that ends later links to Today\'s "Remind me" on its page and on the cards', async () => {
        const r = await t.submit(alice, { merchant_id: shop.id, code: 'VEG5', title: 'Five pounds off veg boxes', expires: '2026-12-01' });
        assert.strictEqual(r.status, 201, r.text.slice(0, 300));
        const id = r.json().coupon.id;

        const page = await t.get(`/c/${id}`);
        const links = remindLinks(page.text);
        assert.ok(links.length, 'the code\'s own page has a "Remind me" link');
        const q = query(links[0]);
        assert.strictEqual(q.title, 'Five pounds off veg boxes at Green Grocer ends');
        assert.strictEqual(q.at, '2026-12-01T23:59:59.999Z', 'the end itself, in UTC');
        assert.strictEqual(q.url, `https://openvibe.coupons/c/${id}`, 'the code\'s canonical page');
        assert.strictEqual(q.from, 'openvibe.coupons');

        const home = await t.get('/');
        const homeLink = remindLinks(home.text).find((h) => query(h).url === `https://openvibe.coupons/c/${id}`);
        assert.ok(homeLink, 'the front page\'s card has the link too');
        assert.strictEqual(query(homeLink).at, '2026-12-01T23:59:59.999Z');

        const store = await t.get(`/m/${shop.slug}`);
        const storeLink = remindLinks(store.text).find((h) => query(h).url === `https://openvibe.coupons/c/${id}`);
        assert.ok(storeLink, 'the shop page\'s row has the link too');
        assert.strictEqual(query(storeLink).title, 'Five pounds off veg boxes at Green Grocer ends');
    });

    await check('a code with no stated end has no "Remind me" link', async () => {
        const r = await t.submit(alice, { merchant_id: shop.id, code: 'NODATE', title: 'Ten percent off anything' });
        assert.strictEqual(r.status, 201, r.text.slice(0, 300));
        const id = r.json().coupon.id;
        const page = await t.get(`/c/${id}`);
        assert.strictEqual(remindLinks(page.text).length, 0, 'no link without an end');
    });

    await check('a code that has ended has no "Remind me" link', async () => {
        const r = await t.submit(alice, { merchant_id: shop.id, code: 'GONE', title: 'Half off the lot' });
        assert.strictEqual(r.status, 201, r.text.slice(0, 300));
        const id = r.json().coupon.id;
        // The end moves into the past: nobody may be reminded for a code that is over.
        await t.ctx.store.db.prepare('UPDATE coupons SET expires_at = ?, expires_precision = ? WHERE id = ?')
            .run(t.clock.now() - 60_000, 'instant', id);
        const page = await t.get(`/c/${id}`);
        assert.strictEqual(remindLinks(page.text).length, 0, 'no link once the end has passed');
    });

    await t.close();
    done();
})();
