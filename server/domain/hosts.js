'use strict';

/**
 * Host normalization and the domain rules merchants are matched by.
 *
 *   normalizeHost('WWW.Example-Shop.co.uk.')  → 'www.example-shop.co.uk'
 *   normalizeHost('bücher.example')           → 'xn--bcher-kva.example'
 *   registrable('www.example-shop.co.uk')     → 'example-shop.co.uk'
 *
 * A host is: lowercase, punycode (IDNA via url.domainToASCII), no trailing dot, no port, at least
 * two labels, each 1–63 of [a-z0-9-] not starting or ending with '-', at most 253 characters. IP
 * literals, localhost and special-use names (.local, .internal, .invalid, .arpa …) are refused:
 * they are never a merchant and must not be looked up.
 *
 * Rule matching (merchant resolution):
 *   - a rule names a host at or below a registrable domain, never a public suffix;
 *   - include_subdomains: the rule also covers every subdomain of its host, but never crosses the
 *     registrable domain of the looked-up host (a rule on myshopify.com cannot claim
 *     foo.myshopify.com, which is its own site);
 *   - path_prefix: the rule matches only when a path is known and starts with the prefix at a
 *     segment boundary; host-only lookups (the browser helper sends only a hostname) never match
 *     path rules, so they fall back to the host's own rule;
 *   - the most specific rule wins: longest host, then longest path prefix.
 */
const { domainToASCII } = require('url');
const { registrableDomain, publicSuffix } = require('./psl');

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const SPECIAL = ['localhost', 'local', 'internal', 'invalid', 'arpa', 'test', 'example', 'onion', 'lan', 'home', 'corp'];

class HostError extends Error {
    constructor(detail) { super(detail); this.name = 'HostError'; this.status = 400; this.code = 'host.invalid'; }
}

/** → normalized host, or throws HostError. */
function normalizeHost(input) {
    if (typeof input !== 'string') throw new HostError('host must be a string');
    let h = input.trim().toLowerCase();
    if (!h || h.length > 300) throw new HostError('host is empty or too long');
    if (/[\s/\\?#@]/.test(h)) throw new HostError('host must be a hostname only (no scheme, path, query or credentials)');
    if (h.startsWith('[')) throw new HostError('IP addresses are not merchants');
    const colon = h.indexOf(':');
    if (colon !== -1) {
        if (!/^\d{1,5}$/.test(h.slice(colon + 1))) throw new HostError('malformed port');
        h = h.slice(0, colon);
    }
    h = h.replace(/\.$/, '');
    const ascii = domainToASCII(h);
    if (!ascii) throw new HostError('not a valid domain name');
    h = ascii.toLowerCase();
    if (h.length > 253) throw new HostError('host is too long');
    const labels = h.split('.');
    if (labels.length < 2) throw new HostError('host needs at least two labels');
    if (!labels.every((l) => LABEL_RE.test(l))) throw new HostError('host has a malformed label');
    if (labels.every((l) => /^\d+$/.test(l)) || /^\d+$/.test(labels[labels.length - 1])) throw new HostError('IP addresses are not merchants');
    if (SPECIAL.includes(labels[labels.length - 1])) throw new HostError('special-use names are not merchants');
    return h;
}

/** Normalize, or null. */
function tryHost(input) {
    try { return normalizeHost(input); } catch { return null; }
}

/** The registrable domain (eTLD+1) of a normalized host, or null when it is a public suffix. */
function registrable(host) { return registrableDomain(host); }

/** Host and path of an http(s) URL (for evidence and Sources items), or null. */
function hostOfUrl(url) {
    let u;
    try { u = new URL(String(url)); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = tryHost(u.hostname);
    return host ? { host, path: u.pathname || '/' } : null;
}

/** '/Shop/x/' → '/Shop/x' ; '' | '/' → '' ; throws on anything that is not a plain path. */
function normalizePathPrefix(p) {
    if (p == null || p === '' || p === '/') return '';
    const s = String(p).trim();
    if (!s.startsWith('/') || s.length > 200 || /[\s?#\\]/.test(s) || s.includes('//') || /(^|\/)\.\.?(\/|$)/.test(s)) {
        throw new HostError('path_prefix must be a plain path like /shop/name');
    }
    return s.replace(/\/+$/, '');
}

/** Does `path` start with `prefix` at a segment boundary? */
function pathMatches(prefix, path) {
    if (!prefix) return true;
    if (path == null) return false;
    return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Validate a new domain rule. → { host, registrable, path_prefix, include_subdomains }.
 * A rule on a public suffix (co.uk, myshopify.com …) is refused.
 */
function checkRule({ host, include_subdomains = true, path_prefix = '' } = {}) {
    const h = normalizeHost(host);
    const reg = registrable(h);
    if (!reg) throw new HostError(`${h} is a public suffix (${publicSuffix(h)}), not a site`);
    return { host: h, registrable: reg, path_prefix: normalizePathPrefix(path_prefix), include_subdomains: include_subdomains === false || include_subdomains === 0 || include_subdomains === '0' ? 0 : 1 };
}

/**
 * The best rule for (host, path) among candidate rule rows
 * ({ host, registrable_domain, include_subdomains, path_prefix, … }), or null.
 */
function bestRule(rules, host, path = null) {
    const reg = registrable(host);
    if (!reg) return null;
    let best = null;
    for (const r of rules) {
        const exact = r.host === host;
        const parent = !exact && r.include_subdomains && host.endsWith(`.${r.host}`);
        if (!exact && !parent) continue;
        // Never across registrable domains: the rule's host must be inside the host's own site.
        if (r.host.length < reg.length || !(r.host === reg || r.host.endsWith(`.${reg}`))) continue;
        if (!pathMatches(r.path_prefix, path)) continue;
        if (!best || r.host.length > best.host.length || (r.host.length === best.host.length && r.path_prefix.length > best.path_prefix.length)) best = r;
    }
    return best;
}

/** Every host a lookup could match a rule on: the host and its parents down to the registrable domain. */
function candidateHosts(host) {
    const reg = registrable(host);
    if (!reg) return [];
    const out = [];
    let h = host;
    for (;;) {
        out.push(h);
        if (h === reg) break;
        h = h.slice(h.indexOf('.') + 1);
    }
    return out;
}

module.exports = { HostError, normalizeHost, tryHost, registrable, hostOfUrl, normalizePathPrefix, pathMatches, checkRule, bestRule, candidateHosts };
