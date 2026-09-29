-- phase: expand
-- OpenVibe.Coupons on the openvibe-publishing/ingest chassis (plan T9): the Sources importer's change
-- cursor moves from import_state to the chassis' <prefix>_ingest_cursor (lib/ingest.js schema()).
-- The old cursor (import_state key 'sources:coupons') is copied once here, never reset to zero.

CREATE TABLE IF NOT EXISTS coupons_ingest_cursor (
    name       text COLLATE "C" NOT NULL,
    cursor     bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (name)
);

INSERT INTO coupons_ingest_cursor (name, cursor, updated_at)
SELECT 'sources', cursor, COALESCE(last_ok_at, last_run_at, 0)
FROM import_state
WHERE key = 'sources:coupons'
ON CONFLICT (name) DO NOTHING;
