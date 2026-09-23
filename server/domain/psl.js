'use strict';

/**
 * A small, bundled subset of the Public Suffix List (https://publicsuffix.org/list/, MPL-2.0),
 * enough to find the registrable domain (eTLD+1) of the shops Coupons is likely to see.
 *
 * Rules follow the PSL algorithm: the longest matching rule wins, `*.x` matches any single label
 * under x, `!a.x` is an exception to a wildcard, and when nothing matches the rule is `*` (the top
 * label alone is the suffix). Private-section entries (hosted shops, static hosts) are included
 * because on them every customer's subdomain is a separate site: foo.myshopify.com and
 * bar.myshopify.com must never resolve to the same merchant.
 *
 * This is a subset on purpose (no network fetch, no runtime dependency). The consequence of a
 * missing multi-label suffix is that its registrable domain is computed one label too short; merchant
 * domain rules are created only by staff (or held for staff review), and a rule on a public suffix
 * is refused, so a gap here cannot make an unrelated site resolve to a merchant by itself.
 * Update it from the PSL when a real merchant needs a suffix that is missing.
 */
const RULES = [
    // ICANN: second-level registries under country codes
    'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk', 'sch.uk',
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
    'co.nz', 'net.nz', 'org.nz', 'ac.nz', 'govt.nz',
    'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
    'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
    'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
    'com.mx', 'org.mx', 'net.mx', 'gob.mx', 'edu.mx',
    'com.ar', 'net.ar', 'org.ar', 'gob.ar',
    'com.co', 'net.co', 'org.co', 'gov.co',
    'com.pe', 'org.pe', 'net.pe',
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
    'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk',
    'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw',
    'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
    'com.my', 'net.my', 'org.my', 'edu.my', 'gov.my',
    'co.id', 'or.id', 'web.id', 'ac.id', 'go.id',
    'com.ph', 'net.ph', 'org.ph', 'gov.ph',
    'com.vn', 'net.vn', 'org.vn', 'gov.vn',
    'co.th', 'in.th', 'or.th', 'ac.th', 'go.th',
    'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'gov.in', 'edu.in',
    'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
    'com.ua', 'net.ua', 'org.ua', 'gov.ua',
    'com.pl', 'net.pl', 'org.pl',
    'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za',
    'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
    'com.sa', 'net.sa', 'org.sa', 'gov.sa',
    'com.eg', 'net.eg', 'org.eg', 'gov.eg',
    'co.ke', 'or.ke', 'ne.ke', 'go.ke',
    'com.ng', 'org.ng', 'net.ng', 'gov.ng',
    // ICANN wildcards and their exceptions
    '*.ck', '!www.ck',
    '*.bd', '*.er', '*.fk', '*.jm', '*.kh', '*.mm', '*.np', '*.pg',
    // Private section: platforms where each customer's subdomain is its own site
    'myshopify.com', 'bigcartel.com', 'wixsite.com',
    'github.io', 'gitlab.io', 'blogspot.com', 'herokuapp.com', 'netlify.app', 'vercel.app',
    'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net',
    'cloudfront.net',
];

const EXACT = new Set();
const WILDCARD = new Set();   // parent of a '*.' rule
const EXCEPTION = new Set();
for (const r of RULES) {
    if (r.startsWith('!')) EXCEPTION.add(r.slice(1));
    else if (r.startsWith('*.')) WILDCARD.add(r.slice(2));
    else EXACT.add(r);
}

/**
 * Number of labels of the public suffix of `host` (already normalized, labels joined by '.').
 * PSL algorithm: exceptions first, then the longest matching normal or wildcard rule, else 1.
 */
function suffixLabels(host) {
    const labels = host.split('.');
    let best = 1;
    for (let i = 0; i < labels.length; i++) {
        const candidate = labels.slice(i).join('.');
        const n = labels.length - i;
        if (EXCEPTION.has(candidate)) return n - 1;
        if (EXACT.has(candidate) && n > best) best = n;
        if (i > 0 && WILDCARD.has(candidate) && n + 1 > best) best = n + 1;
    }
    return best;
}

/** The public suffix of a normalized host (e.g. 'co.uk'). */
function publicSuffix(host) {
    const labels = host.split('.');
    return labels.slice(labels.length - Math.min(suffixLabels(host), labels.length)).join('.');
}

/** eTLD+1, or null when the host IS a public suffix (e.g. 'co.uk', 'myshopify.com'). */
function registrableDomain(host) {
    const labels = host.split('.');
    const n = suffixLabels(host);
    if (labels.length <= n) return null;
    return labels.slice(labels.length - n - 1).join('.');
}

module.exports = { RULES, publicSuffix, registrableDomain, suffixLabels };
