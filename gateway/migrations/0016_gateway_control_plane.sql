CREATE TABLE devserver_user_policies (
    user_id                  uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled                  boolean NOT NULL,
    max_connected_devservers integer NOT NULL
                             CHECK (max_connected_devservers > 0),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devserver_fleet_policy (
    singleton          boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    admissions_enabled boolean NOT NULL,
    updated_at         timestamptz NOT NULL DEFAULT now()
);

INSERT INTO devserver_fleet_policy (singleton, admissions_enabled)
VALUES (true, true);

CREATE TABLE identity_session_index (
    admin_session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    store_id         text NOT NULL UNIQUE,
    authenticated_at timestamptz NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX identity_session_index_user_idx
    ON identity_session_index (user_id, authenticated_at DESC);
