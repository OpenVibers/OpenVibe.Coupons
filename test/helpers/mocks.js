'use strict';
/**
 * In-process stand-ins for Coupons' neighbours, with a real RS256 key pair:
 *   Network    JWKS, /oauth/token (client_credentials → service tokens with the requested scope as
 *              capabilities)
 *   Sources    GET /api/v1/items?category=coupons&after= (needs sources.item.read), items the test
 *              controls in change order; setDown(true) answers 503
 * userToken()/serviceToken() mint the tokens browsers and services present to Coupons.
 */
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { serviceAuth, ids } = require('openvibe-contracts');

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
                handler(req, raw, json, res);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
    });
}

async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const grants = [];
    let issuer = null;
    const srv = await listen((req, raw, json) => {
        if (req.url === '/api/.well-known/jwks') return json(200, { public_key: publicPem, algorithm: 'RS256' });
        if (req.url === '/oauth/token' && req.method === 'POST') {
            let body = {};
            if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw));
            else { try { body = JSON.parse(raw); } catch { /* */ } }
            grants.push(body);
            if (body.client_secret !== 'shh') return json(401, { error: 'invalid_client' });
            if (body.grant_type === 'client_credentials') {
                let scope = body.scope;
                if (scope && typeof scope === 'object') scope = Object.values(scope).join(' ');
                const cap = String(scope || '').split(/\s+/).filter(Boolean);
                return json(200, { access_token: signService({ sub: `svc:${body.client_id}`, aud: [body.audience || 'openvibe.events'], cap }), token_type: 'Bearer', expires_in: 300 });
            }
            return json(400, { error: 'unsupported_grant_type' });
        }
        return json(404, { error: 'not found' });
    });
    issuer = srv.url;
    // An app token carries its developer project and env, as Network's do (identity.service-token-claims 1.2.0).
    function signService({ sub, aud, cap, actorType = 'service', extra = {} }) {
        const app = actorType === 'app' ? { project_id: 'prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', env: 'production' } : {};
        return serviceAuth.signServiceToken({ iss: issuer, sub, actor_type: actorType, aud, cap, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: crypto.randomUUID(), ...app, ...extra }, privatePem);
    }
    function addUser(username, extra = {}) {
        return { subject: ids.newId('user'), username, display_name: extra.display_name || username, role: extra.role || 'user' };
    }
    function userToken(u) {
        return jwt.sign({ sub: String(Math.floor(Math.random() * 1e6)), subject_id: u.subject, username: u.username, display_name: u.display_name, role: u.role || 'user' }, privatePem, { algorithm: 'RS256', issuer, expiresIn: '1h' });
    }
    function serviceToken(client, cap) {
        return signService({ sub: `svc:${client}`, aud: ['openvibe.coupons'], cap });
    }
    return { ...srv, publicPem, grants, addUser, userToken, serviceToken, signService };
}

async function startSources({ network }) {
    const items = [];          // in change order; each gets change_seq
    let seq = 0;
    let down = false;
    const calls = [];
    const srv = await listen((req, raw, json) => {
        calls.push(req.url);
        if (down) return json(503, { code: 'down' });
        const token = String(req.headers.authorization || '').slice(7);
        const v = serviceAuth.verifyServiceToken(token, { publicKey: network.publicPem, issuer: network.url, audience: 'openvibe.sources' });
        if (!v.ok || !(v.claims.cap || []).includes('sources.item.read')) return json(403, { code: 'capability.denied' });
        const u = new URL(req.url, 'http://x');
        if (u.pathname !== '/api/v1/items') return json(404, { code: 'route.not_found' });
        const after = Number(u.searchParams.get('after') || 0);
        const limit = Number(u.searchParams.get('limit') || 100);
        const list = items.filter((i) => i.change_seq > after && i.category === u.searchParams.get('category')).slice(0, limit);
        return json(200, { items: list, next_after: list.length ? list[list.length - 1].change_seq : after, more: false, sources: {} });
    });
    function put(item) {
        const idx = items.findIndex((i) => i.id === item.id);
        const row = { category: 'coupons', kind: 'coupon', revision: 1, removed: null, authors: [], summary: null, published_at: null, source_updated_at: null,
            provenance: { retrieved_at: '2026-09-22T10:00:00.000Z', first_seen_at: '2026-09-22T10:00:00.000Z', content_hash: 'a'.repeat(64), raw_body_hash: null, parser_version: 'manual@1', fetch_run_id: null, license_note: null, terms_note: 'merchant-published codes', entered_by: 'svc:network' },
            ...item, change_seq: ++seq };
        if (idx >= 0) items.splice(idx, 1);
        items.push(row);
        return row;
    }
    return { ...srv, items, calls, put, setDown: (v) => { down = v; } };
}

module.exports = { startNetwork, startSources, listen };
