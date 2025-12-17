const {
  BeritaAcara,
  PermohonanPemusnahanLimbah,
  SigningWorkflow,
  SigningWorkflowStep,
  SigningWorkflowSigner,
  SigningHistory,
  DetailLimbah,
  GolonganLimbah,
  JenisLimbahB3,
  ApprovalHistory,
  ApprovalWorkflowStep,
  sequelize,
} = require("../models");

const axios = require("axios");
const EXTERNAL_APPROVAL_URL =
  process.env.EXTERNAL_APPROVAL_URL || "http://192.168.1.38/api/global-dev/v1/custom/list-approval-magang";

const { Op } = require("sequelize");

const jakartaTime = require("../utils/jakartaTime");

const { determineSigningWorkflow } = require("./workflowController");

// --- Helper Function for External API Authorization ---
// This is consistent with checkApprovalAuthorization in permohonanController but adapted for signing workflow
const checkSigningAuthorization = async (authorizingUser, beritaAcara) => {
  let isAuthorized = false;

  try {
    // First try external API authorization
    const axios = require("axios");
    const EXTERNAL_APPROVAL_URL =
      process.env.EXTERNAL_APPROVAL_URL || "http://192.168.1.38/api/global-dev/v1/custom/list-approval-magang";

    const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
    const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];

    // Filter for ePengelolaan_Limbah_Berita_Acara signers
    const appItems = items.filter((i) => String(i.Appr_ApplicationCode || "") === "ePengelolaan_Limbah_Berita_Acara");

    // Find user's signing capabilities
    const userApprovals = appItems.filter((item) => item.Appr_ID === authorizingUser.log_NIK);

    // Check if user can sign this step level
    const currentStepLevel = beritaAcara.SigningWorkflowStep?.step_level || beritaAcara.current_step_level;

    // Basic match by Appr_No
    const canSignThisStep = userApprovals.some((approval) => approval.Appr_No === currentStepLevel);

    if (canSignThisStep) {
      // For HSE Manager level (step 2), check department matching
      if (currentStepLevel === 2) {
        const userDepartments = userApprovals
          .filter((a) => a.Appr_No === 2)
          .map((a) => a.Appr_DeptID)
          .map((d) => (d || "").toString().toUpperCase());

        // HSE Manager should be from KL department
        isAuthorized = userDepartments.includes("KL");

        // APJ/Department Manager (step 3) requires department-based signing depending on golongan and bagian
      } else if (currentStepLevel === 3) {
        // Determine required signer department from golongan and bagian
        let requiredDept = null;
        try {
          // Analyze golongan and produk pangan requirements from related requests
          const golonganNames = new Set();
          let hasProdukPangan = false;

          if (beritaAcara.PermohonanPemusnahanLimbahs) {
            beritaAcara.PermohonanPemusnahanLimbahs.forEach((req) => {
              const golonganName = String(req.GolonganLimbah?.nama || "").toLowerCase();
              if (golonganName) golonganNames.add(golonganName);

              // Only consider isProdukPangan for pure Recall (not Recall & Prekursor)
              if (
                req.is_produk_pangan === true &&
                golonganName.includes("recall") &&
                !golonganName.includes("prekursor")
              ) {
                hasProdukPangan = true;
              }
            });
          }

          const hasPrecursor = Array.from(golonganNames).some((n) => n.includes("prekursor") || n.includes("oot"));
          const hasRecall = Array.from(golonganNames).some((n) => n.includes("recall"));
          const hasRecallPrecursor = Array.from(golonganNames).some(
            (n) => n.includes("recall") && n.includes("prekursor")
          );

          if (hasRecallPrecursor) {
            // For Recall & Precursor, both PN1 and QA departments are required
            requiredDept = ["PN1", "QA"];
          } else if (hasPrecursor) {
            requiredDept = "PN1";
          } else if (hasRecall) {
            requiredDept = "QA";
            // Add APJ HC (PJKPO) requirement for produk pangan requests
            if (hasProdukPangan) {
              requiredDept = Array.isArray(requiredDept) ? [...requiredDept, "HC"] : [requiredDept, "HC"];
            }
          } else {
            // For Standard workflow, check department manager based on bagian
            const bagian = (beritaAcara.bagian || beritaAcara.creator_dept_id || "").toString().toUpperCase();
            requiredDept = bagian;
          }
        } catch (gErr) {
          console.warn(
            "[checkSigningAuthorization] Failed to determine golongan for signing dept matching:",
            gErr && gErr.message
          );
        }

        // If a requiredDept is determined, require the user's external approvals for this step to include that dept
        if (requiredDept) {
          const userDeptForStep = userApprovals
            .filter((a) => a.Appr_No === 3)
            .map((a) => (a.Appr_DeptID || "").toString().toUpperCase());

          if (Array.isArray(requiredDept)) {
            // For array of required departments, user must belong to at least one
            isAuthorized = requiredDept.some((dept) => userDeptForStep.includes(dept.toString().toUpperCase()));
          } else {
            isAuthorized = userDeptForStep.includes(requiredDept.toString().toUpperCase());
          }
        } else {
          // If we couldn't determine requiredDept, fall back to permissive behavior for step 3
          isAuthorized = userApprovals.some((a) => a.Appr_No === 3);
        }

        // Head of Plant level (step 4)
      } else if (currentStepLevel === 4) {
        const userDepartments = userApprovals
          .filter((a) => a.Appr_No === 4)
          .map((a) => a.Appr_DeptID)
          .map((d) => (d || "").toString().toUpperCase());

        // Head of Plant should be from PL department
        isAuthorized = userDepartments.includes("PL");
      } else {
        // For other steps, if user can sign the step level, they're authorized
        isAuthorized = true;
      }
    }
  } catch (apiError) {
    console.warn(
      "[checkSigningAuthorization] External API authorization failed, falling back to database:",
      apiError.message
    );

    // Fallback to original database check
    if (beritaAcara.SigningWorkflowStep?.SigningWorkflowSigners) {
      isAuthorized = beritaAcara.SigningWorkflowStep.SigningWorkflowSigners.some(
        (signer) => signer.log_nik === authorizingUser.log_NIK
      );
    }
  }

  return isAuthorized;
};

/**
 * Get all completed requests that are available for daily log generation
 * GET /berita-acara/available-requests
 */
const getAvailableRequestsForDailyLog = async (req, res) => {
  try {
    // Accept optional query params: bagian (department) and tanggal (YYYY-MM-DD)
    const { bagian, tanggal } = req.query;

    // Build where clause
    const whereClause = {
      status: "Completed",
      berita_acara_id: null,
    };

    if (bagian) whereClause.bagian = bagian;

    // Load completed requests with ApprovalHistory for Verifikasi Lapangan step
    let completedRequests;

    if (tanggal) {
      // If tanggal is provided, we need to filter by approval date of "Verifikasi Lapangan" step
      const parsedStartIso = jakartaTime.parseJakartaLocal(`${tanggal}T00:00:00`);
      const parsedEndIso = jakartaTime.parseJakartaLocal(`${tanggal}T23:59:59`);
      const start = parsedStartIso ? new Date(parsedStartIso) : new Date(`${tanggal}T00:00:00+07:00`);
      const end = parsedEndIso ? new Date(parsedEndIso) : new Date(`${tanggal}T23:59:59+07:00`);

      completedRequests = await PermohonanPemusnahanLimbah.findAll({
        where: { ...whereClause },
        include: [
          { model: DetailLimbah },
          { model: GolonganLimbah },
          { model: JenisLimbahB3 },
          {
            model: ApprovalHistory,
            include: [
              {
                model: ApprovalWorkflowStep,
                where: {
                  step_level: 3, // Verifikasi Lapangan is step_level 3
                  step_name: "Verifikasi Lapangan",
                },
              },
            ],
            where: {
              status: "Approved",
              decision_date: { [Op.between]: [start, end] },
            },
            required: true, // INNER JOIN to ensure we only get requests with approved Verifikasi Lapangan on this date
          },
        ],
        order: [["created_at", "DESC"]],
      });
    } else {
      // If no tanggal filter, load all completed requests with ApprovalHistory (for consistent data structure)
      completedRequests = await PermohonanPemusnahanLimbah.findAll({
        where: { ...whereClause },
        include: [
          { model: DetailLimbah },
          { model: GolonganLimbah },
          { model: JenisLimbahB3 },
          {
            model: ApprovalHistory,
            include: [
              {
                model: ApprovalWorkflowStep,
                where: {
                  step_level: 3, // Verifikasi Lapangan is step_level 3
                  step_name: "Verifikasi Lapangan",
                },
              },
            ],
            where: {
              status: "Approved",
            },
            required: false, // LEFT JOIN to include requests even if they don't have Verifikasi Lapangan approval yet
          },
        ],
        order: [["created_at", "DESC"]],
      });
    }

    // Bulk-fetch signing histories for any requests that are already linked to a Berita Acara
    const beritaIds = Array.from(new Set(completedRequests.map((r) => r.berita_acara_id).filter(Boolean)));
    let signingHistoriesByBerita = {};
    if (beritaIds.length > 0) {
      const signingHistories = await SigningHistory.findAll({ where: { berita_acara_id: beritaIds } });
      signingHistoriesByBerita = signingHistories.reduce((acc, h) => {
        const key = h.berita_acara_id;
        acc[key] = acc[key] || [];
        acc[key].push(h);
        return acc;
      }, {});
    }

    // Since we already filtered by Verifikasi Lapangan approval date in the query above,
    // we don't need additional filtering here
    let filteredRequests = completedRequests;

    // Map and aggregate data for frontend consumption
    const mapped = filteredRequests.map((reqItem) => {
      const details = reqItem.DetailLimbahs || reqItem.DetailLimbah || [];
      const jumlahItem = reqItem.jumlah_item || (details ? details.length : 0);
      const bobotTotal = details ? details.reduce((s, d) => s + parseFloat(d.bobot || 0), 0) : 0;
      const alasanPemusnahan =
        details && details.length > 0
          ? details
              .map((d) => d.alasan_pemusnahan)
              .filter(Boolean)
              .join("; ")
          : "";

      // Determine verification timestamp for info
      // If we have ApprovalHistory for Verifikasi Lapangan, use the decision_date
      // Otherwise fall back to SigningHistory or updated_at
      let verificationTimestamp = reqItem.created_at;

      if (reqItem.ApprovalHistories && reqItem.ApprovalHistories.length > 0) {
        // Find the Verifikasi Lapangan approval
        const verifikasiApproval = reqItem.ApprovalHistories.find(
          (ah) =>
            ah.ApprovalWorkflowStep &&
            ah.ApprovalWorkflowStep.step_level === 3 &&
            ah.ApprovalWorkflowStep.step_name === "Verifikasi Lapangan"
        );
        if (verifikasiApproval && verifikasiApproval.decision_date) {
          verificationTimestamp = new Date(verifikasiApproval.decision_date);
        }
      } else {
        // Fallback to existing logic for older records or when no ApprovalHistory is loaded
        const histories = signingHistoriesByBerita[reqItem.berita_acara_id] || [];
        let latestSigned = null;
        if (Array.isArray(histories) && histories.length > 0) {
          latestSigned = histories.reduce((latest, h) => {
            const d = h.signed_at ? new Date(h.signed_at) : null;
            if (!d) return latest;
            return !latest || d > latest ? d : latest;
          }, null);
        }
        verificationTimestamp =
          reqItem.status === "Completed" && reqItem.updated_at
            ? new Date(reqItem.updated_at)
            : latestSigned || reqItem.created_at;
      }

      return {
        request_id: reqItem.request_id,
        noPermohonan: reqItem.nomor_permohonan || "",
        bagian: reqItem.bagian,
        bentukLimbah: reqItem.bentuk_limbah,
        golonganLimbah: reqItem.GolonganLimbah ? reqItem.GolonganLimbah.nama : null,
        jenisLimbah: reqItem.JenisLimbahB3 ? reqItem.JenisLimbahB3.nama : null,
        jumlahItem,
        bobotTotal: Number(bobotTotal.toFixed ? bobotTotal.toFixed(2) : bobotTotal),
        alasanPemusnahan,
        verificationTimestamp,
      };
    });

    res.status(200).json({
      success: true,
      data: mapped,
      message: `${mapped.length} completed requests available for daily log generation.`,
    });
  } catch (error) {
    console.error("Error fetching available requests:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching available requests for daily log",
      error: error.message,
    });
  }
};

/**
 * Creates a new Berita Acara by bundling selected 'Completed' requests
 * that have not yet been assigned to a Berita Acara.
 * HSE Supervisor/Officer will be shown the list of requests before publishing.
 * No draft status - immediately moves to signing workflow.
 */
const createBeritaAcara = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { bagian, tanggal, waktu, lokasi_verifikasi, selectedRequestIds } = req.body;
    const { user, delegatedUser } = req;

    // Validate authenticated user presence
    if (!user || !(user.log_NIK || user.emp_NIK || user.log_nik)) {
      await transaction.rollback();
      console.error("createBeritaAcara: missing authenticated user or NIK on request");
      return res.status(401).json({ message: "Unauthorized: missing user identity" });
    }

    // Authorization: only users that appear in external API as Appr_No=1 and Appr_DeptID='KL' (Supervisor/Officer HSE)
    try {
      const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
      const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];
      const beritaItems = items.filter(
        (i) => String(i.Appr_ApplicationCode || "") === "ePengelolaan_Limbah_Berita_Acara"
      );
      const creatorNik = user && (user.log_NIK || user.emp_NIK || user.log_nik);
      const creatorEntries = beritaItems.filter((it) => String(it.Appr_ID) === String(creatorNik));
      const isCreatorAllowed = creatorEntries.some(
        (e) => Number(e.Appr_No) === 1 && String((e.Appr_DeptID || "").toUpperCase()) === "KL"
      );
      if (!isCreatorAllowed) {
        await transaction.rollback();
        return res
          .status(403)
          .json({ message: "You are not authorized to create Berita Acara. Only HSE Supervisor/Officer may create." });
      }
    } catch (err) {
      // If external API fails, deny by default for safety (could be changed to fallback DB allow list)
      console.warn("External approval API failed when checking Berita Acara creator:", err.message || err);
      await transaction.rollback();
      return res
        .status(503)
        .json({ message: "Unable to verify creator authorization at this time. Please try again later." });
    }

    // Basic server-side validation for required fields from the form
    if (!bagian || !tanggal || !waktu || !lokasi_verifikasi) {
      await transaction.rollback();
      return res
        .status(400)
        .json({ message: "Missing required fields: bagian, tanggal, waktu, or lokasi_verifikasi." });
    }

    // Parse and validate tanggal and waktu into Date objects before proceeding.
    let tanggalDate = null;
    let waktuDate = null;
    // Robust parsing: treat 'tanggal' (YYYY-MM-DD) as local date components
    const parseLocalDate = (dstr) => {
      const iso = jakartaTime.parseJakartaLocal(String(dstr));
      return iso ? new Date(iso) : null;
    };

    const parseLocalDateTime = (dtstr) => {
      const iso = jakartaTime.parseJakartaLocal(String(dtstr));
      return iso ? new Date(iso) : null;
    };

    tanggalDate = parseLocalDate(tanggal);
    waktuDate = parseLocalDateTime(waktu);

    // Common client bug: times like '2025-09-26T15:09:52:00' (extra ':00')
    // are invalid ISO strings. Attempt to auto-fix by stripping a trailing ':00'.
    if (waktuDate && isNaN(waktuDate.getTime())) {
      if (typeof waktu === "string" && waktu.endsWith(":00")) {
        const fixed = waktu.replace(/:00$/, "");
        const parsed = new Date(fixed);
        if (!isNaN(parsed.getTime())) waktuDate = parsed;
      }
    }

    if (!tanggalDate || isNaN(tanggalDate.getTime())) {
      await transaction.rollback();
      return res.status(400).json({ message: "Invalid tanggal format. Expected YYYY-MM-DD or ISO date." });
    }

    if (!waktuDate || isNaN(waktuDate.getTime())) {
      await transaction.rollback();
      return res
        .status(400)
        .json({ message: "Invalid waktu format. Expected ISO datetime (e.g. 2025-09-26T15:09:52)." });
    }

    // 1. Find selected completed requests that don't have a Berita Acara yet.
    let completedRequests;
    if (selectedRequestIds && selectedRequestIds.length > 0) {
      // Use selected requests if provided
      completedRequests = await PermohonanPemusnahanLimbah.findAll({
        where: {
          request_id: selectedRequestIds,
          status: "Completed",
          berita_acara_id: null,
        },
        include: [{ model: GolonganLimbah }, { model: JenisLimbahB3 }],
        transaction,
      });
    } else {
      // Get all available completed requests if none selected
      completedRequests = await PermohonanPemusnahanLimbah.findAll({
        where: {
          status: "Completed",
          berita_acara_id: null,
        },
        include: [{ model: GolonganLimbah }, { model: JenisLimbahB3 }],
        transaction,
      });
    }

    if (completedRequests.length === 0) {
      await transaction.rollback();
      return res.status(404).json({ message: "No completed requests found to generate a Berita Acara." });
    }

    // Find the latest completed request (by created_at) to extract verification data
    const latestRequest = completedRequests.reduce((latest, current) => {
      if (!latest) return current;
      const latestDate = new Date(latest.created_at);
      const currentDate = new Date(current.created_at);
      return currentDate > latestDate ? current : latest;
    }, null);

    // Fetch approval history for the latest request to get verification field data
    let pelaksana_bagian = null;
    let supervisor_bagian = null;
    let pelaksana_hse = null;
    let supervisor_hse = null;

    if (latestRequest) {
      const approvalHistories = await ApprovalHistory.findAll({
        where: {
          request_id: latestRequest.request_id,
          status: "Approved",
        },
        include: [
          {
            model: ApprovalWorkflowStep,
            where: {
              step_name: "Verifikasi Lapangan",
            },
          },
        ],
        transaction,
      });

      // Extract verifier data based on roles
      approvalHistories.forEach((h) => {
        const jabatan = h.approver_jabatan || "";
        const approverName = h.approver_name || "";

        if (jabatan.includes("VERIF_ROLE:1")) {
          pelaksana_bagian = approverName;
        } else if (jabatan.includes("VERIF_ROLE:2")) {
          supervisor_bagian = approverName;
        } else if (jabatan.includes("VERIF_ROLE:3")) {
          pelaksana_hse = approverName;
        } else if (jabatan.includes("VERIF_ROLE:4")) {
          supervisor_hse = approverName;
        }
      });
    }

    // Determine the appropriate signing workflow based on the requests
    const signingWorkflowId = await determineSigningWorkflow(completedRequests);

    // Find the first actual signing step (should be the lowest step_level, typically level 2)
    const firstSigningStep = await SigningWorkflowStep.findOne({
      where: {
        signing_workflow_id: signingWorkflowId,
        step_level: { [require("sequelize").Op.gte]: 2 }, // Only consider actual signing steps (level >= 2)
      },
      order: [["step_level", "ASC"]], // Get the lowest level first
      transaction,
    });

    if (!firstSigningStep) {
      await transaction.rollback();
      return res.status(500).json({
        message: "Signing workflow configuration error: no steps found for this workflow",
      });
    }

    // 2. Create the new Berita Acara record
    const beritaPayload = {
      bagian,
      // Store Jakarta-local timestamps explicitly by converting back to Date from Jakarta ISO
      tanggal: tanggalDate ? new Date(jakartaTime.formatJakartaISO(tanggalDate)) : null,
      waktu: waktuDate ? new Date(jakartaTime.formatJakartaISO(waktuDate)) : null,
      lokasi_verifikasi,
      // Auto-fill from latest request's verification data
      pelaksana_bagian: pelaksana_bagian || null,
      supervisor_bagian: supervisor_bagian || null,
      pelaksana_hse: pelaksana_hse || null,
      supervisor_hse: supervisor_hse || null,
      signing_workflow_id: signingWorkflowId,
      // Set to first signing step directly (step_level 2)
      current_signing_step_id: firstSigningStep.step_id,
      status: "InProgress",
      // Snapshot the user creating this event
      creator_id: user.log_NIK,
      creator_name: user.Nama,
      creator_jabatan: user.Jabatan,
      creator_dept_id: user.emp_DeptID,
      creator_job_level_id: user.emp_JobLevelID,
      creator_id_delegated: delegatedUser ? delegatedUser.log_NIK : null,
      creator_name_delegated: delegatedUser ? delegatedUser.Nama : null,
      creator_jabatan_delegated: delegatedUser ? delegatedUser.Jabatan : null,
      creator_dept_id_delegated: delegatedUser ? delegatedUser.emp_DeptID : null,
      creator_job_level_id_delegated: delegatedUser ? delegatedUser.emp_JobLevelID : null,
    };

    const beritaAcara = await BeritaAcara.create(beritaPayload, { transaction });

    // 3. Link all the completed requests to this new Berita Acara.
    const requestIds = completedRequests.map((req) => req.request_id);
    await PermohonanPemusnahanLimbah.update(
      { berita_acara_id: beritaAcara.berita_acara_id },
      { where: { request_id: requestIds }, transaction }
    );

    // If all steps were successful, commit the transaction.
    await transaction.commit();

    res.status(201).json({
      message: `Berita Acara created successfully and linked to ${completedRequests.length} requests.`,
      data: beritaAcara,
    });
  } catch (error) {
    // If any step fails, roll back all changes.
    await transaction.rollback();
    try {
      const errDetails = {
        name: error.name,
        message: error.message,
        errors: Array.isArray(error.errors)
          ? error.errors.map((e) => ({ message: e.message, path: e.path, value: e.value }))
          : undefined,
        stack: error.stack,
      };
      console.error("Failed to create Berita Acara:", JSON.stringify(errDetails, null, 2));
    } catch (logErr) {
      console.error("Failed to create Berita Acara (and failed to serialize error):", error, logErr);
    }

    res.status(500).json({ message: "Error creating Berita Acara", error: error.message });
  }
};

/**
 * GET /berita-acara -> List all Berita Acara events with pagination.
 */
const getAllBeritaAcara = async (req, res) => {
  try {
    // Note: Renamed search/column to match frontend component
    const { page = 1, limit = 8, searchTerm = "", selectedColumn = "" } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // --- SEARCH LOGIC (Corrected) ---
    const whereClause = {};
    if (searchTerm && selectedColumn) {
      const searchCondition = { [Op.iLike]: `%${searchTerm}%` };

      // Search in a specific column using explicit if-else conditions
      if (selectedColumn === 'tanggal') {
        whereClause.tanggal = searchCondition;
      } else if (selectedColumn === 'bagian') {
        whereClause.bagian = searchCondition;
      } else if (selectedColumn === 'lokasi_verifikasi') {
        whereClause.lokasi_verifikasi = searchCondition;
      } else if (selectedColumn === 'status') {
        whereClause.status = searchCondition;
      }
    }

    const queryOptions = {
      limit: parseInt(limit),
      offset: offset,
      order: [["tanggal", "DESC"]],
      where: whereClause,
      distinct: true, // Count distinct BeritaAcara records only, not joined rows
      include: [
        {
          model: SigningWorkflow,
          include: [
            {
              model: SigningWorkflowStep,
              include: [SigningWorkflowSigner], // Include signers for all steps in list view too
              order: [["step_level", "ASC"]],
            },
          ],
        },
        { model: SigningWorkflowStep, include: [SigningWorkflowSigner] },
      ],
    };

    const { count, rows: events } = await BeritaAcara.findAndCountAll(queryOptions);

    const totalPages = Math.ceil(count / parseInt(limit));

    // --- TRANSFORMATION LOGIC (from your original file) ---
    const transformed = events.map((ev) => {
      const e = ev.toJSON ? ev.toJSON() : ev;
      let steps = [];
      if (e.SigningWorkflow && Array.isArray(e.SigningWorkflow.SigningWorkflowSteps)) {
        steps = e.SigningWorkflow.SigningWorkflowSteps.map((s) => ({
          step_id: s.step_id,
          step_level: s.step_level,
          status: "pending",
        }));
      }

      let current_step_level = null;
      if (e.current_signing_step_id) {
        const matching = steps.find((s) => s.step_id === e.current_signing_step_id);
        if (matching) {
          current_step_level = matching.step_level; // Use the actual step level without any transformation
        }
      }

      return {
        ...e,
        id: e.berita_acara_id, // Add an 'id' field for the frontend key
        currentStepLevel: current_step_level, // Match frontend property name
        SigningWorkflowSteps: steps,
      };
    });
    // --- END TRANSFORMATION ---

    res.status(200).json({
      success: true,
      data: transformed, // Use the correct variable name
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: totalPages,
      },
    });
  } catch (error) {
    console.error("Error fetching berita acara list:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching Berita Acara list",
      error: error.message,
    });
  }
};

/**
 * GET /berita-acara/:id -> Get details of a single Berita Acara.
 */
const getBeritaAcaraById = async (req, res) => {
  try {
    const { id } = req.params;

    // Load Berita Acara with related data (using DB-only approach like permohonanController)
    const event = await BeritaAcara.findByPk(id, {
      include: [
        // Include the linked Permohonan requests
        {
          model: PermohonanPemusnahanLimbah,
          include: [{ model: DetailLimbah }, { model: GolonganLimbah }, { model: JenisLimbahB3 }],
        },
        // Include the signing workflow and steps with signers
        {
          model: SigningWorkflow,
          include: [
            {
              model: SigningWorkflowStep,
              include: [SigningWorkflowSigner], // Include signers for all steps
              order: [["step_level", "ASC"]],
            },
          ],
        },
        // Include the current signing step details
        {
          model: SigningWorkflowStep,
          include: [SigningWorkflowSigner],
        },
      ],
    });

    if (!event) {
      return res.status(404).json({ message: "Berita Acara not found" });
    }

    // Get signing history for this berita acara
    const signingHistory = await SigningHistory.findAll({
      where: { berita_acara_id: id },
      order: [["signed_at", "DESC"]],
    });

    // Build workflow steps by integrating external API data with database workflow (like approval workflow)
    let workflowSteps = [];

    try {
      // Try external API first to get signer data
      const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
      const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];

      // Filter items for ePengelolaan_Limbah_Berita_Acara application code
      const appCode = "ePengelolaan_Limbah_Berita_Acara";
      const appItems = items.filter((i) => String(i.Appr_ApplicationCode || "") === appCode);

      if (appItems.length > 0 && event.SigningWorkflow && Array.isArray(event.SigningWorkflow.SigningWorkflowSteps)) {
        // Group external items by step number
        const grouped = {};
        appItems.forEach((it) => {
          const step = it.Appr_No != null ? String(it.Appr_No) : "0";
          grouped[step] = grouped[step] || [];
          grouped[step].push(it);
        });

        workflowSteps = event.SigningWorkflow.SigningWorkflowSteps.map((step) => {
          // Find signing history for this step
          const stepHistory = signingHistory.filter((h) => h.step_id === step.step_id);

          // Get external signers for this step level
          const externalSigners = grouped[String(step.step_level)] || [];
          let filteredSigners = externalSigners;

          // Apply department filtering based on step level and business logic
          const bagian = (event.bagian || event.creator_dept_id || "").toString().toUpperCase();

          if (step.step_level === 2) {
            // HSE Manager - filter by KL department
            const byDept = externalSigners.filter((a) => String(a.Appr_DeptID || "").toUpperCase() === "KL");
            if (byDept.length > 0) filteredSigners = byDept;
          } else if (step.step_level === 3) {
            // APJ/Department Manager - filter based on golongan and business logic
            const golonganNames = new Set();
            let hasProdukPangan = false;

            if (event.PermohonanPemusnahanLimbahs) {
              event.PermohonanPemusnahanLimbahs.forEach((p) => {
                const golonganName = String(p.GolonganLimbah?.nama || "").toLowerCase();
                if (golonganName) golonganNames.add(golonganName);

                // Only consider isProdukPangan for pure Recall (not Recall & Prekursor)
                if (
                  p.is_produk_pangan === true &&
                  golonganName.includes("recall") &&
                  !golonganName.includes("prekursor")
                ) {
                  hasProdukPangan = true;
                }
              });
            }

            const hasPrecursor = Array.from(golonganNames).some((n) => n.includes("prekursor") || n.includes("oot"));
            const hasRecall = Array.from(golonganNames).some((n) => n.includes("recall"));
            const hasRecallPrecursor = Array.from(golonganNames).some(
              (n) => n.includes("recall") && n.includes("prekursor")
            );

            let requiredDepts = [];

            if (hasRecallPrecursor) {
              requiredDepts = ["PN1", "QA"];
            } else if (hasPrecursor) {
              requiredDepts = ["PN1"];
            } else if (hasRecall) {
              if (hasProdukPangan) {
                requiredDepts = ["QA", "HC"];
              } else {
                requiredDepts = ["QA"];
              }
            } else if (bagian) {
              // Standard workflow - Department Manager based on bagian
              requiredDepts = [bagian];
            }

            if (requiredDepts.length > 0) {
              const matches = externalSigners.filter((a) =>
                requiredDepts.includes(String(a.Appr_DeptID || "").toUpperCase())
              );
              if (matches.length > 0) {
                filteredSigners = matches;
              }
            }
          } else if (step.step_level === 4) {
            // Head of Plant - filter by PL department
            const byDept = externalSigners.filter((a) => String(a.Appr_DeptID || "").toUpperCase() === "PL");
            if (byDept.length > 0) filteredSigners = byDept;
          }

          // For APJ step (level 3), check role-based completion
          if (step.step_level === 3 && step.required_signatures > 1) {
            const signedRoles = new Set();
            stepHistory.forEach((h) => {
              const jab = h.signer_jabatan || "";
              const m = jab.match(/APJ_ROLE:(\w+)/);
              if (m && m[1]) signedRoles.add(m[1]);
            });

            // Determine required APJ roles based on golongan
            const requiredApjRoles = [];
            const golonganNames = new Set();
            let hasProdukPangan = false;

            if (event.PermohonanPemusnahanLimbahs) {
              event.PermohonanPemusnahanLimbahs.forEach((p) => {
                const golonganName = String(p.GolonganLimbah?.nama || "").toLowerCase();
                if (golonganName) golonganNames.add(golonganName);

                // Only consider isProdukPangan for pure Recall (not Recall & Prekursor)
                if (
                  p.is_produk_pangan === true &&
                  golonganName.includes("recall") &&
                  !golonganName.includes("prekursor")
                ) {
                  hasProdukPangan = true;
                }
              });

              const hasPrecursor = Array.from(golonganNames).some((n) => n.includes("prekursor") || n.includes("oot"));
              const hasRecall = Array.from(golonganNames).some((n) => n.includes("recall"));
              const hasRecallPrecursor = Array.from(golonganNames).some(
                (n) => n.includes("recall") && n.includes("prekursor")
              );

              if (hasRecallPrecursor) {
                requiredApjRoles.push("PN", "QA");
              } else if (hasPrecursor) {
                requiredApjRoles.push("PN");
              } else if (hasRecall) {
                if (hasProdukPangan) {
                  requiredApjRoles.push("QA", "HC");
                } else {
                  requiredApjRoles.push("QA");
                }
              }
            }

            const allRequiredRolesSigned = requiredApjRoles.every((role) => signedRoles.has(role));
            const isStepSigned = allRequiredRolesSigned && stepHistory.length >= (step.required_signatures || 1);

            const latest =
              stepHistory.length > 0
                ? stepHistory.reduce((acc, cur) => {
                    const d = cur.signed_at ? new Date(cur.signed_at) : null;
                    if (!acc) return cur;
                    const ad = acc.signed_at ? new Date(acc.signed_at) : null;
                    if (!ad) return cur;
                    return d && ad && d > ad ? cur : acc;
                  }, null)
                : null;

            return {
              step_id: step.step_id,
              step_level: step.step_level,
              action_type: "Menandatangani",
              step_name: step.step_name,
              signer_name: isStepSigned && latest ? latest.signer_name || latest.signer_name_delegated || null : null,
              signer_id: isStepSigned && latest ? latest.signer_id : null,
              signed_at: isStepSigned && latest ? latest.signed_at : null,
              status: isStepSigned ? "signed" : "pending",
              comments: isStepSigned && latest ? latest.comments : null,
              required_signatures: step.required_signatures || 1,
              // Use external API data with individual signer status from history
              signers: filteredSigners.map((s) => {
                const signerHistory = stepHistory.find((h) => h.signer_id === s.Appr_ID);
                return {
                  log_nik: s.Appr_ID,
                  signer_name: s.emp_Name,
                  signer_dept_id: s.Appr_DeptID,
                  signer_cc: s.Appr_CC,
                  signed_at: signerHistory ? signerHistory.signed_at : null,
                  status: signerHistory ? "signed" : "pending",
                  comments: signerHistory ? signerHistory.comments : null,
                };
              }),
            };
          } else {
            // Other steps: use simple history lookup
            const stepSigned = stepHistory.length >= (step.required_signatures || 1);
            const latest = stepHistory.length > 0 ? stepHistory[0] : null;

            return {
              step_id: step.step_id,
              step_level: step.step_level,
              action_type: "Menandatangani",
              step_name: step.step_name,
              signer_name: stepSigned && latest ? latest.signer_name || latest.signer_name_delegated || null : null,
              signer_id: stepSigned && latest ? latest.signer_id : null,
              signed_at: stepSigned && latest ? latest.signed_at : null,
              status: stepSigned ? "signed" : "pending",
              comments: stepSigned && latest ? latest.comments : null,
              required_signatures: step.required_signatures || 1,
              // Use external API data with individual signer status from history
              signers: filteredSigners.map((s) => {
                const signerHistory = stepHistory.find((h) => h.signer_id === s.Appr_ID);
                return {
                  log_nik: s.Appr_ID,
                  signer_name: s.emp_Name,
                  signer_dept_id: s.Appr_DeptID,
                  signer_cc: s.Appr_CC,
                  signed_at: signerHistory ? signerHistory.signed_at : null,
                  status: signerHistory ? "signed" : "pending",
                  comments: signerHistory ? signerHistory.comments : null,
                };
              }),
            };
          }
        });
      } else {
        throw new Error("External API data not available or empty");
      }
    } catch (externalError) {
      console.warn(
        "[getBeritaAcaraById] External API failed, falling back to database signers:",
        externalError.message
      );

      // Fallback to database-only workflow steps
      if (event.SigningWorkflow && Array.isArray(event.SigningWorkflow.SigningWorkflowSteps)) {
        workflowSteps = event.SigningWorkflow.SigningWorkflowSteps.map((step) => {
          // Find signing history for this step
          const stepHistory = signingHistory.filter((h) => h.step_id === step.step_id);

          // For APJ step (level 3), check role-based completion
          if (step.step_level === 3 && step.required_signatures > 1) {
            const signedRoles = new Set();
            stepHistory.forEach((h) => {
              const jab = h.signer_jabatan || "";
              const m = jab.match(/APJ_ROLE:(\w+)/);
              if (m && m[1]) signedRoles.add(m[1]);
            });

            // Determine required APJ roles based on golongan
            const requiredApjRoles = [];
            if (event.PermohonanPemusnahanLimbahs) {
              const golonganNames = new Set();
              let hasProdukPangan = false;

              event.PermohonanPemusnahanLimbahs.forEach((p) => {
                const golonganName = String(p.GolonganLimbah?.nama || "").toLowerCase();
                if (golonganName) golonganNames.add(golonganName);

                // Only consider isProdukPangan for pure Recall (not Recall & Prekursor)
                if (
                  p.is_produk_pangan === true &&
                  golonganName.includes("recall") &&
                  !golonganName.includes("prekursor")
                ) {
                  hasProdukPangan = true;
                }
              });

              const hasPrecursor = Array.from(golonganNames).some((n) => n.includes("prekursor") || n.includes("oot"));
              const hasRecall = Array.from(golonganNames).some((n) => n.includes("recall"));
              const hasRecallPrecursor = Array.from(golonganNames).some(
                (n) => n.includes("recall") && n.includes("prekursor")
              );

              if (hasRecallPrecursor) {
                requiredApjRoles.push("PN", "QA");
              } else if (hasPrecursor) {
                requiredApjRoles.push("PN");
              } else if (hasRecall) {
                if (hasProdukPangan) {
                  requiredApjRoles.push("QA", "HC");
                } else {
                  requiredApjRoles.push("QA");
                }
              }
            }

            const allRequiredRolesSigned = requiredApjRoles.every((role) => signedRoles.has(role));
            const isStepSigned = allRequiredRolesSigned && stepHistory.length >= (step.required_signatures || 1);

            const latest =
              stepHistory.length > 0
                ? stepHistory.reduce((acc, cur) => {
                    const d = cur.signed_at ? new Date(cur.signed_at) : null;
                    if (!acc) return cur;
                    const ad = acc.signed_at ? new Date(acc.signed_at) : null;
                    if (!ad) return cur;
                    return d && ad && d > ad ? cur : acc;
                  }, null)
                : null;

            return {
              step_id: step.step_id,
              step_level: step.step_level,
              action_type: "Menandatangani",
              step_name: step.step_name,
              signer_name: isStepSigned && latest ? latest.signer_name || latest.signer_name_delegated || null : null,
              signer_id: isStepSigned && latest ? latest.signer_id : null,
              signed_at: isStepSigned && latest ? latest.signed_at : null,
              status: isStepSigned ? "signed" : "pending",
              comments: isStepSigned && latest ? latest.comments : null,
              required_signatures: step.required_signatures || 1,
              signers: (step.SigningWorkflowSigners || []).map((s) => {
                const signerHistory = stepHistory.find((h) => h.signer_id === s.log_nik);
                return {
                  log_nik: s.log_nik,
                  signer_name: s.signer_name,
                  signer_dept_id: s.signer_dept_id,
                  signer_cc: s.signer_cc,
                  signed_at: signerHistory ? signerHistory.signed_at : null,
                  status: signerHistory ? "signed" : "pending",
                  comments: signerHistory ? signerHistory.comments : null,
                };
              }),
            };
          } else {
            // Other steps: use simple history lookup
            const stepSigned = stepHistory.length >= (step.required_signatures || 1);
            const latest = stepHistory.length > 0 ? stepHistory[0] : null;

            return {
              step_id: step.step_id,
              step_level: step.step_level,
              action_type: "Menandatangani",
              step_name: step.step_name,
              signer_name: stepSigned && latest ? latest.signer_name || latest.signer_name_delegated || null : null,
              signer_id: stepSigned && latest ? latest.signer_id : null,
              signed_at: stepSigned && latest ? latest.signed_at : null,
              status: stepSigned ? "signed" : "pending",
              comments: stepSigned && latest ? latest.comments : null,
              required_signatures: step.required_signatures || 1,
              signers: (step.SigningWorkflowSigners || []).map((s) => {
                const signerHistory = stepHistory.find((h) => h.signer_id === s.log_nik);
                return {
                  log_nik: s.log_nik,
                  signer_name: s.signer_name,
                  signer_dept_id: s.signer_dept_id,
                  signer_cc: s.signer_cc,
                  signed_at: signerHistory ? signerHistory.signed_at : null,
                  status: signerHistory ? "signed" : "pending",
                  comments: signerHistory ? signerHistory.comments : null,
                };
              }),
            };
          }
        });
      }
    }

    // Attach constructed SigningWorkflowSteps to the event payload
    const result = event.toJSON ? event.toJSON() : event;
    result.SigningWorkflowSteps = workflowSteps;

    // Determine current status and step
    const pendingSteps = workflowSteps
      .filter((s) => s.status === "pending" && s.step_level >= 2)
      .sort((a, b) => a.step_level - b.step_level); // Sort by step_level ascending to get the lowest level first

    if (pendingSteps.length === 0 && workflowSteps.length > 0) {
      result.status = "Completed";
      result.current_signing_step_id = null;
    } else if (pendingSteps.length > 0) {
      result.status = "InProgress";
      result.current_signing_step_id = pendingSteps[0].step_id; // Now this will be the lowest pending step
    }

    // Compute current_step_level
    let current_step_level = null;
    if (result.current_signing_step_id) {
      const matching = workflowSteps.find((s) => s.step_id === result.current_signing_step_id);
      if (matching) current_step_level = matching.step_level;
    }
    if (!current_step_level && workflowSteps.length > 0) {
      // Find the lowest pending step (same logic as pendingSteps above)
      const pendingStep = workflowSteps
        .filter((s) => s.status === "pending" && s.step_level >= 2)
        .sort((a, b) => a.step_level - b.step_level)[0];
      current_step_level = pendingStep ? pendingStep.step_level : null;
    }

    // Determine can_sign using consistent authorization logic (like approval workflow)
    let can_sign = false;
    if (result.current_signing_step_id && req.user) {
      try {
        can_sign = await checkSigningAuthorization(req.user, result);
      } catch (authError) {
        console.warn("[getBeritaAcaraById] Authorization check failed:", authError.message);
        can_sign = false;
      }
    }

    result.current_step_level = current_step_level;
    result.can_sign = !!can_sign;

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("Error fetching Berita Acara detail:", error);
    res.status(500).json({ message: "Error fetching Berita Acara detail", error: error.message });
  }
};

/**
 * POST /berita-acara/:id/approve -> Sign a Berita Acara at its current step.
 * In this context, "approve" means "sign".
 */
const signBeritaAcara = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;

    const { user, delegatedUser } = req;
    // Follow the same semantics as approvePermohonan:
    // - Authorization: use the actual logged-in user (`user`) to check if they have signing authority
    // - Acting user (for audit/history snapshots): delegatedUser if present, otherwise user
    const authorizingUser = user; // who is authorized (logged-in)
    const actingUser = delegatedUser || user; // who is being acted-as (for snapshots)

    const event = await BeritaAcara.findByPk(id, {
      include: [{ model: SigningWorkflowStep, include: [SigningWorkflowSigner] }],
      transaction,
    });

    if (!event) {
      await transaction.rollback();
      return res.status(404).json({ message: "Berita Acara not found" });
    }

    // Ensure we have a reference to the current signing step object
    // so downstream logic can safely access required_signatures and step_level
    // regardless of whether external approval API succeeds or not.
    let currentStep = event.SigningWorkflowStep;
    // If currentStep doesn't match the current_signing_step_id, fetch the correct step
    if (!currentStep || currentStep.step_id !== event.current_signing_step_id) {
      currentStep = await SigningWorkflowStep.findByPk(event.current_signing_step_id, {
        include: [SigningWorkflowSigner],
        transaction,
      });
    }

    // Load linked PermohonanPemusnahanLimbah items (with GolonganLimbah) so
    // we can determine golongan-based rules (e.g., whether PL approval is required)
    // and compute dynamic required signatures correctly. Use the same transaction
    // to keep reads consistent.
    try {
      const relatedRequests = await PermohonanPemusnahanLimbah.findAll({
        where: { berita_acara_id: event.berita_acara_id },
        include: [{ model: GolonganLimbah }],
        transaction,
      });
      // Attach to event so later logic that expects event.PermohonanPemusnahanLimbahs can use it
      event.PermohonanPemusnahanLimbahs = relatedRequests || [];
    } catch (loadReqErr) {
      // Non-fatal: we'll continue but dynamic computations may fall back to defaults
      console.warn("Failed to load related permohonan items for Berita Acara:", loadReqErr.message || loadReqErr);
      event.PermohonanPemusnahanLimbahs = event.PermohonanPemusnahanLimbahs || [];
    }

    // Authorization: use consistent signing authorization logic (like approval workflow)
    const isSigner = await checkSigningAuthorization(authorizingUser, event);

    if (!isSigner) {
      // Log details for easier debugging during development
      console.warn("Unauthorized sign attempt for Berita Acara", {
        berita_acara_id: event.berita_acara_id,
        current_signing_step_id: event.current_signing_step_id,
        authorizingUser: authorizingUser && authorizingUser.log_NIK,
      });
      await transaction.rollback();
      return res.status(403).json({ message: "You are not authorized to sign this document at the current step." });
    }

    // Check if this authorizing user has already signed this step
    const existingSignature = await SigningHistory.findOne({
      where: {
        berita_acara_id: event.berita_acara_id,
        step_id: event.current_signing_step_id,
        signer_id: authorizingUser.log_NIK,
      },
      transaction,
    });

    // DEBUG: Log existing signature check

    if (existingSignature) {
      await transaction.rollback();
      return res.status(400).json({ message: "You have already signed this document at the current step." });
    }

    // Get current step level for role determination
    const currentStepLevel = event.SigningWorkflowStep ? event.SigningWorkflowStep.step_level : null;

    // Determine the role marker for APJ signing
    let signerJabatan = authorizingUser.Jabatan;
    let apjRoleForHistory = null;

    // Determine APJ role for step 3 signing history (consistent with approval workflow)
    if (currentStepLevel === 3) {
      try {
        const axios = require("axios");
        const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
        const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];
        const appItems = items.filter(
          (i) => String(i.Appr_ApplicationCode || "") === "ePengelolaan_Limbah_Berita_Acara"
        );

        const authorizingNik = authorizingUser.log_NIK;
        const userApprovals = appItems.filter(
          (item) => String(item.Appr_ID) === String(authorizingNik) && Number(item.Appr_No) === 3
        );

        if (userApprovals.length > 0) {
          const dept = (userApprovals[0].Appr_DeptID || "").toString().toUpperCase();

          // Simple role determination based on department
          if (dept === "PN1") apjRoleForHistory = "APJ_ROLE:PN";
          else if (dept === "QA") apjRoleForHistory = "APJ_ROLE:QA";
          else if (dept === "HC") apjRoleForHistory = "APJ_ROLE:HC";
        }
      } catch (err) {
        console.warn("Failed to determine APJ role for signing history:", err.message);
      }

      if (apjRoleForHistory) {
        signerJabatan = `${authorizingUser.Jabatan}|${apjRoleForHistory}`;
      }
    }

    // Use the current step_id (following permohonanController pattern)
    // Role differentiation is handled via signer_jabatan markers
    let signingStepId = event.current_signing_step_id;

    // Record the signature in the history. Snapshot both the authorizing user and delegated user (if any)
    await SigningHistory.create(
      {
        berita_acara_id: event.berita_acara_id,
        step_id: signingStepId,
        // --- Signer (authorizing user) Details ---
        signer_id: authorizingUser.log_NIK,
        signer_name: authorizingUser.Nama,
        signer_jabatan: signerJabatan,
        signer_dept_id: authorizingUser.emp_DeptID,
        signer_job_level_id: authorizingUser.emp_JobLevelID,
        // --- Delegated Signer Details (if applicable) ---
        signer_id_delegated: delegatedUser ? delegatedUser.log_NIK : null,
        signer_name_delegated: delegatedUser ? delegatedUser.Nama : null,
        signer_jabatan_delegated: delegatedUser ? delegatedUser.Jabatan : null,
        signer_dept_id_delegated: delegatedUser ? delegatedUser.emp_DeptID : null,
        signer_job_level_id_delegated: delegatedUser ? delegatedUser.emp_JobLevelID : null,
      },
      { transaction }
    );

    // Check if all required signatures for this step are complete
    // Determine required signatures. Prefer persisted required_signatures on currentStep; otherwise compute from berita acara golongan when using external workflow.
    let requiredSignatures = 1;
    if (
      currentStep &&
      typeof currentStep.required_signatures !== "undefined" &&
      currentStep.required_signatures !== null
    ) {
      requiredSignatures = currentStep.required_signatures || 1;
    } else {
      // Compute dynamically based on current step level and berita acara items
      const currentStepLevel =
        currentStep && currentStep.step_level
          ? Number(currentStep.step_level)
          : event.current_signing_step_id
          ? Number(event.current_signing_step_id)
          : null;

      if (currentStepLevel === 2) {
        requiredSignatures = 1;
      } else if (currentStepLevel === 3) {
        // Count distinct roles required by golongan and produk pangan
        const golonganNames = new Set();
        let hasProdukPangan = false;
        if (event && Array.isArray(event.PermohonanPemusnahanLimbahs)) {
          event.PermohonanPemusnahanLimbahs.forEach((p) => {
            const g = p.GolonganLimbah && p.GolonganLimbah.nama ? String(p.GolonganLimbah.nama).toLowerCase() : null;
            if (g) golonganNames.add(g);
            // Only consider isProdukPangan for pure Recall (not Recall & Prekursor)
            if (p.is_produk_pangan === true && g && g.includes("recall") && !g.includes("prekursor")) {
              hasProdukPangan = true;
            }
          });
        }
        const hasPrecursor = Array.from(golonganNames).some((n) => n.includes("prekursor") || n.includes("oot"));
        const hasRecall = Array.from(golonganNames).some((n) => n.includes("recall"));
        const hasRecallPrecursor = Array.from(golonganNames).some(
          (n) => n.includes("recall") && n.includes("prekursor")
        );
        const hasOther = Array.from(golonganNames).some(
          (n) => !(n.includes("prekursor") || n.includes("oot") || n.includes("recall"))
        );
        const bagian = event.bagian || event.creator_dept_id || null;
        const requiredRoles = new Set();

        // Handle special cases first
        if (hasRecallPrecursor) {
          // For "Recall & Prekursor", require both APJ PN and APJ QA
          requiredRoles.add("APJ_ROLE:PN");
          requiredRoles.add("APJ_ROLE:QA");
        } else {
          // Handle individual categories
          if (hasPrecursor) requiredRoles.add("APJ_ROLE:PN");
          if (hasRecall) {
            requiredRoles.add("APJ_ROLE:QA");
            // For pure Recall with produk pangan, also need PJKPO (HC)
            if (hasProdukPangan) requiredRoles.add("APJ_ROLE:HC");
          }
        }

        // For non-APJ roles (Manager), still use department
        if (hasOther && bagian) requiredRoles.add(String(bagian).toUpperCase());
        requiredSignatures = Math.max(1, requiredRoles.size);
      } else if (currentStepLevel === 4) {
        requiredSignatures = 1;
      } else {
        requiredSignatures = 1;
      }
    }
    // Count completed signatures, for APJ level count distinct roles across all step_level 3 steps
    let completedSignatures;

    // Determine if this is actually an APJ step by checking:
    // 1. Step name contains "APJ"
    // 2. OR workflow requires APJ based on golongan types
    let isAPJStep = false;

    if (currentStep && currentStep.step_level === 3) {
      // Check step name first
      if (currentStep.step_name && currentStep.step_name.toLowerCase().includes("apj")) {
        isAPJStep = true;
      } else {
        // Check if workflow requires APJ based on golongan types
        const golonganNames = new Set();
        if (event && Array.isArray(event.PermohonanPemusnahanLimbahs)) {
          event.PermohonanPemusnahanLimbahs.forEach((p) => {
            const g = p.GolonganLimbah && p.GolonganLimbah.nama ? String(p.GolonganLimbah.nama).toLowerCase() : null;
            if (g) golonganNames.add(g);
          });
        }

        // APJ is required for Recall, Precursor, or OOT golongan types
        const hasPrecursor = Array.from(golonganNames).some((n) => n.includes("prekursor") || n.includes("oot"));
        const hasRecall = Array.from(golonganNames).some((n) => n.includes("recall"));

        isAPJStep = hasPrecursor || hasRecall;
      }
    }


    if (isAPJStep) {
      // For APJ level, count unique roles that have signed using role markers
      const level3Signatures = await SigningHistory.findAll({
        where: {
          berita_acara_id: event.berita_acara_id,
          step_id: event.current_signing_step_id,
        },
        transaction,
      });

      const signedApjRoles = new Set();
      level3Signatures.forEach((h) => {
        const jab = h.signer_jabatan || "";
        const m = jab.match(/APJ_ROLE:(\w+)/);
        if (m && m[1]) signedApjRoles.add(m[1]);
      });

      completedSignatures = signedApjRoles.size;
    } else {
      // For other levels (including Department Manager at level 3), count total signatures for current step
      completedSignatures = await SigningHistory.count({
        where: {
          berita_acara_id: event.berita_acara_id,
          step_id: event.current_signing_step_id,
        },
        transaction,
      });
    }

    // Only advance to next step if all required signatures are obtained
    if (completedSignatures >= requiredSignatures) {
      // DEBUG: Log step advancement

      // Find the next signing step
      // Use a robust lookup: find the nearest step with step_level greater than current
      // This handles workflows that may skip numeric levels (e.g., 3 -> 4 or 3 -> 5)

      // Fetch candidate next steps - always advance to the next step in the workflow
      // Don't skip any steps automatically; let the workflow definition determine what steps are needed
      const candidateSteps = await SigningWorkflowStep.findAll({
        where: {
          signing_workflow_id: event.signing_workflow_id,
          step_level: { [Op.gt]: currentStep.step_level },
        },
        order: [["step_level", "ASC"]],
        transaction,
      });

      // Take the next step in sequence without skipping based on golongan
      // The workflow should be configured correctly in the database to include only required steps
      let chosenNextStep = candidateSteps.length > 0 ? candidateSteps[0] : null;

      // DEBUG: Log candidate steps
      if (candidateSteps.length > 0) {
      } else {
      }

      // Update the event to the next step (or complete if none)
      event.current_signing_step_id = chosenNextStep ? chosenNextStep.step_id : null;
      if (!chosenNextStep) {
        event.status = "Completed";
      } else {
      }
      await event.save({ transaction });

      // DEBUG: Log the step change
    } else {
      // DEBUG: Log when step doesn't advance
    }

    await transaction.commit();

    // Reload the event from DB so we return the latest persisted status/fields
    const refreshedEvent = await BeritaAcara.findByPk(event.berita_acara_id, {
      include: [
        { model: PermohonanPemusnahanLimbah, include: [DetailLimbah, GolonganLimbah, JenisLimbahB3] },
        { model: SigningWorkflowStep, include: [SigningWorkflowSigner] },
      ],
    });

    const message =
      completedSignatures >= requiredSignatures
        ? refreshedEvent && refreshedEvent.current_signing_step_id
          ? "Berita Acara signed successfully. Advanced to next step."
          : "Berita Acara signed successfully. All signatures complete."
        : `Berita Acara signed successfully. ${
            requiredSignatures - completedSignatures
          } more signature(s) required for this step.`;

    res.status(200).json({ success: true, message, data: refreshedEvent });
  } catch (error) {
    await transaction.rollback();
    res.status(500).json({ message: "Error signing Berita Acara", error: error.message });
  }
};

/**
 * Get pending signatures for daily logs (for reminder notifications)
 * GET /berita-acara/pending-signatures
 * TODO: Add notification logic for logs ignored for over a week
 */
const getPendingSignatures = async (req, res) => {
  try {
    const oneWeekAgo = new Date(jakartaTime.nowJakarta());
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const pendingLogs = await BeritaAcara.findAll({
      where: {
        status: "InProgress",
        created_at: {
          [Op.lt]: oneWeekAgo,
        },
      },
      include: [
        {
          model: SigningWorkflowStep,
          include: [SigningWorkflowSigner],
        },
      ],
    });

    // TODO: Implement notification logic here
    // For now, just return the pending logs
    res.status(200).json({
      success: true,
      data: pendingLogs,
      message: `${pendingLogs.length} daily logs have been pending for over a week.`,
    });
  } catch (error) {
    console.error("Error fetching pending signatures:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching pending signatures",
      error: error.message,
    });
  }
};

module.exports = {
  getAvailableRequestsForDailyLog,
  createBeritaAcara,
  getAllBeritaAcara,
  getBeritaAcaraById,
  signBeritaAcara,
  getPendingSignatures,
};
