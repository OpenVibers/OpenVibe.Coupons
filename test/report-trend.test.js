'use strict';
/**
 * Success over time (weekly.js, render/pages.js reportTrend/merchantTrend, GET /coupons/:id/success and
 * GET /stores/:slug/success): twelve weekly buckets of people, drawn with the shared kit. A week with fewer than
 * 3 people is null, and no answer carries a reporter key, install id, channel or day-level row.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const DAY = 86400000;
const forbidden = /reporter|install|channel|^day$|reporter_key|install_id/i;

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const shop = await t.merchant({ name: 'Blue Kettle', host: 'bluekettle.shop' });
    const code = (await t.submit(alice, { host: 'bluekettle.shop', code: 'KETTLE10', title: 'Code KETTLE10' })).json().coupon;
    const quiet = (await t.submit(alice, { host: 'bluekettle.shop', code: 'QUIET5', title: 'Code QUIET5' })).json().coupon;

    // Reports on days in the past weeks, each from its own reporter (the table allows one per person, code and day).
    const now = t.clock.now();
    const day = (ago) => new Date(now - ago * DAY).toISOString().slice(0, 10);
    let n = 0;
    const add = async (ago, outcome) => {
        n += 1;
        await t.ctx.store.db.prepare(`INSERT INTO coupon_validation_reports (coupon_id, reporter_key, channel, day, outcome, reason, created_at, updated_at)
            VALUES (?, ?, 'site', ?, ?, ?, ?, ?)`).run(code.id, `rk${n}`, day(ago), outcome, outcome === 'failed' ? 'expired' : null, now - ago * DAY, now - ago * DAY);
    };
    for (const ago of [1, 2, 3, 9, 10]) await add(ago, 'worked');
    for (const ago of [2, 40, 41, 42]) await add(ago, 'failed');
    await add(200, 'worked');   // older than twelve weeks: not in the buckets

    await check('the code page: worked-for people, the shared weekly chart, too-few weeks left blank', async () => {
        const r = await t.get(`/c/${code.id}`);
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /Worked for 5 of 6 people in the last 30 days\./);
        assert.match(r.text, /<h2 id="trend-h">Success over time<\/h2>/);
        assert.match(r.text, /class="ovk-chart ovk-chart--line"/, 'the shared kit draws it, not a hand-drawn SVG');
        assert.match(r.text, /2 people said it worked and 4 said it didn't/);
        assert.match(r.text, /A week with fewer than 3 people is too few to show/);
        assert.match(r.text, /\/shared\/kit-data-web\.js\?v=/, 'the chart readout is loaded');
        assert.ok(!/rk\d/.test(r.text), 'never who reported');
    });

    await check('the code API: weekly buckets, a null under 3 people, no per-person field', async () => {
        const j = (await t.get(`/api/v1/coupons/${code.id}/success`)).json();
        assert.deepStrictEqual(Object.keys(j).sort(), ['from', 'min_people', 'to', 'weeks']);
        assert.strictEqual(j.min_people, 3);
        assert.strictEqual(j.weeks.length, 12);
        assert.ok(j.weeks.every((w) => w === null || (/^\d{4}-\d\d-\d\d$/.test(w.week) && new Date(`${w.week}T00:00:00Z`).getUTCDay() === 1)), 'weeks start on Monday');
        const visible = j.weeks.filter(Boolean);
        assert.strictEqual(visible.length, 2, 'only weeks with 3 people are shown');
        assert.deepStrictEqual(visible.map((w) => [w.worked, w.failed]), [[0, 3], [2, 1]]);
        assert.strictEqual(j.weeks.filter((w) => w === null).length, 10, 'a week with 1 or 2 people is null');
        assert.ok(!/reporter|install_id|channel|"day"/i.test(JSON.stringify(j)), 'aggregates only');
    });

    await check('the store page and API: the shop\'s success per week across its codes', async () => {
        const page = await t.get(`/m/${shop.slug}`);
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /<h2 id="shop-trend-h">Success over time<\/h2>/);
        assert.match(page.text, /33% of people said a code worked in the weeks with enough reports \(2 of 6\)\./);
        assert.match(page.text, /class="ovk-chart ovk-chart--line"/);
        assert.match(page.text, /\/shared\/kit-data\.css\?v=/);
        assert.match(page.text, /\/shared\/kit-data-web\.js\?v=/);
        const deals = await t.get(`/m/${shop.slug}?tab=deals`);
        assert.match(deals.text, /shop-trend-h/, 'the shop-wide chart is on the Product deals tab too');
        assert.doesNotMatch((await t.get(`/m/${shop.slug}?tab=about`)).text, /shop-trend-h/, 'About stays About');
        const j = (await t.get(`/api/v1/stores/${shop.slug}/success`)).json();
        assert.strictEqual(j.weeks.length, 12);
        assert.deepStrictEqual(j.weeks.filter(Boolean).map((w) => [w.worked, w.failed]), [[0, 3], [2, 1]]);
        assert.ok(!/reporter|install_id|channel|"day"/i.test(JSON.stringify(j)));
        assert.strictEqual((await t.get('/api/v1/stores/nope/success')).status, 404);
    });

    await check('a code nobody reported on shows too few, never a chart', async () => {
        const r = await t.get(`/c/${quiet.id}`);
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /No one reported in the last 30 days\./);
        assert.match(r.text, /Too few reports in the last 12 weeks to show a chart/);
        assert.ok(!/class="ovk-chart/.test(r.text));
    });

    await check('the JSON twin carries the buckets too, and no person', async () => {
        const j = (await t.get(`/c/${code.id}.json`)).json();
        assert.strictEqual(j.report_weeks.length, 12);
        assert.strictEqual(j.report_weeks.filter(Boolean).length, 2);
        assert.ok(!/reporter|install_id|channel|"day"/i.test(JSON.stringify(j.report_weeks)));
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
