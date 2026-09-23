'use strict';

/**
 * Extension install tokens — the only credential the OpenVibe browser helper ever holds.
 *
 *   cpx_<43 base64url chars>   256 random bits; shown ONCE on /connect-extension; stored as sha256
 *
 * A signed-in person creates one per browser, with the scopes they choose (coupons.lookup is
 * always included; coupons.report is optional). A token is:
 *   - scoped: it can look up codes and (optionally) report worked/failed — nothing else. It is not
 *     a Network session and is refused everywhere a Network token is expected;
 *   - revocable: revoked_at is checked on every request (no cache), so revocation is immediate;
 *   - expiring: COUPONS_INSTALL_TTL_DAYS (365) after creation.
 * Revoking or expiring a token never deletes the reports made with it (they are the person's).
 */
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const { ApiError } = require('../http/errors');
const { SCOPES, ALL_SCOPES } = require('../auth/capabilities');

const TOKEN_RE = /^cpx_[A-Za-z0-9_-]{43}$/;
const DAY = 24 * 60 * 60 * 1000;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function createInstalls({ store, config }) {
    const { db } = store;
    const q = {
        insert: db.prepare(`INSERT INTO extension_installs (id, subject, token_hash, token_hint, label, scopes, created_at, expires_at)
                            VALUES (@id, @subject, @token_hash, @token_hint, @label, @scopes, @created_at, @expires_at)`),
        byHash: db.prepare('SELECT * FROM extension_installs WHERE token_hash = ?'),
        byId: db.prepare('SELECT * FROM extension_installs WHERE id = ?'),
        mine: db.prepare('SELECT * FROM extension_installs WHERE subject = ? ORDER BY created_at DESC LIMIT 50'),
        activeCount: db.prepare('SELECT COUNT(*) AS n FROM extension_installs WHERE subject = ? AND revoked_at IS NULL AND expires_at > ?'),
        revoke: db.prepare('UPDATE extension_installs SET revoked_at = ? WHERE id = ? AND subject = ? AND revoked_at IS NULL'),
        touch: db.prepare('UPDATE extension_installs SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)'),
    };

    const view = (row) => ({
        id: row.id,
        label: row.label,
        token_hint: row.token_hint,
        scopes: JSON.parse(row.scopes),
        created_at: new Date(row.created_at).toISOString(),
        expires_at: new Date(row.expires_at).toISOString(),
        last_used_at: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
        revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
        active: !row.revoked_at && row.expires_at > store.now(),
    });

    return {
        TOKEN_RE,
        view,

        /** → { install (view), token } — the token exists only in this return value. */
        create(subject, { label, scopes } = {}) {
            if (!ids.isSubjectId('user', subject)) throw new ApiError(403, 'auth.person_required', 'only a signed-in person can connect an extension');
            const name = String(label == null ? '' : label).trim().slice(0, 60) || 'Browser helper';
            const wanted = new Set(Array.isArray(scopes) ? scopes : scopes ? [scopes] : []);
            for (const s of wanted) if (!ALL_SCOPES.includes(s)) throw new ApiError(422, 'install.bad_scope', `unknown scope ${s}`);
            wanted.add(SCOPES.LOOKUP);
            const now = store.now();
            if (q.activeCount.get(subject, now).n >= config.limits.installsPerSubject) {
                throw new ApiError(409, 'install.limit', `at most ${config.limits.installsPerSubject} connected extensions; revoke one first`);
            }
            const token = `cpx_${crypto.randomBytes(32).toString('base64url')}`;
            const row = {
                id: `cpi_${ids.ulid(now)}`, subject, token_hash: hashToken(token), token_hint: token.slice(0, 10),
                label: name, scopes: JSON.stringify(ALL_SCOPES.filter((s) => wanted.has(s))),
                created_at: now, expires_at: now + config.installTtlDays * DAY,
            };
            q.insert.run(row);
            return { install: view(q.byId.get(row.id)), token };
        },

        list(subject) { return q.mine.all(subject).map(view); },

        /** Revoke one of `subject`'s installs. → true when it was active. */
        revoke(subject, id) { return q.revoke.run(store.now(), String(id), subject).changes === 1; },

        /**
         * Verify a presented token. → { install, subject, scopes } or throws 401 (malformed, unknown,
         * revoked, expired). Reads the row every time: revocation takes effect on the next request.
         */
        verify(token) {
            if (!TOKEN_RE.test(String(token))) throw new ApiError(401, 'token.invalid', 'malformed extension token');
            const row = q.byHash.get(hashToken(token));
            if (!row) throw new ApiError(401, 'token.invalid', 'unknown extension token');
            const now = store.now();
            if (row.revoked_at) throw new ApiError(401, 'token.revoked', 'this extension was disconnected; connect it again on openvibe.coupons');
            if (row.expires_at <= now) throw new ApiError(401, 'token.expired', 'this extension token expired; connect it again on openvibe.coupons');
            q.touch.run(now, row.id, now - 60 * 1000);
            return { install: row.id, subject: row.subject, scopes: JSON.parse(row.scopes) };
        },
    };
}

module.exports = { createInstalls, hashToken, TOKEN_RE };
