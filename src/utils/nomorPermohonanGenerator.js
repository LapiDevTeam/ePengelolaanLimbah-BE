const { PermohonanPemusnahanLimbah, sequelize } = require("../models");
const { Op } = require("sequelize");

/**
 * Generates a unique nomor_permohonan following the format:
 * AAAAA/KL-PL/[P/C]/BB/CC
 *
 * AAAAA : Request number (starts from 00001 up to 99999)
 * KL-PL : Leave as is, 'KL-PL' for all requests
 * P/C : If bentuk_limbah is Padat, 'P'. If Cair, 'C'
 * BB : Month (format: 01, 02, up to 12)
 * CC: Year (Last 2 digits of current year. Format: 24, 25, 26...)
 *
 * The AAAAA resets back to 00001 once the calendar changes YEAR.
 *
 * @param {string} bentuk_limbah - 'Padat' or 'Cair'
 * @param {Object} transaction - Database transaction object
 * @returns {Promise<string>} - Generated nomor_permohonan
 */
const generateNomorPermohonan = async (bentuk_limbah, transaction) => {
  try {
    console.log("Generating nomor permohonan for bentuk_limbah:", bentuk_limbah);
    const jakartaTime = require("./jakartaTime");
    const SPECIAL_START_YEAR = 2026;
    const SPECIAL_START_REQUEST_NUMBER = 2546;

    // Validate bentuk_limbah parameter
    if (!bentuk_limbah || (bentuk_limbah !== "Padat" && bentuk_limbah !== "Cair")) {
      throw new Error(`Invalid bentuk_limbah: ${bentuk_limbah}. Must be 'Padat' or 'Cair'`);
    }

    const nowIsoJakarta = jakartaTime.nowJakarta(); // e.g. 2025-09-28T15:04:05+07:00
    // Extract components from jakarta ISO
    const m = nowIsoJakarta.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    const currentYear = m ? parseInt(m[1], 10) : new Date().getFullYear();
    const currentMonth = m ? parseInt(m[2], 10) : new Date().getMonth() + 1;
    const defaultStartRequestNumber =
      currentYear === SPECIAL_START_YEAR ? SPECIAL_START_REQUEST_NUMBER : 1;

    // Format year as last 2 digits (e.g., 2024 -> 24)
    const yearSuffix = currentYear.toString().slice(-2);

    // Format month as 2 digits (e.g., 1 -> 01)
    const monthFormatted = currentMonth.toString().padStart(2, "0");

    // Determine waste form code
    const wasteFormCode = bentuk_limbah === "Padat" ? "P" : "C";

    // Find the highest request number for the current year
    // Build start and end of year in Jakarta local and convert to Date objects
    const startOfYear = new Date(`${currentYear}-01-01T00:00:00+07:00`);
    const endOfYear = new Date(`${currentYear}-12-31T23:59:59+07:00`);

    const lastRequest = await PermohonanPemusnahanLimbah.findOne({
      where: {
        created_at: {
          [Op.between]: [startOfYear, endOfYear],
        },
        nomor_permohonan: {
          [Op.not]: null,
        },
      },
      order: [["nomor_permohonan", "DESC"]],
      transaction,
    });

    let nextRequestNumber = defaultStartRequestNumber;

    if (lastRequest && lastRequest.nomor_permohonan) {
      // Extract the request number from the last nomor_permohonan
      // Format: AAAAA/KL-PL/[P/C]/BB/CC
      const parts = lastRequest.nomor_permohonan.split("/");
      if (parts.length >= 1) {
        const lastRequestNumber = parseInt(parts[0], 10);
        if (!isNaN(lastRequestNumber)) {
          const nextFromLast = lastRequestNumber + 1;
          nextRequestNumber = Math.max(nextFromLast, defaultStartRequestNumber);
        }
      }
    }

    // Ensure request number doesn't exceed 99999
    if (nextRequestNumber > 99999) {
      throw new Error("Request number limit exceeded for the current year (99999)");
    }

    // Format request number as 5 digits with leading zeros
    const requestNumberFormatted = nextRequestNumber.toString().padStart(5, "0");

    // Construct the nomor_permohonan
    const nomorPermohonan = `${requestNumberFormatted}/KL-PL/${wasteFormCode}/${monthFormatted}/${yearSuffix}`;

    return nomorPermohonan;
  } catch (error) {
    console.error("Error generating nomor_permohonan:", error);
    throw error;
  }
};

/**
 * Validates if a nomor_permohonan follows the correct format
 * @param {string} nomorPermohonan - The nomor_permohonan to validate
 * @returns {boolean} - True if valid, false otherwise
 */
const validateNomorPermohonan = (nomorPermohonan) => {
  if (!nomorPermohonan || typeof nomorPermohonan !== "string") {
    return false;
  }

  // Regex pattern for AAAAA/KL-PL/[P/C]/BB/CC
  const pattern = /^\d{5}\/KL-PL\/[PC]\/\d{2}\/\d{2}$/;
  return pattern.test(nomorPermohonan);
};

/**
 * Checks if a nomor_permohonan already exists in the database
 * @param {string} nomorPermohonan - The nomor_permohonan to check
 * @param {Object} transaction - Database transaction object
 * @returns {Promise<boolean>} - True if exists, false otherwise
 */
const checkNomorPermohonanExists = async (nomorPermohonan, transaction) => {
  try {
    const existingRequest = await PermohonanPemusnahanLimbah.findOne({
      where: {
        nomor_permohonan: nomorPermohonan,
      },
      transaction,
    });

    return !!existingRequest;
  } catch (error) {
    console.error("Error checking nomor_permohonan existence:", error);
    throw error;
  }
};

module.exports = {
  generateNomorPermohonan,
  validateNomorPermohonan,
  checkNomorPermohonanExists,
};
