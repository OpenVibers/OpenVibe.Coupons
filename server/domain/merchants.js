'use strict';

/**
 * Merchants and their domain rules.
 *
 *   pending   proposed by a member's submission for a site no merchant covers yet; invisible to the
 *             public (no page, no lookup) until staff approve it
 *   active    listed, resolvable, its codes can be shown
 *   disabled  taken down: no page (410), no lookup, codes out of every list
 *
 * resolve(host, { path }) is the merchant lookup (see hosts.js for the matching rules). Only active
 * merchants resolve publicly.
 */
const { ids } = require('openvibe-contracts');
const hosts = require('./hosts');
const { ApiError } = require('../http/errors');

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function slugify(s) {
    return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
}

function createMerchants({ store }) {
    const { db } = store;
    const q = {
        byId: db.prepare('SELECT * FROM coupon_merchants WHERE id = ?'),
        bySlug: db.prepare('SELECT * FROM coupon_merchants WHERE slug = ?'),
        insert: db.prepare(`INSERT INTO coupon_merchants (id, slug, name, homepage_url, description, status, created_by, created_at, updated_at)
                            VALUES (@id, @slug, @name, @homepage_url, @description, @status, @created_by, @now, @now)`),
        setStatus: db.prepare('UPDATE coupon_merchants SET status = ?, updated_at = ? WHERE id = ?'),
        domains: db.prepare('SELECT * FROM coupon_merchant_domains WHERE merchant_id = ? ORDER BY host, path_prefix'),
        domainInsert: db.prepare(`INSERT INTO coupon_merchant_domains (merchant_id, host, registrable_domain, include_subdomains, path_prefix, created_by, created_at)
                                  VALUES (@merchant_id, @host, @registrable, @include_subdomains, @path_prefix, @created_by, @now)`),
        domainByKey: db.prepare('SELECT * FROM coupon_merchant_domains WHERE host = ? AND path_prefix = ?'),
        domainDelete: db.prepare('DELETE FROM coupon_merchant_domains WHERE id = ? AND merchant_id = ?'),
        rulesFor: db.prepare(`SELECT d.*, m.status AS merchant_status FROM coupon_merchant_domains d JOIN coupon_merchants m ON m.id = d.merchant_id
                              WHERE d.registrable_domain = ?`),
        listActive: db.prepare(`SELECT * FROM coupon_merchants WHERE status = 'active' ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`),
        countActive: db.prepare("SELECT COUNT(*) AS n FROM coupon_merchants WHERE status = 'active'"),
        search: db.prepare(`SELECT DISTINCT m.* FROM coupon_merchants m LEFT JOIN coupon_merchant_domains d ON d.merchant_id = m.id
                            WHERE m.status = 'active' AND (m.name LIKE @q ESCAPE '\\' OR d.host LIKE @q ESCAPE '\\')
                            ORDER BY m.name COLLATE NOCASE LIMIT 50`),
        pending: db.prepare("SELECT * FROM coupon_merchants WHERE status = 'pending' ORDER BY created_at LIMIT 200"),
    };

    function get(idOrSlug) {
        const s = String(idOrSlug || '');
        return s.startsWith('mer_') ? q.byId.get(s) : q.bySlug.get(s);
    }

    function uniqueSlug(base) {
        let slug = SLUG_RE.test(base) ? base : slugify(base) || 'merchant';
        if (!q.bySlug.get(slug)) return slug;
        for (let i = 2; i < 1000; i++) { const s = `${slug.slice(0, 58)}-${i}`; if (!q.bySlug.get(s)) return s; }
        throw new ApiError(409, 'merchant.slug_taken', 'could not find a free slug');
    }

    /** Add one domain rule (inside the caller's transaction). */
    function addDomain(merchant, rule, actor) {
        const r = hosts.checkRule(rule);
        const clash = q.domainByKey.get(r.host, r.path_prefix);
        if (clash) {
            if (clash.merchant_id === merchant.id) return clash;
            throw new ApiError(409, 'merchant.domain_taken', `${r.host}${r.path_prefix} already belongs to another merchant`);
        }
        q.domainInsert.run({ merchant_id: merchant.id, ...r, created_by: actor, now: store.now() });
        return q.domainByKey.get(r.host, r.path_prefix);
    }

    /**
     * Create a merchant with at least one domain rule.
     * input: { name, slug?, homepage_url?, description?, domains: [{ host, include_subdomains?, path_prefix? }] }
     */
    function create(input, { status = 'active', actor }) {
        const domains = Array.isArray(input.domains) ? input.domains : [];
        if (!domains.length) throw new ApiError(422, 'merchant.domain_required', 'a merchant needs at least one domain');
        const first = hosts.checkRule(domains[0]);
        const name = String(input.name == null ? '' : input.name).trim().slice(0, 120) || first.registrable;
        let homepage = null;
        if (input.homepage_url) {
            const h = hosts.hostOfUrl(input.homepage_url);
            if (!h || !/^https:\/\//i.test(String(input.homepage_url))) throw new ApiError(422, 'merchant.bad_homepage', 'homepage_url must be an https URL');
            homepage = String(input.homepage_url).slice(0, 500);
        } else {
            homepage = `https://${first.host}/`;
        }
        return store.tx(() => {
            const id = `mer_${ids.ulid(store.now())}`;
            const slug = uniqueSlug(input.slug ? String(input.slug) : slugify(name));
            q.insert.run({
                id, slug, name, homepage_url: homepage,
                description: input.description ? String(input.description).trim().slice(0, 1000) : null,
                status, created_by: actor, now: store.now(),
            });
            const m = q.byId.get(id);
            for (const d of domains) addDomain(m, d, actor);
            return m;
        });
    }

    /**
     * The merchant for a host (and optionally a path). `includeStatuses` limits which merchants count
     * (default: active only). → { merchant, rule, host, registrable } or null.
     */
    function resolve(rawHost, { path = null, includeStatuses = ['active'] } = {}) {
        const host = hosts.normalizeHost(rawHost);
        const reg = hosts.registrable(host);
        if (!reg) return null;
        const rules = q.rulesFor.all(reg).filter((r) => includeStatuses.includes(r.merchant_status));
        const rule = hosts.bestRule(rules, host, path);
        if (!rule) return null;
        return { merchant: q.byId.get(rule.merchant_id), rule, host, registrable: reg };
    }

    /** Is `url` on one of the merchant's own domains (merchant evidence)? */
    function ownsUrl(merchant, url) {
        const h = hosts.hostOfUrl(url);
        if (!h) return false;
        const rules = q.domains.all(merchant.id);
        return Boolean(hosts.bestRule(rules, h.host, h.path));
    }

    return {
        get,
        byId: (id) => q.byId.get(id),
        domains: (m) => q.domains.all(m.id),
        create,
        addDomain: (m, rule, actor) => store.tx(() => addDomain(m, rule, actor)),
        removeDomain: (m, domainId) => q.domainDelete.run(Number(domainId), m.id).changes === 1,
        setStatus(m, status) {
            if (!['pending', 'active', 'disabled'].includes(status)) throw new ApiError(422, 'merchant.bad_status', 'status must be pending, active or disabled');
            q.setStatus.run(status, store.now(), m.id);
            return q.byId.get(m.id);
        },
        resolve,
        ownsUrl,
        listActive: ({ limit = 100, offset = 0 } = {}) => q.listActive.all(limit, offset),
        countActive: () => q.countActive.get().n,
        search(text) {
            const t = String(text || '').trim().toLowerCase().slice(0, 60);
            if (!t) return [];
            return q.search.all({ q: `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%` });
        },
        pending: () => q.pending.all(),
        slugify,
    };
}

module.exports = { createMerchants, slugify };
