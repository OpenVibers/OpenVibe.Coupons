'use strict';
// The shop page's reading of a code (server/render/pages.js): which codes are for one product (Product deals) and the
// headline a person scans for, from the code's own title and description; and which tab opens first.
const assert = require('assert');
const pages = require('../server/render/pages');

const v = (title, description = '') => ({ title, description });
const cases = [
    ['Mosiech 7-Piece Ceramic Nonstick Cookware Set for From $46 + free shipping', true, '$46'],
    ['Andusic Aroma Diffuser for $24 + free shipping w/ Prime', true, '$24'],
    ['Shoes for only $19.99', true, '$19.99'],
    ['20% off sitewide', false, '20% off'],
    ['$15 off orders of $75+', false, '$15 off'],
    ['Free shipping on orders over $60', false, 'Free shipping'],
    ['Welcome offer', false, 'Code'],
];
cases.forEach(([title, deal, head]) => {
    assert.strictEqual(pages.isProductDeal(v(title)), deal, `deal: ${title}`);
    assert.strictEqual(pages.headline(v(title)), head, `headline: ${title}`);
});
assert.strictEqual(pages.headline(v('Air monitor for $35', "it's $35 (50%) off the list price")), '50% off', 'a percent in the description wins over the price');
const active = [v('Desk for $99'), v('Lamp for $20')];
assert.strictEqual(pages.shopTab({}, active), 'deals', 'only product deals: they open first');
assert.strictEqual(pages.shopTab({}, [...active, v('10% off everything')]), 'codes', 'a code for the shop: Codes opens');
assert.strictEqual(pages.shopTab({ tab: 'about' }, active), 'about');
assert.strictEqual(pages.shopTab({ tab: 'nope' }, []), 'codes', 'an unknown tab, nothing active: Codes');
console.log('shop page: product deals, headlines and the first tab ok');
