-- ---------------------------------------------------------------------------
-- field-ops-offline-sync — demo data.
--
-- Everything here is invented. The people, the sites and the assets do not
-- exist; the e-mail addresses are on example.com, which is reserved by RFC 2606
-- exactly so that sample data cannot reach a real inbox.
--
-- Demo passwords (bcrypt, cost 12 — they are in a public repository on
-- purpose, and must never be reused anywhere):
--
--   john@example.com   technician123   role: technician
--   jane@example.com   supervisor123   role: supervisor
--   dana@example.com   admin123        role: admin
--
-- Run after schema.sql:
--   mysql -u root -p field_ops < api/database/schema.sql
--   mysql -u root -p field_ops < api/database/seed_demo.sql
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4;

INSERT INTO users (id, name, email, password_hash, role, is_active) VALUES
    (1, 'John Smith',  'john@example.com', '$2y$12$tCv2oj.TB8oHGbXXIqXbZObk/qBxL34s6XHK2Q9GlChWSeTDQuLrK', 'technician', 1),
    (2, 'Jane Doe',    'jane@example.com', '$2y$12$fvk8qzlPlAXG9J95HMuhsuxcEEmB459eZ7lKu/FW4ZWlXtvanK.eC', 'supervisor', 1),
    (3, 'Dana Wright', 'dana@example.com', '$2y$12$vfQ9U6u72IpRdMrryxjjbePZMIytBgzLGITdcxpq4bLOHYZxcgYmy', 'admin',      1);

INSERT INTO sites (id, code, name, address) VALUES
    (1, 'SITE-001', 'North Yard',       '18 Marsh Lane, Springfield'),
    (2, 'SITE-002', 'Riverside Depot',  '4 Canal Road, Springfield'),
    (3, 'SITE-003', 'West Substation',  'Kilometre 12, Old Mill Road');

INSERT INTO assets (id, site_id, code, name, category, status, installed_on) VALUES
    (1, 1, 'AST-1001', 'Pump Station 3',      'pump',        'operational',    '2021-03-14'),
    (2, 1, 'AST-1002', 'Backup Generator A',  'generator',   'operational',    '2019-11-02'),
    (3, 1, 'AST-1003', 'Storage Tank 7',      'tank',        'degraded',       '2017-06-21'),
    (4, 2, 'AST-2001', 'Loading Dock Hoist',  'hoist',       'operational',    '2022-08-30'),
    (5, 2, 'AST-2002', 'Air Compressor 2',    'compressor',  'out_of_service', '2016-01-19'),
    (6, 3, 'AST-3001', 'Transformer T1',      'transformer', 'operational',    '2020-05-05'),
    (7, 3, 'AST-3002', 'Switchgear Panel B',  'switchgear',  'operational',    '2020-05-05');

-- Two inspections that already reached the server, so a fresh install has
-- something to display before the technician records anything. The client_uuid
-- values are fixed here only to keep the seed reproducible; in real use they
-- are generated on the handset.
INSERT INTO inspections
    (id, client_uuid, asset_id, user_id, checklist_result, reading_value, reading_unit,
     notes, performed_at, status, photo_count)
VALUES
    (1, '3f1c9d70-1a4e-4a2b-9c31-1b0f5a7d2e11', 1, 1, 'pass', 4.200, 'bar',
     'Seals dry, no vibration at the coupling.', '2026-08-18 07:42:11.000', 'submitted', 0),
    (2, '8b7a2c14-55d9-4f60-8a03-6d2e9f4c1a22', 3, 1, 'attention', 61.500, 'pct',
     'Level below the usual range for this time of month.', '2026-08-19 09:05:47.000', 'submitted', 0);
