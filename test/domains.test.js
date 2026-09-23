'use strict';
/**
 * Domain normalization: hosts, the bundled public-suffix subset (eTLD+1, wildcards, exceptions,
 * private-section platforms), rule checks and merchant matching (subdomains, paths, never across
 * registrable domains) — and the same through the resolve API.
 */
const assert = require('assert');
const hosts = require('../server/domain/hosts');
const psl = require('../server/domain/psl');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    await check('normalizeHost: case, trailing dot, port, IDN → punycode', async () => {
        assert.strictEqual(hosts.normalizeHost('WWW.Example-Shop.CO.UK.'), 'www.example-shop.co.uk');
        assert.strictEqual(hosts.normalizeHost('shop.example.com:8443'), 'shop.example.com');
        assert.strictEqual(hosts.normalizeHost('bücher.de'), 'xn--bcher-kva.de');
        assert.strictEqual(hosts.normalizeHost('  Shop.Com '), 'shop.com');
    });

    await check('normalizeHost refuses URLs, paths, credentials, IPs, localhost and special-use names', async () => {
        for (const bad of ['https://shop.com', 'shop.com/path', 'user@shop.com', 'shop.com?x=1', 'shop.com#a', '127.0.0.1', '10.0.0.1', '[::1]',
            'localhost', 'printer.local', 'db.internal', 'x.invalid', 'a.test', 'com', '', '-bad.com', 'bad-.com', 'a..com', 'a'.repeat(64) + '.com', 'shop.com:abc']) {
            assert.throws(() => hosts.normalizeHost(bad), (e) => e.name === 'HostError' && e.status === 400, bad);
        }
    });

    await check('registrable domain (eTLD+1) from the bundled public-suffix subset', async () => {
        const cases = {
            'shop.com': 'shop.com',
            'www.shop.com': 'shop.com',
            'a.b.c.shop.com': 'shop.com',
            'www.example-shop.co.uk': 'example-shop.co.uk',
            'store.example.com.au': 'example.com.au',
            'm.example.co.jp': 'example.co.jp',
            'foo.myshopify.com': 'foo.myshopify.com',
            'checkout.foo.myshopify.com': 'foo.myshopify.com',
            'someone.github.io': 'someone.github.io',
            'shop.example.bar.ck': 'example.bar.ck',  // *.ck wildcard: bar.ck is a suffix
            'www.ck': 'www.ck',                       // !www.ck exception
            'a.www.ck': 'www.ck',
            'x.example.kh': 'x.example.kh',           // *.kh: example.kh is a suffix
        };
        for (const [h, want] of Object.entries(cases)) assert.strictEqual(hosts.registrable(h), want, h);
        assert.strictEqual(hosts.registrable('co.uk'), null);
        assert.strictEqual(hosts.registrable('myshopify.com'), null);
        assert.strictEqual(hosts.registrable('bar.ck'), null);
        assert.strictEqual(psl.publicSuffix('www.example-shop.co.uk'), 'co.uk');
    });

    await check('checkRule refuses a rule on a public suffix and normalizes path prefixes', async () => {
        for (const bad of ['co.uk', 'myshopify.com', 'github.io', 'bar.ck']) assert.throws(() => hosts.checkRule({ host: bad }), /public suffix/, bad);
        assert.deepStrictEqual(hosts.checkRule({ host: 'Shop.COM', path_prefix: '/Brand/X/' }), { host: 'shop.com', registrable: 'shop.com', path_prefix: '/Brand/X', include_subdomains: 1 });
        for (const bad of ['brand', '/a/../b', '/a b', '/a?x', '//a']) assert.throws(() => hosts.checkRule({ host: 'shop.com', path_prefix: bad }), /plain path/, bad);
        assert.strictEqual(hosts.checkRule({ host: 'shop.com', include_subdomains: false }).include_subdomains, 0);
    });

    await check('bestRule: exact host, subdomains, paths at segment boundaries, most specific wins, never across sites', async () => {
        const rule = (host, include_subdomains, path_prefix = '', id = host + path_prefix) => ({ id, host, registrable_domain: hosts.registrable(host), include_subdomains, path_prefix });
        const rules = [rule('shop.com', 1), rule('eu.shop.com', 0), rule('shop.com', 1, '/brands/acme')];
        assert.strictEqual(hosts.bestRule(rules, 'shop.com').id, 'shop.com');
        assert.strictEqual(hosts.bestRule(rules, 'www.shop.com').id, 'shop.com');
        assert.strictEqual(hosts.bestRule(rules, 'eu.shop.com').id, 'eu.shop.com');
        assert.strictEqual(hosts.bestRule(rules, 'x.eu.shop.com').id, 'shop.com', 'eu.shop.com does not include subdomains');
        assert.strictEqual(hosts.bestRule(rules, 'shop.com', '/brands/acme/shoes').id, 'shop.com/brands/acme');
        assert.strictEqual(hosts.bestRule(rules, 'shop.com', '/brands/acmecorp').id, 'shop.com', 'segment boundary');
        assert.strictEqual(hosts.bestRule(rules, 'shop.com', null).id, 'shop.com', 'host-only lookups never match path rules');
        assert.strictEqual(hosts.bestRule(rules, 'othershop.com'), null);
        assert.strictEqual(hosts.bestRule(rules, 'shop.com.evil.net'), null);
        assert.strictEqual(hosts.bestRule(rules, 'evilshop.com'), null, 'suffix match must be at a label boundary');
        // A (hypothetical) rule on a platform domain never claims a customer's own site.
        const platform = [{ id: 'p', host: 'myshopify.com', registrable_domain: 'foo.myshopify.com', include_subdomains: 1, path_prefix: '' }];
        assert.strictEqual(hosts.bestRule(platform, 'foo.myshopify.com'), null);
    });

    const t = await boot();
    await check('the resolve API: subdomains, unknown hosts, bad input, platform subdomains are separate shops', async () => {
        await t.merchant({ name: 'Example Shop', host: 'example-shop.co.uk' });
        await t.merchant({ name: 'Foo on Shopify', host: 'foo.myshopify.com' });
        const r = await t.get('/api/v1/merchants/resolve?host=WWW.Example-Shop.co.uk');
        assert.strictEqual(r.status, 200, r.text);
        const b = r.json();
        assert.strictEqual(b.merchant.name, 'Example Shop');
        assert.strictEqual(b.host, 'www.example-shop.co.uk');
        assert.strictEqual(b.registrable_domain, 'example-shop.co.uk');
        assert.strictEqual((await t.get('/api/v1/merchants/resolve?host=foo.myshopify.com')).json().merchant.name, 'Foo on Shopify');
        const bar = await t.get('/api/v1/merchants/resolve?host=bar.myshopify.com');
        assert.strictEqual(bar.status, 404);
        assert.strictEqual(bar.json().code, 'merchant.not_found');
        assert.strictEqual((await t.get('/api/v1/merchants/resolve?host=127.0.0.1')).status, 400);
        assert.strictEqual((await t.get('/api/v1/merchants/resolve?host=https://example-shop.co.uk/cart')).status, 400);
        assert.strictEqual((await t.get('/api/v1/merchants/resolve')).status, 400);
    });

    await check('a merchant cannot be created on a public suffix, and a domain rule belongs to one merchant', async () => {
        const r = await t.get('/api/v1/merchants', { as: t.staffToken(), json: { name: 'All UK', domains: [{ host: 'co.uk' }] } });
        assert.strictEqual(r.status, 400);
        const dup = await t.get('/api/v1/merchants', { as: t.staffToken(), json: { name: 'Impostor', domains: [{ host: 'example-shop.co.uk' }] } });
        assert.strictEqual(dup.status, 409);
        assert.strictEqual(dup.json().code, 'merchant.domain_taken');
    });

    await t.close();
    done();
})();
