'use strict';
/**
 * coupons.moderation.action (ADR-022): staff acting on someone else's code or on a shop goes to
 * Network's moderation audit log, from the outbox in the same transaction. It names the staff
 * member and never the submitter. Staff changing their own code reports nothing.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    await t.merchant({ name: 'Acme Outdoor', host: 'acme-outdoor.com' });
    const moderation = () => t.events('coupons.moderation.action');
    const setStatus = (id, body) => t.get(`/api/v1/coupons/${id}/status`, { as: t.staffToken(), json: body });
    const valid = (e) => {
        assert.strictEqual(contracts.validate('events.event-envelope@1', e).valid, true, JSON.stringify(e));
        const r = contracts.validate('coupons.moderation.action@1', e.payload);
        assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
        assert.strictEqual(e.source, 'coupons');
        assert.strictEqual(e.visibility, 'internal');
        assert.deepStrictEqual(e.actor, { type: 'user', id: t.staff.subject });
        assert.strictEqual(e.payload.actor_subject, t.staff.subject);
        assert.strictEqual(e.payload.target.owner_subject, null, 'the submitter stays inside Coupons');
        assert.ok(!JSON.stringify(e).includes(alice.subject));
    };

    await check('staff disabling their own code is not moderation: no event', async () => {
        const r = await t.submit(t.staff, { host: 'acme-outdoor.com', code: 'STAFFOWN', title: 'Staff code' });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual((await setStatus(r.json().coupon.id, { status: 'disabled' })).status, 200);
        assert.strictEqual(moderation().length, 0);
    });

    await check('staff disabling someone else\'s code: exactly one valid event', async () => {
        const r = await t.submit(alice, { host: 'acme-outdoor.com', code: 'FAKE50', title: 'Too good to be true' });
        assert.strictEqual(r.status, 201, r.text);
        const id = r.json().coupon.id;
        const off = await setStatus(id, { status: 'disabled', note: 'fabricated code' });
        assert.strictEqual(off.status, 200, off.text);
        const ev = moderation();
        assert.strictEqual(ev.length, 1);
        valid(ev[0]);
        assert.deepStrictEqual(ev[0].subject, { type: 'moderation_action', id: `coupon:${id}` });
        assert.strictEqual(ev[0].payload.action, 'coupon.disabled');
        assert.deepStrictEqual(ev[0].payload.target, { type: 'coupon', id, owner_subject: null });
        assert.strictEqual(ev[0].payload.reason, 'fabricated code');
        assert.strictEqual(ev[0].payload.details.previous, 'unknown');
        assert.ok(!JSON.stringify(ev[0]).includes('FAKE50'), 'never the code itself');
    });

    await check('approving a shop members proposed: one merchant.approved, not one per code it publishes', async () => {
        const r = await t.submit(alice, { url: 'https://www.new-gadgets.net/cart', code: 'GADGET5', title: 'Five off gadgets' });
        assert.strictEqual(r.json().merchant.status, 'pending');
        const n = moderation().length;
        const ok = await t.get(`/staff/merchants/${r.json().merchant.id}/status`, { as: t.staff, form: { csrf: t.csrf(t.staff), status: 'active' } });
        assert.strictEqual(ok.status, 200);
        const ev = moderation();
        assert.strictEqual(ev.length, n + 1);
        valid(ev[n]);
        assert.strictEqual(ev[n].payload.action, 'merchant.approved');
        assert.deepStrictEqual(ev[n].payload.target, { type: 'merchant', id: r.json().merchant.id, owner_subject: null });
        assert.deepStrictEqual(ev[n].payload.details, { previous: 'pending', status: 'active', codes_published: 1 });
    });

    await t.close();
    done();
})();
