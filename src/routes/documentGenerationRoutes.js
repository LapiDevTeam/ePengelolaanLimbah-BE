const express = require('express');
const router = express.Router();
const { 
    getPermohonanDataForDoc, 
    getBeritaAcaraDataForDoc,
    generatePermohonanExcel,
    generateLogbookExcel,
    downloadPermohonanByDateRangeExcel
} = require('../controllers/documentGenerationController');
const PrintController = require('../controllers/printController');
const authMiddleware = require('../middleware/authMiddleware');

/**
 * GET /api/print-permohonan-pemusnahan
 * The new endpoint for printing the 'Permohonan Pemusnahan' document.
 * This route does NOT use authMiddleware because it accepts token via query parameter
 * for direct browser access (window.open)
 */
router.get('/print-permohonan-pemusnahan', PrintController.printPermohonanPemusnahan);

/**
 * GET /api/print-berita-acara-pemusnahan
 * The new endpoint for printing the 'Berita Acara Pemusnahan' document.
 * This route does NOT use authMiddleware because it accepts token via query parameter
 * for direct browser access (window.open)
 */
router.get('/print-berita-acara-pemusnahan', PrintController.printBeritaAcaraPemusnahan);

// All routes below are protected by the authentication middleware
router.use(authMiddleware);

/**
 * GET /api/document-generation/permohonan/:id
 * Retrieves formatted data for generating the 'Permohonan' document.
 */
router.get('/permohonan/:id', getPermohonanDataForDoc);

/**
 * GET /api/document-generation/berita-acara/:id
 * Retrieves formatted data for generating the 'Berita Acara' document.
 */
router.get('/berita-acara/:id', getBeritaAcaraDataForDoc);

/**
 * GET /api/document-generation/permohonan/range/excel?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * Generates an Excel file with details of all permohonan within a date range (tanggal_pengajuan).
 */
router.get('/permohonan/range/excel', downloadPermohonanByDateRangeExcel);

/**
 * GET /api/document-generation/permohonan/:id/excel
 * Generates an Excel file with the details of a specific Permohonan.
 */
router.get('/permohonan/:id/excel', generatePermohonanExcel);

/**
 * GET /api/document-generation/logbook/excel?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * Generates an Excel logbook file with multiple sheets grouped by jenis limbah.
 */
router.get('/logbook/excel', generateLogbookExcel);

module.exports = router;
