'use strict';
/**
 * A code's reports over time (the owner, 2026-10-28: "historical data or trends… Coupons success over time"): its page
 * shows twelve weekly columns of "worked" and "didn't work", with a sentence that says it plainly, and its JSON carries
 * the same weeks. Counts only, never who reported; nothing at all when nobody reported.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const DAY = 86400000;

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    await t.merchant({ name: 'Blue Kettle', host: 'bluekettle.shop' });
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
    await add(200, 'worked');   // older than twelve weeks: not in the columns

    await check("the code's page shows its reports over time, plainly", async () => {
        const r = await t.get(`/c/${code.id}`);
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /<h2 id="trend-h">Reports over time<\/h2>/);
        assert.match(r.text, /5 “worked” and 4 “didn't work” in the last 12 weeks\./);
        assert.strictEqual((r.text.match(/class="cpn-week"/g) || []).length, 12, 'twelve weeks, empty ones too');
        assert.match(r.text, /role="img" aria-label="Reports per week for 12 weeks: /);
        assert.match(r.text, /✓ Worked<\/span><span class="cpn-lk cpn-lk-no">✕ Didn't work/);
        assert.ok(!/rk\d/.test(r.text), 'never who reported');
    });

    await check('the JSON carries the same weeks, oldest first', async () => {
        const j = (await t.get(`/c/${code.id}.json`)).json();
        assert.strictEqual(j.report_weeks.length, 12);
        assert.ok(j.report_weeks.every((w) => /^\d{4}-\d\d-\d\d$/.test(w.week) && new Date(`${w.week}T00:00:00Z`).getUTCDay() === 1), 'weeks start on Monday');
        assert.strictEqual(j.report_weeks.reduce((s, w) => s + w.worked, 0), 5);
        assert.strictEqual(j.report_weeks.reduce((s, w) => s + w.failed, 0), 4);
        assert.ok(j.report_weeks[0].week < j.report_weeks[11].week, 'oldest first');
    });

    await check('a code nobody reported on shows no chart', async () => {
        const r = await t.get(`/c/${quiet.id}`);
        assert.strictEqual(r.status, 200);
        assert.ok(!/Reports over time/.test(r.text));
    });

    await t.close();
    done();
})();
