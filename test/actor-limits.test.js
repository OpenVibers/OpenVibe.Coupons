'use strict';
/**
 * Per-actor rate limits (server/http/actor-limits.js, roadmap WS-R task 4): past its limit one caller
 * gets 429 problem+json `rate_limited` with Retry-After, before the route does any work, while
 * another caller still passes; the window reopens on the clock. The browser helper's install tokens
 * count as the person who connected them (every browser together), never as the address they report
 * from; signed-out callers count by address; a service reading for itself is not counted. Writes have
 * their own budget, shared by the API and the page form. Health, ready, release.json and metrics are
 * never limited, nor is revoking a browser helper; refusals are logged and counted.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { actor, serviceItself } = require('../server/http/actor-limits');

(async () => {
    // The limiter's clock: 15 s into a minute, so the minute window has 45 s left. Reads: 3 a minute.
    let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
    const lines = [];
    const log = { log() {}, error() {}, warn: (m) => lines.push(String(m)) };
    // The per-person report limits out of the way, so the per-actor one is what answers.
    const t = await boot({ env: { COUPONS_LIMITS_MINUTE: '3', COUPONS_LIMITS_HOUR: '100', COUPONS_REPORTS_PER_HOUR: '1000', COUPONS_REPORTS_PER_DAY: '1000' }, limitsNow: () => clock, log });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const carol = t.network.addUser('carol');
    await t.merchant({ name: 'Blue Kettle', host: 'bluekettle.shop' });
    const code = (await t.submit(alice, { host: 'bluekettle.shop', code: 'KETTLE10', title: 'Ten off' })).json().coupon;
    const laptop = await t.connect(bob, { label: 'laptop' });
    const phone = await t.connect(bob, { label: 'phone' });
    const carols = await t.connect(carol);
    const lookup = (o = {}) => t.get('/api/v1/merchants/resolve?host=bluekettle.shop', o);

    await check('a lookup: 3 a minute per person across their browsers, then 429 rate_limited with Retry-After; another person passes', async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await lookup({ as: laptop, headers: { 'X-Forwarded-For': `198.51.100.${i + 1}` } })).status, 200);
        const r = await lookup({ as: phone, headers: { 'X-Forwarded-For': '198.51.100.9' } });
        assert.strictEqual(r.status, 429, 'the second browser, from another address, is the same person');
        assert.strictEqual(r.headers.get('retry-after'), '45');
        assert.ok(/^application\/problem\+json/.test(r.headers.get('content-type')), r.headers.get('content-type'));
        const body = r.json();
        assert.deepStrictEqual([body.code, body.status, body.retry_after_seconds], ['rate_limited', 429, 45]);
        assert.ok(body.detail.includes('coupons.read'), body.detail);
        assert.strictEqual((await lookup({ as: carols, headers: { 'X-Forwarded-For': '198.51.100.1' } })).status, 200, 'another person on the same address still passes');
    });

    await check('signed-out lookups count by address; a service reading for itself is not counted', async () => {
        const from = (ip) => lookup({ headers: { 'X-Forwarded-For': ip } });
        for (let i = 0; i < 3; i++) assert.strictEqual((await from('203.0.113.7')).status, 200);
        assert.strictEqual((await from('203.0.113.7')).status, 429);
        assert.strictEqual((await from('203.0.113.8')).status, 200, 'another address still passes');
        const svc = t.network.serviceToken('ai', ['coupons.merchant.resolve']);
        for (let i = 0; i < 6; i++) assert.strictEqual((await lookup({ as: svc })).status, 200);
    });

    await check('the next minute opens the window again', async () => {
        clock += 45 * 1000;
        assert.strictEqual((await lookup({ as: phone })).status, 200);
    });

    await check('reports have their own budget (30 a minute) for the person, whichever browser or form sends them', async () => {
        clock = Date.UTC(2026, 8, 27, 12, 5, 0);
        const stored = async () => await t.ctx.store.db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM coupon_validation_reports').get();
        for (let i = 0; i < 30; i++) {
            const r = await t.get(`/api/v1/coupons/${code.id}/report`, { as: i % 2 ? laptop : phone, json: { outcome: i % 3 ? 'worked' : 'failed', reason: i % 3 ? null : 'expired' } });
            assert.ok(r.status === 200 || r.status === 201, `report ${i + 1}: ${r.text}`);
        }
        const before = JSON.stringify(await stored());
        const r = await t.get(`/c/${code.id}/report`, { as: bob, form: { csrf: t.csrf(bob), outcome: 'failed', reason: 'expired' } });
        assert.deepStrictEqual([r.status, r.json().code, r.headers.get('retry-after')], [429, 'rate_limited', '60'], 'the site form shares the budget');
        assert.ok(r.json().detail.includes('coupons.report.create'), r.json().detail);
        assert.strictEqual(JSON.stringify(await stored()), before, 'nothing recorded');
        assert.strictEqual((await t.get(`/api/v1/coupons/${code.id}/report`, { as: carols, json: { outcome: 'worked' } })).status, 201, 'another person still reports');
    });

    await check('revoking a browser helper is never limited', async () => {
        const installs = await t.ctx.installs.list(bob.subject);
        assert.ok(installs.length >= 2);
        for (let i = 0; i < 6; i++) {
            const r = await t.get(`/connect-extension/${installs[0].id}/revoke`, { as: bob, form: { csrf: t.csrf(bob) } });
            assert.strictEqual(r.status, 303);
        }
    });

    await check('health, ready, release.json and metrics are never limited', async () => {
        for (let i = 0; i < 6; i++) {
            assert.strictEqual((await t.get('/api/health')).status, 200);
            assert.notStrictEqual((await t.get('/api/ready')).status, 429);
            assert.strictEqual((await t.get('/release.json')).status, 200);
            assert.strictEqual((await t.get('/metrics')).status, 200);
        }
    });

    await check('refusals are counted in coupons_rate_limited_total and logged without a token', async () => {
        const m = (await t.get('/metrics')).text;
        const counted = m.split('\n').filter((l) => l.includes('coupons_rate_limited_total')).join('\n');
        assert.ok(/coupons_rate_limited_total\{limit="coupons.read",window="minute"\} 2/.test(m), counted);
        assert.ok(/coupons_rate_limited_total\{limit="coupons.report.create",window="minute"\} 1/.test(m), counted);
        assert.ok(lines.some((l) => l.includes(`coupons.read: user:${bob.subject} refused`)), lines.join('\n'));
        for (const l of lines) for (const tok of [laptop, phone, carols]) assert.ok(!l.includes(tok), 'a token in the log');
    });

    await check('who is counted', () => {
        const q = (viewer, { xff = null, ip = '127.0.0.1' } = {}) => ({ viewer, ip, get: (n) => (n === 'x-forwarded-for' ? xff : undefined) });
        assert.strictEqual(actor(q({ kind: 'install', install: 'cpi_1', subject: 'usr_a' }, { ip: '203.0.113.1' })), 'user:usr_a', 'an install token is its person');
        assert.strictEqual(actor(q({ kind: 'user', subject: 'usr_a' })), 'user:usr_a');
        assert.strictEqual(actor(q({ kind: 'service', service: 'svc:ai', subject: 'usr_a' })), 'user:usr_a');
        assert.strictEqual(actor(q({ kind: 'service', service: 'svc:ai', subject: null }, { xff: '203.0.113.9', ip: '203.0.113.9' })), 'ip:203.0.113.9');
        assert.strictEqual(actor(q({ kind: 'service', service: 'svc:ai', subject: null })), 'svc:ai', 'acting as itself (AI extraction)');
        assert.strictEqual(actor(q({ kind: 'anonymous', subject: null }, { ip: '198.51.100.4' })), 'ip:198.51.100.4');
        assert.strictEqual(serviceItself(q({ kind: 'service', service: 'svc:ai', subject: null })), true);
        assert.strictEqual(serviceItself(q({ kind: 'service', service: 'app:app_1', subject: null })), false);
    });

    await t.close();
    done();
})();
