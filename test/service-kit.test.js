'use strict';
/**
 * openvibe-sdk/service (plan T1): the shared JSON body parser answers 413 for a body over 32 kB
 * (the hand-rolled one answered 400 request.invalid_json there), and the entry point's graceful stop
 * runs its stop and close steps and exits 0. Only an ApiError or a HostError is a refusal: any other error
 * answers a generic 500, even one carrying { status, code }.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const express = require('express');
const { createLifecycle } = require('../server/index');
const errors = require('../server/http/errors');

(async () => {
    const t = await boot();

    await check('a JSON body over 32 kB is 413 request.too_large, not 400 request.invalid_json', async () => {
        const r = await t.get('/api/v1/merchants', { as: t.staffToken(), json: { name: 'Big', domains: [{ host: 'big.example' }], padding: 'y'.repeat(40 * 1024) } });
        assert.strictEqual(r.status, 413, r.text);
        assert.strictEqual(r.json().code, 'request.too_large');
    });

    await check('an error that is not an ApiError or a HostError never reaches the client, even with { status, code }', async () => {
        const app = express();
        app.get('/x', errors.run(() => { const e = new Error('secret internals'); e.status = 409; e.code = 'db.conflict'; throw e; }));
        app.get('/h', errors.run(() => { const e = new Error('bad host'); e.name = 'HostError'; e.status = 422; e.code = 'host.invalid'; throw e; }));
        const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        const base = `http://127.0.0.1:${server.address().port}`;
        const log = console.error;
        console.error = () => {};
        try {
            const leak = await fetch(`${base}/x`);
            assert.strictEqual(leak.status, 500);
            const body = await leak.json();
            assert.strictEqual(body.code, 'internal.error');
            assert.ok(!JSON.stringify(body).includes('secret'), JSON.stringify(body));
            const host = await fetch(`${base}/h`);
            assert.strictEqual(host.status, 422);
            assert.strictEqual((await host.json()).code, 'host.invalid');
        } finally {
            console.error = log;
            server.close();
        }
    });

    await check('the entry point stop runs its stop and close steps, then exits 0', async () => {
        const steps = [];
        const spy = (obj, method, label) => {
            const orig = obj[method].bind(obj);
            obj[method] = (...a) => { steps.push(label); return orig(...a); };
        };
        spy(t.ctx.worker, 'stop', 'worker.stop');
        spy(t.ctx.outbox, 'stop', 'outbox.stop');
        spy(t.ctx.store, 'close', 'store.close');

        const server = http.createServer(t.app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

        const exits = [];
        const lifecycle = createLifecycle({ server, ctx: t.ctx, exit: (code) => exits.push(code), signals: false });
        const code = await lifecycle.stop('SIGTERM');

        assert.strictEqual(code, 0);
        assert.deepStrictEqual(exits, [0]);
        assert.deepStrictEqual(steps, ['worker.stop', 'outbox.stop', 'store.close']);
        assert.strictEqual(server.listening, false);
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
