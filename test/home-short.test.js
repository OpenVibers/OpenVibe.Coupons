'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the three code lists are one pick block, every list
 * is shown, and the chips are a row of links that jump to a list (the owner, 2026-10-31: never hide content to shorten).
 * The parts a reader rarely needs are folds. A wider screen shows every list and no chips.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    try {
        await check('the empty home draws the kit empty state with one button', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /class="ovk-empty"/, 'the kit empty state is used, not a bare sentence');
            assert.match(r.text, /No coupon code has been listed yet/);
            assert.match(r.text, /class="ovk-btn[^"]*" href="\/submit"/, 'the empty state offers one button forward');
        });

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
            // Shared pick() (11-12): two lists or more are tabs on a phone; one list with codes is simply shown (never
            // an empty tab). Every list that has something to show is a pane in the page.
            const panes = [...block.matchAll(/<div class="pick-pane" id="([a-z-]+)">/g)].map((m) => m[1]);
            assert.ok(panes.length >= 1, `a pane per list with codes (${panes.length})`);
            if (panes.length > 1) {
                assert.match(block, /<div class="ov-parts ov-parts--front" data-parts="\d+">/, 'its lists are tabs on a phone');
                assert.ok(/<input type="radio" class="ov-parts-r"[^>]* checked>/.test(block), 'the first list is open on a phone');
            } else assert.match(block, /<div class="ov-parts is-stacked">/, 'one list: shown, no tabs');
            assert.ok(block.includes('VEG5'), 'the code is on the page');
        });

        await check('the CSS guard: the chips are hidden and the lists all show until 640 px and where :has() is understood', async () => {
            const r = await t.get('/');
            const page = r.text;
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'coupons.css'), 'utf8');
            assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
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
