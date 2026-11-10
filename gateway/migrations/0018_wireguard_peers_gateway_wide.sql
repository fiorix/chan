-- One WireGuard peer per public key, with one address set unique across the
-- gateway. Every ingress host lists every peer, so a peer belongs to no host,
-- and a key or an address held on two hosts is a duplicate.

-- The three per-host unique constraints go with the column. The migration
-- runs in one transaction, so this statement's lock keeps enrollments out
-- until the new constraints exist.
ALTER TABLE wireguard_peers DROP COLUMN host;

-- A row goes when a later enrollment holds its key or one of its addresses,
-- whether or not that later row itself stays: a key keeps at most its latest
-- enrollment, the one its desktop holds, and the outcome does not depend on
-- the order rows are visited in. The id breaks a tie in updated_at, so one row
-- of a tied pair still goes. A NULL address_v6 equals nothing and is never a
-- duplicate. A desktop whose row goes enrolls again at its next sign-in.
--
-- Each column is its own join on equality, which the planner can hash. The
-- indexes on these columns went with the per-host constraints, and one join on
-- the three equalities under OR would compare every pair of rows while the
-- table is locked. The three joins read the table as it stood before the
-- statement, and a row that more than one of them finds is deleted once.
--
-- Each deleted enrollment gets the audit row the sweeper writes when it
-- releases a peer, so the trail of a token whose tunnel stops does not end at
-- wireguard_enrolled. The migrator applies this file and records the version
-- in one transaction, so these rows carry the installed_on of version 18 in
-- _sqlx_migrations as their ts, which tells them from a sweep's.
WITH released AS (
    DELETE FROM wireguard_peers
    WHERE id IN (
        SELECT older.id
        FROM wireguard_peers older
        JOIN wireguard_peers newer
          ON newer.public_key = older.public_key
         AND (newer.updated_at, newer.id) > (older.updated_at, older.id)
        UNION ALL
        SELECT older.id
        FROM wireguard_peers older
        JOIN wireguard_peers newer
          ON newer.address_v4 = older.address_v4
         AND (newer.updated_at, newer.id) > (older.updated_at, older.id)
        UNION ALL
        SELECT older.id
        FROM wireguard_peers older
        JOIN wireguard_peers newer
          ON newer.address_v6 = older.address_v6
         AND (newer.updated_at, newer.id) > (older.updated_at, older.id)
    )
    RETURNING token_id
)
INSERT INTO api_token_audit (token_id, action)
SELECT token_id, 'wireguard_released' FROM released;

ALTER TABLE wireguard_peers
    ADD UNIQUE (public_key),
    ADD UNIQUE (address_v4),
    ADD UNIQUE (address_v6);
