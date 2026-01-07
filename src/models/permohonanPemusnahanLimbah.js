module.exports = (sequelize, DataTypes) => {
  const PermohonanPemusnahanLimbah = sequelize.define('PermohonanPemusnahanLimbah', {
    request_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    nomor_permohonan: { type: DataTypes.TEXT, unique: true },
    bagian: { type: DataTypes.TEXT, allowNull: false },
    bentuk_limbah: { type: DataTypes.ENUM('Padat', 'Cair'), allowNull: false },
    status: {
      type: DataTypes.ENUM('Draft', 'InProgress', 'Completed', 'Rejected', 'Pembuatan BAP'),
      allowNull: false,
      defaultValue: 'Draft'
    },
    alasan_penolakan: DataTypes.TEXT,
    requester_id: { type: DataTypes.TEXT, allowNull: false },
    requester_id_delegated: DataTypes.TEXT,
    golongan_limbah_id: { type: DataTypes.INTEGER, allowNull: false },
    jenis_limbah_b3_id: { type: DataTypes.INTEGER, allowNull: false },
    jumlah_item: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    is_produk_pangan: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
    approval_workflow_id: { type: DataTypes.INTEGER, allowNull: false },
    current_step_id: DataTypes.INTEGER,
    berita_acara_id: DataTypes.INTEGER,
    requester_name: DataTypes.TEXT,
    requester_jabatan: DataTypes.TEXT,
    requester_dept_id: DataTypes.TEXT,
    submitted_at: DataTypes.DATE,
    requester_job_level_id: DataTypes.TEXT,
    requester_name_delegated: DataTypes.TEXT,
    requester_jabatan_delegated: DataTypes.TEXT,
    requester_dept_id_delegated: DataTypes.TEXT,
    requester_job_level_id_delegated: DataTypes.TEXT,
  }, {
    tableName: 'permohonan_pemusnahan_limbah',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  PermohonanPemusnahanLimbah.associate = (models) => {
    PermohonanPemusnahanLimbah.hasMany(models.DetailLimbah, { foreignKey: 'request_id' });
    PermohonanPemusnahanLimbah.hasMany(models.ApprovalHistory, { foreignKey: 'request_id' });
    PermohonanPemusnahanLimbah.hasMany(models.AuditLog, { foreignKey: 'request_id' });
    PermohonanPemusnahanLimbah.belongsTo(models.GolonganLimbah, { foreignKey: 'golongan_limbah_id' });
    PermohonanPemusnahanLimbah.belongsTo(models.JenisLimbahB3, { foreignKey: 'jenis_limbah_b3_id' });
    PermohonanPemusnahanLimbah.belongsTo(models.ApprovalWorkflow, { foreignKey: 'approval_workflow_id' });
    PermohonanPemusnahanLimbah.belongsTo(models.ApprovalWorkflowStep, { as: 'CurrentStep', foreignKey: 'current_step_id' });
    PermohonanPemusnahanLimbah.belongsTo(models.BeritaAcara, { foreignKey: 'berita_acara_id' });
  };

  // Automatically set submitted_at when status transitions to InProgress
  PermohonanPemusnahanLimbah.addHook('beforeSave', 'setSubmittedAtOnSubmit', (instance, options) => {
    try {
      // If status changed to InProgress and submitted_at is not set, set it now
      if (instance.changed && typeof instance.changed === 'function' && instance.changed('status')) {
        const newStatus = instance.get('status');
        if (newStatus === 'InProgress' && !instance.get('submitted_at')) {
          const jakartaTime = require('../utils/jakartaTime');
          instance.set('submitted_at', jakartaTime.nowJakarta());
        }
      }
    } catch (e) {
      // Non-fatal: do not block save if hook fails
      console.warn('[Permohonan] setSubmittedAtOnSubmit hook error:', e && e.message);
    }
  });

  return PermohonanPemusnahanLimbah;
};