'use strict';

/**
 * Inbound event webhook (OpenVibe.Events → Coupons): a signed POST /internal/events endpoint that
 * receives deliveries from OpenVibe.Events and acts on them. The shared half — signature verification,
 * exactly-once through the inbox — is openvibe-publishing/ingest createEventConsumer. What stays here
 * is the coupons policy: which event types trigger what.
 *
 *   sources.item.created   a new Sources item was published; run the importer to pick it up
 *   other sources.*        acknowledged (the cursor will catch it on the next scheduled run)
 *
 * Mounted before sign-in and body-parser (server/app.js): the route reads its own raw body for the
 * HMAC and never touches cookies, sessions or the JSON parser.
 */
const { createEventConsumer } = require('openvibe-publishing/ingest');

function createWebhookRouter(express, { config, store, importer, log = console }) {
    const consumer = createEventConsumer({
        db: store.db,
        secrets: config.events.webhookSecrets,
        consumer: 'coupons-sources',
    });
    // Ensure the idempotency_receipts table exists (the inbox needs it for exactly-once).
    consumer.inbox.ensureSchema().catch((err) => log.warn('[Coupons] inbox schema:', err.message));

    const router = express.Router();

    // Raw body for signature verification; never parsed by the shared JSON body-parser.
    router.post('/internal/events', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
        const r = await consumer.apply(req.body, req.headers, async (event) => {
            const type = event && event.event_type;
            if (type === 'sources.item.created') {
                try {
                    const result = await importer.run();
                    return result.error ? `error:${result.error}` : 'imported';
                } catch (err) {
                    return `error:${err.message}`;
                }
            }
            if (type && typeof type === 'string' && type.startsWith('sources.')) {
                return 'ack';
            }
            return null;
        });

        if (r.status === 503) return res.status(404).end();
        if (r.status === 401) return res.status(401).end();
        if (r.status === 400) return res.status(400).end();
        return res.status(200).json({ accepted: true, duplicate: !!r.duplicate, outcome: r.outcome || null });
    });

    return router;
}

module.exports = { createWebhookRouter };
