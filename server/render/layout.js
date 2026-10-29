'use strict';

/**
 * Page shell. Every page is server-rendered through openvibe-publishing/layout (openvibe-shared/shell
 * page()) and is complete without JavaScript:
 *   - <head>: title, description, canonical and robots from the indexability gate's decision
 *     (there is no default that makes a page indexable), Open Graph, JSON-LD built from real
 *     fields only, feed links, the shared app icon, the site stylesheet and the boost marker
 *   - the OpenVibe Frame: theme-loader, web runtime, navbar and footer from the Network
 *     (progressive), a <noscript> navigation bar and the server-rendered shared footer
 *   - no script of Coupons' own beyond the navbar init: copying a code is plain text selection
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const layout = require('openvibe-publishing/layout');
const frame = require('openvibe-shared/frame');
const ovServe = require('openvibe-shared/serve');

/**
 * The page's JSON-LD in one script: every node in one @graph, so a page carries exactly one JSON-LD script.
 * The nodes keep their own fields; only their own @context goes, because the graph carries it once.
 */
const oneGraph = (nodes) => {
    const graph = nodes.filter(Boolean).map((n) => { const c = { ...n }; delete c['@context']; return c; });
    return [{ '@context': 'https://schema.org', '@graph': graph }];
};

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Coupons';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const NAV = [
    { label: 'Shops', href: '/', icon: 'fa-ticket' },
    { label: 'Submit a code', href: '/submit', icon: 'fa-plus' },
    { label: 'Browser extension', href: '/companion' },
];
// The phone app bar (Shared 4.20): the shops, submitting a code, what you watch, how codes are labelled.
const APP_BAR = (signedIn) => [
    { label: 'Shops', href: '/', icon: 'fa-ticket' },
    { label: 'Submit', href: '/submit', icon: 'fa-plus' },
    signedIn ? { label: 'Watching', href: '/watching', icon: 'fa-bell' } : { label: 'How it works', href: '/about', icon: 'fa-circle-info' },
];

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in place only
// between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

/**
 * o: title, description, decision (required), canonical, summary, facts, updated, url, jsonLd [],
 *    feeds [{ type, href, title }], body (HTML), viewer, config, path, bodyClass
 */
// The Markdown twin of this page (openvibe-shared/agent-layer): the head names it, so a reader that
// already has the HTML finds the twin from it. The twin's address is this page's own address + '.md'.
const agentHeadTags = (o) => {
    const canonical = o.canonical || (o.config && o.config.baseUrl ? `${o.config.baseUrl}${String(o.path || '/').split('?')[0]}` : null);
    return canonical ? require('openvibe-shared/agent-layer').linkHeaderTags(canonical, '/llms.txt').head : '';
};
function renderPage(o) {
    if (!o.decision) throw new TypeError('renderPage needs the gate decision');
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const loginNext = encodeURIComponent(o.path || '/');
    const nav = {
        service: 'coupons',
        apiBase: NETWORK_URL,
        links: NAV.map((l) => ({ label: l.label, href: l.href, ...(l.icon ? { icon: l.icon } : {}) })),
        appBar: APP_BAR(signedIn),
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${o.config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',   // filled from the current page (boost moves between pages)
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,   // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
    // This site's own account links live in the shared navbar's account menu (the page's account
    // bar below is only for visitors without JavaScript).
    if (signedIn) nav.menu = { before: [{ label: 'Watching', href: '/watching', icon: 'fa-bell' }, { label: 'Connected browsers', href: '/connect-extension', icon: 'fa-puzzle-piece' }, ...(viewer.staff ? [{ label: 'Staff', href: '/staff', icon: 'fa-shield' }] : [])] };
    const footer = { service: 'coupons', variant: 'auto', path: o.path, mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };   // full on the front page only (Shared 4.19)
    const account = signedIn
        ? `<a href="/watching">Watching</a> · <a href="/connect-extension">Connected browsers</a>${viewer.staff ? ' · <a href="/staff">Staff</a>' : ''} · <a href="/auth/logout?next=${loginNext}">Sign out</a>`
        : `<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a>`;
    return layout.renderDocument({
        site: 'coupons',
        siteName: SITE_NAME,
        // The front page's title says what the site is (search results show it); every other page is "<page> · OpenVibe.Coupons".
        title: o.title ? `${o.title} · ${SITE_NAME}` : o.path === '/' ? `${SITE_NAME}: coupon codes with honest expiry` : SITE_NAME,
        description: o.description || 'Coupon codes with merchant matching, restrictions, honest expiry and people\'s validity reports.',
        canonical: o.canonical,
        // The head names the page's own Markdown twin (openvibe-shared/agent-layer).
        head: agentHeadTags(o),
        decision: o.decision,
        // The AI-readable summary (publishing v1.3.0): given one, the shell emits the ai-summary meta
        // and a WebPage JSON-LD tag from these real fields; with none it emits neither.
        summary: o.summary,
        styles: [...(o.styles || []), 'kit.css'],   // openvibe-shared stylesheet names (the home's showcase.css; the OpenVibe Kit)
        scripts: [`<script src="${ovServe.url('kit-web.js')}" defer></script>`],   // the kit's behaviour: copy buttons, menus, confirms (the page works without it)
        facts: o.facts,
        updated: o.updated,
        url: o.url,
        type: 'website',
        jsonLd: o.jsonLd,
        feeds: o.feeds,
        navbar: nav,
        footer,
        navLinks: NAV,
        home: '/',
        css: asset('css/coupons.css'),
        release: RELEASE,
        account,
        body: o.body,
        shipped: o.path === '/' ? frame.shipped({ service: 'coupons', title: `Recently shipped on ${SITE_NAME}` }) : '',
        bodyClass: o.bodyClass,
    });
}

module.exports = { renderPage, asset, assetVersion, setRelease, SITE_NAME, NETWORK_URL, oneGraph };
