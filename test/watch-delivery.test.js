'use strict';
/**
 * Watching a shop is delivered (coupons.watch.matched v1, server/domain/coupons.js notifyWatchers): when a code for a
 * watched merchant is publicly listed, every watcher but the submitter gets one internal event naming them as the
 * recipient, which OpenVibe.Network turns into an inbox notification. Created published → the watchers but the
 * submitter; an AI draft → nobody until staff approve it, then everyone watching; a watcher who stopped watching →
 * nothing; the payload is valid, internal, and carries no code text. The /watching page says what happens.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const shop = await t.merchant({ name: 'Trail Supply', host: 'trail-supply.com' });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const carol = t.network.addUser('carol');
    const subjectOf = (u) => t.network.subjectOf ? t.network.subjectOf(u) : u.subject;
    const watch = async (u, action = 'watch') => assert.strictEqual((await t.get(`/m/${shop.slug}/watch`, { as: u, form: { csrf: t.csrf(u), action } })).status, 303);
    const matched = async () => await t.events('coupons.watch.matched');

    await check('a member\'s code reaches every watcher but its submitter, once, as a valid internal event without the code', async () => {
        await watch(alice); await watch(bob);
        const r = await t.submit(bob, { host: 'trail-supply.com', code: 'TRAIL20', title: '20% off tents' });
        assert.ok([200, 201].includes(r.status), r.text);
        const evs = await matched();
        assert.strictEqual(evs.length, 1, JSON.stringify(evs.map((e) => e.payload.recipient)));
        const e = evs[0];
        assert.strictEqual(e.payload.recipient, subjectOf(alice));
        assert.strictEqual(e.visibility, 'internal');
        assert.deepStrictEqual(e.actor, { type: 'service', id: 'coupons' });
        assert.deepStrictEqual(e.subject, { type: 'coupon', id: r.json().coupon.id });
        assert.ok(contracts.validate('events.event-envelope@1', e).valid);
        const v = contracts.validate('coupons.watch.matched@1', e.payload);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(e.payload.merchant_name, 'Trail Supply');
        assert.match(e.payload.coupon_url, /^https:\/\/openvibe\.coupons\/c\//);
        assert.ok(!JSON.stringify(e.payload).includes('TRAIL20'), 'no code text');
    });

    await check('an AI draft tells nobody until staff approve it; then everyone watching, and nobody who stopped', async () => {
        await watch(carol); await watch(bob, 'unwatch');
        const before = (await matched()).length;
        const ai = t.network.serviceToken('ai', ['coupons.coupon.submit']);
        const r = await t.get('/api/v1/coupons/submit', { as: ai, headers: { 'x-ov-origin': 'ai' }, json: { host: 'trail-supply.com', code: 'AIDRAFT', title: 'Free shipping', evidence_url: 'https://trail-supply.com/promo' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual((await matched()).length, before, 'a pending draft is not listed');
        const id = r.json().coupon.id;
        const ok = await t.get(`/staff/coupons/${id}/approve`, { as: t.staff, form: { csrf: t.csrf(t.staff) } });
        assert.ok([200, 303].includes(ok.status), ok.text);
        const fresh = (await matched()).slice(before);
        assert.deepStrictEqual(fresh.map((e) => e.payload.recipient).sort(), [subjectOf(alice), subjectOf(carol)].sort(), 'alice and carol; bob stopped watching');
        assert.ok(fresh.every((e) => e.subject.id === id));
        const again = await t.get(`/staff/coupons/${id}/approve`, { as: t.staff, form: { csrf: t.csrf(t.staff) } });
        assert.ok(again.status < 500);
        assert.strictEqual((await matched()).length, before + 2, 'approving twice tells nobody twice');
    });

    await check('the watch pages say new codes reach your notifications', async () => {
        assert.match((await t.get('/watching', { as: alice })).text, /you get a notification in your OpenVibe inbox/);
        assert.match((await t.get(`/m/${shop.slug}`, { as: alice })).text, /new codes reach your OpenVibe notifications/);
    });

    await t.close();
    done();
})();
