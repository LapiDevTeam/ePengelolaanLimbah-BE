-- Waste Management System Initial Schema (v2 - User Snapshotting)
-- Database: PostgreSQL

-- =============================================================================
-- CUSTOM ENUM TYPES
-- =============================================================================
CREATE TYPE bentuk_limbah_enum AS ENUM ('Padat', 'Cair');
CREATE TYPE approval_status_enum AS ENUM ('Approved', 'Rejected');
CREATE TYPE audit_action_type_enum AS ENUM ('UPDATE', 'ADD_ITEM', 'REMOVE_ITEM');
CREATE TYPE request_status_enum as ENUM ('Draft', 'InProgress', 'Completed', 'Rejected');

-- =============================================================================
-- LOOKUP TABLES
-- =============================================================================
CREATE TABLE golongan_limbah (
    category_id SERIAL PRIMARY KEY,
    nama TEXT NOT NULL UNIQUE
);

CREATE TABLE jenis_limbah_b3 (
    type_id SERIAL PRIMARY KEY,
    nama TEXT NOT NULL UNIQUE
);

-- =============================================================================
-- APPROVAL WORKFLOW ENGINE
-- =============================================================================
CREATE TABLE approval_workflows (
    approval_workflow_id SERIAL PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE approval_workflow_steps (
    step_id SERIAL PRIMARY KEY,
    approval_workflow_id INTEGER NOT NULL REFERENCES approval_workflows(approval_workflow_id) ON DELETE RESTRICT,
    step_level INTEGER NOT NULL,
    step_name TEXT NOT NULL,
    required_approvals INTEGER NOT NULL DEFAULT 1,
    UNIQUE (approval_workflow_id, step_level)
);

CREATE TABLE approval_workflow_approvers (
    approver_config_id SERIAL PRIMARY KEY,
    step_id INTEGER NOT NULL REFERENCES approval_workflow_steps(step_id) ON DELETE CASCADE,
    approver_id TEXT NOT NULL,
    approver_name TEXT,
    approver_cc TEXT,
    approver_dept_id TEXT,
    approver_identity TEXT
);

-- =============================================================================
-- SIGNING WORKFLOW ENGINE
-- =============================================================================
CREATE TABLE signing_workflows (
    signing_workflow_id SERIAL PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE signing_workflow_steps (
    step_id SERIAL PRIMARY KEY,
    signing_workflow_id INTEGER NOT NULL REFERENCES signing_workflows(signing_workflow_id) ON DELETE RESTRICT,
    step_level INTEGER NOT NULL,
    step_name TEXT NOT NULL,
    required_signatures INTEGER NOT NULL DEFAULT 1,
    UNIQUE (signing_workflow_id, step_level)
);

CREATE TABLE signing_workflow_signers (
    signer_config_id SERIAL PRIMARY KEY,
    step_id INTEGER NOT NULL REFERENCES signing_workflow_steps(step_id) ON DELETE CASCADE,
    log_nik TEXT NOT NULL,
    peran TEXT NOT NULL
);

-- =============================================================================
-- BERITA ACARA (EVENT)
-- =============================================================================
CREATE TABLE berita_acara (
    berita_acara_id SERIAL PRIMARY KEY,
    bagian TEXT NOT NULL,
    tanggal DATE NOT NULL,
    waktu TIMESTAMPTZ NOT NULL,
    lokasi_verifikasi TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    creator_id TEXT NOT NULL,
    creator_id_delegated TEXT,
    signing_workflow_id INTEGER NOT NULL REFERENCES signing_workflows(signing_workflow_id) ON DELETE RESTRICT,
    current_signing_step_id INTEGER REFERENCES signing_workflow_steps(step_id) ON DELETE RESTRICT,
    creator_name TEXT,
    creator_jabatan TEXT,
    creator_dept_id TEXT,
    creator_job_level_id TEXT,
    creator_name_delegated TEXT,
    creator_jabatan_delegated TEXT,
    creator_dept_id_delegated TEXT,
    creator_job_level_id_delegated TEXT
);

-- =============================================================================
-- CORE REQUEST
-- =============================================================================
CREATE TABLE permohonan_pemusnahan_limbah (
    request_id SERIAL PRIMARY KEY,
    nomor_permohonan TEXT UNIQUE,
    bagian TEXT NOT NULL,
    bentuk_limbah bentuk_limbah_enum NOT NULL,
    status request_status_enum NOT NULL DEFAULT 'Draft',
    alasan_penolakan TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    requester_id TEXT NOT NULL,
    requester_id_delegated TEXT,
    golongan_limbah_id INTEGER NOT NULL REFERENCES golongan_limbah(category_id) ON DELETE RESTRICT,
    jenis_limbah_b3_id INTEGER NOT NULL REFERENCES jenis_limbah_b3(type_id) ON DELETE RESTRICT,
    jumlah_item INTEGER NOT NULL DEFAULT 0,
    approval_workflow_id INTEGER NOT NULL REFERENCES approval_workflows(approval_workflow_id) ON DELETE RESTRICT,
    current_step_id INTEGER REFERENCES approval_workflow_steps(step_id) ON DELETE RESTRICT,
    berita_acara_id INTEGER REFERENCES berita_acara(berita_acara_id) ON DELETE SET NULL,
    requester_name TEXT,
    requester_jabatan TEXT,
    requester_dept_id TEXT,
    requester_job_level_id TEXT,
    requester_name_delegated TEXT,
    requester_jabatan_delegated TEXT,
    requester_dept_id_delegated TEXT,
    requester_job_level_id_delegated TEXT
);

CREATE TABLE detail_limbah (
    detail_id SERIAL PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES permohonan_pemusnahan_limbah(request_id) ON DELETE CASCADE,
    nama_limbah TEXT NOT NULL,
    nomor_analisa TEXT,
    nomor_referensi TEXT,
    nomor_wadah INTEGER,
    jumlah_barang NUMERIC(10, 2),
    satuan TEXT NOT NULL,
    bobot NUMERIC(10, 2) NOT NULL,
    alasan_pemusnahan TEXT NOT NULL
);

-- =============================================================================
-- LOGGING & HISTORY
-- =============================================================================
CREATE TABLE approval_history (
    history_id SERIAL PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES permohonan_pemusnahan_limbah(request_id) ON DELETE CASCADE,
    step_id INTEGER NOT NULL REFERENCES approval_workflow_steps(step_id) ON DELETE RESTRICT,
    decision_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status approval_status_enum NOT NULL,
    comments TEXT,
    approver_id TEXT NOT NULL,
    approver_id_delegated TEXT,
    approver_name TEXT,
    approver_jabatan TEXT,
    approver_dept_id TEXT,
    approver_job_level_id TEXT,
    approver_name_delegated TEXT,
    approver_jabatan_delegated TEXT,
    approver_dept_id_delegated TEXT,
    approver_job_level_id_delegated TEXT
);

CREATE TABLE signing_history (
    history_id SERIAL PRIMARY KEY,
    berita_acara_id INTEGER NOT NULL REFERENCES berita_acara(berita_acara_id) ON DELETE CASCADE,
    step_id INTEGER NOT NULL REFERENCES signing_workflow_steps(step_id) ON DELETE RESTRICT,
    signed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    signer_id TEXT NOT NULL,
    signer_id_delegated TEXT,
    signer_name TEXT,
    signer_jabatan TEXT,
    signer_dept_id TEXT,
    signer_job_level_id TEXT,
    signer_name_delegated TEXT,
    signer_jabatan_delegated TEXT,
    signer_dept_id_delegated TEXT,
    signer_job_level_id_delegated TEXT
);

CREATE TABLE audit_log_permohonan_pemusnahan_limbah (
    log_id BIGSERIAL PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES permohonan_pemusnahan_limbah(request_id) ON DELETE CASCADE,
    change_timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    action_type audit_action_type_enum NOT NULL,
    changer_id TEXT NOT NULL,
    changer_id_delegated TEXT,
    changer_name TEXT,
    changer_jabatan TEXT,
    changer_dept_id TEXT,
    changer_job_level_id TEXT,
    changer_name_delegated TEXT,
    changer_jabatan_delegated TEXT,
    changer_dept_id_delegated TEXT,
    changer_job_level_id_delegated TEXT,
    target_entity TEXT,
    target_entity_id TEXT,
    field_name TEXT,
    old_value TEXT,
    new_value TEXT
);
