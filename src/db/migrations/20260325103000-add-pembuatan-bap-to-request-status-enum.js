'use strict';

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = async (pgm) => {
  pgm.sql("ALTER TYPE request_status_enum ADD VALUE IF NOT EXISTS 'Pembuatan BAP';");
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = async () => {
  // PostgreSQL does not support removing a single enum value safely.
  // Intentionally left as no-op.
};
