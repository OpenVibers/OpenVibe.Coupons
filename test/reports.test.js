'use strict';
/**
 * Validity reports: deduplicated per (person, code, UTC day) across every channel, only the latest
 * per person counts, rate-limited per person, never anonymous, never from a cookie on the API,
 * never returned or emitted with the reporter, and decaying back to unknown with time.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

(async () => {
    const t = await boot({ env: { COUPONS_REPORTS_PER_HOUR: '5', COUPONS_REPORTS_PER_DAY: '8' } });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const carol = t.network.addUser('carol');
    const shop = await t.merchant({ name: 'Blue Kettle', host: 'bluekettle.shop' });
    const mk = async (code) => (await t.submit(alice, { host: 'bluekettle.shop', code, title: `Code ${code}` })).json().coupon;
    const code = await mk('KETTLE10');
    const report = (who, id, body) => t.get(`/api/v1/coupons/${id}/report`, { as: typeof who === 'string' ? who : t.network.userToken(who), json: body });

    await check('anonymous reports are refused, and the API ignores cookies (no ambient session)', async () => {
        assert.strictEqual((await t.get(`/api/v1/coupons/${code.id}/report`, { json: { outcome: 'worked' } })).status, 401);
        const cookieOnly = await t.get(`/api/v1/coupons/${code.id}/report`, { as: bob, json: { outcome: 'worked' } });
        assert.strictEqual(cookieOnly.status, 401, 'a signed-in cookie does not authenticate the API');
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM coupon_validation_reports').get().n, 0);
    });

    await check('input is validated: outcome worked|failed, reasons only for failed ones', async () => {
        assert.strictEqual((await report(bob, code.id, { outcome: 'great' })).status, 422);
        assert.strictEqual((await report(bob, code.id, { outcome: 'worked', reason: 'invalid' })).status, 422);
        assert.strictEqual((await report(bob, code.id, { outcome: 'failed', reason: 'because' })).status, 422);
        assert.strictEqual((await report(bob, 'cpn_nope', { outcome: 'worked' })).status, 404);
    });

    await check('same person, same code, same day: one report — a repeat is a no-op, the other outcome corrects it', async () => {
        const a = await report(bob, code.id, { outcome: 'worked' });
        assert.strictEqual(a.status, 201);
        assert.strictEqual(a.json().deduplicated, false);
        const b = await report(bob, code.id, { outcome: 'worked' });
        assert.strictEqual(b.status, 200);
        assert.strictEqual(b.json().deduplicated, true);
        assert.strictEqual(b.json().corrected, false);
        // Through the site form and the extension too — the same person is one reporter.
        const form = await t.get(`/c/${code.id}/report`, { as: bob, form: { csrf: t.csrf(bob), outcome: 'worked', back: `/m/${shop.slug}` } });
        assert.strictEqual(form.status, 303);
        assert.match(form.headers.get('location'), /done=report_same/);
        const tokenA = await t.connect(bob, { label: 'laptop' });
        const tokenB = await t.connect(bob, { label: 'phone' });
        assert.strictEqual((await report(tokenA, code.id, { outcome: 'worked' })).json().deduplicated, true);
        assert.strictEqual((await report(tokenB, code.id, { outcome: 'worked' })).json().deduplicated, true);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM coupon_validation_reports').get().n, 1);
        const c = await report(bob, code.id, { outcome: 'failed', reason: 'min_spend_not_met' });
        assert.strictEqual(c.json().corrected, true);
        assert.strictEqual(c.json().coupon.status, 'reported_failed');
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM coupon_validation_reports').get().n, 1);
        assert.strictEqual(t.events('coupons.report.created').length, 1, 'one report, one event');
    });

    await check('the next day is a new report, but only the latest per person counts', async () => {
        t.clock.advance(DAY);
        const r = await report(bob, code.id, { outcome: 'worked' });
        assert.strictEqual(r.status, 201);
        const v = r.json().coupon;
        assert.deepStrictEqual([v.reports.worked, v.reports.failed], [1, 0], 'bob counts once, with his latest');
        assert.strictEqual(v.status, 'reported_working');
        assert.strictEqual(v.confidence, 0.67);
        await report(carol, code.id, { outcome: 'failed', reason: 'invalid' });
        const after = (await t.get(`/api/v1/coupons/${code.id}`)).json().coupon;
        assert.strictEqual(after.status, 'unknown', 'one worked and one failed: the reports disagree');
        assert.strictEqual(after.confidence, 0.5);
    });

    await check('the response and the events never name a reporter; report times are published to the hour', async () => {
        const r = await report(alice, code.id, { outcome: 'worked' });
        const body = r.text;
        assert.doesNotMatch(body, /usr_[0-9A-Z]{26}/);
        assert.doesNotMatch(body, /reporter|install_id|cpi_/);
        const last = r.json().coupon.reports.last_report_at;
        assert.match(last, /T\d{2}:00:00\.000Z$/);
        for (const e of t.events('coupons.report.created')) {
            assert.deepStrictEqual(Object.keys(e.payload).sort(), ['channel', 'day', 'merchant_id', 'outcome', ...(e.payload.reason ? ['reason'] : [])].sort());
            assert.deepStrictEqual(e.actor, { type: 'service', id: 'coupons' });
        }
        const keys = t.ctx.store.db.prepare('SELECT reporter_key FROM coupon_validation_reports').all().map((x) => x.reporter_key);
        for (const k of keys) { assert.match(k, /^[0-9a-f]{64}$/); assert.ok(!k.includes('usr_')); }
    });

    await check('rate limit: new reports per person per hour and per day (dedupe hits do not count)', async () => {
        const codes = [];
        for (let i = 0; i < 8; i++) codes.push(await mk(`RL${i}`));
        t.clock.advance(2 * HOUR);
        const dave = t.network.addUser('dave');
        for (let i = 0; i < 5; i++) assert.strictEqual((await report(dave, codes[i].id, { outcome: 'worked' })).status, 201, `report ${i}`);
        assert.strictEqual((await report(dave, codes[0].id, { outcome: 'worked' })).status, 200, 'a dedupe hit is not a new report');
        const limited = await report(dave, codes[5].id, { outcome: 'worked' });
        assert.strictEqual(limited.status, 429);
        assert.strictEqual(limited.json().code, 'report.rate_limited');
        t.clock.advance(HOUR + 1);
        for (let i = 5; i < 8; i++) assert.strictEqual((await report(dave, codes[i].id, { outcome: 'worked' })).status, 201);
        const daily = await report(dave, code.id, { outcome: 'worked' });
        assert.strictEqual(daily.status, 429, 'eight in a day is the daily ceiling here');
        // Another person is unaffected.
        assert.strictEqual((await report(t.network.addUser('erin'), codes[5].id, { outcome: 'worked' })).status, 201);
    });

    await check('decay: a lone "worked" is reported_working for a week, unknown after, and no confidence after 30 days', async () => {
        const fresh = await mk('DECAY1');
        const frank = t.network.addUser('frank');
        await report(frank, fresh.id, { outcome: 'worked' });
        assert.strictEqual(t.ctx.coupons.get(fresh.id).status, 'reported_working');
        t.clock.advance(6 * DAY);
        t.ctx.worker.sweep();
        assert.strictEqual(t.ctx.coupons.get(fresh.id).status, 'reported_working');
        t.clock.advance(2 * DAY);
        t.ctx.worker.sweep();
        assert.strictEqual(t.ctx.coupons.get(fresh.id).status, 'unknown');
        assert.ok(t.ctx.coupons.get(fresh.id).confidence > 0.5);
        t.clock.advance(23 * DAY);
        t.ctx.worker.sweep();
        assert.strictEqual(t.ctx.coupons.get(fresh.id).confidence, null);
        const hist = t.ctx.coupons.history(fresh.id).map((h) => h.reason);
        assert.ok(hist.includes('decay'));
        assert.ok(t.events('coupons.confidence.changed').some((e) => e.subject.id === fresh.id && e.payload.to === null));
    });

    await t.close();
    done();
})();
