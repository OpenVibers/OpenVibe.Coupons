'use strict';
// What openvibe.coupons tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: the bearer-token API, the pages that explain how codes
// are labelled, llms.txt and the sitemap.
module.exports = {
    id: 'coupons',
    name: 'OpenVibe.Coupons',
    purpose: 'Discount codes and vouchers, each with the shop it belongs to, the restrictions it carries and the date it ends, taken from people\'s reports and kept honest about what is known and what is not.',
    home: 'https://openvibe.coupons',
    site: 'openvibe.coupons',
    api: '/api/v1',
    docs: '/about',
    openapi: '/openapi.json',
    policy: {
        auth: ['none', 'Network OIDC'],
        // What an id in a page's address is, and that it never changes meaning (AGT-4): server/domain/coupons.js mints
        // the code ids, and server/http/public.js answers a taken-down code or shop with 410.
        stableIds: [
            { kind: 'code', url: 'https://openvibe.coupons/c/{id}', id: 'cpn_ and a ULID, minted once when the code is first reported: never reused, since a code is taken down but never deleted', gone: 'a code taken down answers 410; an id that never existed answers 404' },
            { kind: 'shop', url: 'https://openvibe.coupons/m/{slug}', id: 'the shop\'s slug', gone: 'a shop no longer listed answers 410' },
        ],
    },
};
