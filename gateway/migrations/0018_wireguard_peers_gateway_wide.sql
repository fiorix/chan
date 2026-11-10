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
DELETE FROM wireguard_peers older
USING wireguard_peers newer
WHERE (newer.updated_at, newer.id) > (older.updated_at, older.id)
  AND (newer.public_key = older.public_key
       OR newer.address_v4 = older.address_v4
       OR newer.address_v6 = older.address_v6);

ALTER TABLE wireguard_peers
    ADD UNIQUE (public_key),
    ADD UNIQUE (address_v4),
    ADD UNIQUE (address_v6);
