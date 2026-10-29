'use strict';
/**
 * A code's own page carries one JSON-LD script, every node in one @graph, and a Product/Offer only
 * where the page shows a price or an amount off with a currency (the owner rule: structured data may
 * claim only what the page itself shows).
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const scripts = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
const nodes = (html) => scripts(html).flatMap((m) => {
    const doc = JSON.parse(m[1]);
    return Array.isArray(doc['@graph']) ? doc['@graph'] : [doc];
});
const product = (html) => nodes(html).find((n) => n['@type'] === 'Product');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const shop = await t.merchant({ name: 'Green Grocer', host: 'greengrocer.co.uk' });

    // A code whose page shows "$15 off" and a minimum spend in US dollars.
    const money = await t.submit(alice, {
        merchant_id: shop.id, code: 'SAVE15', title: '$15 off orders of $75+',
        restrictions: { min_spend: { amount: '75.00', currency: 'USD' } },
    });
    assert.strictEqual(money.status, 201, money.text.slice(0, 300));
    const moneyId = money.json().coupon.id;

    // A code whose page shows only a percentage.
    const percent = await t.submit(alice, { merchant_id: shop.id, code: 'PCT20', title: '20% off sitewide' });
    assert.strictEqual(percent.status, 201, percent.text.slice(0, 300));
    const percentId = percent.json().coupon.id;

    await check("a code's page carries one JSON-LD script, every node in one @graph", async () => {
        const page = await t.get(`/c/${moneyId}`);
        assert.strictEqual(page.status, 200);
        assert.strictEqual(scripts(page.text).length, 1, 'exactly one JSON-LD script');
        const doc = JSON.parse(scripts(page.text)[0][1]);
        assert.strictEqual(doc['@context'], 'https://schema.org');
        assert.ok(Array.isArray(doc['@graph']), 'the nodes are in one @graph');
        const types = doc['@graph'].map((n) => n['@type']);
        assert.ok(types.includes('BreadcrumbList') && types.includes('WebPage') && types.includes('Product'), JSON.stringify(types));
        for (const n of doc['@graph']) assert.strictEqual(n['@context'], undefined, 'the graph carries the @context once');
    });

    await check('the offer claims the money the page shows, as a number', async () => {
        const page = await t.get(`/c/${moneyId}`);
        assert.match(page.text, /\$15 off/, 'the page shows the amount');
        assert.match(page.text, /<span class="cpn-scope">USD<\/span>/, 'the page shows the currency it claims');
        const p = product(page.text);
        assert.ok(p, 'the page carries a Product');
        assert.strictEqual(p.url, `https://openvibe.coupons/c/${moneyId}`);
        assert.strictEqual(p.offers.length, 1);
        const offer = p.offers[0];
        assert.strictEqual(typeof offer.price, 'number', 'the price is a number');
        assert.strictEqual(offer.price, 15);
        assert.strictEqual(offer.priceCurrency, 'USD');
        assert.strictEqual(offer.url, `https://openvibe.coupons/c/${moneyId}`);
        assert.strictEqual(offer.availability, 'https://schema.org/InStock');
    });

    await check('a page that shows only a percentage carries no Product and no Offer', async () => {
        const page = await t.get(`/c/${percentId}`);
        assert.strictEqual(scripts(page.text).length, 1, 'exactly one JSON-LD script');
        assert.ok(!product(page.text), 'no Product');
        assert.ok(!/"price"/.test(JSON.stringify(nodes(page.text))), 'no price at all');
    });

    await check('a page shows no rating, so it claims none', async () => {
        const page = await t.get(`/c/${moneyId}`);
        assert.ok(!nodes(page.text).some((n) => n['@type'] === 'AggregateRating'), 'no invented rating');
    });

    await check('a shop page keeps the nodes it already had', async () => {
        const page = await t.get(`/m/${shop.slug}`);
        assert.strictEqual(page.status, 200);
        const types = nodes(page.text).map((n) => n['@type']);
        assert.ok(types.includes('BreadcrumbList') && types.includes('WebPage'), JSON.stringify(types));
        assert.ok(!types.includes('Product'), 'no Offer for a code the shop page does not offer as a product');
    });

    await check('an expired code says sold out', async () => {
        const r = await t.submit(alice, {
            merchant_id: shop.id, code: 'OLD20', title: '$20 off', expires: '2026-09-23',
            restrictions: { min_spend: { amount: '50.00', currency: 'USD' } },
        });
        assert.strictEqual(r.status, 201, r.text.slice(0, 300));
        t.clock.advance(2 * 24 * 3600 * 1000);   // past its expiry
        const page = await t.get(`/c/${r.json().coupon.id}`);
        assert.strictEqual(page.status, 200);
        const p = product(page.text);
        assert.ok(p, 'the page still carries the Product it shows');
        assert.strictEqual(p.offers[0].availability, 'https://schema.org/SoldOut');
    });

    await done();
})().catch((e) => { console.error(e); process.exit(1); });
