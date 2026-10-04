'use strict';
/**
 * Inbound event webhook (OpenVibe.Events → Coupons): signed POST /internal/events.
 *   - no secret configured → 404 (route not served)
 *   - bad signature        → 401
 *   - valid sources.item.created → 200, importer.run once, duplicate false
 *   - replay of the same delivery → 200, duplicate true, importer.run not called again
 *   - other sources.* events → 200, importer not called
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');
const { signDeliveryHeaders } = require('openvibe-sdk/events');

const EVENT_ID = 'evt_01J8Z6Q3KX0000000000000000';
const ITEM_ID = 'itm_01J8Z6Q3KX0000000000000000';

function makeDelivery(event, secret, now = Date.now()) {
    const raw = Buffer.from(JSON.stringify({ event, seq: 1 }));
    return { raw, headers: signDeliveryHeaders(raw, secret, { now }) };
}

function envelope(type, id = EVENT_ID) {
    return {
        event_id: id,
        event_type: type,
        version: 1,
        source: 'sources',
        actor: { type: 'service', id: 'sources' },
        timestamp: '2026-09-22T12:00:00.000Z',
        visibility: 'internal',
        subject: { type: 'item', id: ITEM_ID },
        payload: { category: 'coupons', item_id: ITEM_ID },
    };
}

(async () => {
    // ── No secret configured → 404 ──────────────────────────────────────────
    await check('no COUPONS_EVENTS_SECRET: POST /internal/events is 404', async () => {
        const t = await boot();
        const res = await t.get('/internal/events', { method: 'POST', json: { event: envelope('sources.item.created') } });
        assert.strictEqual(res.status, 404);
        await t.close();
    });

    // ── With secret configured ──────────────────────────────────────────────
    const secret = crypto.randomBytes(32).toString('hex');
    const t = await boot({ env: { COUPONS_EVENTS_SECRET: secret } });

    await check('bad signature: 401', async () => {
        const wrong = crypto.randomBytes(32).toString('hex');
        const d = makeDelivery(envelope('sources.item.created'), wrong);
        const res = await t.get('/internal/events', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...d.headers },
            body: d.raw,
        });
        assert.strictEqual(res.status, 401);
    });

    await check('valid sources.item.created: 200, duplicate false, importer.run called once', async () => {
        const d = makeDelivery(envelope('sources.item.created'), secret);
        let runs = 0;
        const origRun = t.ctx.importer.run.bind(t.ctx.importer);
        t.ctx.importer.run = async (...args) => { runs++; return origRun(...args); };
        const res = await t.get('/internal/events', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...d.headers },
            body: d.raw,
        });
        assert.strictEqual(res.status, 200);
        const body = res.json();
        assert.strictEqual(body.accepted, true);
        assert.strictEqual(body.duplicate, false);
        assert.strictEqual(runs, 1);
        t.ctx.importer.run = origRun;
    });

    await check('replay of the same delivery: 200, duplicate true, importer not called again', async () => {
        const d = makeDelivery(envelope('sources.item.created'), secret);
        let runs = 0;
        const origRun = t.ctx.importer.run.bind(t.ctx.importer);
        t.ctx.importer.run = async (...args) => { runs++; return origRun(...args); };
        const res = await t.get('/internal/events', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...d.headers },
            body: d.raw,
        });
        assert.strictEqual(res.status, 200);
        const body = res.json();
        assert.strictEqual(body.duplicate, true);
        assert.strictEqual(runs, 0);
        t.ctx.importer.run = origRun;
    });

    await check('other sources.* event: 200, importer not called', async () => {
        const d = makeDelivery(envelope('sources.item.updated', 'evt_01J8Z6Q3KX0000000000000001'), secret);
        let runs = 0;
        const origRun = t.ctx.importer.run.bind(t.ctx.importer);
        t.ctx.importer.run = async (...args) => { runs++; return origRun(...args); };
        const res = await t.get('/internal/events', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...d.headers },
            body: d.raw,
        });
        assert.strictEqual(res.status, 200);
        const body = res.json();
        assert.strictEqual(body.accepted, true);
        assert.strictEqual(body.duplicate, false);
        assert.strictEqual(runs, 0);
        t.ctx.importer.run = origRun;
    });

    await t.close();
    done();
})();
