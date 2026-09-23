'use strict';
/**
 * The browser-helper surface: install tokens (scoped, hashed at rest, revocation immediate,
 * expiring), the lookup API (same bytes for every caller, no personal data), CORS only for the
 * extension origin and only on the lookup routes, per-caller rate limits — and what a malicious
 * merchant page can do with a visitor's browser (nothing that reveals anyone's data).
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const DAY = 24 * 3600 * 1000;

(async () => {
    const t = await boot({ env: { COUPONS_EXTENSION_ORIGINS: `${EXT},moz-extension://*`, COUPONS_LOOKUP_ANON_PER_MIN: '8', COUPONS_LOOKUP_TOKEN_PER_MIN: '40' } });
    const alice = t.network.addUser('alice');
    const bob = t.network.addUser('bob');
    const shop = await t.merchant({ name: 'Paper Lantern', host: 'paperlantern.store' });
    const submitter = t.network.addUser('sam');
    const code = (await t.submit(submitter, { host: 'paperlantern.store', code: 'GLOW', title: 'Ten off lamps', evidence_url: 'https://paperlantern.store/sale' })).json().coupon;
    await t.get(`/api/v1/coupons/${code.id}/report`, { as: t.network.userToken(alice), json: { outcome: 'worked' } });

    let aliceToken;
    let bobToken;
    await check('connect page: signed out → sign-in link; signed in → token shown once, stored only as a hash', async () => {
        const anon = await t.get('/connect-extension');
        assert.strictEqual(anon.status, 200);
        assert.match(anon.text, /Sign in with OpenVibe/);
        assert.doesNotMatch(anon.text, /cpx_/);
        aliceToken = await t.connect(alice, { label: 'Firefox' });
        bobToken = await t.connect(bob, { label: 'Chrome', report: false });
        assert.match(aliceToken, /^cpx_[A-Za-z0-9_-]{43}$/);
        const rows = t.ctx.store.db.prepare('SELECT * FROM extension_installs').all();
        assert.strictEqual(rows.length, 2);
        const dump = JSON.stringify(rows);
        assert.ok(!dump.includes(aliceToken) && !dump.includes(bobToken), 'the token itself is never stored');
        const again = await t.get('/connect-extension', { as: alice });
        assert.doesNotMatch(again.text, new RegExp(aliceToken), 'shown once only');
        assert.match(again.text, /Firefox/);
        assert.match(again.headers.get('cache-control'), /no-store/);
    });

    await check('connect and revoke forms need the form token (CSRF)', async () => {
        const r = await t.get('/connect-extension', { as: alice, form: { label: 'x', scope_report: '1' } });
        assert.strictEqual(r.status, 403);
        const install = t.ctx.installs.list(alice.subject)[0];
        const rv = await t.get(`/connect-extension/${install.id}/revoke`, { as: alice, form: { csrf: 'forged' } });
        assert.strictEqual(rv.status, 403);
        assert.strictEqual(t.ctx.installs.list(alice.subject)[0].active, true);
    });

    await check('scopes: lookup always; report only when granted; nothing else (no submit, no staff)', async () => {
        assert.strictEqual((await t.get(`/api/v1/merchants/${shop.id}/coupons`, { as: bobToken })).status, 200);
        const noReport = await t.get(`/api/v1/coupons/${code.id}/report`, { as: bobToken, json: { outcome: 'worked' } });
        assert.strictEqual(noReport.status, 403);
        assert.strictEqual(noReport.json().code, 'token.scope');
        assert.strictEqual((await t.get(`/api/v1/coupons/${code.id}/report`, { as: aliceToken, json: { outcome: 'worked' } })).status, 200, 'alice already reported today via the API: deduplicated');
        assert.strictEqual((await t.get('/api/v1/coupons/submit', { as: aliceToken, json: { host: 'paperlantern.store', code: 'NEW', title: 'New one' } })).status, 403);
        assert.strictEqual((await t.get(`/api/v1/coupons/${code.id}/status`, { as: aliceToken, json: { status: 'disabled' } })).status, 403);
        // An install token is not a session: pages treat it as anonymous.
        const page = await t.get('/connect-extension', { as: aliceToken });
        assert.match(page.text, /Sign in with OpenVibe/);
    });

    await check('revocation takes effect on the very next request', async () => {
        assert.strictEqual((await t.get('/api/v1/merchants/resolve?host=paperlantern.store', { as: aliceToken })).status, 200);
        const install = t.ctx.installs.list(alice.subject).find((i) => i.label === 'Firefox');
        const rv = await t.get(`/connect-extension/${install.id}/revoke`, { as: alice, form: { csrf: t.csrf(alice) } });
        assert.strictEqual(rv.status, 303);
        const r = await t.get('/api/v1/merchants/resolve?host=paperlantern.store', { as: aliceToken });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.json().code, 'token.revoked');
        assert.strictEqual((await t.get(`/api/v1/coupons/${code.id}/report`, { as: aliceToken, json: { outcome: 'failed' } })).status, 401);
        // Someone else cannot revoke bob's install.
        const bobInstall = t.ctx.installs.list(bob.subject)[0];
        await t.get(`/connect-extension/${bobInstall.id}/revoke`, { as: alice, form: { csrf: t.csrf(alice) } });
        assert.strictEqual((await t.get('/api/v1/merchants/resolve?host=paperlantern.store', { as: bobToken })).status, 200);
    });

    await check('malformed, unknown and expired tokens are refused, never downgraded to anonymous', async () => {
        assert.strictEqual((await t.get('/api/v1/merchants/resolve?host=paperlantern.store', { as: 'cpx_short' })).json().code, 'token.invalid');
        assert.strictEqual((await t.get('/api/v1/merchants/resolve?host=paperlantern.store', { as: `cpx_${'A'.repeat(43)}` })).json().code, 'token.invalid');
        const temp = await t.connect(alice, { label: 'temp' });
        t.clock.advance(366 * DAY);
        const r = await t.get('/api/v1/merchants/resolve?host=paperlantern.store', { as: temp });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.json().code, 'token.expired');
        t.clock.advance(-366 * DAY);
    });

    await check('a lookup response is the same bytes for anonymous callers and for any two people, and holds no personal data', async () => {
        const carolToken = await t.connect(t.network.addUser('carol'));
        const paths = ['/api/v1/merchants/resolve?host=www.paperlantern.store', `/api/v1/merchants/${shop.id}/coupons`];
        for (const p of paths) {
            const anon = await t.get(p);
            const b = await t.get(p, { as: bobToken });
            const c = await t.get(p, { as: carolToken });
            const signed = await t.get(p, { as: t.network.userToken(alice) });
            assert.strictEqual(anon.status, 200, anon.text);
            assert.strictEqual(b.text, anon.text, p);
            assert.strictEqual(c.text, anon.text, p);
            assert.strictEqual(signed.text, anon.text, p);
            assert.doesNotMatch(anon.text, /usr_|gst_|cpi_|cpx_|reporter|submitted_by|created_by|install/);
            assert.strictEqual(anon.headers.get('cache-control'), 'public, max-age=60');
        }
    });

    await check('CORS: the extension origin (and moz-extension://*) on the two lookup routes only; never a web origin, never credentials', async () => {
        const lookup = `/api/v1/merchants/${shop.id}/coupons`;
        const ok = await t.get(lookup, { headers: { origin: EXT } });
        assert.strictEqual(ok.headers.get('access-control-allow-origin'), EXT);
        assert.strictEqual(ok.headers.get('access-control-allow-credentials'), null);
        assert.match(ok.headers.get('vary'), /Origin/);
        const moz = await t.get('/api/v1/merchants/resolve?host=paperlantern.store', { headers: { origin: 'moz-extension://0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0' } });
        assert.strictEqual(moz.headers.get('access-control-allow-origin'), 'moz-extension://0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0');
        const pre = await t.get(lookup, { method: 'OPTIONS', headers: { origin: EXT, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
        assert.strictEqual(pre.status, 204);
        assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
        for (const origin of ['https://paperlantern.store', 'https://evil.example-shop.com', 'null', 'chrome-extension://someotherextensionidxxxxxxxxxxxx']) {
            const r = await t.get(lookup, { headers: { origin } });
            assert.strictEqual(r.headers.get('access-control-allow-origin'), null, origin);
        }
        const report = await t.get(`/api/v1/coupons/${code.id}/report`, { method: 'OPTIONS', headers: { origin: EXT, 'access-control-request-method': 'POST' } });
        assert.strictEqual(report.headers.get('access-control-allow-origin'), null, 'no CORS on reports');
        const single = await t.get(`/api/v1/coupons/${code.id}`, { headers: { origin: EXT } });
        assert.strictEqual(single.headers.get('access-control-allow-origin'), null, 'no CORS beyond the two lookup routes');
    });

    await check('a malicious merchant page riding the visitor\'s cookies gets nothing: API ignores cookies, forms need a token only this site can make', async () => {
        const cookie = `ov_token=${t.network.userToken(bob)}`;
        const evil = { origin: 'https://paperlantern.store', cookie };
        const rep = await t.get(`/api/v1/coupons/${code.id}/report`, { method: 'POST', headers: { ...evil, 'content-type': 'application/json' }, body: JSON.stringify({ outcome: 'failed' }) });
        assert.strictEqual(rep.status, 401);
        const formRep = await t.get(`/c/${code.id}/report`, { method: 'POST', headers: { ...evil, 'content-type': 'application/x-www-form-urlencoded' }, body: 'outcome=failed' });
        assert.strictEqual(formRep.status, 403, 'no form token → refused');
        const connect = await t.get('/connect-extension', { method: 'POST', headers: { ...evil, 'content-type': 'application/x-www-form-urlencoded' }, body: 'label=stolen' });
        assert.strictEqual(connect.status, 403, 'cannot mint a token for the visitor');
        const lookup = await t.get('/api/v1/merchants/resolve?host=paperlantern.store', { headers: evil });
        assert.strictEqual(lookup.headers.get('access-control-allow-origin'), null, 'and its script cannot read even the public answer');
        assert.doesNotMatch(lookup.text, /bob|usr_/);
        const watching = await t.get('/watching', { headers: { origin: 'https://paperlantern.store' } });
        assert.strictEqual(watching.status, 303, 'private pages need the visitor\'s own session');
        const framed = await t.get('/connect-extension', { as: bob });
        assert.strictEqual(framed.headers.get('x-frame-options'), 'DENY', 'the connect page cannot be framed (clickjacking)');
        assert.match(framed.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    });

    await check('lookup rate limits: anonymous callers per IP, installs per install (higher), 429 as problem+json', async () => {
        await t.restart();
        const p = '/api/v1/merchants/resolve?host=paperlantern.store';
        let last;
        for (let i = 0; i < 9; i++) last = await t.get(p);
        assert.strictEqual(last.status, 429);
        assert.strictEqual(last.json().code, 'lookup.rate_limited');
        assert.match(last.headers.get('content-type'), /application\/problem\+json/);
        const withToken = await t.get(p, { as: bobToken });
        assert.strictEqual(withToken.status, 200, 'an install has its own, larger budget');
    });

    await t.close();
    done();
})();
