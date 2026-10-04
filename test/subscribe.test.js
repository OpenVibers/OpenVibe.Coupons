'use strict';
/**
 * Plan T9 (J7a/J7a') — scripts/subscribe.js.
 *
 *   - it creates one OpenVibe.Events subscription per Sources pattern, as the coupons principal,
 *     with the configured delivery secret; an existing (409) subscription is reported, not retried,
 *     and nothing secret is ever printed;
 *   - --reconcile is one idempotent, bounded pass over every merchant and every code (any status, so a
 *     code that left active results gets its tombstone), reporting { sent, unchanged }.
 */
const assert = require('assert');
const { load } = require('../server/config');
const { subscribe, reconcile, parseArgs, PATTERNS, defaultEndpoint, DEFAULT_PAGE_SIZE } = require('../scripts/subscribe');
const { boot, check, done } = require('./helpers/boot');

const SECRET = 's'.repeat(64);
const CLIENT_SECRET = 'c'.repeat(48);
const ENV = {
    EVENTS_URL: 'http://events.test/', OV_NETWORK_INTERNAL_URL: 'http://network.test',
    OV_OAUTH_CLIENT_ID: 'coupons', OV_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    COUPONS_EVENTS_SECRET: SECRET, PORT: '4850',
};

/** A stub Network token endpoint and Events subscriptions endpoint; records every call. */
function stub({ tokenStatus = 200, createStatus = 201 } = {}) {
    const calls = [];
    const reply = (status, body) => ({ status, ok: status < 300, json: async () => body });
    const fetchImpl = async (url, opts = {}) => {
        calls.push({ url, method: opts.method, headers: opts.headers || {}, body: opts.body || null });
        if (url === 'http://network.test/oauth/token') {
            const p = new URLSearchParams(opts.body);
            assert.strictEqual(p.get('grant_type'), 'client_credentials');
            assert.strictEqual(p.get('client_id'), 'coupons');
            assert.strictEqual(p.get('audience'), 'openvibe.events');
            assert.strictEqual(p.get('scope'), 'events.subscription.manage');
            return tokenStatus === 200
                ? reply(200, { access_token: 'tok-coupons', token_type: 'Bearer', expires_in: 300 })
                : reply(tokenStatus, { error: 'invalid_client' });
        }
        if (url === 'http://events.test/api/v1/subscriptions' && opts.method === 'POST') {
            const b = JSON.parse(opts.body);
            if (createStatus === 409) return reply(409, { code: 'events.subscription_exists', subscription_id: 'sub_existing' });
            return reply(201, { id: `sub_${b.topic_pattern === PATTERNS[0] ? 1 : 2}` });
        }
        return reply(404, { code: 'not_found' });
    };
    return { fetchImpl, calls };
}

const logs = () => { const lines = []; const log = (s) => lines.push(String(s)); log.lines = lines; return log; };

(async () => {
    await check('subscribes both Sources patterns as coupons with the secret; nothing secret is printed', async () => {
        const s = stub();
        const log = logs();
        const out = await subscribe({ config: load(ENV), fetchImpl: s.fetchImpl, log });
        assert.deepStrictEqual(out, [
            { pattern: 'sources.item.*', subscription_id: 'sub_1', existed: false },
            { pattern: 'sources.fetch.failed', subscription_id: 'sub_2', existed: false },
        ]);
        const posts = s.calls.filter((c) => c.method === 'POST' && c.url === 'http://events.test/api/v1/subscriptions');
        assert.strictEqual(posts.length, 2, 'one subscription per pattern');
        assert.deepStrictEqual(JSON.parse(posts[0].body), {
            topic_pattern: 'sources.item.*', endpoint: 'http://127.0.0.1:4850/internal/events', secret: SECRET,
        });
        assert.strictEqual(posts[1].headers.Authorization, 'Bearer tok-coupons');
        assert.match(log.lines.join('\n'), /subscribed: sub_1 \(sources\.item\.\* → http:\/\/127\.0\.0\.1:4850\/internal\/events\)/);
        for (const l of log.lines) for (const v of [SECRET, CLIENT_SECRET, 'tok-coupons']) assert.ok(!l.includes(v), `printed a secret: ${l}`);
    });

    await check('an existing subscription is reported ("exists"), not duplicated; a 409 race is handled', async () => {
        const s = stub({ createStatus: 409 });
        const log = logs();
        const out = await subscribe({ config: load(ENV), fetchImpl: s.fetchImpl, log });
        assert.deepStrictEqual(out.map((o) => o.subscription_id), ['sub_existing', 'sub_existing']);
        assert.match(log.lines.join('\n'), /subscription exists: sub_existing/);
        assert.strictEqual(s.calls.filter((c) => c.method === 'POST' && c.url === 'http://events.test/api/v1/subscriptions').length, 2, 'no retry loop');
    });

    await check('refuses before calling anything when the environment is not usable; a refused token is an error', async () => {
        let called = 0;
        const fetchImpl = async () => { called++; return { status: 500, ok: false, json: async () => ({}) }; };
        await assert.rejects(subscribe({ config: load({ ...ENV, EVENTS_URL: '' }), fetchImpl, log: () => {} }), /EVENTS_URL is not set/);
        await assert.rejects(subscribe({ config: load({ ...ENV, COUPONS_EVENTS_SECRET: 'short' }), fetchImpl, log: () => {} }), /COUPONS_EVENTS_SECRET must be set/);
        await assert.rejects(subscribe({ config: load({ ...ENV, OV_OAUTH_CLIENT_SECRET: '' }), fetchImpl, log: () => {} }), /OV_OAUTH_CLIENT_SECRET is not set/);
        assert.strictEqual(called, 0);
        await assert.rejects(subscribe({ config: load(ENV), fetchImpl: stub({ tokenStatus: 401 }).fetchImpl, log: () => {} }), /token endpoint 401/);
    });

    await check('arguments', () => {
        assert.strictEqual(parseArgs([]).reconcile, false);
        assert.strictEqual(parseArgs(['--reconcile']).reconcile, true);
        assert.strictEqual(parseArgs(['--endpoint', 'http://x/internal/events']).endpoint, 'http://x/internal/events');
        const o = parseArgs(['--page-size', '50', '--max-pages', '3']);
        assert.strictEqual(o.pageSize, 50);
        assert.strictEqual(o.maxPages, 3);
        assert.strictEqual(DEFAULT_PAGE_SIZE, 200);
        assert.throws(() => parseArgs(['--nope']), /unknown argument/);
        assert.throws(() => parseArgs(['--page-size', '0']), /--page-size must be a positive integer/);
        assert.throws(() => parseArgs(['--endpoint']), /--endpoint needs a value/);
    });

    await check('--reconcile re-stamps every Search document, the next pass is unchanged, and a code that left active results is tombstoned', async () => {
        const t = await boot();
        try {
            const alice = t.network.addUser('alice');
            const a = await t.merchant({ name: 'Reconcile A', host: 'reconcile-a.com' });
            const b = await t.merchant({ name: 'Reconcile B', host: 'reconcile-b.com' });
            await t.submit(alice, { merchant_id: a.id, code: 'RA10', title: 'Ten off A' });
            await t.submit(alice, { merchant_id: b.id, code: 'RB10', title: 'Ten off B' });
            // A Search index that lost its publications: no revisions survive.
            await t.ctx.store.db.query('DELETE FROM coupons_index_revisions');
            assert.deepStrictEqual(await reconcile({ ctx: t.ctx, log: () => {} }), { sent: 4, unchanged: 0 }, '2 merchants + 2 public coupons');
            assert.deepStrictEqual(await reconcile({ ctx: t.ctx, log: () => {} }), { sent: 0, unchanged: 4 }, 'idempotent: nothing left to send');
            // A code that left active results behind the index's back still reaches Search.
            await t.ctx.store.db.query("UPDATE coupons SET status = 'disabled' WHERE code = 'RA10'");
            const before = Number((await t.ctx.store.db.query("SELECT COUNT(*) AS n FROM event_outbox WHERE envelope->>'event_type' = 'coupons.index_document.deleted'")).rows[0].n);
            assert.deepStrictEqual(await reconcile({ ctx: t.ctx, log: () => {} }), { sent: 2, unchanged: 2 }, 'its tombstone + its merchant (one fewer active code)');
            const after = Number((await t.ctx.store.db.query("SELECT COUNT(*) AS n FROM event_outbox WHERE envelope->>'event_type' = 'coupons.index_document.deleted'")).rows[0].n);
            assert.strictEqual(after - before, 1, 'the disabled code is tombstoned');
        } finally { await t.close(); }
    });

    await check('--page-size and --max-pages bound one pass to a page per table', async () => {
        const t = await boot();
        try {
            const alice = t.network.addUser('alice');
            for (const n of ['C', 'D']) {
                const m = await t.merchant({ name: `Bounded ${n}`, host: `bounded-${n.toLowerCase()}.com` });
                await t.submit(alice, { merchant_id: m.id, code: `B${n}10`, title: `Ten off ${n}` });
            }
            await t.ctx.store.db.query('DELETE FROM coupons_index_revisions');
            assert.deepStrictEqual(await reconcile({ ctx: t.ctx, pageSize: 1, maxPages: 1, log: () => {} }), { sent: 2, unchanged: 0 }, 'one merchant page + one coupon page');
        } finally { await t.close(); }
    });

    await check('the default endpoint is this service\'s port 4850 webhook', () => {
        assert.strictEqual(defaultEndpoint(load(ENV)), 'http://127.0.0.1:4850/internal/events');
        assert.strictEqual(load(ENV).port, 4850);
    });

    done();
})();
