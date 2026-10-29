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
    policy: {
        auth: ['none', 'Network OIDC'],
    },
};
