'use strict';

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = async (pgm) => {
    //==============================================================================
    // CUSTOM ENUM TYPES
    //==============================================================================
    pgm.createType('bentuk_limbah_enum', ['Padat', 'Cair']);
    pgm.createType('approval_status_enum', ['Approved', 'Rejected']);
    pgm.createType('audit_action_type_enum', ['UPDATE', 'ADD_ITEM', 'REMOVE_ITEM']);
    pgm.createType('request_status_enum', ['Draft', 'InProgress', 'Completed', 'Rejected']);

    //==============================================================================
    // LOOKUP TABLES
    //==============================================================================
    pgm.createTable('golongan_limbah', {
        category_id: 'id',
        nama: { type: 'text', notNull: true, unique: true },
    });

    pgm.createTable('jenis_limbah_b3', {
        type_id: 'id',
        nama: { type: 'text', notNull: true, unique: true },
    });

    //==============================================================================
    // APPROVAL WORKFLOW ENGINE TABLES
    //==============================================================================
    pgm.createTable('approval_workflows', {
        approval_workflow_id: 'id',
        workflow_name: { type: 'text', notNull: true },
        is_active: { type: 'boolean', notNull: true, default: true },
    });

    pgm.createTable('approval_workflow_steps', {
        step_id: 'id',
        approval_workflow_id: { type: 'integer', notNull: true, references: 'approval_workflows', onDelete: 'RESTRICT' },
        step_level: { type: 'integer', notNull: true },
        step_name: { type: 'text', notNull: true },
        required_approvals: { type: 'integer', notNull: true, default: 1 },
    });
    // Removed unique constraint to allow parallel approvals at same step level
    // pgm.addConstraint('approval_workflow_steps', 'approval_workflow_steps_workflow_id_step_level_key', {
    //     unique: ['approval_workflow_id', 'step_level'],
    // });

    pgm.createTable('approval_workflow_approvers', {
        approver_config_id: 'id',
        step_id: { type: 'integer', notNull: true, references: 'approval_workflow_steps', onDelete: 'CASCADE' },
        approver_id: { type: 'text', notNull: true },
        approver_name: { type: 'text' },
        approver_cc: { type: 'text' },
        approver_dept_id: { type: 'text' },
        approver_identity: { type: 'text' },
    });

    //==============================================================================
    // SIGNING WORKFLOW ENGINE TABLES
    //==============================================================================
    pgm.createTable('signing_workflows', {
        signing_workflow_id: 'id',
        workflow_name: { type: 'text', notNull: true },
        is_active: { type: 'boolean', notNull: true, default: true },
    });

    pgm.createTable('signing_workflow_steps', {
        step_id: 'id',
        signing_workflow_id: { type: 'integer', notNull: true, references: 'signing_workflows', onDelete: 'RESTRICT' },
        step_level: { type: 'integer', notNull: true },
        step_name: { type: 'text', notNull: true },
        required_signatures: { type: 'integer', notNull: true, default: 1 },
    });
    // Removed unique constraint to allow parallel signatures at same step level
    // pgm.addConstraint('signing_workflow_steps', 'signing_workflow_steps_workflow_id_step_level_key', {
    //     unique: ['signing_workflow_id', 'step_level'],
    // });

    pgm.createTable('signing_workflow_signers', {
        signer_config_id: 'id',
        step_id: { type: 'integer', notNull: true, references: 'signing_workflow_steps', onDelete: 'CASCADE' },
        log_nik: { type: 'text', notNull: true },
        peran: { type: 'text', notNull: true },
    });

    //==============================================================================
    // BERITA ACARA (EVENT) TABLES
    //==============================================================================
    pgm.createTable('berita_acara', {
        berita_acara_id: 'id',
        bagian: { type: 'text', notNull: true },
        tanggal: { type: 'date', notNull: true },
        waktu: { type: 'timestamptz', notNull: true },
        lokasi_verifikasi: { type: 'text', notNull: true },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        creator_id: { type: 'text', notNull: true },
        creator_id_delegated: { type: 'text' },
        signing_workflow_id: { type: 'integer', notNull: true, references: 'signing_workflows', onDelete: 'RESTRICT' },
        current_signing_step_id: { type: 'integer', references: 'signing_workflow_steps', onDelete: 'RESTRICT' },
        // Snapshot fields for creator
        creator_name: { type: 'text' },
        creator_jabatan: { type: 'text' },
        creator_dept_id: { type: 'text' },
        creator_job_level_id: { type: 'text' },
        // Snapshot fields for delegated creator
        creator_name_delegated: { type: 'text' },
        creator_jabatan_delegated: { type: 'text' },
        creator_dept_id_delegated: { type: 'text' },
        creator_job_level_id_delegated: { type: 'text' },
    });

    //==============================================================================
    // CORE REQUEST TABLES
    //==============================================================================
    pgm.createTable('permohonan_pemusnahan_limbah', {
        request_id: 'id',
        nomor_permohonan: { type: 'text', unique: true },
        bagian: { type: 'text', notNull: true },
        bentuk_limbah: { type: 'bentuk_limbah_enum', notNull: true },
        alasan_penolakan: { type: 'text' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        requester_id: { type: 'text', notNull: true },
        requester_id_delegated: { type: 'text' },
        golongan_limbah_id: { type: 'integer', notNull: true, references: 'golongan_limbah', onDelete: 'RESTRICT' },
        jenis_limbah_b3_id: { type: 'integer', notNull: true, references: 'jenis_limbah_b3', onDelete: 'RESTRICT' },
        jumlah_item: { type: 'integer', notNull: true, default: 0 },
        approval_workflow_id: { type: 'integer', notNull: true, references: 'approval_workflows', onDelete: 'RESTRICT' },
        status: { type: 'request_status_enum', notNull: true, default: 'Draft' },
        current_step_id: { type: 'integer', references: 'approval_workflow_steps', onDelete: 'RESTRICT' },
        berita_acara_id: { type: 'integer', references: 'berita_acara', onDelete: 'SET NULL' },
        // Snapshot fields for requester
        requester_name: { type: 'text' },
        requester_jabatan: { type: 'text' },
        requester_dept_id: { type: 'text' },
        requester_job_level_id: { type: 'text' },
        // Snapshot fields for delegated requester
        requester_name_delegated: { type: 'text' },
        requester_jabatan_delegated: { type: 'text' },
        requester_dept_id_delegated: { type: 'text' },
        requester_job_level_id_delegated: { type: 'text' },
    });

    pgm.createTable('detail_limbah', {
        detail_id: 'id',
        request_id: { type: 'integer', notNull: true, references: 'permohonan_pemusnahan_limbah', onDelete: 'CASCADE' },
        nama_limbah: { type: 'text', notNull: true },
        nomor_analisa: { type: 'text' },
        nomor_referensi: { type: 'text' },
        nomor_wadah: { type: 'integer' },
        jumlah_barang: { type: 'decimal(10, 2)' },
        satuan: { type: 'text', notNull: true },
        bobot: { type: 'decimal(10, 2)', notNull: true },
        alasan_pemusnahan: { type: 'text', notNull: true },
    });

    //==============================================================================
    // LOGGING & HISTORY TABLES
    //==============================================================================
    pgm.createTable('approval_history', {
        history_id: 'id',
        request_id: { type: 'integer', notNull: true, references: 'permohonan_pemusnahan_limbah', onDelete: 'CASCADE' },
        step_id: { type: 'integer', notNull: true, references: 'approval_workflow_steps', onDelete: 'RESTRICT' },
        decision_date: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        status: { type: 'approval_status_enum', notNull: true },
        comments: { type: 'text' },
        approver_id: { type: 'text', notNull: true },
        approver_id_delegated: { type: 'text' },
        // Snapshot fields for approver
        approver_name: { type: 'text' },
        approver_jabatan: { type: 'text' },
        approver_dept_id: { type: 'text' },
        approver_job_level_id: { type: 'text' },
        // Snapshot fields for delegated approver
        approver_name_delegated: { type: 'text' },
        approver_jabatan_delegated: { type: 'text' },
        approver_dept_id_delegated: { type: 'text' },
        approver_job_level_id_delegated: { type: 'text' },
    });

    pgm.createTable('signing_history', {
        history_id: 'id',
        berita_acara_id: { type: 'integer', notNull: true, references: 'berita_acara', onDelete: 'CASCADE' },
        step_id: { type: 'integer', notNull: true, references: 'signing_workflow_steps', onDelete: 'RESTRICT' },
        signed_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        signer_id: { type: 'text', notNull: true },
        signer_id_delegated: { type: 'text' },
        // Snapshot fields for signer
        signer_name: { type: 'text' },
        signer_jabatan: { type: 'text' },
        signer_dept_id: { type: 'text' },
        signer_job_level_id: { type: 'text' },
        // Snapshot fields for delegated signer
        signer_name_delegated: { type: 'text' },
        signer_jabatan_delegated: { type: 'text' },
        signer_dept_id_delegated: { type: 'text' },
        signer_job_level_id_delegated: { type: 'text' },
    });

    pgm.createTable('audit_log_permohonan_pemusnahan_limbah', {
        log_id: { type: 'bigserial', primaryKey: true },
        request_id: { type: 'integer', notNull: true, references: 'permohonan_pemusnahan_limbah', onDelete: 'CASCADE' },
        change_timestamp: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
        action_type: { type: 'audit_action_type_enum', notNull: true },
        changer_id: { type: 'text', notNull: true },
        changer_id_delegated: { type: 'text' },
        // Snapshot fields for changer
        changer_name: { type: 'text' },
        changer_jabatan: { type: 'text' },
        changer_dept_id: { type: 'text' },
        changer_job_level_id: { type: 'text' },
        // Snapshot fields for delegated changer
        changer_name_delegated: { type: 'text' },
        changer_jabatan_delegated: { type: 'text' },
        changer_dept_id_delegated: { type: 'text' },
        changer_job_level_id_delegated: { type: 'text' },
        // Change details
        target_entity: { type: 'text' },
        target_entity_id: { type: 'text' },
        field_name: { type: 'text' },
        old_value: { type: 'text' },
        new_value: { type: 'text' },
    });
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = async (pgm) => {
    // Drop in reverse order
    pgm.dropTable('audit_log_permohonan_pemusnahan_limbah');
    pgm.dropTable('signing_history');
    pgm.dropTable('approval_history');
    pgm.dropTable('detail_limbah');
    pgm.dropTable('permohonan_pemusnahan_limbah');
    pgm.dropTable('berita_acara');
    pgm.dropTable('signing_workflow_signers');
    pgm.dropTable('signing_workflow_steps');
    pgm.dropTable('signing_workflows');
    pgm.dropTable('approval_workflow_approvers');
    pgm.dropTable('approval_workflow_steps');
    pgm.dropTable('approval_workflows');
    pgm.dropTable('jenis_limbah_b3');
    pgm.dropTable('golongan_limbah');

    // Drop custom types
    pgm.dropType('audit_action_type_enum');
    pgm.dropType('approval_status_enum');
    pgm.dropType('bentuk_limbah_enum');
};
