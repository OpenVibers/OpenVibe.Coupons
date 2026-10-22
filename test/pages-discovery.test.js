'use strict';
/**
 * Useful without JavaScript (every flow is a plain form), discoverable (robots, llms.txt, sitemaps,
 * feeds, JSON twins, JSON-LD from real fields only), cache-safe, and honest about readiness.
 */
const assert = require('assert');

function assertSitemapLastmods(xml, tag = 'url') {
    const entries = [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))];
    for (const [, body] of entries) {
        const match = /<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/.exec(body);
        assert.ok(match, body);
        assert.strictEqual(new Date(match[1]).toISOString().slice(0, 10), match[1]);
    }
    return entries;
}

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
        codeId = (await t.ctx.store.db.prepare("SELECT id FROM coupons WHERE code = 'VEG5'").get()).id;
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
        assert.strictEqual(anon.headers.get('cache-control'), 'public, max-age=60, stale-while-revalidate=3600');
        assert.match(anon.headers.get('vary'), /Cookie/);
        const signed = await t.get(`/m/${shop.slug}`, { as: alice });
        assert.strictEqual(signed.headers.get('cache-control'), 'private, no-store');
        assert.match(signed.text, /name="csrf"/);
        assert.doesNotMatch(anon.text, /name="csrf"/, 'no form tokens in a shared cache');
    });

    await check('JSON-LD only from real fields (breadcrumbs, web page); the JSON twin has the page\'s content', async () => {
        const page = (await t.get(`/c/${codeId}`)).text;
        assert.strictEqual((page.match(/<h1\b/g) || []).length, 1, 'the code page has one h1: its title');
        assert.match(page, /<h1 class="coupon-title">/);
        // Its description is its own facts, not the same "Validity unknown. Expiry unknown." as every other code.
        const desc = (page.match(/<meta name="description" content="([^"]*)">/) || [])[1] || '';
        assert.match(desc, /^Coupon code VEG5 for .+ at .+: (Validity unknown|Reported working|Reported not working), (expires \d{4}-\d{2}-\d{2}|no expiry stated)[^"]*\.$/, desc);
        assert.ok(desc.length <= 160, desc);
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
        const couponMap = (await t.get('/sitemaps/coupons.xml')).text;
        const merchantMap = (await t.get('/sitemaps/merchants.xml')).text;
        assertSitemapLastmods(couponMap);
        assertSitemapLastmods(merchantMap);
        const row = await t.ctx.store.db.prepare('SELECT updated_at FROM coupons WHERE id = ?').get(codeId);
        assert.ok(couponMap.includes(`<loc>https://openvibe.coupons/c/${codeId}</loc><lastmod>${new Date(row.updated_at).toISOString().slice(0, 10)}</lastmod>`));
        assertSitemapLastmods((await t.get('/sitemap.xml')).text, 'sitemap');
        const rss = await t.get('/feed.xml');
        assert.match(rss.headers.get('content-type'), /rss/);
        assert.match(rss.text, /VEG5/);
        assert.match(rss.text, /Expiry unknown/);
        assert.match((await t.get('/atom.xml')).text, /<entry>/);
        assert.strictEqual((await t.get('/feed.json')).json().items.length, 1);
        assert.match((await t.get(`/m/${shop.slug}/feed.xml`)).text, /VEG5/);
    });

    await check('llms-full.txt carries only indexable entries, within its byte budget; the home page carries the AI summary', async () => {
        const full = await t.get('/llms-full.txt');
        assert.strictEqual(full.status, 200);
        assert.match(full.headers.get('content-type'), /^text\/plain/);
        assert.match(full.text, new RegExp(`URL: https://openvibe\\.coupons/c/${codeId}\\n`));
        assert.match(full.text, new RegExp(`URL: https://openvibe\\.coupons/m/${shop.slug}\\n`));
        assert.match(full.text, /Expiry unknown\./, 'the entry carries its short summary');
        assert.doesNotMatch(full.text, /Minimum spend/, 'never the full source text');
        assert.ok(Buffer.byteLength(full.text) <= 512 * 1024, 'llms-full stays within maxBytes');

        // A code that leaves active results is not indexable and must not be listed.
        await t.get('/submit', { as: alice, form: { csrf: t.csrf(alice), merchant: shop.slug, code: 'GONE1', title: 'Withdrawn offer' } });
        await t.ctx.store.db.query("UPDATE coupons SET status = 'disabled' WHERE code = 'GONE1'");
        const after = await t.get('/llms-full.txt');
        assert.doesNotMatch(after.text, /GONE1/, 'a taken-down code is never listed');
        assert.match(after.text, new RegExp(`URL: https://openvibe\\.coupons/c/${codeId}\\n`), 'the indexable code is still there');

        const home = await t.get('/');
        assert.match(home.text, /<meta name="ai-summary" content="[^"]+">/, 'the home page carries the ai-summary meta');
        assert.match(home.text, /"@type":"WebPage"/, 'the home page carries WebPage JSON-LD');
        assert.match(home.text, /Coupon codes for online shops with merchant\/domain matching/);
    });

    await check('home, search and the about page (with the formula) render without JavaScript', async () => {
        const home = await t.get('/');
        assert.match(home.text, /Green Grocer/);
        assert.match(home.text, /Green Grocer <span class="chip-n">1<span class="sr-only"> active code<\/span><\/span>/, 'a shop with a code is a chip with its count, worded for screen readers');
        assert.match(home.text, /1 shop listed; 1 with an active code right now\./);
        // The front page opens with the showcase (openvibe-shared/showcase): its hero is the one h1 and its stylesheet is linked;
        // the shops still follow. A search result page has neither.
        assert.ok(home.text.includes('class="sc-hero') && home.text.includes('class="sc-sec"'), 'the home opens with the showcase');
        assert.match(home.text, /<link rel="stylesheet" href="[^"]*showcase\.css[^"]*">/);
        assert.strictEqual((home.text.match(/<h1[\s>]/g) || []).length, 1, 'one h1 on the home page');
        const body = home.text.slice(home.text.indexOf('<main'));
        assert.ok(body.indexOf('class="sc-hero') < body.indexOf('Green Grocer'), 'the showcase sits above the shops');
        // The curated front page: the code itself on a ticket, the numbers, questions with their FAQPage JSON-LD, no filler.
        assert.ok(body.includes('<code class="code">VEG5</code>'), 'codes on tickets, each showing its code');
        assert.ok(body.includes('class="cp-stats"') && /<b>1<\/b><span>active codes<\/span>/.test(body), 'the numbers');
        assert.ok(body.includes('id="cp-working"') && body.indexOf('VEG5') > body.indexOf('id="cp-working"'), 'people reported it worked: it leads, under "Reported working"');
        assert.strictEqual(body.split('<code class="code">VEG5</code>').length, 2, 'a code shows once');
        const ld = [...home.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        const faq = ld.find((x) => x['@type'] === 'FAQPage');
        assert.ok(faq && faq.mainEntity.length >= 5 && ld.some((x) => x['@type'] === 'WebSite') && ld.some((x) => x['@type'] === 'ItemList'));
        for (const q of faq.mainEntity) assert.ok(body.includes(`<summary>${q.name.replace(/"/g, '&quot;')}</summary>`), `the question is on the page: ${q.name}`);
        assert.doesNotMatch(body, /coming soon/i);
        const s = await t.get('/?q=grocer');
        assert.match(s.text, /Shops matching “grocer”/);
        assert.ok(!s.text.includes('sc-hero') && !s.text.includes('showcase.css'), 'a search page has no showcase');
        assert.match(s.text, /<h1>Coupon codes, honestly labelled<\/h1>/);
        assert.match(s.text, /<meta name="robots" content="noindex, nofollow">/, 'search results are not indexed');
        const about = await t.get('/about');
        assert.match(about.text, /confidence = \(1 \+ e \+ W\) \/ \(2 \+ e \+ W \+ F\)/);
        assert.match(about.text, /sends this site only the <strong>hostname<\/strong>/);
        assert.match(about.text, /never rewrites links or adds referral tags/);
        assert.ok(home.text.includes('href="/companion"'), 'the home links the Companion');
        const cp = await t.get('/companion');
        assert.strictEqual(cp.status, 200);
        assert.ok(cp.text.includes('class="sc-hero') && /<h1[^>]*>The OpenVibe[\s\S]{0,80}Companion/.test(cp.text), 'the page opens with its showcase');
        assert.strictEqual((cp.text.match(/<h1[\s>]/g) || []).length, 1, 'one h1');
        assert.ok(cp.text.includes('https://github.com/OpenVibers/OpenVibe.Extensions/releases/latest') && cp.text.includes('chrome://extensions') && cp.text.includes('about:debugging'), 'how to install it');
        assert.ok(cp.text.includes('https://openvibe.rent/in') && cp.text.includes('checks its rent') && cp.text.includes('https://openvibe.food/delivery') && cp.text.includes('https://openvibe.reviews') && cp.text.includes('Review sites: bring the rating'), 'what it does across sites');
        assert.match(cp.text, /<link rel="canonical" href="[^"]*\/companion">/);
        assert.doesNotMatch(cp.text, /noindex/, 'indexable');
    });

    await check('every page carries the boost marker and script; the navbar signs in back to the current page', async () => {
        for (const url of ['/', '/about', `/m/${shop.slug}`]) {
            const page = (await t.get(url)).text;
            assert.match(page, /<meta name="ov-boost" content="coupons@[^"]+">/, `${url}: the boost marker`);
            assert.match(page, /<script src="\/shared\/boost\.js\?v=[^"]+" data-main="#main" defer><\/script>/, `${url}: the boost script, main = #main`);
            assert.match(page, /"loginUrl":"\/auth\/login\?next=\{path\}"/, `${url}: the navbar's login template`);
            assert.match(page, /<main id="main"/, `${url}: the swappable main`);
        }
    });

    await check('health, readiness, release, 404s', async () => {
        assert.strictEqual((await t.get('/api/health')).json().service, 'openvibe-coupons');
        const ready = await t.get('/api/ready');
        assert.strictEqual(ready.status, 200);
        const body = ready.json();
        assert.match(JSON.stringify(body), /relay off/);
        assert.match(JSON.stringify(body), /worker off/);
        const rel = await t.get('/release.json');
        assert.strictEqual(rel.status, 200);
        assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', rel.json()).errors, []);
        assert.strictEqual(rel.json().metrics_url, '/release-metrics');
        assert.strictEqual((await t.get('/nope')).status, 404);
        assert.strictEqual((await t.get('/m/nope')).status, 404);
        assert.strictEqual((await t.get('//evil.example/x')).status, 404, 'a path that would leave the origin is a 404, not a 500 (scanners, 10-16)');
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
