'use strict';
/**
 * The page shell (server/render/layout.js): every page is openvibe-publishing/layout's document
 * (openvibe-shared/shell page()): one title, the canonical and robots from the gate's decision, the
 * JSON-LD, feeds, the site stylesheet, the Frame (navbar mount, noscript navigation) and the
 * server-rendered footer with its init, plus the boost marker and script.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { renderPage } = require('../server/render/layout');

const count = (html, re) => (html.match(re) || []).length;

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');

    await check('a page needs the gate decision: there is no default that makes it indexable', async () => {
        assert.throws(() => renderPage({ title: 'x', body: '', config: { baseUrl: 'https://openvibe.coupons' } }), TypeError);
    });

    await check('the document head and frame come from openvibe-publishing/layout, robots from the decision', async () => {
        const empty = await t.merchant({ name: 'Quiet Shop', host: 'quietshop.co.uk' });
        const shop = await t.merchant({ name: 'Green Grocer', host: 'greengrocer.co.uk' });
        const sub = await t.get('/submit', { as: alice, form: { csrf: t.csrf(alice), merchant: shop.slug, code: 'VEG5', title: 'Five pounds off veg boxes' } });
        assert.strictEqual(sub.status, 201, sub.text.slice(0, 300));
        // A shop with no active code is thin (noindex, still served); one with a code is indexable.
        for (const [m, robots] of [[shop, 'index, follow'], [empty, 'noindex, follow']]) {
            const r = await t.get(`/m/${m.slug}`);
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            const html = r.text;
            const head = html.slice(0, html.indexOf('</head>'));
            const body = html.slice(html.indexOf('</head>'));
            assert.strictEqual(count(html, /<title>/g), 1, 'exactly one <title>');
            assert.ok(head.includes(`<title>${m.name} coupon codes · OpenVibe.Coupons</title>`), 'the composed title');
            assert.ok(head.includes(`<link rel="canonical" href="https://openvibe.coupons/m/${m.slug}">`), 'the canonical');
            assert.strictEqual(count(head, /<meta name="robots"/g), 1, 'one robots meta');
            assert.ok(head.includes(`<meta name="robots" content="${robots}">`), `${m.slug}: robots ${robots} from the decision`);
            assert.ok(count(head, /<script type="application\/ld\+json">/g) >= 1, 'JSON-LD');
            assert.ok(head.includes(`<link rel="alternate" type="application/rss+xml" href="/m/${m.slug}/feed.xml" title="${m.name} codes (RSS)">`), 'the shop feed link');
            assert.ok(/<link rel="stylesheet" href="\/css\/coupons\.css\?v=[0-9a-f]+">/.test(head), 'the coupons stylesheet');
            assert.ok(/<meta name="ov-boost" content="coupons@[^"]+">/.test(head), 'the boost marker');
            assert.ok(/<script src="\/shared\/boost\.js\?v=[0-9a-f]{12}" data-main="#main" defer><\/script>/.test(head), 'the boost script');
            assert.ok(body.includes('<div id="navbar-mount"></div>'), 'the navbar mount');
            assert.ok(body.includes('<nav aria-label="Site"'), 'the noscript navigation');
            assert.ok(body.includes('<main id="main" class="page">'), 'the swappable main');
            assert.ok(body.includes('id="ov-footer"'), 'the server-rendered footer');
            assert.ok(body.includes('OpenVibeFooter.init(window.__OV_PAGE.footer)'), 'the footer is initialised');
            assert.ok(body.includes('"loginUrl":"/auth/login?next={path}"'), 'sign-in is a {path} template');
        }
        const home = (await t.get('/')).text;
        const head = home.slice(0, home.indexOf('</head>'));
        assert.strictEqual(count(head, /<title>/g), 1);
        assert.ok(head.includes('<link rel="canonical" href="https://openvibe.coupons/">'));
        assert.strictEqual(count(head, /<script type="application\/ld\+json">/g), 1, 'one JSON-LD script on the home page');
        for (const [type, href, title] of [['application/rss+xml', '/feed.xml', 'New codes (RSS)'], ['application/atom+xml', '/atom.xml', 'New codes (Atom)'], ['application/feed+json', '/feed.json', 'New codes (JSON Feed)']]) {
            assert.ok(head.includes(`<link rel="alternate" type="${type}" href="${href}" title="${title}">`), `${href} feed link`);
        }
        assert.ok(home.includes('Recently shipped on OpenVibe.Coupons'), 'the shipped line stays on the home page');
    });

    await t.close();
    done();
})();
