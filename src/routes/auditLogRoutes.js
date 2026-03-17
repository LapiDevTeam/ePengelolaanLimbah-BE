const express = require('express');
const router = express.Router();
const auditLogController = require('../controllers/auditLogController');
const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware);

// GET /api/audit-logs/download?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get('/download', auditLogController.downloadAuditLogExcel);

module.exports = router;
