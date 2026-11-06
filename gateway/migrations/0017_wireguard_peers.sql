CREATE TABLE wireguard_peers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_id    uuid NOT NULL UNIQUE REFERENCES api_tokens(id) ON DELETE CASCADE,
    host        text NOT NULL,
    public_key  text NOT NULL,
    address_v4  text NOT NULL,
    address_v6  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (host, public_key),
    UNIQUE (host, address_v4),
    UNIQUE (host, address_v6)
);
CREATE INDEX wireguard_peers_user_idx ON wireguard_peers (user_id);
