'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the three code lists are one pick block, a row of
 * chips picks one of them, and the parts a reader rarely needs are folds. Radio inputs and :has(), no script for the
 * chips; every list stays in the page for crawlers; a wider screen shows them all and no chips.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    try {
        await check('setup: a shop and a code, so the lists have something to show', async () => {
            const shop = await t.merchant({ name: 'Green Grocer', host: 'greengrocer.co.uk' });
            const r = await t.get('/submit', { as: alice, form: { csrf: t.csrf(alice), merchant: shop.slug, code: 'VEG5', title: 'Five pounds off veg boxes', expires: '', min_spend_amount: '30', min_spend_currency: 'gbp', regions: 'GB' } });
            assert.strictEqual(r.status, 201, r.text.slice(0, 300));
        });

        await check('the codes are one pick block: a chip per list, the first picked, every list in the page', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            const start = page.indexOf('<div class="pick" id="pick-codes">');
            assert.ok(start > 0, 'the pick block is on the home');
            const block = page.slice(start, page.indexOf('<section class="cp-sec" id="shops"'));
            assert.match(block, /<div class="pick-row" role="radiogroup" aria-label="Codes">/);
            const chips = [...block.matchAll(/<input type="radio" name="pick-codes" id="pk-codes-([a-z-]+)" value="([a-z-]+)"( checked)?><label for="pk-codes-[a-z-]+">([^<]+)<\/label>/g)];
            assert.ok(chips.length >= 1, `a chip per list (${chips.length})`);
            assert.deepStrictEqual(chips.filter((m) => m[3]).map((m) => m[1]), [chips[0][1]], 'the first list is picked');
            // The lists that have something to show stay in the page, each in its own pane.
            for (const id of chips.map((m) => m[1])) {
                assert.ok(block.includes(`id="${id}"`), `the pane of ${id} is in the page`);
            }
            assert.ok(block.includes('VEG5'), 'the code is on the page');
        });

        await check('the CSS guard: the chips are hidden and the lists all show until 640 px and where :has() is understood', async () => {
            const r = await t.get('/');
            const page = r.text;
            assert.match(page, /<style>@supports selector\(:has\(\*\)\)\{@media \(max-width:640px\)\{\.pick:has\(#pk-codes-cp-working:checked\) #cp-working\{display:block\}/, 'the rule that shows the picked list');
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'coupons.css'), 'utf8');
            assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
            assert.match(css, /@supports selector\(:has\(\*\)\) \{ @media \(max-width: 640px\) \{/, 'the phone rules are under :has() and 640 px');
            assert.match(css, /\.pick-row label \{[^}]*min-height: 44px/, 'a chip is a 44 px target');
            assert.match(css, /\.pick \.pick-pane \{ display: none; \}/, 'the lists are hidden on a phone');
        });

        await check('the parts a reader rarely needs are folds, open in the page and closed on a phone', async () => {
            const r = await t.get('/');
            const page = r.text;
            for (const id of ['companion', 'faq', 'network', 'shipped']) {
                assert.ok(page.includes(`<details class="cp-fold cp-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
                assert.ok(page.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
            }
            // The content of the folds stays in the page.
            assert.match(page, /<h2 id="cp-companion-h">The OpenVibe Companion<\/h2>/);
            assert.match(page, /<h2 id="cp-faq-h">Questions and answers<\/h2>/);
            assert.match(page, /<h2 id="cp-network-h">Part of OpenVibe<\/h2>/);
            assert.match(page, /<h2 id="cp-shipped-h">Recently shipped on OpenVibe.Coupons<\/h2>/);
            assert.match(page, /<summary>Do these codes work\?<\/summary>/, 'the questions are still on the page');
        });
    } finally {
        await done(t);
    }
})().catch((e) => { console.error(e); process.exit(1); });
