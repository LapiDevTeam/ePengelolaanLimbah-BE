module.exports = (sequelize, DataTypes) => {
  const DetailLimbah = sequelize.define('DetailLimbah', {
    detail_id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    request_id: { type: DataTypes.INTEGER, allowNull: false },
    nama_limbah: { type: DataTypes.TEXT, allowNull: false },
    nomor_analisa: DataTypes.TEXT,
    nomor_referensi: DataTypes.TEXT,
    nomor_wadah: DataTypes.INTEGER,
    jumlah_barang: DataTypes.DECIMAL(10, 2),
    satuan: { type: DataTypes.TEXT, allowNull: false },
    bobot: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    alasan_pemusnahan: { type: DataTypes.TEXT, allowNull: false },
  }, {
    tableName: 'detail_limbah',
    timestamps: false,
  });

  DetailLimbah.associate = (models) => {
    DetailLimbah.belongsTo(models.PermohonanPemusnahanLimbah, { foreignKey: 'request_id' });
  };

  return DetailLimbah;
};
