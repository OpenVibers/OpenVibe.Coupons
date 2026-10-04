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

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Coupons';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const NAV = [
    { label: 'Merchants', href: '/' },
    { label: 'Submit a code', href: '/submit' },
    { label: 'Browser helper', href: '/connect-extension' },
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
 * o: title, description, decision (required), canonical, jsonLd [], feeds [{ type, href, title }],
 *    body (HTML), viewer, config, path, bodyClass
 */
function renderPage(o) {
    if (!o.decision) throw new TypeError('renderPage needs the gate decision');
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const loginNext = encodeURIComponent(o.path || '/');
    const nav = {
        service: 'coupons',
        apiBase: NETWORK_URL,
        links: NAV.map((l) => ({ label: l.label, href: l.href })),
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${o.config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',   // filled from the current page (boost moves between pages)
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,   // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
    // This site's own account links live in the shared navbar's account menu (the page's account
    // bar below is only for visitors without JavaScript).
    if (signedIn) nav.menu = { before: [{ label: 'Watching', href: '/watching', icon: 'fa-bell' }, { label: 'Browser helper', href: '/connect-extension', icon: 'fa-puzzle-piece' }, ...(viewer.staff ? [{ label: 'Staff', href: '/staff', icon: 'fa-shield' }] : [])] };
    const footer = { service: 'coupons', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };
    const account = signedIn
        ? `<a href="/watching">Watching</a> · <a href="/connect-extension">Browser helper</a>${viewer.staff ? ' · <a href="/staff">Staff</a>' : ''} · <a href="/auth/logout?next=${loginNext}">Sign out</a>`
        : `<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a>`;
    return layout.renderDocument({
        site: 'coupons',
        siteName: SITE_NAME,
        title: o.title ? `${o.title} · ${SITE_NAME}` : SITE_NAME,
        description: o.description || 'Coupon codes with merchant matching, restrictions, honest expiry and people\'s validity reports.',
        canonical: o.canonical,
        decision: o.decision,
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

module.exports = { renderPage, asset, assetVersion, setRelease, SITE_NAME, NETWORK_URL };
