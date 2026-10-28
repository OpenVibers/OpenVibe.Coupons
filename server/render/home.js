'use strict';

/**
 * The front page (/): what OpenVibe.Coupons is for and a shop search, the site's numbers, then codes that end soon,
 * new codes, codes people reported working, the shops, the Companion, how codes are labelled and the questions people
 * ask. Every section is built from rows the page passes; one with nothing to show renders nothing.
 *
 * Wording rules (as in pages.js): a code is called working only from people's recent reports (its status label); an
 * expiry is shown only when someone stated it; a source's required attribution ("via DealNews") is on its codes.
 */
const ssr = require('openvibe-publishing/ssr');
const showcase = require('openvibe-shared/showcase');
const { STATUS_LABEL, shopsSection } = require('./pages');

const { html: h, raw } = ssr;
const count = (n) => Number(n).toLocaleString('en-US');

/** "in 5 hours" / "in 3 days" until a stated end. */
function until(iso, now) {
    const hrs = Math.max(0, (Date.parse(iso) - now) / 3600000);
    if (hrs < 1) return 'within the hour';
    if (hrs < 36) return `in ${Math.round(hrs)} hour${Math.round(hrs) === 1 ? '' : 's'}`;
    const d = Math.round(hrs / 24);
    return `in ${d} day${d === 1 ? '' : 's'}`;
}

/** One code as a ticket: the shop, the code to copy, what it is for, its end and its first restriction. */
function codeCard(v, m, now) {
    const min = (v.restrictions || []).find((r) => r.kind === 'min_spend');
    const rules = [min ? `Minimum spend ${min.amount}` : null, (v.restrictions || []).some((r) => r.kind === 'new_customers_only') ? 'New customers only' : null].filter(Boolean);
    return h`<li class="cp-card">
<p class="cp-top"><a class="cp-shop" href="/m/${m.slug}">${m.name}</a> <span class="status status-${v.status}">${STATUS_LABEL[v.status] || v.status}</span></p>
<p class="cp-code"><span class="sr-only">Code: </span><code class="code">${v.code}</code></p>
<h3><a href="/c/${v.id}">${v.title}</a></h3>
<p class="meta">${v.expiry.known ? h`Ends <time datetime="${v.expiry.expires_at}" title="${v.expiry.expires_at.slice(0, 16).replace('T', ' ')} UTC">${until(v.expiry.expires_at, now)}</time>` : h`<span class="unknown">No end date stated</span>`}${rules.length ? h` · ${rules.join(' · ')}` : ''}</p>
${v.attribution ? h`<p class="meta cp-via">via <a href="${v.attribution.url}" rel="nofollow noopener">${v.attribution.text}</a></p>` : ''}
</li>`;
}

function section({ id, title, lede, more, body }) {
    if (!body) return '';
    return h`<section class="cp-sec" aria-labelledby="${id}">
<div class="cp-head"><h2 id="${id}">${title}</h2>${more ? h`<a class="cp-more" href="${more.href}">${more.label}<span aria-hidden="true"> →</span></a>` : ''}</div>
${lede ? h`<p class="cp-lede">${lede}</p>` : ''}
${raw(String(body))}
</section>`;
}

const cards = (list, now) => (list.length ? h`<ol class="cp-cards">${list.map((x) => codeCard(x.view, x.merchant, now))}</ol>` : '');

/** The numbers beside the hero, each a link; zero counts are left out. */
function stats(items) {
    const shown = items.filter((x) => x.n > 0);
    if (!shown.length) return '';
    return h`<ul class="cp-stats" aria-label="OpenVibe.Coupons in numbers">${shown.map((x) => h`<li><a href="${x.href}"><b>${count(x.n)}</b><span>${x.label}</span></a></li>`)}</ul>`;
}

/** Questions people ask, answered from how the site works (also the page's FAQPage JSON-LD). */
function faqItems({ windowDays }) {
    return [
        { q: 'Do these codes work?', a: `Nobody can promise that, so OpenVibe.Coupons says what is known. A code is marked "Reported working" only when people who tried it in the last ${windowDays} days said it worked, and "Reported not working" when they said it did not. Every other code says "Validity unknown".` },
        { q: 'Where do the codes come from?', a: 'From people who submit a code with a link to where it was published, and from DealNews, whose deal feed names a code, the shop and often an end date. OpenVibe.Sources reads that feed every hour. Each code page links to its evidence.' },
        { q: 'How do I use a code?', a: 'Copy the code, open the shop, and paste it into the coupon or promo box at checkout. The code page lists any minimum spend or other rule that was stated, and how to apply it when someone wrote that down.' },
        { q: 'What does "No end date stated" mean?', a: 'Nobody stated when the code ends, so no date is shown. OpenVibe.Coupons never guesses one. A code with a stated end leaves the active list the moment it passes.' },
        { q: 'Does the browser extension change referral links?', a: 'No. The OpenVibe Companion never rewrites links, never adds referral tags and never earns from your shopping, so the creator or site that sent you keeps its credit. Codes from DealNews stay on this site, because DealNews\' terms keep them out of browser extensions.' },
        { q: 'Can I add a code?', a: 'Yes. Sign in with your free OpenVibe account and submit it with a link to where it was published. It starts as "Validity unknown" until people report on it.' },
    ];
}

function faqJsonLd(items) {
    return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) };
}

/**
 * d: { now, stats: { active, shops, dated, ending, added, working, reports }, ending, recent, working: [{ view, merchant }],
 *      merchants: [{ merchant, active }], total, faq, windowDays }
 */
function homePage(d) {
    const s = d.stats;
    const hero = h`<section class="sc-hero sc-split cp-hero"><div class="sc-hero-main">
<h1>Coupon codes,<span class="sc-accent"> honestly labelled</span></h1>
<p class="sc-hero-lede">Codes for online shops, each with the deal it is for, its end date when one is stated and what people reported when they tried it. A code is called working only when people said so recently.</p>
<form method="get" action="/" class="search cp-search" role="search"><label class="sr-only" for="q">Find a shop by name or domain</label><input id="q" name="q" type="search" maxlength="60" placeholder="Find a shop, like amazon.com"><button type="submit" class="primary">Search</button></form>
<div class="sc-actions"><a class="sc-btn sc-primary" href="#cp-new">See the newest codes</a><a class="sc-btn" href="/companion">Get the extension</a><a class="sc-btn" href="/submit">Submit a code</a></div>
</div>
<div class="sc-hero-aside">${stats([
        { n: s.active, label: 'active codes', href: '#cp-new' },
        { n: s.shops, label: 'shops with a code today', href: '#shops-h' },
        { n: s.ending, label: 'ending in the next 7 days', href: '#cp-ending' },
        { n: s.added, label: 'added in the last 7 days', href: '#cp-new' },
        { n: s.dated, label: 'with a stated end date', href: '/about#expiry' },
        { n: s.reports, label: `reports from people in ${d.windowDays} days`, href: '/about#confidence' },
    ])}</div></section>`;

    return h`${hero}
${s.active === 0 ? h`<p class="empty cp-empty">No codes are listed yet. <a href="/submit">Submit the first one</a>.</p>` : ''}
${section({ id: 'cp-working', title: 'Reported working', lede: `Codes people said worked when they tried them in the last ${d.windowDays} days, the most recent first.`, body: cards(d.working, d.now) })}
${section({ id: 'cp-ending', title: 'Ending soon', lede: 'Codes whose stated end is in the next seven days, soonest first.', body: cards(d.ending, d.now) })}
${section({ id: 'cp-new', title: 'New codes', lede: 'The latest codes added, newest first. Copy one and paste it at the shop\'s checkout.', more: { href: '/feed.xml', label: 'Follow new codes (RSS)' }, body: cards(d.recent, d.now) })}
${raw(String(shopsSection(d.merchants, d.total)))}
${raw(showcase.features({
        title: 'The OpenVibe Companion',
        lede: 'A free, open-source browser extension for Chrome, Edge, Brave and Firefox.',
        items: [
            { icon: 'ov:coupons', title: 'Codes where you shop', text: 'On a shop\'s site it lists the codes people submitted for that shop, with their rules and what people reported.', href: '/companion' },
            { icon: 'ov:check', title: 'Tried when you ask', text: 'At checkout one button types the codes into the shop\'s own coupon box and reads the total before and after.', href: '/companion' },
            { icon: 'ov:shield', title: 'No referral games', text: 'It never rewrites links or adds referral tags, so whoever sent you keeps the credit.', href: '/companion' },
        ],
    }))}
${raw(showcase.features({
        title: 'What every code tells you',
        items: [
            { icon: 'ov:coupons', title: 'The right shop', text: 'Each shop lists the domains and paths it covers, so a code is matched to the site you are on.' },
            { icon: 'ov:docs', title: 'Restrictions stated', text: 'Minimum spend, new customers only, the products it applies to: written down, not hidden.' },
            { icon: 'ov:history', title: 'Honest expiry', text: 'An end date when someone stated one, and "No end date stated" when nobody did.', href: '/about#expiry' },
            { icon: 'ov:community', title: 'Reports from people', text: 'Worked or did not work, recently: the status comes from what people said when they tried it.', href: '/about#statuses' },
        ],
    }))}
<section class="cp-sec" aria-labelledby="cp-faq"><div class="cp-head"><h2 id="cp-faq">Questions and answers</h2></div>
<div class="cp-faq">${d.faq.map((x) => h`<details><summary>${x.q}</summary><p>${x.a}</p></details>`)}</div></section>
${raw(showcase.network({ service: 'coupons' }))}
${raw(showcase.cta({ title: 'Have a code?', text: 'Share it with a link to where it was published. People report whether it works, and everyone sees what they said.', actions: [{ label: 'Submit a code', href: '/submit', primary: true }, { label: 'Find deals on OpenVibe.Deals', href: 'https://openvibe.deals/' }] }))}
<p class="meta"><a href="/about">How statuses and confidence work</a> · <a href="/feed.xml">RSS</a> · <a href="/atom.xml">Atom</a> · <a href="/feed.json">JSON Feed</a></p>`;
}

module.exports = { homePage, faqItems, faqJsonLd, codeCard };
