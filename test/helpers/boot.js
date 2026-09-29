'use strict';
/**
 * Boots Coupons on a temp database with a controllable clock and mocks of its neighbours, and
 * returns a small HTTP client. Every test file gets its own instance.
 *
 *   const t = await boot({ env });
 *   t.get(path, { as: user | 'Bearer token string', json, form, headers, method })
 *   t.clock.advance(ms)            the app's clock (expiry, reports, decay, tokens)
 *   t.merchant({ name, host })     an active merchant created through the API as staff
 *   t.submit(user, body)           POST /api/v1/coupons/submit as that user
 *   t.connect(user, { report })    a cpx_ token created through the /connect-extension form
 */
const http = require('http');
const { startNetwork, startSources } = require('./mocks');

function makeClock(start = Date.parse('2026-09-22T12:00:00Z')) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; return t; }, set: (v) => { t = v; } };
}

async function boot(opts = {}) {
    const network = await startNetwork();
    const sources = await startSources({ network });
    const clock = opts.clock || makeClock();
    const staff = network.addUser('staffer', { role: 'admin' });
    const env = {
        NODE_ENV: 'test', PORT: '0', BASE_URL: 'https://openvibe.coupons', TRUST_PROXY: '1',
        OV_NETWORK_URL: network.url, OV_NETWORK_INTERNAL_URL: network.url,
        OV_OAUTH_CLIENT_ID: 'coupons', OV_OAUTH_CLIENT_SECRET: 'shh', COOKIE_SECURE: 'false',
        COUPONS_WORKER: 'off', COUPONS_FORM_SECRET: 'test-form-secret', COUPONS_REPORTER_KEY_SECRET: 'test-reporter-secret',
        OV_SOURCES_INTERNAL_URL: sources.url,
        ...(opts.env || {}),
    };
    const configLib = require('../../server/config');
    const { createApp } = require('../../server/app');
    const quiet = { log() {}, warn() {}, error: (...a) => { if (process.env.VERBOSE) console.error(...a); } };

    const { createStore } = require('../../server/db');
    // One database per boot (PGlite, or COUPONS_TEST_STORE=pg: the containers); a restart keeps it.
    const testdb = await require('./db').testDb();
    let server = null;
    let built = null;
    async function start() {
        const config = configLib.load(env);
        built = await createApp({ config, store: createStore(testdb.db, { now: clock.now }), now: clock.now, log: opts.log || quiet, limitsNow: opts.limitsNow });
        try { await built.ctx.jwks.keys(); } catch { /* started without the key: readiness reports it */ }
        server = await new Promise((resolve) => { const s = http.createServer(built.app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        t.base = `http://127.0.0.1:${server.address().port}`;
        t.app = built.app;
        t.ctx = built.ctx;
    }
    async function stop() {
        if (server) await new Promise((r) => server.close(r));
        if (built) { built.ctx.worker.stop(); await built.ctx.outbox.stop(); }
        server = null; built = null;
    }

    /** as: a network user ({ subject, … }) → ov_token cookie; a string → Authorization: Bearer <string>. */
    async function get(p, o = {}) {
        const headers = { ...(o.headers || {}) };
        if (o.as && typeof o.as === 'object') headers.cookie = `ov_token=${network.userToken(o.as)}`;
        if (typeof o.as === 'string') headers.authorization = `Bearer ${o.as}`;
        let body = o.body;
        if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
        if (o.form) { body = new URLSearchParams(o.form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        const res = await fetch(t.base + p, { method: o.method || (body ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
        const text = await res.text();
        return { status: res.status, headers: res.headers, text, json() { return JSON.parse(text); } };
    }

    /** Rows of event_outbox as parsed envelopes. */
    async function events(type = null) {
        return (await t.ctx.store.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all()).map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope))
            .filter((e) => !type || e.event_type === type || (type instanceof RegExp && type.test(e.event_type)));
    }

    const csrf = (user) => require('../../server/auth/forms').csrfToken({ formSecret: env.COUPONS_FORM_SECRET }, user);

    async function merchant({ name, host, include_subdomains = true, path_prefix = '' }) {
        const r = await get('/api/v1/merchants', { as: network.userToken(staff), json: { name, domains: [{ host, include_subdomains, path_prefix }] } });
        if (r.status !== 201) throw new Error(`merchant: ${r.status} ${r.text}`);
        return r.json().merchant;
    }

    async function submit(user, body) {
        return await get('/api/v1/coupons/submit', { as: network.userToken(user), json: body });
    }

    async function connect(user, { report = true, label = 'test browser' } = {}) {
        const r = await get('/connect-extension', { as: user, form: { csrf: csrf(user), label, ...(report ? { scope_report: '1' } : {}) } });
        if (r.status !== 201) throw new Error(`connect: ${r.status} ${r.text.slice(0, 300)}`);
        const m = r.text.match(/cpx_[A-Za-z0-9_-]{43}/);
        if (!m) throw new Error('no token on the page');
        return m[0];
    }

    const t = {
        network, sources, clock, staff, get, events, csrf, merchant, submit, connect,
        staffToken: () => network.userToken(staff),
        async restart() { await stop(); await start(); },
        async close() { await stop(); await testdb.close(); await network.close(); await sources.close(); },
    };
    await start();
    return t;
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}
function done() { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }

module.exports = { boot, check, done, makeClock };
