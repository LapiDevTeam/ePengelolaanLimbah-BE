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
const authMiddlewareWithQuery = require('../middleware/authMiddlewareWithQuery');

/**
 * GET /api/document-generation/permohonan/:id
 * Retrieves formatted data for generating the 'Permohonan' document.
 */
router.get('/permohonan/:id', authMiddleware, getPermohonanDataForDoc);

/**
 * GET /api/document-generation/berita-acara/:id
 * Retrieves formatted data for generating the 'Berita Acara' document.
 */
router.get('/berita-acara/:id', authMiddleware, getBeritaAcaraDataForDoc);

/**
 * GET /api/print-permohonan-pemusnahan
 * The new endpoint for printing the 'Permohonan Pemusnahan' document.
 * Uses authMiddlewareWithQuery to support token in query parameter (for window.open)
 */
router.get('/print-permohonan-pemusnahan', authMiddlewareWithQuery, PrintController.printPermohonanPemusnahan);

/**
 * GET /api/print-berita-acara-pemusnahan
 * The new endpoint for printing the 'Berita Acara Pemusnahan' document.
 * Uses authMiddlewareWithQuery to support token in query parameter (for window.open)
 */
router.get('/print-berita-acara-pemusnahan', authMiddlewareWithQuery, PrintController.printBeritaAcaraPemusnahan);

/**
 * GET /api/document-generation/permohonan/range/excel?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * Generates an Excel file with details of all permohonan within a date range (tanggal_pengajuan).
 */
router.get('/permohonan/range/excel', authMiddleware, downloadPermohonanByDateRangeExcel);

/**
 * GET /api/document-generation/permohonan/:id/excel
 * Generates an Excel file with the details of a specific Permohonan.
 */
router.get('/permohonan/:id/excel', authMiddleware, generatePermohonanExcel);

/**
 * GET /api/document-generation/logbook/excel?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * Generates an Excel logbook file with multiple sheets grouped by jenis limbah.
 */
router.get('/logbook/excel', authMiddleware, generateLogbookExcel);

module.exports = router;
