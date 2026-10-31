'use strict';
/**
 * The store page (server/render/store.js): the best code and how it is chosen, the status wording at 0, 4, 5 and
 * 23 reports, the 30-day rule, a shop with no codes, the report forms, and the words the page never uses.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

/** A code of a shop, submitted the way a member submits one. */
async function submitCode(t, user, slug, code, title, extra) {
    const form = Object.assign({ csrf: t.csrf(user), merchant: slug, code, title, expires: '' }, extra || {});
    const r = await t.get('/submit', { as: user, form });
    const err = /<div class="errors"[\s\S]*?<\/div>/.exec(r.text);
    assert.strictEqual(r.status, 201, 'submit ' + code + ': ' + r.status + ' ' + (err ? err[0] : r.text.slice(0, 300)));
    return (await t.ctx.store.db.prepare('SELECT id FROM coupons WHERE code = ?').get(code)).id;
}

/** People report on a code: one report each, so each counts as one person. */
async function report(t, codeId, outcome, times) {
    for (let i = 0; i < times; i++) {
        const who = t.network.addUser('reporter-' + i + '-' + Math.random().toString(36).slice(2, 7));
        const r = await t.get('/c/' + codeId + '/report', { as: who, form: { csrf: t.csrf(who), outcome, back: '/' } });
        assert.strictEqual(r.status, 303, 'report on ' + codeId + ': ' + r.status + ' ' + r.text.slice(0, 200));
    }
}

/** The code the page shows first: the one inside the best-code card. */
function bestCardCode(html) {
    const card = html.slice(html.indexOf('id="cpn-best-card"'));
    const m = /<code class="cpn-codetext" id="[^"]+">([^<]+)</.exec(card);
    return m ? m[1] : null;
}

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');

    await check('the best code is the one with the most evidence of working', async () => {
        const shop = await t.merchant({ name: 'Every Plate', host: 'everyplate.com' });
        const best = await submitCode(t, alice, shop.slug, 'SAVE20', '20% off');
        const runnerUp = await submitCode(t, alice, shop.slug, 'HALFOFF', '15% off');
        const five = await submitCode(t, alice, shop.slug, 'TENOFF', '10% off');
        const four = await submitCode(t, alice, shop.slug, 'FOUR', '5% off');
        const stale = await submitCode(t, alice, shop.slug, 'STALE', 'Old code');
        await submitCode(t, alice, shop.slug, 'NONE', 'Free shipping');
        // 20 of 23 people said SAVE20 worked (87%); 8 of 10 said HALFOFF worked (80%).
        await report(t, best, 'worked', 20);
        await report(t, best, 'failed', 3);
        await report(t, runnerUp, 'worked', 8);
        await report(t, runnerUp, 'failed', 2);
        await report(t, five, 'worked', 3);
        await report(t, five, 'failed', 2);
        await report(t, four, 'worked', 4);
        await report(t, stale, 'worked', 1);

        const page = await t.get('/m/' + shop.slug);
        assert.strictEqual(page.status, 200);
        const html = page.text;
        assert.strictEqual(bestCardCode(html), 'SAVE20', 'the code with the highest share of people who said it worked');
        assert.match(html, /87% worked \(23 reports\)/, 'the rate and its sample size');
        assert.match(html, /80% worked \(10 reports\)/);
        assert.match(html, /60% worked \(5 reports\)/, 'five reports are enough for a rate');
        assert.match(html, /Validity unknown \(4 reports\)/, 'under five reports: only that validity is unknown');
        assert.doesNotMatch(html, /Validity unknown \(0 reports\)/, 'no count is invented');

        // The other codes follow the same order: the most evidence first, the code nobody reported on last.
        const order = ['HALFOFF', 'TENOFF', 'FOUR', 'STALE', 'NONE'].map((c) => html.indexOf('>' + c + '<'));
        assert.ok(order.every((i) => i > 0), 'every code is on the page');
        assert.deepStrictEqual(order.slice().sort((a, b) => a - b), order, 'the codes are ordered by their evidence');

        // The head: the shop, its domain and one muted line.
        assert.match(html, /Every Plate/);
        assert.match(html, /everyplate\.com/);
        assert.match(html, /6 codes · 43 reports this week/, 'the counts of the shop');

        // The report buttons, and the report forms post to the report route.
        assert.match(html, /It worked/);
        assert.match(html, /It didn't work/);
        assert.ok(html.indexOf('<form method="post" action="/c/' + best + '/report"') > 0, 'the report forms post to the report route');

        // Nothing on the page is called verified.
        assert.doesNotMatch(html, /verified/i, 'the page never says verified');
    });

    await check('the last report is dated, and a code nobody reported on lately says so and sorts last', async () => {
        const shop = await t.merchant({ name: 'Late Shop', host: 'late-shop.com' });
        const stale = await submitCode(t, alice, shop.slug, 'OLDC', 'Old code');
        await report(t, stale, 'worked', 2);
        const before = (await t.get('/m/' + shop.slug)).text;
        assert.match(before, /Last report 22 Sep around 12:00 UTC/, 'the last report, to the hour');
        assert.doesNotMatch(before, /No reports in the last 30 days/);

        // 31 days later the report is outside the window: the code says so and sorts last.
        t.clock.advance(31 * 24 * 60 * 60 * 1000);
        const fresh = await submitCode(t, alice, shop.slug, 'NEWC', 'New code');
        await report(t, fresh, 'worked', 2);
        const after = (await t.get('/m/' + shop.slug)).text;
        assert.match(after, /No reports in the last 30 days/, 'the stale code says it has no recent reports');
        assert.ok(after.indexOf('>NEWC<') < after.indexOf('>OLDC<'), 'the stale code sorts last');
    });

    await check('a shop with no codes says so, and never reads "Codes 0"', async () => {
        const shop = await t.merchant({ name: 'Empty Shop', host: 'empty-shop.com' });
        const page = await t.get('/m/' + shop.slug);
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /No codes for empty-shop\.com right now/);
        assert.match(page.text, /Tell me when one appears/, 'the watch');
        assert.doesNotMatch(page.text, /Codes 0/);
        assert.doesNotMatch(page.text, /Codes \(0\)/);
        assert.doesNotMatch(page.text, /ovk-tab-n">0</, 'no tab counts nothing');
        // The watch is the existing coupon_watches flow: a signed-out visitor is sent to sign in first.
        assert.match(page.text, /\/auth\/login\?next=/, 'the watch asks a visitor to sign in');
        const member = t.network.addUser('watcher');
        const signed = await t.get('/m/' + shop.slug, { as: member });
        assert.ok(signed.text.indexOf('<form method="post" action="/m/' + shop.slug + '/watch"') > 0, 'the watch is a plain form to the watch route: slug=' + shop.slug + ' idx=' + signed.text.indexOf('/watch') + ' ctx=' + signed.text.slice(Math.max(0, signed.text.indexOf('/watch') - 200), signed.text.indexOf('/watch') + 200));
        assert.doesNotMatch(page.text, /verified/i);
    });

    await check('the report forms post and the page shows the report that followed', async () => {
        const shop = await t.merchant({ name: 'Reporting Shop', host: 'reporting-shop.com' });
        const code = await submitCode(t, alice, shop.slug, 'REPORT1', '10% off');
        const bob = t.network.addUser('bob');
        const r = await t.get('/c/' + code + '/report', { as: bob, form: { csrf: t.csrf(bob), outcome: 'worked', back: '/m/' + shop.slug } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.headers.get('location'), '/m/' + shop.slug + '?done=reported');
        const after = await t.get('/m/' + shop.slug + '?done=reported', { as: bob });
        assert.match(after.text, /your report was recorded/);
        assert.match(after.text, /Validity unknown \(1 report\)/, 'one report is not a rate yet');
        // A signed-out visitor cannot report: the form sends them to sign in.
        const anon = await t.get('/c/' + code + '/report', { form: { outcome: 'worked', back: '/m/' + shop.slug } });
        assert.strictEqual(anon.status, 303);
        assert.match(anon.headers.get('location'), /\/auth\/login/);
    });

    await check('the sticky bar and the tabs are there, and the About tab carries the quick facts', async () => {
        const shop = await t.merchant({ name: 'Facts Shop', host: 'facts-shop.com' });
        await submitCode(t, alice, shop.slug, 'FACTS20', '20% off', { expires: '2026-12-31', evidence_url: 'https://everyplate.com/offers' });
        const page = await t.get('/m/' + shop.slug);
        assert.match(page.text, /id="cpn-sticky"/, 'the slim bar');
        assert.match(page.text, /hidden/, 'the bar is hidden until the best code leaves the screen');
        assert.match(page.text, /IntersectionObserver/, 'the few lines that show it');
        assert.match(page.text, /Expires 31 Dec 2026 \(end of day, UTC\)/, 'the expiry with its precision');
        const about = await t.get('/m/' + shop.slug + '?tab=about');
        assert.strictEqual(about.status, 200);
        assert.match(about.text, /Quick facts/);
        assert.match(about.text, /everyplate\.com/, 'the evidence URL');
        assert.match(about.text, /2026-12-31 \(end of that day in UTC/, 'the expiry in full');
        assert.doesNotMatch(about.text, /verified/i);
    });

    await check('product deals show twenty at a time, with a link to the next ones (Amazon had 200 on one page)', async () => {
        const shop = await t.merchant({ name: 'Deals Shop', host: 'deals-shop.com' });
        const people = Array.from({ length: 5 }, (_, i) => t.network.addUser('dealer-' + i));
        let n = 0;
        while (n < 25) {
            await submitCode(t, people[n % 5], shop.slug, 'DEAL' + String(n).padStart(3, '0'), 'Widget ' + n + ' for $' + (10 + n));
            n++;
        }
        const first = await t.get('/m/' + shop.slug + '?tab=deals');
        assert.strictEqual(first.status, 200);
        assert.strictEqual((first.text.match(/One product/g) || []).length, 20, 'the first page shows twenty');
        assert.match(first.text, /href="\/m\/[^"]+\?tab=deals&amp;deals=25">Show 5 more/, 'and a link to the rest');
        const all = await t.get('/m/' + shop.slug + '?tab=deals&deals=25');
        assert.strictEqual((all.text.match(/One product/g) || []).length, 25, 'the link shows them all');
        assert.doesNotMatch(all.text, /Show \d+ more/, 'with nothing left to show, no link');
        const silly = await t.get('/m/' + shop.slug + '?tab=deals&deals=-4');
        assert.strictEqual((silly.text.match(/One product/g) || []).length, 20, 'a nonsense count falls back to a page');
    });

    await t.close();
    done();
})();
