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

        await check('the code lists are all on the page: no chip row, every list in full', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            assert.ok(!page.includes('pick-codes'), 'the codes are no longer a pick block');
            assert.ok(page.includes('<h2 id="cp-new-h">New codes</h2>'), 'the list with a code is in the page');
            assert.ok((page.match(/class="cp-sec"/g) || []).length >= 1, 'the code sections are on the page');
            assert.ok(page.includes('VEG5'), 'the code is on the page');
        });

        await check('nothing hides a code card or a fold count on a phone', async () => {
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'coupons.css'), 'utf8');
            assert.ok(!/\.cp-cards > li:nth-child\(n\+5\) \{ display: none/.test(css), 'no code card is hidden');
            assert.ok(!/\.cp-fold > summary span \{ display: none/.test(css), 'a fold keeps its count');
            assert.match(css, /\.cp-sec \.cp-cards, \.cp-hero \.cp-stats \{[^}]*display: flex;/, 'the code lists are sideways rows');
            const r = await t.get('/');
            assert.ok(!r.text.includes('@supports selector(:has(*)){@media (max-width:640px){.pick:has(#pk-codes'), 'no pick rule is written for the codes');
        });

        await check('the parts a reader rarely needs are folds that start open on every screen', async () => {
            const r = await t.get('/');
            const page = r.text;
            for (const id of ['companion', 'faq', 'network', 'shipped']) {
                assert.ok(page.includes(`<details class="cp-fold cp-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
                assert.ok(!page.includes(`document.getElementById("${id}")`), `${id} is never closed by script`);
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
