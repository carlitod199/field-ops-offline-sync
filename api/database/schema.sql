-- ---------------------------------------------------------------------------
-- field-ops-offline-sync — schema (MySQL 8.0+)
--
-- Conventions used throughout:
--
--   * DATETIME(3), never TIMESTAMP. The whole system stores UTC and the PDO
--     connection pins `time_zone = '+00:00'`; TIMESTAMP's implicit session
--     conversion would move delta cursors by hours whenever a connection came
--     up with a different time zone.
--
--   * Millisecond precision. The delta cursor is a timestamp comparison, so
--     resolution is the granularity at which two writes can be distinguished.
--     Second precision would put far more rows into the same tie group.
--
--   * `updated_at ... ON UPDATE CURRENT_TIMESTAMP(3)` on every synchronised
--     table. Rows in `sites` and `assets` are maintained by back-office tools
--     that are not part of this repository; the column has to move on its own,
--     or those edits never reach a handset. Note that MySQL stamps this value
--     when the statement runs, not when the transaction commits — which is
--     exactly the race the cursor overlap in routes/sync.php compensates for.
--
--   * Soft deletes (`deleted_at`). A row that is hard-deleted leaves nothing
--     behind for a delta to report, so every device that already cached it
--     keeps it forever. Soft deletion turns a removal into an update, which
--     the delta already knows how to deliver as a tombstone.
--
--   * Index `(updated_at, id)` on every synchronised table: it is the exact
--     ordering `/sync/pull` reads in, so paging is an index range scan rather
--     than a filesort over the whole table.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- Accounts and sessions
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    name            VARCHAR(120)    NOT NULL,
    email           VARCHAR(190)    NOT NULL,
    -- bcrypt, cost 12. Never any other algorithm, never a plain digest.
    password_hash   CHAR(60)        NOT NULL,
    role            ENUM('technician', 'supervisor', 'admin') NOT NULL DEFAULT 'technician',
    is_active       TINYINT(1)      NOT NULL DEFAULT 1,
    last_login_at   DATETIME(3)     NULL DEFAULT NULL,
    created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    -- Login looks accounts up by e-mail; the unique index is both the lookup
    -- path and the guarantee that the lookup returns at most one row.
    UNIQUE KEY uq_users_email (email)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE auth_tokens (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id         INT UNSIGNED    NOT NULL,
    -- SHA-256 of the opaque bearer token. The plaintext is returned once, at
    -- login, and never stored.
    token_hash      CHAR(64)        NOT NULL,
    device_label    VARCHAR(120)    NOT NULL DEFAULT 'unknown device',
    created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    expires_at      DATETIME(3)     NOT NULL,
    last_used_at    DATETIME(3)     NULL DEFAULT NULL,
    revoked_at      DATETIME(3)     NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_auth_tokens_hash (token_hash),
    KEY ix_auth_tokens_user (user_id, revoked_at),
    CONSTRAINT fk_auth_tokens_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- Login throttling. Rows are counted per (email, ip) inside a rolling window.
-- There is no cleanup job in this repository; see NOTES.md, "Not implemented".
CREATE TABLE login_attempts (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    email           VARCHAR(190)    NOT NULL,
    ip_address      VARCHAR(45)     NOT NULL,
    succeeded       TINYINT(1)      NOT NULL DEFAULT 0,
    created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY ix_login_attempts_window (email, ip_address, created_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Domain
-- ---------------------------------------------------------------------------

CREATE TABLE sites (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    code            VARCHAR(30)     NOT NULL,
    name            VARCHAR(150)    NOT NULL,
    address         VARCHAR(255)    NULL DEFAULT NULL,
    created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    deleted_at      DATETIME(3)     NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_sites_code (code),
    KEY ix_sites_delta (updated_at, id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE assets (
    id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    site_id         INT UNSIGNED    NOT NULL,
    code            VARCHAR(30)     NOT NULL,
    name            VARCHAR(150)    NOT NULL,
    category        VARCHAR(60)     NOT NULL DEFAULT 'general',
    status          ENUM('operational', 'degraded', 'out_of_service') NOT NULL DEFAULT 'operational',
    installed_on    DATE            NULL DEFAULT NULL,
    created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    deleted_at      DATETIME(3)     NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_assets_code (code),
    KEY ix_assets_site (site_id),
    KEY ix_assets_delta (updated_at, id),
    CONSTRAINT fk_assets_site FOREIGN KEY (site_id) REFERENCES sites (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE inspections (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    -- Assigned on the handset the moment the technician saves the form,
    -- possibly days before the server sees it. This is the record's identity
    -- across the offline boundary, and the UNIQUE index below is what makes a
    -- replayed push impossible to double-insert even if the ledger were
    -- bypassed.
    client_uuid         CHAR(36)        NOT NULL,
    asset_id            INT UNSIGNED    NOT NULL,
    user_id             INT UNSIGNED    NOT NULL,
    checklist_result    ENUM('pass', 'attention', 'fail') NOT NULL,
    reading_value       DECIMAL(12, 3)  NULL DEFAULT NULL,
    reading_unit        VARCHAR(20)     NULL DEFAULT NULL,
    notes               VARCHAR(2000)   NULL DEFAULT NULL,
    -- When the technician performed the inspection (handset clock, often well
    -- before it reached the server). Distinct from created_at, which is when
    -- the server received it. Both are needed: one is the operational fact,
    -- the other is the audit trail.
    performed_at        DATETIME(3)     NOT NULL,
    status              ENUM('submitted', 'reviewed') NOT NULL DEFAULT 'submitted',
    reviewed_by         INT UNSIGNED    NULL DEFAULT NULL,
    reviewed_at         DATETIME(3)     NULL DEFAULT NULL,
    photo_count         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    deleted_at          DATETIME(3)     NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_inspections_client_uuid (client_uuid),
    KEY ix_inspections_asset (asset_id, performed_at),
    -- Technicians pull only their own inspections; this index serves that
    -- scoped delta scan.
    KEY ix_inspections_user_delta (user_id, updated_at, id),
    KEY ix_inspections_delta (updated_at, id),
    CONSTRAINT fk_inspections_asset FOREIGN KEY (asset_id) REFERENCES assets (id),
    CONSTRAINT fk_inspections_user FOREIGN KEY (user_id) REFERENCES users (id),
    CONSTRAINT fk_inspections_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE inspection_photos (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    inspection_id   BIGINT UNSIGNED NOT NULL,
    client_uuid     CHAR(36)        NOT NULL,
    -- Display only. The path below is generated server-side and never derived
    -- from this value.
    original_name   VARCHAR(200)    NOT NULL,
    -- Relative to UPLOAD_DIR, e.g. '2026/08/9f3c....jpg'.
    stored_path     VARCHAR(255)    NOT NULL,
    mime_type       VARCHAR(60)     NOT NULL,
    byte_size       INT UNSIGNED    NOT NULL,
    width_px        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    height_px       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    -- Content hash of the stored bytes: lets an operator verify a file on disk
    -- against the record without opening it.
    sha256          CHAR(64)        NOT NULL,
    captured_at     DATETIME(3)     NOT NULL,
    created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_inspection_photos_client_uuid (client_uuid),
    KEY ix_inspection_photos_parent (inspection_id),
    CONSTRAINT fk_inspection_photos_inspection
        FOREIGN KEY (inspection_id) REFERENCES inspections (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Idempotency ledger
--
-- One row per queued operation the server has ever applied. The row is written
-- in the same transaction as the domain change, so the pair is atomic: there
-- is no instant at which an inspection exists without its ledger entry, and
-- therefore no window in which a retry could insert a second copy.
--
-- `result_json` stores the exact response body that was produced the first
-- time, so a replay is answered identically instead of being recomputed.
-- ---------------------------------------------------------------------------
CREATE TABLE sync_operations (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    client_uuid     CHAR(36)        NOT NULL,
    user_id         INT UNSIGNED    NOT NULL,
    operation       VARCHAR(40)     NOT NULL,
    entity_type     VARCHAR(40)     NULL DEFAULT NULL,
    entity_id       BIGINT UNSIGNED NULL DEFAULT NULL,
    result_json     JSON            NULL DEFAULT NULL,
    created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    -- The whole mechanism rests on this index. Two concurrent replays of the
    -- same batch both try to insert here; one wins, the other reads the
    -- winner's row.
    UNIQUE KEY uq_sync_operations_client_uuid (client_uuid),
    KEY ix_sync_operations_user (user_id, created_at),
    CONSTRAINT fk_sync_operations_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
