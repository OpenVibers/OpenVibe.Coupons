'use strict';
/**
 * Third-party principals: a developer app (app:…) or module (mod:…) token acts only for the person
 * in its on_behalf_of claim. X-OV-Subject naming anyone else is refused, and so are sandbox tokens.
 * First-party services (svc:…) still name the person they act for.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const APP = 'app:app_01J8ZQ4Y7N3M2K1H0G9F8E7D6C';
const MOD = 'mod:mod_01J8ZQ4Y7N3M2K1H0G9F8E7D6C';

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const victim = t.network.addUser('victim');
    const appUser = t.network.addUser('appuser');
    await t.merchant({ name: 'Tin Robot', host: 'tinrobot.shop' });
    const code = (await t.submit(alice, { host: 'tinrobot.shop', code: 'BEEP10', title: 'Ten off robots' })).json().coupon;
    const caps = ['coupons.report.create', 'coupons.coupon.submit'];
    const appToken = (sub, actorType, extra) => t.network.signService({ sub, actorType, aud: ['openvibe.coupons'], cap: caps, extra });
    const report = (token, headers) => t.get(`/api/v1/coupons/${code.id}/report`, { as: token, headers, json: { outcome: 'failed', reason: 'invalid' } });
    const reportsOf = (subject) => t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM coupon_validation_reports WHERE reporter_key = ?').get(t.ctx.reports.reporterKey(subject)).n;

    await check('an app token cannot act for someone else by naming them in X-OV-Subject', async () => {
        for (const [sub, type] of [[APP, 'app'], [MOD, 'mod']]) {
            const r = await report(appToken(sub, type, { on_behalf_of: appUser.subject }), { 'x-ov-subject': victim.subject });
            assert.strictEqual(r.status, 403, `${type}: ${r.text}`);
            assert.strictEqual(r.json().code, 'subject.not_delegated');
            const noDelegation = await report(appToken(sub, type, {}), { 'x-ov-subject': victim.subject });
            assert.strictEqual(noDelegation.status, 403, `${type} without on_behalf_of`);
        }
        const sub = await t.get('/api/v1/coupons/submit', { as: appToken(APP, 'app', {}), headers: { 'x-ov-subject': victim.subject }, json: { host: 'tinrobot.shop', code: 'FAKE99', title: 'Made up' } });
        assert.strictEqual(sub.status, 403);
        assert.strictEqual(reportsOf(victim.subject), 0);
    });

    await check('an app token acts for its on_behalf_of person (header optional, must match)', async () => {
        const token = appToken(APP, 'app', { on_behalf_of: appUser.subject });
        assert.strictEqual((await report(token)).status, 201);
        assert.strictEqual((await report(token, { 'x-ov-subject': appUser.subject })).status, 200, 'same person, same day: deduplicated');
        assert.strictEqual(reportsOf(appUser.subject), 1);
    });

    await check('sandbox app tokens are refused', async () => {
        const r = await report(appToken(APP, 'app', { on_behalf_of: appUser.subject, env: 'sandbox' }));
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.json().code, 'token.sandbox_refused');
    });

    await check('first-party services still name the person they act for', async () => {
        const svc = t.network.serviceToken('live', caps);
        assert.strictEqual((await report(svc, { 'x-ov-subject': victim.subject })).status, 201);
    });

    await t.close();
    done();
})();
