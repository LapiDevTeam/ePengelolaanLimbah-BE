const nodemailer = require('nodemailer');

// ============================================================
// EMAIL CONFIG
// Toggle TEST_MODE to switch between hardcoded test email
// and real recipient emails from user API
// ============================================================
const TEST_MODE = false; // true = kirim ke TEST_EMAIL, false = kirim ke email dari user API
const TEST_EMAIL = 'thehascine@gmail.com'; // Ganti dengan email kamu untuk testing

// Create reusable transporter
const createTransporter = () => {
  const config = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
  };

  // Only add auth if credentials are provided
  // (some internal SMTP servers allow relay without auth)
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    config.auth = {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    };
  }

  return nodemailer.createTransport(config);
};

/**
 * Resolve recipient email(s) for next signer(s)
 * In TEST_MODE, always returns the hardcoded test email
 * Otherwise, looks up email from user API cache
 * 
 * @param {string[]} nikList - Array of NIK to find emails for
 * @returns {Promise<string[]>} - Array of email addresses
 */
const resolveEmails = async (nikList) => {
  if (TEST_MODE) {
    // Still resolve actual emails so we can log them for verification
    try {
      const { fetchUsersWithCache } = require('../controllers/userController');
      const users = await fetchUsersWithCache();
      const userList = Array.isArray(users) ? users : (users?.data || []);
      const actualEmails = nikList.map(nik => {
        const u = userList.find(u => String(u.emp_NIK) === String(nik));
        return u ? `${u.emp_NIK} → ${u.emp_Email || '(no email)'}` : `${nik} → (not found)`;
      });
      console.log(`[EmailService] TEST_MODE aktif. Seharusnya dikirim ke:\n  ${actualEmails.join('\n  ')}\n  → Dikirim ke test email: ${TEST_EMAIL}`);
    } catch (e) {
      console.log(`[EmailService] TEST_MODE: NIKs: ${nikList.join(', ')} → ${TEST_EMAIL} (gagal lookup: ${e.message})`);
    }
    return [TEST_EMAIL];
  }

  try {
    const { fetchUsersWithCache } = require('../controllers/userController');
    const users = await fetchUsersWithCache();
    const userList = Array.isArray(users) ? users : (users?.data || []);

    const emails = [];
    for (const nik of nikList) {
      const user = userList.find(u => String(u.emp_NIK) === String(nik));
      if (user && user.emp_Email) {
        emails.push(user.emp_Email);
      } else {
        console.warn(`[EmailService] No email found for NIK: ${nik}`);
      }
    }
    return emails;
  } catch (err) {
    console.error('[EmailService] Failed to resolve emails:', err.message);
    return [];
  }
};

/**
 * Get next signer NIK(s) from External Approval API
 * 
 * @param {number} nextStepLevel - The step_level to find signers for (3 or 4)
 * @param {Object} beritaAcara - The BAP object with related permohonan data
 * @returns {Promise<string[]>} - Array of signer NIKs
 */
const getNextSignerNiks = async (nextStepLevel, beritaAcara) => {
  try {
    const axios = require('axios');
    const EXTERNAL_APPROVAL_URL = process.env.EXTERNAL_APPROVAL_URL;
    const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
    const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];

    // Filter for BAP signing approvers at the target step level
    const signers = items.filter(i =>
      String(i.Appr_ApplicationCode || '') === 'ePengelolaan_Limbah_Berita_Acara' &&
      Number(i.Appr_No) === nextStepLevel
    );

    if (nextStepLevel === 3) {
      // Step 3 (APJ/Dept Manager) - filter by relevant department based on golongan
      const relevantDepts = new Set();
      const permohonanList = beritaAcara.PermohonanPemusnahanLimbahs || [];
      
      for (const p of permohonanList) {
        const catName = (p.GolonganLimbah?.nama || '').toLowerCase();
        const isPrecursor = catName.includes('prekursor') || catName.includes('oot');
        const isRecall = catName.includes('recall');
        const isRecallPrecursor = catName.includes('recall') && catName.includes('prekursor');

        if (isRecallPrecursor) {
          relevantDepts.add('PN1');
          relevantDepts.add('QA');
        } else if (isPrecursor) {
          relevantDepts.add('PN1');
        } else if (isRecall) {
          relevantDepts.add('QA');
          if (p.is_produk_pangan) relevantDepts.add('HC');
        } else {
          // Standard: dept manager from bagian
          const bagian = (p.bagian || '').toUpperCase();
          if (bagian) relevantDepts.add(bagian);
        }
      }

      const filteredSigners = signers.filter(s =>
        relevantDepts.has((s.Appr_DeptID || '').toUpperCase())
      );

      return filteredSigners.map(s => String(s.Appr_ID));
    }

    if (nextStepLevel === 4) {
      // Step 4 (Head of Plant) - dept PL
      const plSigners = signers.filter(s =>
        (s.Appr_DeptID || '').toUpperCase() === 'PL'
      );
      return plSigners.map(s => String(s.Appr_ID));
    }

    return signers.map(s => String(s.Appr_ID));
  } catch (err) {
    console.error('[EmailService] Failed to get next signer NIKs:', err.message);
    return [];
  }
};

/**
 * Build HTML email content for BAP signing notification
 * 
 * @param {Object} params
 * @param {Object} params.beritaAcara - BAP data
 * @param {string} params.stepName - Next step name (e.g., "APJ Approval", "Head of Plant")
 * @param {string} params.signerName - Current signer who just signed
 * @param {string} params.previousStepName - Step that was just completed
 * @returns {string} HTML email content
 */
const buildBapEmailHtml = ({ beritaAcara, stepName, signerName, previousStepName }) => {
  const bapNomor = `BA-${String(beritaAcara.berita_acara_id).padStart(3, '0')}`;
  const lmsLoginUrl = 'http://192.168.1.24/lms/login';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { background-color: #1e40af; color: white; padding: 24px; text-align: center; }
    .header h1 { margin: 0; font-size: 20px; }
    .content { padding: 24px; color: #333; line-height: 1.6; }
    .info-table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    .info-table td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    .info-table td:first-child { font-weight: 600; color: #555; width: 180px; white-space: nowrap; }
    .btn { display: inline-block; background-color: #1e40af; color: white; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; margin-top: 16px; }
    .footer { padding: 16px 24px; background-color: #f9fafb; color: #888; font-size: 12px; text-align: center; border-top: 1px solid #e5e7eb; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Berita Acara Pemusnahan - Perlu Tanda Tangan</h1>
    </div>
    <div class="content">
      <p>Yth. Bapak/Ibu,</p>
      <p>Berita Acara Pemusnahan berikut memerlukan tanda tangan Anda pada tahap <strong>${stepName}</strong>.</p>
      
      <table class="info-table">
        <tr><td>No. Berita Acara</td><td>${bapNomor}</td></tr>
        <tr><td>Ditandatangani oleh</td><td>${signerName} (${previousStepName})</td></tr>
        <tr><td>Tahap Saat Ini</td><td>${stepName}</td></tr>
      </table>
      
      <p>Silakan login ke LMS untuk membuka dan menandatangani dokumen:</p>
      <a href="${lmsLoginUrl}" class="btn">Login ke LMS</a>
    </div>
    <div class="footer">
      Email ini dikirim otomatis oleh sistem ePemusnahan Limbah. Mohon tidak membalas email ini.
    </div>
  </div>
</body>
</html>`;
};

/**
 * Send BAP signing notification email to next signer(s)
 * Fire-and-forget: email failure does NOT affect BAP signing process
 * 
 * @param {Object} params
 * @param {Object} params.beritaAcara - BAP object with PermohonanPemusnahanLimbahs
 * @param {number} params.nextStepLevel - Step level of the next signer (3 or 4)
 * @param {string} params.nextStepName - Human-readable name of next step
 * @param {string} params.currentSignerName - Name of person who just signed
 * @param {string} params.currentStepName - Name of step that was just completed
 */
const sendBapSigningNotification = async ({ beritaAcara, nextStepLevel, nextStepName, currentSignerName, currentStepName }) => {
  try {
    // 1. Find next signer NIK(s)
    const signerNiks = await getNextSignerNiks(nextStepLevel, beritaAcara);
    if (signerNiks.length === 0) {
      console.warn(`[EmailService] No signers found for step level ${nextStepLevel}`);
      return;
    }

    // 2. Resolve email addresses
    const emails = await resolveEmails(signerNiks);
    if (emails.length === 0) {
      console.warn('[EmailService] No email addresses resolved, skipping notification');
      return;
    }

    // 3. Build email
    const html = buildBapEmailHtml({
      beritaAcara,
      stepName: nextStepName,
      signerName: currentSignerName,
      previousStepName: currentStepName,
    });

    const bapNomor = `BA-${String(beritaAcara.berita_acara_id).padStart(3, '0')}`;

    // 4. Send email
    const transporter = createTransporter();
    const info = await transporter.sendMail({
      from: `"ePemusnahan Limbah" <${process.env.SMTP_USER || 'noreply@lapi.co.id'}>`,
      to: emails.join(', '),
      subject: `[ePemusnahan Limbah] Berita Acara ${bapNomor} - Perlu Tanda Tangan (${nextStepName})`,
      html,
    });

    console.log(`[EmailService] BAP notification sent to ${emails.join(', ')} | messageId: ${info.messageId}`);
  } catch (err) {
    // Fire-and-forget: log error but don't throw
    console.error('[EmailService] Failed to send BAP notification:', err.message);
  }
};

/**
 * Get NIKs of step 2 (APJ) approvers for a permohonan based on golongan category.
 * Queries the external ePengelolaan_Limbah approval API.
 *
 * @param {Object} params
 * @param {string} params.categoryName - Lowercase golongan name
 * @param {boolean} params.isProdukPangan - Whether request is produk pangan
 * @returns {Promise<string[]>} - Array of approver NIKs
 */
const getStep2ApproverNiks = async ({ categoryName, isProdukPangan }) => {
  try {
    const axios = require('axios');
    const EXTERNAL_APPROVAL_URL = process.env.EXTERNAL_APPROVAL_URL;
    const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
    const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];

    // Filter for ePengelolaan_Limbah step 2 approvers
    const step2Items = items.filter(i =>
      String(i.Appr_ApplicationCode || '') === 'ePengelolaan_Limbah' &&
      Number(i.Appr_No) === 2
    );

    // Determine which departments are needed for this request
    const relevantDepts = new Set();
    const isPrecursor = categoryName.includes('prekursor') || categoryName.includes('oot');
    const isRecall = categoryName.includes('recall');
    const isRecallPrecursor = categoryName.includes('recall') && categoryName.includes('prekursor');

    if (isRecallPrecursor) {
      relevantDepts.add('PN1');
      relevantDepts.add('QA');
    } else if (isPrecursor) {
      relevantDepts.add('PN1');
    } else if (isRecall) {
      relevantDepts.add('QA');
      if (isProdukPangan) relevantDepts.add('PC');
    }

    if (relevantDepts.size === 0) {
      // Standard or unknown: no step 2, shouldn't happen but return empty
      return [];
    }

    const filtered = step2Items.filter(i =>
      relevantDepts.has((i.Appr_DeptID || '').toUpperCase())
    );

    return [...new Set(filtered.map(i => String(i.Appr_ID)))];
  } catch (err) {
    console.error('[EmailService] Failed to get step 2 approver NIKs:', err.message);
    return [];
  }
};

/**
 * Build HTML email for permohonan step 2 (APJ) approval notification.
 */
const buildPermohonanStep2EmailHtml = ({ permohonan, approverName, golonganName }) => {
  const lmsLoginUrl = 'http://192.168.1.24/lms/login';
  const nomorText = permohonan.nomor_permohonan || `Draft-${String(permohonan.request_id).padStart(3, '0')}`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { background-color: #1e40af; color: white; padding: 24px; text-align: center; }
    .header h1 { margin: 0; font-size: 20px; }
    .content { padding: 24px; color: #333; line-height: 1.6; }
    .info-table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    .info-table td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    .info-table td:first-child { font-weight: 600; color: #555; width: 180px; white-space: nowrap; }
    .btn { display: inline-block; background-color: #1e40af; color: white; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; margin-top: 16px; }
    .footer { padding: 16px 24px; background-color: #f9fafb; color: #888; font-size: 12px; text-align: center; border-top: 1px solid #e5e7eb; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Ajuan Pemusnahan Limbah - Perlu Persetujuan APJ</h1>
    </div>
    <div class="content">
      <p>Yth. Bapak/Ibu,</p>
      <p>Terdapat ajuan pemusnahan limbah yang memerlukan persetujuan Anda pada tahap <strong>APJ Approval</strong>.</p>
      <p>Ajuan ini telah disetujui oleh Manager Departemen dan sekarang menunggu persetujuan APJ.</p>

      <table class="info-table">
        <tr><td>No. Permohonan</td><td>${nomorText}</td></tr>
        <tr><td>Departemen</td><td>${permohonan.bagian || '-'}</td></tr>
        <tr><td>Golongan Limbah</td><td>${golonganName || '-'}</td></tr>
        <tr><td>Bentuk Limbah</td><td>${permohonan.bentuk_limbah || '-'}</td></tr>
        <tr><td>Disetujui Manager</td><td>${approverName}</td></tr>
        <tr><td>Tahap Saat Ini</td><td>APJ Approval</td></tr>
      </table>

      <p>Silakan login ke LMS untuk membuka dan menyetujui ajuan:</p>
      <a href="${lmsLoginUrl}" class="btn">Login ke LMS</a>
    </div>
    <div class="footer">
      Email ini dikirim otomatis oleh sistem ePemusnahan Limbah. Mohon tidak membalas email ini.
    </div>
  </div>
</body>
</html>`;
};

/**
 * Send email notification to all step 2 (APJ) approvers after step 1 is completed.
 * Fire-and-forget: email failure does NOT affect the approval process.
 *
 * @param {Object} params
 * @param {Object} params.permohonan - PermohonanPemusnahanLimbah instance
 * @param {string} params.categoryName - Lowercase golongan name
 * @param {string} params.golonganName - Display name of golongan
 * @param {boolean} params.isProdukPangan - Whether is produk pangan
 * @param {string} params.managerApproverName - Name of the step 1 approver (manager)
 */
const sendApprovalStep2Notification = async ({ permohonan, categoryName, golonganName, isProdukPangan, managerApproverName }) => {
  try {
    // 1. Get step 2 approver NIKs from external API
    const approverNiks = await getStep2ApproverNiks({ categoryName, isProdukPangan });
    if (approverNiks.length === 0) {
      console.warn(`[EmailService] No step 2 approvers found for request ${permohonan.request_id} (golongan: ${categoryName})`);
      return;
    }

    // 2. Resolve email addresses
    const emails = await resolveEmails(approverNiks);
    if (emails.length === 0) {
      console.warn('[EmailService] No email addresses resolved for step 2 approvers, skipping notification');
      return;
    }

    // 3. Build email
    const isRecall = categoryName.includes('recall');
    const displayGolonganName = (isRecall && isProdukPangan && golonganName)
      ? `${golonganName} (Pangan)`
      : golonganName;
    const html = buildPermohonanStep2EmailHtml({
      permohonan,
      approverName: managerApproverName,
      golonganName: displayGolonganName,
    });

    const nomorText = permohonan.nomor_permohonan || `Draft-${String(permohonan.request_id).padStart(3, '0')}`;

    // 4. Send email (parallel to all approvers)
    const transporter = createTransporter();
    const info = await transporter.sendMail({
      from: `"ePemusnahan Limbah" <${process.env.SMTP_USER || 'noreply@lapi.co.id'}>`,
      to: emails.join(', '),
      subject: `[ePemusnahan Limbah] Ajuan ${nomorText} - Perlu Persetujuan APJ`,
      html,
    });

    console.log(`[EmailService] Step 2 approval notification sent to ${emails.join(', ')} for request ${permohonan.request_id} | messageId: ${info.messageId}`);
  } catch (err) {
    // Fire-and-forget: log error but don't throw
    console.error('[EmailService] Failed to send step 2 approval notification:', err.message);
  }
};

module.exports = {
  sendBapSigningNotification,
  sendApprovalStep2Notification,
  resolveEmails,
  getNextSignerNiks,
  getStep2ApproverNiks,
  TEST_MODE,
  TEST_EMAIL,
};
