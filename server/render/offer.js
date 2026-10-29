'use strict';

/**
 * The Product and Offer a code's own page carries — only what the page shows.
 *
 * The owner rule: public structured data may claim only what the page itself shows. So a code's page
 * carries a Product/Offer only when it shows a price or an amount off with a currency:
 *   - the price is the money the page's headline shows (an amount off, or a product's price), as a number;
 *     a percentage ("20% off"), free shipping or a plain code is not a price, and such a page carries
 *     no Product/Offer at all
 *   - the currency is the ISO 4217 code the code states, and the page shows it beside the amount
 *   - availability comes from the page's own state: in stock while the code is in date and in active
 *     results, sold out once the page says it expired
 *   - the url is the page's canonical
 * A rating is never invented: a code's page shows no rating and no review count, so it claims none.
 */
const pages = require('./pages');

const AVAILABILITY = { in_stock: 'https://schema.org/InStock', sold_out: 'https://schema.org/SoldOut' };

/**
 * The Product/Offer for a code's page, or null when the page shows no price with a currency.
 * v: the code's public view; merchant: { name, url } (the shop the page shows); now: the site's clock.
 */
function productOf(v, { merchant = null, now = Date.now() } = {}) {
    const money = pages.moneyOf(v);
    const currency = pages.currencyOf(v, money);
    if (!money || !currency) return null;
    const expired = v.status === 'expired'
        || (v.expiry && v.expiry.known && v.expiry.expires_at && Date.parse(v.expiry.expires_at) <= now);
    const availability = expired ? AVAILABILITY.sold_out : (v.active ? AVAILABILITY.in_stock : null);
    const offer = {
        '@type': 'Offer',
        price: money.amount,
        priceCurrency: currency,
        url: v.url,
        ...(availability ? { availability } : {}),
        // The expiry the page states, when it states one.
        ...(v.expiry && v.expiry.known ? { validThrough: v.expiry.expires_at } : {}),
        ...(merchant ? { seller: { '@type': 'Organization', name: merchant.name, url: merchant.url } } : {}),
    };
    return {
        '@type': 'Product',
        name: v.title,
        url: v.url,
        ...(v.description ? { description: v.description } : {}),
        offers: [offer],
    };
}

module.exports = { productOf };
