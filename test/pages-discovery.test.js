'use strict';
/**
 * Useful without JavaScript (every flow is a plain form), discoverable (robots, llms.txt, sitemaps,
 * feeds, JSON twins, JSON-LD from real fields only), cache-safe, and honest about readiness.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const shop = await t.merchant({ name: 'Green Grocer', host: 'greengrocer.co.uk' });

    let codeId;
    await check('submit a code with the plain form (no JavaScript): listed at once as unknown', async () => {
        const anon = await t.get('/submit');
        assert.match(anon.text, /Sign in with OpenVibe/);
        const page = await t.get(`/submit?merchant=${shop.slug}`, { as: alice });
        assert.match(page.text, /<form method="post" action="\/submit"/);
        assert.match(page.text, /Shop: <strong>Green Grocer<\/strong>/);
        assert.doesNotMatch(page.text, /<script src="\/[^"]+\.js"/, 'no page script of our own');
        const r = await t.get('/submit', { as: alice, form: { csrf: t.csrf(alice), merchant: shop.slug, code: 'VEG5', title: 'Five pounds off veg boxes', expires: '', min_spend_amount: '30', min_spend_currency: 'gbp', regions: 'GB' } });
        assert.strictEqual(r.status, 201, r.text.slice(0, 300));
        assert.match(r.text, /your code is listed/);
        codeId = t.ctx.store.db.prepare("SELECT id FROM coupons WHERE code = 'VEG5'").get().id;
        const m = await t.get(`/m/${shop.slug}`);
        assert.match(m.text, /VEG5/);
        assert.match(m.text, /Minimum spend £30\.00/);
        assert.match(m.text, /United Kingdom \(GB\)/);
        const bad = await t.get('/submit', { as: alice, form: { csrf: t.csrf(alice), merchant: shop.slug, code: 'has space', title: 'x' } });
        assert.strictEqual(bad.status, 422);
        assert.match(bad.text, /Please fix/);
        assert.match(bad.text, /value="x"/, 'the form keeps what was typed');
        assert.strictEqual((await t.get('/submit', { as: alice, form: { merchant: shop.slug, code: 'A1', title: 'abc' } })).status, 403, 'no form token');
    });

    await check('report and watch with plain forms; the watch list is private', async () => {
        const own = await t.get(`/c/${codeId}/report`, { as: alice, form: { csrf: t.csrf(alice), outcome: 'worked', back: `/m/${shop.slug}` } });
        assert.strictEqual(own.status, 403, 'the submitter cannot report on her own code');
        const bob = t.network.addUser('bob');
        const r = await t.get(`/c/${codeId}/report`, { as: bob, form: { csrf: t.csrf(bob), outcome: 'worked', back: `/m/${shop.slug}` } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.headers.get('location'), `/m/${shop.slug}?done=reported`);
        const after = await t.get(`/m/${shop.slug}?done=reported`, { as: bob });
        assert.match(after.text, /your report was recorded/);
        assert.match(after.text, /Reported working/);
        assert.match(after.text, /Confidence 67%/);
        const offsite = await t.get(`/c/${codeId}/report`, { as: bob, form: { csrf: t.csrf(bob), outcome: 'worked', back: 'https://evil.example-shop.com/' } });
        assert.strictEqual(offsite.headers.get('location'), `/c/${codeId}?done=report_same`, 'no open redirect');
        const w = await t.get(`/m/${shop.slug}/watch`, { as: alice, form: { csrf: t.csrf(alice), action: 'watch' } });
        assert.strictEqual(w.status, 303);
        assert.match((await t.get('/watching', { as: alice })).text, /Green Grocer/);
        assert.strictEqual((await t.get('/watching')).status, 303, 'anonymous → sign in');
        await t.get(`/m/${shop.slug}/watch`, { as: alice, form: { csrf: t.csrf(alice), action: 'unwatch' } });
        assert.doesNotMatch((await t.get('/watching', { as: alice })).text, /Green Grocer/);
    });

    await check('caching: anonymous pages are public for 60 s, signed-in pages are private; both vary on Cookie', async () => {
        const anon = await t.get(`/m/${shop.slug}`);
        assert.match(anon.headers.get('cache-control'), /^public, max-age=60/);
        assert.match(anon.headers.get('vary'), /Cookie/);
        const signed = await t.get(`/m/${shop.slug}`, { as: alice });
        assert.strictEqual(signed.headers.get('cache-control'), 'private, no-store');
        assert.match(signed.text, /name="csrf"/);
        assert.doesNotMatch(anon.text, /name="csrf"/, 'no form tokens in a shared cache');
    });

    await check('JSON-LD only from real fields (breadcrumbs, web page); the JSON twin has the page\'s content', async () => {
        const page = (await t.get(`/c/${codeId}`)).text;
        const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        assert.deepStrictEqual(blocks.map((b) => b['@type']).sort(), ['BreadcrumbList', 'WebPage']);
        const json = (await t.get(`/c/${codeId}.json`)).json();
        assert.strictEqual(json.coupon.code, 'VEG5');
        assert.strictEqual(json.indexability.indexable, true);
        const mj = (await t.get(`/m/${shop.slug}.json`)).json();
        assert.deepStrictEqual(mj.coupons.map((c) => c.code), ['VEG5']);
    });

    await check('robots.txt, llms.txt, the sitemap index and sections, and the feeds', async () => {
        const robots = await t.get('/robots.txt');
        assert.match(robots.text, /Sitemap: https:\/\/openvibe\.coupons\/sitemap\.xml/);
        assert.match(robots.text, /Disallow: \/api\//);
        assert.match(robots.text, /automated-consumer policy/);
        const llms = await t.get('/llms.txt');
        assert.match(llms.text, /reported_working/);
        assert.match(llms.text, /\/m\/<slug>\.json/);
        assert.match((await t.get('/sitemap.xml')).text, /sitemaps\/coupons\.xml[\s\S]*sitemaps\/merchants\.xml|sitemaps\/merchants\.xml[\s\S]*sitemaps\/coupons\.xml/);
        assert.match((await t.get('/sitemaps/coupons.xml')).text, new RegExp(`https://openvibe\\.coupons/c/${codeId}`));
        assert.match((await t.get('/sitemaps/merchants.xml')).text, new RegExp(`https://openvibe\\.coupons/m/${shop.slug}`));
        const rss = await t.get('/feed.xml');
        assert.match(rss.headers.get('content-type'), /rss/);
        assert.match(rss.text, /VEG5/);
        assert.match(rss.text, /Expiry unknown/);
        assert.match((await t.get('/atom.xml')).text, /<entry>/);
        assert.strictEqual((await t.get('/feed.json')).json().items.length, 1);
        assert.match((await t.get(`/m/${shop.slug}/feed.xml`)).text, /VEG5/);
    });

    await check('home, search and the about page (with the formula) render without JavaScript', async () => {
        const home = await t.get('/');
        assert.match(home.text, /Green Grocer/);
        assert.match(home.text, /1 active code</);
        const s = await t.get('/?q=grocer');
        assert.match(s.text, /Shops matching “grocer”/);
        assert.match(s.text, /<meta name="robots" content="noindex, nofollow">/, 'search results are not indexed');
        const about = await t.get('/about');
        assert.match(about.text, /confidence = \(1 \+ e \+ W\) \/ \(2 \+ e \+ W \+ F\)/);
        assert.match(about.text, /reads only the hostname/);
    });

    await check('health, readiness, release, 404s', async () => {
        assert.strictEqual((await t.get('/api/health')).json().service, 'openvibe-coupons');
        const ready = await t.get('/api/ready');
        assert.strictEqual(ready.status, 200);
        const body = ready.json();
        assert.match(JSON.stringify(body), /relay off/);
        assert.match(JSON.stringify(body), /worker off/);
        assert.strictEqual((await t.get('/release.json')).status, 200);
        assert.strictEqual((await t.get('/nope')).status, 404);
        assert.strictEqual((await t.get('/m/nope')).status, 404);
        assert.strictEqual((await t.get('/c/cpn_00000000000000000000000000')).status, 404);
        const api404 = await t.get('/api/v1/nope');
        assert.strictEqual(api404.status, 404);
        assert.match(api404.headers.get('content-type'), /problem\+json/);
    });

    await check('staff pages are for staff only', async () => {
        assert.strictEqual((await t.get('/staff')).status, 303);
        assert.strictEqual((await t.get('/staff', { as: alice })).status, 403);
        assert.strictEqual((await t.get('/staff', { as: t.staff })).status, 200);
        const add = await t.get('/staff/merchants', { as: t.staff, form: { csrf: t.csrf(t.staff), name: 'Cycle Hub', host: 'cyclehub.de', include_subdomains: '1' } });
        assert.match(add.text, /Added Cycle Hub/);
        const noCsrf = await t.get('/staff/merchants', { as: t.staff, form: { name: 'X', host: 'x-shop.de' } });
        assert.strictEqual(noCsrf.status, 403);
    });

    await t.close();
    done();
})();
