'use strict';
/**
 * Account export and deletion → Coupons (ADR-033; openvibe-sdk/account-data).
 *
 * A person's own rows are the merchants they watch (coupon_watches) and the browser-extension installs they made
 * (extension_installs: the label, scopes and dates, never the token hash). Both are exported and deleted with them.
 *
 * The catalogue stays: a coupon, a merchant, its domains and an application hint are community records; their
 * created_by becomes NULL on deletion (anonymize), because the catalogue's value is the code, not who added it.
 * coupons_index_revisions.owner is the index document's owning service, not a person.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const anonymize = { anonymize: {} };

const TABLES = [
    { table: 'coupon_watches', subject: 'subject', file: 'watched-merchants.json', columns: ['merchant_id', 'created_at'], order: 'created_at' },
    { table: 'extension_installs', subject: 'subject', file: 'extension-installs.json', order: 'created_at',
        columns: ['label', 'token_hint', 'scopes', 'created_at', 'expires_at', 'last_used_at', 'revoked_at'] },
    // The catalogue stays, without its contributor.
    { table: 'coupons', subject: 'created_by', file: null, erase: anonymize },
    { table: 'coupon_merchants', subject: 'created_by', file: null, erase: anonymize },
    { table: 'coupon_merchant_domains', subject: 'created_by', file: null, erase: anonymize },
    { table: 'coupon_application_hints', subject: 'created_by', file: null, erase: anonymize },
    // The provenance of a coupon stays (where the code was published); the person who submitted it is erased from it.
    { table: 'coupon_sources', subject: 'submitted_by', file: null, erase: anonymize },
];

function create({ db, log = console } = {}) {
    return createAccountData({ db, service: 'coupons', tables: TABLES, log });
}

module.exports = { create, TABLES, TOPICS };
