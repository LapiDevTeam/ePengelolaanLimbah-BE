const ExcelJS = require('exceljs');
const { Op } = require('sequelize');
const { AuditLog, PermohonanPemusnahanLimbah } = require('../models');

const parseDateParam = (value, endOfDay = false) => {
  if (!value) return null;

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const suffix = endOfDay ? 'T23:59:59.999' : 'T00:00:00.000';
    const parsed = new Date(`${value.trim()}${suffix}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const sanitizeFilenamePart = (value) => {
  if (!value) return '';
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '-');
};

/**
 * GET /api/audit-logs/download?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Also supports snake_case: start_date, end_date.
 */
const downloadAuditLogExcel = async (req, res) => {
  try {
    const startDateRaw = req.query.startDate || req.query.start_date || req.query.start || null;
    const endDateRaw = req.query.endDate || req.query.end_date || req.query.end || null;

    const startDate = parseDateParam(startDateRaw, false);
    const endDate = parseDateParam(endDateRaw, true);

    if (startDateRaw && !startDate) {
      return res.status(400).json({
        success: false,
        message: 'Invalid start date format. Use YYYY-MM-DD or ISO datetime.'
      });
    }

    if (endDateRaw && !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Invalid end date format. Use YYYY-MM-DD or ISO datetime.'
      });
    }

    if (startDate && endDate && startDate > endDate) {
      return res.status(400).json({
        success: false,
        message: 'startDate must be less than or equal to endDate.'
      });
    }

    const where = {};
    if (startDate && endDate) {
      where.change_timestamp = { [Op.between]: [startDate, endDate] };
    } else if (startDate) {
      where.change_timestamp = { [Op.gte]: startDate };
    } else if (endDate) {
      where.change_timestamp = { [Op.lte]: endDate };
    }

    const logs = await AuditLog.findAll({
      where,
      include: [
        {
          model: PermohonanPemusnahanLimbah,
          attributes: ['nomor_permohonan'],
          required: false,
        }
      ],
      order: [['change_timestamp', 'DESC'], ['log_id', 'DESC']]
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Audit Log');

    worksheet.columns = [
      { header: 'Log ID', key: 'log_id', width: 12 },
      { header: 'Request ID', key: 'request_id', width: 12 },
      { header: 'No. Permohonan', key: 'nomor_permohonan', width: 22 },
      { header: 'Change Timestamp', key: 'change_timestamp', width: 22 },
      { header: 'Action Type', key: 'action_type', width: 16 },
      { header: 'Changer ID', key: 'changer_id', width: 16 },
      { header: 'Changer Name', key: 'changer_name', width: 24 },
      { header: 'Changer Jabatan', key: 'changer_jabatan', width: 24 },
      { header: 'Changer ID Delegated', key: 'changer_id_delegated', width: 20 },
      { header: 'Changer Name Delegated', key: 'changer_name_delegated', width: 24 },
      { header: 'Changer Jabatan Delegated', key: 'changer_jabatan_delegated', width: 24 },
      { header: 'Target Entity', key: 'target_entity', width: 20 },
      { header: 'Target Entity ID', key: 'target_entity_id', width: 18 },
      { header: 'Field Name', key: 'field_name', width: 20 },
      { header: 'Old Value', key: 'old_value', width: 40 },
      { header: 'New Value', key: 'new_value', width: 40 },
    ];

    worksheet.getRow(1).font = { bold: true };
    worksheet.getColumn('change_timestamp').numFmt = 'yyyy-mm-dd hh:mm:ss';

    worksheet.addRows(logs.map((log) => ({
      log_id: log.log_id,
      request_id: log.request_id,
      nomor_permohonan: log.PermohonanPemusnahanLimbah?.nomor_permohonan || '',
      change_timestamp: log.change_timestamp ? new Date(log.change_timestamp) : null,
      action_type: log.action_type,
      changer_id: log.changer_id,
      changer_name: log.changer_name,
      changer_jabatan: log.changer_jabatan,
      changer_id_delegated: log.changer_id_delegated,
      changer_name_delegated: log.changer_name_delegated,
      changer_jabatan_delegated: log.changer_jabatan_delegated,
      target_entity: log.target_entity,
      target_entity_id: log.target_entity_id,
      field_name: log.field_name,
      old_value: log.old_value,
      new_value: log.new_value,
    })));

    const filenameParts = ['audit-log'];
    if (startDateRaw) filenameParts.push(`start-${sanitizeFilenamePart(startDateRaw)}`);
    if (endDateRaw) filenameParts.push(`end-${sanitizeFilenamePart(endDateRaw)}`);
    if (!startDateRaw && !endDateRaw) filenameParts.push('all');
    const filename = `${filenameParts.join('_')}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error generating audit log Excel file:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred while generating audit log file.',
      error: error.message
    });
  }
};

module.exports = {
  downloadAuditLogExcel,
};
