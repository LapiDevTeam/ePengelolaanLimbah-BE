const Sequelize = require('sequelize');
const Op = Sequelize.Op;
const {
    PermohonanPemusnahanLimbah,
    DetailLimbah,
    ApprovalWorkflowStep,
    ApprovalWorkflowApprover,
    GolonganLimbah,
    JenisLimbahB3,
    ApprovalHistory,
    AuditLog,
    sequelize
} = require('../models');

const { determineApprovalWorkflow } = require('./workflowController');
const { generateNomorPermohonan } = require('../utils/nomorPermohonanGenerator');

// --- Helper Function for External API Authorization ---
const checkApprovalAuthorization = async (authorizingUser, permohonan) => {
  let isAuthorized = false;
  
  try {
    // First try external API authorization
    const axios = require('axios');
    const EXTERNAL_APPROVAL_URL = process.env.EXTERNAL_APPROVAL_URL || 'http://192.168.1.38/api/global-dev/v1/custom/list-approval-magang';
    
    const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
    const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];
    
    // Filter for ePengelolaan_Limbah approvers
    const appItems = items.filter(i => String(i.Appr_ApplicationCode || '') === 'ePengelolaan_Limbah');
    
    // Find user's approval capabilities
    const userApprovals = appItems.filter(item => item.Appr_ID === authorizingUser.log_NIK);
    
    // Check if user can approve this step level
    const currentStepLevel = permohonan.CurrentStep?.step_level;

    // Basic match by Appr_No
    const canApproveThisStep = userApprovals.some(approval => approval.Appr_No === currentStepLevel);

    if (canApproveThisStep) {
      // For department manager level (step 1), also check department matching
      if (currentStepLevel === 1) {
        const userDepartments = userApprovals
          .filter(a => a.Appr_No === 1)
          .map(a => a.Appr_DeptID)
          .map(d => (d || '').toString().toUpperCase());

        const requestDepartment = (permohonan.bagian || permohonan.requester_dept_id || '').toString().toUpperCase();
        isAuthorized = userDepartments.includes(requestDepartment);

      // APJ (step 2) requires department-based approval depending on golongan (e.g. Prekursor/OOT -> PN1, Recall -> QA)
      // Additionally, for isProdukPangan requests, APJ HC (PJKPO) is also required
      } else if (currentStepLevel === 2) {
        // Determine required approver department from golongan
        let requiredDept = null;
        try {
          const golongan = await GolonganLimbah.findByPk(permohonan.golongan_limbah_id);
          const categoryName = (golongan && golongan.nama) ? String(golongan.nama).toLowerCase() : '';
          const isPrecursor = categoryName.includes('prekursor') || categoryName.includes('oot');
          const isRecall = categoryName.includes('recall');
          const isRecallPrecursor = categoryName.includes('recall') && categoryName.includes('prekursor');

          if (isRecallPrecursor) {
            // For Recall & Precursor, both PN1 and QA departments are required
            requiredDept = ['PN1', 'QA'];
          } else if (isPrecursor) {
            requiredDept = 'PN1';
          } else if (isRecall) {
            requiredDept = 'QA';
          }

          // Add APJ HC (PJKPO) requirement for produk pangan requests
          if (permohonan.is_produk_pangan) {
            if (Array.isArray(requiredDept)) {
              requiredDept.push('HC');
            } else if (requiredDept) {
              requiredDept = [requiredDept, 'HC'];
            } else {
              requiredDept = 'HC';
            }
          }
        } catch (gErr) {
          console.warn('[checkApprovalAuthorization] Failed to determine golongan for APJ dept matching:', gErr && gErr.message);
        }

        // If a requiredDept is determined, require the user's external approvals for this step to include that dept
        if (requiredDept) {
          const userDeptForStep = userApprovals
            .filter(a => a.Appr_No === 2)
            .map(a => (a.Appr_DeptID || '').toString().toUpperCase());
          
          if (Array.isArray(requiredDept)) {
            // For array of required departments, user must belong to at least one
            isAuthorized = requiredDept.some(dept => userDeptForStep.includes(dept.toString().toUpperCase()));
          } else {
            isAuthorized = userDeptForStep.includes(requiredDept.toString().toUpperCase());
          }
        } else {
          // If we couldn't determine requiredDept, fall back to permissive behavior for step 2
          isAuthorized = userApprovals.some(a => a.Appr_No === 2);
        }

      } else if (currentStepLevel === 3) {
        // Special logic for Verifikasi Lapangan (step 3): group approval
        // A user qualifies if they have Appr_No === 3 and their Appr_DeptID and job level match one of the four roles
        // We'll accept any of: pelaksana (job_level 7) or supervisor/officer (5 or 6) from either HSE (KL) or the requester's dept
        const requestDepartment = permohonan.bagian || permohonan.requester_dept_id;

        const qualifies = userApprovals.some(a => {
          if (a.Appr_No !== 3) return false;
          const dept = (a.Appr_DeptID || '').toString().toUpperCase();
          // User can be HSE side if dept is KL
          const isHSE = dept === 'KL';
          // User can be Pemohon side if dept matches requester's department
          const isPemohon = requestDepartment && dept === String(requestDepartment).toUpperCase();
          // Note: HSE can also be pemohon if they submitted the request (bagian = KL)
          if (!isHSE && !isPemohon) return false;
          // job level info may not be present in external item; best-effort: treat Appr_CC or other hints as acceptable
          // If external data contains job level (rare), prefer it
          const jobLevel = a.Appr_JobLevel || a.emp_JobLevel || null;
          if (!jobLevel) return true; // cannot determine, allow based on department membership
          const jl = Number(jobLevel);
          return jl === 7 || jl === 6 || jl === 5;
        });

        isAuthorized = !!qualifies;
      } else {
        // For other steps, if user can approve the step level, they're authorized
        isAuthorized = true;
      }
    }
    
  } catch (apiError) {
    console.warn('[checkApprovalAuthorization] External API authorization failed, falling back to database:', apiError.message);
    
    // Fallback to original database check
    if (permohonan.CurrentStep?.ApprovalWorkflowApprovers) {
      isAuthorized = permohonan.CurrentStep.ApprovalWorkflowApprovers.some(
        approver => approver.approver_id === authorizingUser.log_NIK || 
                   approver.approver_identity === authorizingUser.log_NIK
      );
    }
  }
  
  return isAuthorized;
};

// --- Helper Function for Audit Logging ---
const logChanges = async (
    { user, delegatedUser }, 
    action_type, 
    request_id, 
    changes,
    transaction
) => {
    const actingUser = delegatedUser || user;
    const auditLogs = changes.map(change => ({
        request_id,
        action_type,
        field_name: change.field,
        old_value: String(change.old),
        new_value: String(change.new),
        target_entity: change.entity || 'PermohonanPemusnahanLimbah',
        target_entity_id: change.entity_id || request_id,
        // Snapshot the user performing the change
        changer_id: user.log_NIK,
        changer_name: user.Nama,
        changer_jabatan: user.Jabatan,
        changer_id_delegated: delegatedUser ? delegatedUser.log_NIK : null,
        changer_name_delegated: delegatedUser ? delegatedUser.Nama : null,
        changer_jabatan_delegated: delegatedUser ? delegatedUser.Jabatan : null,
    }));

    if (auditLogs.length > 0) {
        await AuditLog.bulkCreate(auditLogs, { transaction });
    }
};

// Helper to parse a datetime string sent from frontend.
// If the string contains timezone info (Z or +/-offset), parse as absolute moment.
// If it's a date-only or datetime without timezone, interpret components as local.
const parseLocalDateTime = (dtstr) => {
  const jakartaTime = require('../utils/jakartaTime');
  if (!dtstr) return null;
  if (dtstr instanceof Date) return dtstr;
  if (typeof dtstr !== 'string') return new Date(dtstr);

  const trimmed = dtstr.trim();
  // If contains Z or timezone offset, let Date parse it as absolute
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d;
  }

  // For date-only or datetime without offset, interpret as Jakarta local components
  const parsedJakartaIso = jakartaTime.parseJakartaLocal(trimmed);
  if (parsedJakartaIso) {
    const d = new Date(parsedJakartaIso);
    return isNaN(d.getTime()) ? null : d;
  }

  // Last resort
  const fallback = new Date(trimmed);
  return isNaN(fallback.getTime()) ? null : fallback;
};

// --- Controller Functions ---

/**
 * Buat baru - POST /permohonan-pemusnahan-limbah
 * This function handles creating a new request along with its detail items.
 * It uses a transaction to ensure that either everything is created successfully, or nothing is.
 */
const createPermohonan = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { bagian, bentuk_limbah, golongan_limbah_id, jenis_limbah_b3_id, is_produk_pangan, details } = req.body;
        const { user, delegatedUser } = req;

        // Determine the appropriate workflow based on waste type
        const workflowId = await determineApprovalWorkflow(golongan_limbah_id, jenis_limbah_b3_id, is_produk_pangan);

        const permohonan = await PermohonanPemusnahanLimbah.create({
            bagian: user.emp_DeptID,
            bentuk_limbah,
            golongan_limbah_id,
            jenis_limbah_b3_id,
            is_produk_pangan: is_produk_pangan || false,
            approval_workflow_id: workflowId,
            current_step_id: null,
            status: 'Draft',
            requester_id: user.log_NIK,
            requester_name: user.Nama,
            requester_jabatan: user.Jabatan,
            requester_id_delegated: delegatedUser ? delegatedUser.log_NIK : null,
            requester_name_delegated: delegatedUser ? delegatedUser.Nama : null,
            requester_jabatan_delegated: delegatedUser ? delegatedUser.Jabatan : null,
        }, { transaction });

        const detailItems = details.map(detail => ({ ...detail, request_id: permohonan.request_id }));
        await DetailLimbah.bulkCreate(detailItems, { transaction });

        // Compute jumlah_item as number of unique (nama_limbah, nomor_analisa) pairs
        try {
          const pairSet = new Set();
          (details || []).forEach(d => {
            const name = (d.nama_limbah || '').toString().trim();
            const analisa = (d.nomor_analisa || '').toString().trim();
            pairSet.add(`${name}|||${analisa}`);
          });
          permohonan.jumlah_item = pairSet.size;
          await permohonan.save({ transaction });
        } catch (e) {
          console.warn('[createPermohonan] Failed to compute jumlah_item:', e && e.message);
        }

        // Log the creation action
        await logChanges(
            req, 'ADD_ITEM', permohonan.request_id, 
            [{ field: 'request', old: null, new: `Request created with ID ${permohonan.request_id}` }],
            transaction
        );

        await transaction.commit();
        res.status(201).json({ message: "Draft permohonan created successfully", data: permohonan });

    } catch (error) {
        await transaction.rollback();
        console.error("Failed to create permohonan:", error);
        res.status(500).json({ message: "Error creating permohonan", error: error.message });
    }
};

/**
 * List - GET /permohonan-pemusnahan-limbah
 * Fetches a paginated list of requests based on user role and filters.
 */
const getAllPermohonan = async (req, res) => {
  try {
    const { page = 1, limit = 8, search = '', column = '', userOnly = false, pendingApproval = false, processedBy = false, status, verificationOnly = false, statusFilter = '' } = req.query;
    const { user, delegatedUser } = req;
    // For data filtering: use the actual logged-in user, not the delegated user
    // For actions: use delegatedUser if available (handled in other operations)
    const filteringUser = user; // Always use the logged-in user for filtering
    
    const offset = (parseInt(page) - 1) * parseInt(limit);

  // --- SEARCH LOGIC ---
  // Columns that will be filtered post-query (to avoid SQL join issues)
  const postQueryFilterColumns = ['status', 'namaLimbah', 'nomorAnalisa', 'bobot'];
  const needsPostQueryFilter = search && column && postQueryFilterColumns.includes(column);
  
  let whereClause = {};
    if (search && column && !needsPostQueryFilter) {
      const searchCondition = { [Op.iLike]: `%${search}%` };

      // Search in a specific column using explicit if-else conditions
      // Only columns that can be safely queried at DB level
      if (column === 'noPermohonan') {
        whereClause.nomor_permohonan = searchCondition;
      } else if (column === 'tanggal') {
        // For tanggal search, create OR conditions for multiple date formats
        const dateSearchConditions = [
          Sequelize.where(Sequelize.fn('to_char', Sequelize.col('PermohonanPemusnahanLimbah.created_at'), 'YYYY-MM-DD'), { [Op.iLike]: `%${search}%` }),
          Sequelize.where(Sequelize.fn('to_char', Sequelize.col('PermohonanPemusnahanLimbah.created_at'), 'DD/MM/YYYY'), { [Op.iLike]: `%${search}%` }),
          Sequelize.where(Sequelize.fn('to_char', Sequelize.col('PermohonanPemusnahanLimbah.created_at'), 'DD/MM/YY'), { [Op.iLike]: `%${search}%` }),
          Sequelize.where(Sequelize.fn('to_char', Sequelize.col('PermohonanPemusnahanLimbah.created_at'), 'DD-MM-YYYY'), { [Op.iLike]: `%${search}%` })
        ];
        whereClause = { [Op.or]: dateSearchConditions };
      } else if (column === 'golongan') {
        whereClause['$GolonganLimbah.nama$'] = searchCondition;
      } else if (column === 'jenis') {
        whereClause['$JenisLimbahB3.nama$'] = searchCondition;
      } else if (column === 'bagian') {
        whereClause.bagian = searchCondition;
      }
    }

    // Filter by status if explicitly requested (e.g., Rejected tab)
    if (status) {
      whereClause.status = status;
    }

    // Handle statusFilter for KL dashboard cards
    // This maps dashboard card filters to appropriate query conditions
    let statusFilterStepLevel = null;
    if (statusFilter) {
      if (statusFilter === 'Verification') {
        // Show InProgress requests at verification step (step 3)
        whereClause.status = 'InProgress';
        statusFilterStepLevel = 3;
      } else if (statusFilter === 'WaitingHSEManager') {
        // Show InProgress requests at HSE Manager step (step 4)
        whereClause.status = 'InProgress';
        statusFilterStepLevel = 4;
      } else if (statusFilter === 'Rejected') {
        // Show all rejected requests
        whereClause.status = 'Rejected';
      }
    }

    const isVerificationOnly = verificationOnly === 'true' || verificationOnly === true;

    // For verification tab: show only InProgress requests at verification step (step 3)
    if (isVerificationOnly) {
      whereClause.status = 'InProgress';
    }

    const queryOptions = {
      include: [
        { model: DetailLimbah, required: false },
        { model: ApprovalWorkflowStep, as: 'CurrentStep', required: false, include: [ApprovalWorkflowApprover] },
        { model: GolonganLimbah, required: true },
        { model: JenisLimbahB3, required: true }
      ],
      limit: parseInt(limit),
      offset: offset,
      order: [['created_at', 'DESC']],
      where: whereClause,
      distinct: true  // Ensure count is based on unique PermohonanPemusnahanLimbah records
    };

    // Force current step to verification (step 3) when requested
    if (isVerificationOnly) {
      queryOptions.include = queryOptions.include.filter(include => include.as !== 'CurrentStep');
      queryOptions.include.push({
        model: ApprovalWorkflowStep,
        as: 'CurrentStep',
        required: true,
        where: { step_level: 3 },
        include: [ApprovalWorkflowApprover]
      });
    }

    // Apply statusFilter step level filtering (for KL dashboard cards)
    if (statusFilterStepLevel) {
      queryOptions.include = queryOptions.include.filter(include => include.as !== 'CurrentStep');
      queryOptions.include.push({
        model: ApprovalWorkflowStep,
        as: 'CurrentStep',
        required: true,
        where: { step_level: statusFilterStepLevel },
        include: [ApprovalWorkflowApprover]
      });
    }
    
    // Filter by user's own requests if userOnly is specified
    if (userOnly === 'true' || userOnly === true) {
      // Merge with existing whereClause if it exists (from search filters)
      if (Object.keys(queryOptions.where).length > 0) {
        // Combine with existing conditions using Op.and
        queryOptions.where = {
          [Op.and]: [
            queryOptions.where,
            { requester_id: filteringUser.log_NIK }
          ]
        };
      } else {
        queryOptions.where.requester_id = filteringUser.log_NIK;
      }
    }

    // Filter to requests processed (approved or rejected) by the current user
    // This is used by the frontend "Approved" tab: show ALL requests where
    // the current user has an ApprovalHistory entry (Approved or Rejected)
    // at ANY step that matches their approval authority, regardless of whether
    // the request is still InProgress or already Completed.
    if (processedBy === 'true' || processedBy === true) {
      queryOptions.include.push({
        model: ApprovalHistory,
        required: true,
        where: {
          [Op.and]: [
            {
              [Op.or]: [
                { approver_id: filteringUser.log_NIK },
                { approver_id_delegated: filteringUser.log_NIK }
              ]
            },
            { 
              status: { 
                [Op.in]: ['Approved', 'Rejected'] 
              } 
            }
          ]
        }
      });

      // Exclude requests created by the same user
      // Merge with existing whereClause if it exists (from search filters)
      if (Object.keys(queryOptions.where).length > 0) {
        // Combine with existing conditions using Op.and
        queryOptions.where = {
          [Op.and]: [
            queryOptions.where,
            { requester_id: { [Op.ne]: filteringUser.log_NIK } }
          ]
        };
      } else {
        queryOptions.where.requester_id = { [Op.ne]: filteringUser.log_NIK };
      }
      
      // Add CurrentStep for post-processing check
      if (!queryOptions.include.some(inc => inc.as === 'CurrentStep')) {
        queryOptions.include.push({
          model: ApprovalWorkflowStep,
          as: 'CurrentStep',
          required: false,
          include: [ApprovalWorkflowApprover]
        });
      }
    }

    // Enhanced pendingApproval filtering with external API
    if (!isVerificationOnly && (pendingApproval === 'true' || pendingApproval === true)) {
      try {
        const axios = require('axios');
        const EXTERNAL_APPROVAL_URL = process.env.EXTERNAL_APPROVAL_URL || 'http://192.168.1.38/api/global-dev/v1/custom/list-approval-magang';
        
        // Get all requests that are InProgress first
        // Merge with existing whereClause if it exists (from search filters)
        const inProgressConditions = {
          status: 'InProgress',
          current_step_id: {
            [require('sequelize').Op.ne]: null
          }
        };
        
        if (Object.keys(queryOptions.where).length > 0) {
          // Combine with existing search conditions using Op.and
          queryOptions.where = {
            [Op.and]: [
              queryOptions.where,
              inProgressConditions
            ]
          };
        } else {
          queryOptions.where = inProgressConditions;
        }
        
        // Remove existing CurrentStep includes
        queryOptions.include = queryOptions.include.filter(include => 
          !(include.as === 'CurrentStep')
        );
        
        try {
          // Fetch external API data
          const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
          const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];
          
          // Filter for ePengelolaan_Limbah approvers
          const appItems = items.filter(i => String(i.Appr_ApplicationCode || '') === 'ePengelolaan_Limbah');
          
          // Find which step levels this user can approve at
          const userApprovalSteps = appItems
            .filter(item => item.Appr_ID === filteringUser.log_NIK)
            .map(item => item.Appr_No)
            .filter(stepNo => stepNo != null);
          
          // For department managers (step 1), also find which departments they can approve for
          const userDepartmentApprovals = appItems
            .filter(item => 
              item.Appr_ID === filteringUser.log_NIK && 
              item.Appr_No === 1 // Department manager level
            )
            .map(item => item.Appr_DeptID)
            .filter(deptId => deptId != null);
          
          if (userApprovalSteps.length > 0) {
            // Build query to get pending approvals based on step levels and additional filters
            const canApproveManager = userApprovalSteps.includes(1);
            const canApproveAPJ = userApprovalSteps.includes(2);
            const canApproveVerification = userApprovalSteps.includes(3);
            const canApproveHSE = userApprovalSteps.includes(4);

            // Always include CurrentStep with step_level filter

            queryOptions.include.push({
              model: ApprovalWorkflowStep,
              as: 'CurrentStep',
              required: true,
              where: {
                step_level: {
                  [require('sequelize').Op.in]: userApprovalSteps
                }
              },
              include: [{
                model: ApprovalWorkflowApprover,
                required: false
              }]
            });
            
            // Build complex WHERE conditions using OR logic for different step levels
            const Op = require('sequelize').Op;
            const stepConditions = [];

            // Step 1 (Department Manager): filter by department
            if (canApproveManager && userDepartmentApprovals.length > 0) {
              stepConditions.push({
                [Op.and]: [
                  { '$CurrentStep.step_level$': 1 },
                  { bagian: { [Op.in]: userDepartmentApprovals } }
                ]
              });
            }

            // Step 2 (APJ): filter by golongan based on department
            if (canApproveAPJ) {
              const userAPJDepts = appItems
                .filter(item => item.Appr_ID === filteringUser.log_NIK && item.Appr_No === 2)
                .map(i => (i.Appr_DeptID || '').toString().toUpperCase())
                .filter(Boolean);

              if (userAPJDepts.length > 0) {
                const golonganConditions = [];
                
                if (userAPJDepts.includes('PN1')) {
                  golonganConditions.push({ '$GolonganLimbah.nama$': { [Op.iLike]: '%prekursor%' } });
                  golonganConditions.push({ '$GolonganLimbah.nama$': { [Op.iLike]: '%oot%' } });
                }
                if (userAPJDepts.includes('QA')) {
                  golonganConditions.push({ '$GolonganLimbah.nama$': { [Op.iLike]: '%recall%' } });
                }
                if (userAPJDepts.includes('HC')) {
                  golonganConditions.push({ is_produk_pangan: true });
                }

                if (golonganConditions.length > 0) {
                  stepConditions.push({
                    [Op.and]: [
                      { '$CurrentStep.step_level$': 2 },
                      { [Op.or]: golonganConditions }
                    ]
                  });
                }
              }
            }

            // Step 3 (Verifikasi Lapangan): no additional filter, all verification requests visible
            if (canApproveVerification) {
              stepConditions.push({
                '$CurrentStep.step_level$': 3
              });
            }

            // Step 4 (HSE Manager): no additional filter, all HSE approval requests visible
            if (canApproveHSE) {
              stepConditions.push({
                '$CurrentStep.step_level$': 4
              });
            }

            // Apply OR conditions if we have multiple step filters
            if (stepConditions.length > 0) {
              // If user can approve multiple steps, use OR to combine conditions
              if (stepConditions.length > 1) {
                queryOptions.where[Op.or] = stepConditions;
              } else {
                // If only one step condition, apply it directly
                Object.assign(queryOptions.where, stepConditions[0]);
              }
            }

          } else {
            // User not found in external API, use database fallback
            throw new Error('User not found in external approval API');
          }
          
        } catch (apiError) {
          console.warn('[getAllPermohonan] External API failed, using database fallback:', apiError.message);
          
          // Fallback to database-based filtering
          // Use a simplified approach to avoid complex nested queries
          const Op = require('sequelize').Op;
          
          queryOptions.include.push({
            model: ApprovalWorkflowStep,
            as: 'CurrentStep',
            required: true,
            include: [{
              model: ApprovalWorkflowApprover,
              required: true,
              where: {
                [Op.or]: [
                  // Direct approver matches
                  { approver_id: filteringUser.log_NIK },
                  { approver_identity: filteringUser.log_NIK },
                  // Department matches (simplified - check in post-processing if needed)
                  { approver_dept_id: filteringUser.emp_DeptID },
                  // KL department can access verification steps
                  { approver_dept_id: 'KL' }
                ]
              }
            }]
          });
          
          // For PJKPO (HC department) users, filter for produk pangan only
          if (filteringUser.emp_DeptID === 'HC') {
            queryOptions.where.is_produk_pangan = true;
          }
        }
        
      } catch (error) {
        console.error('[getAllPermohonan] Error in pendingApproval filtering:', error);
        // Ultimate fallback
        queryOptions.where.status = 'InProgress';
        queryOptions.include.push({
          model: ApprovalWorkflowStep,
          as: 'CurrentStep',
          required: true,
          include: [{
            model: ApprovalWorkflowApprover,
            required: true,
            where: {
              approver_id: filteringUser.log_NIK
            }
          }]
        });
        
        // For PJKPO (HC department) users, filter for produk pangan only
        if (filteringUser.emp_DeptID === 'HC') {
          queryOptions.where.is_produk_pangan = true;
        }
      }
    }

    // For pending approvals, exclude requests that the current user has already processed
    // IMPORTANT: For users who approve multiple steps (e.g., HSE Manager on step 1 and 4),
    // only exclude if they processed the CURRENT step. If they approved step 1 and current
    // is step 4, they should still see it in pending.
    if (pendingApproval === 'true' || pendingApproval === true) {
      // We'll do post-processing instead of subquery to check current_step_id
      // The subquery approach doesn't work well with current_step_id filtering
      // So we fetch all and filter in memory
    }

    // For processedBy or post-query filters, we need to remove pagination from query and do it after filtering
    // because the filtering logic requires post-processing
    const needsPostProcessing = (processedBy === 'true' || processedBy === true) || needsPostQueryFilter;
    let queryOptionsForDB = { ...queryOptions };
    
    if (needsPostProcessing) {
      // Remove limit and offset for initial query
      delete queryOptionsForDB.limit;
      delete queryOptionsForDB.offset;
    }

    const { count, rows: permohonanList } = await PermohonanPemusnahanLimbah.findAndCountAll(queryOptionsForDB);
    
    // Post-processing filters for pendingApproval, processedBy, and certain column searches
    // Important: For users who approve multiple steps (e.g., HSE Manager on step 1 and 4),
    // we only check current step, not any previous steps they may have approved.
    let filteredList = permohonanList;
    let filteredCount = count;
    
    // Apply post-query column filters if needed
    if (needsPostQueryFilter) {
      const searchLower = search.toLowerCase();
      
      filteredList = filteredList.filter(request => {
        const itemData = request.toJSON ? request.toJSON() : request;
        
        if (column === 'status') {
          // Check both CurrentStep.step_name and status field
          const stepName = itemData.CurrentStep?.step_name || '';
          const status = itemData.status || '';
          return stepName.toLowerCase().includes(searchLower) || status.toLowerCase().includes(searchLower);
        } else if (column === 'namaLimbah') {
          // Search in DetailLimbahs.nama_limbah
          const details = itemData.DetailLimbahs || [];
          return details.some(d => (d.nama_limbah || '').toLowerCase().includes(searchLower));
        } else if (column === 'nomorAnalisa') {
          // Search in DetailLimbahs.nomor_analisa
          const details = itemData.DetailLimbahs || [];
          return details.some(d => (d.nomor_analisa || '').toLowerCase().includes(searchLower));
        } else if (column === 'bobot') {
          // Search in DetailLimbahs.bobot (convert to string)
          const details = itemData.DetailLimbahs || [];
          return details.some(d => String(d.bobot || '').includes(search));
        }
        return true;
      });
      
      filteredCount = filteredList.length;
    }
    
    if (pendingApproval === 'true' || pendingApproval === true) {
      // Pending: exclude only if user approved CURRENT step
      filteredList = filteredList.filter(request => {
        const currentStepId = request.current_step_id;
        const histories = Array.isArray(request.ApprovalHistories) ? request.ApprovalHistories : [];
        
        // Check if user has already processed the CURRENT step
        const hasProcessedCurrentStep = histories.some(h => {
          const approverIds = [h.approver_id, h.approver_id_delegated].filter(Boolean).map(String);
          const matchesUser = approverIds.includes(String(filteringUser.log_NIK));
          const isProcessed = ['Approved', 'Rejected'].includes(h.status);
          const matchesCurrentStep = currentStepId && String(h.step_id) === String(currentStepId);
          
          return matchesUser && isProcessed && matchesCurrentStep;
        });
        
        // Only show if they haven't processed current step
        return !hasProcessedCurrentStep;
      });
      
      filteredCount = filteredList.length;
    }
    
    if (processedBy === 'true' || processedBy === true) {
      // Approved: show ALL requests where user has approved OR rejected at their step
      // EXCEPT if current step also needs user's approval but hasn't been processed yet
      // (in that case, it should be in Pending Approvals instead)
      // NOTE: Search filters have already been applied at the database level
      
      if (filteredList.length === 0) {
        filteredCount = 0;
      } else {
        // Need to fetch user's approval authority to check current step
        // to exclude requests where user still needs to process at current step
        try {
          const axios = require('axios');
          const EXTERNAL_APPROVAL_URL = process.env.EXTERNAL_APPROVAL_URL || 'http://192.168.1.38/api/global-dev/v1/custom/list-approval-magang';
          const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
          const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];
          const appItems = items.filter(i => String(i.Appr_ApplicationCode || '') === 'ePengelolaan_Limbah');
          const userApprovals = appItems.filter(item => item.Appr_ID === filteringUser.log_NIK);
          const userApprovalSteps = userApprovals.map(item => item.Appr_No).filter(stepNo => stepNo != null);
          
          filteredList = filteredList.filter(request => {
            // If no current step (completed/rejected), always show in Processed
            if (!request.current_step_id || !request.CurrentStep) {
              return true;
            }
            
            const currentStepLevel = request.CurrentStep.step_level;
            
            // If current step is not in user's approval authority, show in Processed
            if (!userApprovalSteps.includes(currentStepLevel)) {
              return true;
            }
            
            // Current step needs user's approval - check if already processed (approved or rejected)
            const histories = Array.isArray(request.ApprovalHistories) ? request.ApprovalHistories : [];
            const hasProcessedCurrentStep = histories.some(h => {
              const approverIds = [h.approver_id, h.approver_id_delegated].filter(Boolean).map(String);
              const matchesUser = approverIds.includes(String(filteringUser.log_NIK));
              const isProcessed = ['Approved', 'Rejected'].includes(h.status);
              const matchesCurrentStep = String(h.step_id) === String(request.current_step_id);
              return matchesUser && isProcessed && matchesCurrentStep;
            });
            
            // Only show in Processed if user has already processed current step
            return hasProcessedCurrentStep;
          });
          
          filteredCount = filteredList.length;
        } catch (apiError) {
          console.warn('[processedBy filter] External API check failed:', apiError.message);
          // If API fails, just use the results from database filter
          // The search filter was already applied at DB level
          filteredCount = filteredList.length;
        }
      }
    }
    
    // Apply pagination AFTER filtering for processedBy
    if (needsPostProcessing && filteredList.length > 0) {
      const startIndex = offset;
      const endIndex = offset + parseInt(limit);
      filteredList = filteredList.slice(startIndex, endIndex);
    }
    
    const totalPages = Math.ceil(filteredCount / parseInt(limit));
    
    // Transform response: keep only required fields from DetailLimbahs
    const transformedList = filteredList.map(item => {
      const itemData = item.toJSON ? item.toJSON() : item;
      if (itemData.DetailLimbahs && Array.isArray(itemData.DetailLimbahs)) {
        itemData.DetailLimbahs = itemData.DetailLimbahs.map(detail => ({
          nama_limbah: detail.nama_limbah,
          nomor_analisa: detail.nomor_analisa,
          bobot: detail.bobot
        }));
      }
      return itemData;
    });
    
    res.status(200).json({
      success: true,
      data: transformedList,
      pagination: {
        total: filteredCount,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: totalPages
      }
    });
    
  } catch (error) {
    console.error('Error in getAllPermohonan:', error);
    res.status(500).json({ 
      success: false,
      message: "Error fetching permohonan list", 
      error: error.message
    });
  }
};

/**
 * Detail - GET /permohonan-pemusnahan-limbah/:id
 * Fetches a single request by its ID.
 */
const getPermohonanById = async (req, res) => {
  try {
    const { id } = req.params;
    // Include DetailLimbah and the current approval step (with approvers) so
    // the response contains CurrentStep.step_level and approver info.
    // Also include ApprovalHistory so frontend can determine whether the
    // current user already processed (approved/rejected) this request.
    const permohonan = await PermohonanPemusnahanLimbah.findByPk(id, {
      include: [
        { model: DetailLimbah },
        { model: ApprovalWorkflowStep, as: 'CurrentStep', include: [ApprovalWorkflowApprover], required: false },
        { model: ApprovalHistory, required: false }
      ]
    });

    if (!permohonan) {
      return res.status(404).json({ message: 'Permohonan not found' });
    }

    // Determine whether the logged-in user (req.user) has processed this request
    // Important: For users who need to approve multiple steps (e.g., HSE Manager for both
    // Department Manager step and HSE Manager step), we only check if they've processed
    // the CURRENT step, not any previous steps.
    const filteringUser = req.user;
    let processedByCurrentUser = false;
    try {
      const histories = Array.isArray(permohonan.ApprovalHistories) ? permohonan.ApprovalHistories : [];
      const currentStepId = permohonan.current_step_id;
      
      if (currentStepId) {
        processedByCurrentUser = histories.some(h => {
          const approverIds = [h.approver_id, h.approver_id_delegated].filter(Boolean).map(String);
          const matchesUser = approverIds.includes(String(filteringUser.log_NIK));
          const isProcessed = ['Approved', 'Rejected'].includes(h.status);
          // Only consider as processed if they approved/rejected the CURRENT step
          // Use String comparison to avoid type mismatch issues
          const matchesCurrentStep = String(h.step_id) === String(currentStepId);
          
          return matchesUser && isProcessed && matchesCurrentStep;
        });
      } else {
        // If no current step (e.g., Draft or Completed), check any history
        processedByCurrentUser = histories.some(h => {
          const approverIds = [h.approver_id, h.approver_id_delegated].filter(Boolean).map(String);
          return approverIds.includes(String(filteringUser.log_NIK)) && ['Approved', 'Rejected'].includes(h.status);
        });
      }
    } catch (e) {
      // Non-fatal; default to false
      console.error('[getPermohonanById] Error checking processedByCurrentUser:', e);
      processedByCurrentUser = false;
    }

    const result = permohonan.toJSON();
    result.processedByCurrentUser = processedByCurrentUser;

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: "Error fetching permohonan detail", error: error.message });
  }
};

/**
 * Submit - POST /permohonan-pemusnahan-limbah/:id/submit
 * Submits a draft request into the approval workflow.
 */
const submitPermohonan = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { user, delegatedUser } = req;
        const actingUser = delegatedUser || user;

        const permohonan = await PermohonanPemusnahanLimbah.findByPk(id, { transaction });

        if (!permohonan) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Permohonan not found' });
        }

        // Authorization: Only the original requester or their delegated user can submit their own draft
        const isRequester = permohonan.requester_id === actingUser.log_NIK || permohonan.requester_id_delegated === actingUser.log_NIK;
        if (!isRequester) {
          await transaction.rollback();
          return res.status(403).json({ message: 'You are not authorized to submit this request.' });
        }

        // Ensure it's actually a draft
        if (permohonan.current_step_id !== null) {
            await transaction.rollback();
            return res.status(400).json({ message: 'This request has already been submitted.' });
        }

        // Find the first step (step_level = 1) for the assigned workflow
        const firstStep = await ApprovalWorkflowStep.findOne({
            where: {
                approval_workflow_id: permohonan.approval_workflow_id,
                step_level: 1
            },
            transaction
        });

        if (!firstStep) {
            await transaction.rollback();
            return res.status(500).json({ message: 'Workflow is not configured correctly; first step not found.' });
        }

        // Update the request to point to the first step
        permohonan.current_step_id = firstStep.step_id;
        permohonan.status = 'InProgress';
        // Record the timestamp when the draft is submitted.
        // If client provided submitted_at (as local components or zoned ISO), parse it safely; otherwise use server now.
        const jakartaTime = require('../utils/jakartaTime');
        permohonan.submitted_at = parseLocalDateTime(req.body?.submitted_at) || new Date(jakartaTime.nowJakarta());

        // If this request was previously rejected by Manager and returned to Draft,
        // clear the rejection reason and remove the manager 'Rejected' history entries
        try {
          // Clear rejection reason on the main request
          permohonan.alasan_penolakan = null;

          // Remove any ApprovalHistory rows that are a manager-level rejection for this request
          // Find any history rows for this request and the first step that have status 'Rejected'
          await ApprovalHistory.destroy({
            where: {
              request_id: permohonan.request_id,
              step_id: firstStep.step_id,
              status: 'Rejected'
            },
            transaction
          });
        } catch (cleanupErr) {
          // Non-fatal: log but don't abort submission
          console.warn('Failed to cleanup previous rejection history:', cleanupErr);
        }
        await permohonan.save({ transaction });

        await transaction.commit();
        res.status(200).json({ message: 'Request submitted successfully and is now pending approval.', data: permohonan });

    } catch (error) {
        await transaction.rollback();
        console.error("Failed to submit permohonan:", error);
        res.status(500).json({ message: "Error submitting permohonan", error: error.message });
    }
};

/**
 * Approve - POST /permohonan-pemusnahan-limbah/:id/approve
 * Handles the logic for a user approving a request at its current step.
 */
const approvePermohonan = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
      const { id } = req.params;
      const { user, delegatedUser } = req; // User data from auth middleware
  // For authorization: by default use the logged-in user. However the frontend
  // may pass an explicit verifierId when the approval is performed by a
  // different approver who authenticated locally in the modal. Use that
  // verifierId for the authorization check if present.
  const actingUser = delegatedUser || user; // For audit trail - who the action is being performed as
  const verifierId = req.body?.verifierId || user.log_NIK;
  // If verifierId differs from the logged-in user, construct a minimal
  // authorizingUser object so checkApprovalAuthorization will query the
  // external approval API using verifier's ID.
  const authorizingUser = verifierId === user.log_NIK ? user : { log_NIK: verifierId };
  
      // 1. Find the request and its current step details
      const permohonan = await PermohonanPemusnahanLimbah.findByPk(id, {
        include: [{
          model: ApprovalWorkflowStep,
          as: 'CurrentStep',
          include: [ApprovalWorkflowApprover]
        }],
        transaction
      });
  
      if (!permohonan) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Permohonan not found' });
      }
      if (!permohonan.CurrentStep) {
          await transaction.rollback();
          return res.status(400).json({ message: 'Request is not currently in an approval step.'});
      }
  
      // 2. Authorization Check using external API (or fallback DB)
      let isApprover = await checkApprovalAuthorization(authorizingUser, permohonan);

      // TEST BYPASS: allow developers to bypass Verifikasi Lapangan authorization when
      // process.env.TEST_BYPASS_VERIFICATION === 'true' AND a valid token header is provided.
      // This is intentionally strict: it only applies to step_level === 3 (Verifikasi Lapangan)
      // and requires the header `x-test-bypass-token` to equal process.env.TEST_BYPASS_TOKEN.
      try {
        const bypassEnabled = String(process.env.TEST_BYPASS_VERIFICATION || '').toLowerCase() === 'true';
        const bypassToken = process.env.TEST_BYPASS_TOKEN || null;
        const providedToken = (req.headers['x-test-bypass-token'] || req.headers['X-Test-Bypass-Token'] || '').toString();
        const isVerificationStep = permohonan.CurrentStep && permohonan.CurrentStep.step_level === 3;
        if (!isApprover && bypassEnabled && bypassToken && providedToken && isVerificationStep) {
          if (providedToken === bypassToken) {
            isApprover = true;
            // mark request so downstream code or audit logs can note this was a bypass
            req.usedVerificationBypass = true;
            console.warn('[TEST_BYPASS] Verification bypass used for request', permohonan.request_id, 'by', user && user.log_NIK);
          }
        }
      } catch (bypassErr) {
        console.warn('Error evaluating test bypass:', bypassErr && bypassErr.message);
      }

      if (!isApprover) {
        await transaction.rollback();
        return res.status(403).json({ 
          message: 'You are not authorized to approve this request at its current step.',
          debug: {
            userId: authorizingUser.log_NIK,
            currentStepLevel: permohonan.CurrentStep.step_level,
            requestDepartment: permohonan.bagian || permohonan.requester_dept_id
          }
        });
      }
  
      // 3. Generate nomor_permohonan if this is the first approval step (Department Manager)
      let nomorPermohonan = permohonan.nomor_permohonan;
      if (permohonan.CurrentStep.step_level === 1 && !nomorPermohonan) {
        try {
          nomorPermohonan = await generateNomorPermohonan(permohonan.bentuk_limbah, transaction);
          permohonan.nomor_permohonan = nomorPermohonan;
          
          // Log the nomor_permohonan generation
          await logChanges(
            req, 'UPDATE', permohonan.request_id,
            [{ field: 'nomor_permohonan', old: null, new: nomorPermohonan }],
            transaction
          );
        } catch (nomorError) {
          await transaction.rollback();
          console.error("Failed to generate nomor_permohonan:", nomorError);
          console.error("Permohonan data:", JSON.stringify(permohonan.toJSON(), null, 2));
          
          // Handle race condition - ask user to resubmit
          if (nomorError.message.includes('limit exceeded') || nomorError.message.includes('already exists')) {
            return res.status(409).json({ 
              message: 'Unable to generate request number due to system constraints. Please cancel this request and resubmit.',
              error: 'REQUEST_NUMBER_CONFLICT'
            });
          }
          
          return res.status(500).json({ message: "Error generating request number", error: nomorError.message });
        }
      }

      // 4. Record the approval in the history table
      // For Verifikasi Lapangan (step_level === 3) we support 4 distinct roles
      // (pelaksana pemohon, supervisor pemohon, pelaksana hse, supervisor hse).
      // Frontend passes `roleId` in payload when performing a verification approval.
      const roleId = req.body.roleId || null;

      // If this is a verification step, ensure the same role can't approve twice.
      const currentStepLevel = permohonan.CurrentStep.step_level;

      if (currentStepLevel === 3 && roleId) {
        // Check if an ApprovalHistory entry already exists for this request + step + role
        const existing = await ApprovalHistory.findOne({
          where: {
            request_id: permohonan.request_id,
            step_id: permohonan.current_step_id,
            approver_jabatan: { [require('sequelize').Op.like]: `%VERIF_ROLE:${roleId}%` },
            status: 'Approved'
          },
          transaction
        });

        if (existing) {
          // Duplicate approval for same role - treat as idempotent success
          await transaction.commit();
          return res.status(200).json({ message: 'Role already approved previously.', data: permohonan });
        }
      }

      // Determine APJ role for step level 2 (APJ approval)
      let apjRole = null;
      if (currentStepLevel === 2) {
        try {
          // Get approver's department from external API
          const axios = require('axios');
          const EXTERNAL_APPROVAL_URL = process.env.EXTERNAL_APPROVAL_URL || 'http://192.168.1.38/api/global-dev/v1/custom/list-approval-magang';
          const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
          const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];
          const apjItems = items.filter(i => 
            String(i.Appr_ApplicationCode || '') === 'ePengelolaan_Limbah' && 
            Number(i.Appr_No) === 2
          );
          
          const userApj = apjItems.find(item => String(item.Appr_ID) === String(verifierId));
          if (userApj && userApj.Appr_DeptID) {
            const dept = String(userApj.Appr_DeptID).toUpperCase();
            if (dept === 'PN1') apjRole = 'PN';
            else if (dept === 'QA') apjRole = 'QA';
            else if (dept === 'HC') apjRole = 'HC';
          }
        } catch (apjErr) {
          console.warn('[approvePermohonan] Failed to determine APJ role:', apjErr.message);
        }

        // Check if this APJ role has already approved
        if (apjRole) {
          const existing = await ApprovalHistory.findOne({
            where: {
              request_id: permohonan.request_id,
              step_id: permohonan.current_step_id,
              approver_jabatan: { [require('sequelize').Op.like]: `%APJ_ROLE:${apjRole}%` },
              status: 'Approved'
            },
            transaction
          });

          if (existing) {
            // Duplicate approval for same APJ role - treat as idempotent success
            await transaction.commit();
            return res.status(200).json({ message: 'APJ role already approved previously.', data: permohonan });
          }
        }
      }
      
      // Check for duplicate APJ department approvals in step 2
      if (currentStepLevel === 2) {
        // Get approver's department from external API
        let approverDept = null;
        try {
          const axios = require('axios');
          const EXTERNAL_APPROVAL_URL = process.env.EXTERNAL_APPROVAL_URL || 'http://192.168.1.38/api/global-dev/v1/custom/list-approval-magang';
          const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
          const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];
          const userApprovals = items.filter(item => 
            String(item.Appr_ApplicationCode || '') === 'ePengelolaan_Limbah' &&
            String(item.Appr_ID) === String(verifierId) &&
            Number(item.Appr_No) === 2
          );
          
          if (userApprovals.length > 0) {
            approverDept = String(userApprovals[0].Appr_DeptID || '').toUpperCase();
          }
        } catch (extErr) {
          console.warn('[approvePermohonan] Failed to get approver department for duplicate check:', extErr.message);
        }

        if (approverDept) {
          // Check if this department has already approved this step
          const histories = await ApprovalHistory.findAll({
            where: {
              request_id: permohonan.request_id,
              step_id: permohonan.current_step_id,
              status: 'Approved'
            },
            transaction
          });

          // Check if any existing approval is from the same department
          for (const history of histories) {
            const historyApproverId = history.approver_id || history.approver_id_delegated;
            try {
              const axios = require('axios');
              const EXTERNAL_APPROVAL_URL = process.env.EXTERNAL_APPROVAL_URL || 'http://192.168.1.38/api/global-dev/v1/custom/list-approval-magang';
              const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
              const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];
              const historyApproverData = items.find(item => 
                String(item.Appr_ApplicationCode || '') === 'ePengelolaan_Limbah' &&
                String(item.Appr_ID) === String(historyApproverId) &&
                Number(item.Appr_No) === 2
              );
              
              if (historyApproverData && String(historyApproverData.Appr_DeptID || '').toUpperCase() === approverDept) {
                // Same department has already approved
                await transaction.commit();
                return res.status(200).json({ 
                  message: `APJ ${approverDept} department has already approved this request.`, 
                  data: permohonan 
                });
              }
            } catch (dupCheckErr) {
              console.warn('[approvePermohonan] Error in duplicate APJ department check:', dupCheckErr.message);
            }
          }
        }
      }

      // Build approver_jabatan to include role marker so we can reconstruct per-role approvals
      let approverJabatanSnapshot = req.body.verifierJabatan || user.Jabatan || null;
      if (currentStepLevel === 3 && roleId) {
        approverJabatanSnapshot = `${approverJabatanSnapshot || ''} VERIF_ROLE:${roleId}`.trim();
      } else if (currentStepLevel === 2 && apjRole) {
        approverJabatanSnapshot = `${approverJabatanSnapshot || ''} APJ_ROLE:${apjRole}`.trim();
      }

      // For Verifikasi Lapangan (step_level === 3) the approver is signing as themselves
      // (they authenticate inside the modal). Ensure any delegated snapshot fields are NULL
      // so generated docs and UI show the approver as themselves rather than 'a.n.' delegation.
      const isVerificationStepCreate = permohonan.CurrentStep && permohonan.CurrentStep.step_level === 3;

      await ApprovalHistory.create({
        request_id: permohonan.request_id,
        step_id: permohonan.current_step_id,
        status: 'Approved',
        comments: req.body.comments || 'Approved',
        // Snapshot the user who approved - prefer verifierId when provided
        approver_id: verifierId,
        approver_name: req.body.verifierName || user.Nama,
        approver_jabatan: approverJabatanSnapshot,
        // For verification step, do NOT record delegated approver snapshot (they are signing as themselves)
        approver_id_delegated: isVerificationStepCreate ? null : (delegatedUser ? delegatedUser.log_NIK : null),
        approver_name_delegated: isVerificationStepCreate ? null : (delegatedUser ? delegatedUser.Nama : null),
        approver_jabatan_delegated: isVerificationStepCreate ? null : (delegatedUser ? delegatedUser.Jabatan : null),
      }, { transaction });

      // --- Check if this is HSE Manager step - but DON'T auto-complete
      // Let the normal workflow flow handle completion when there are no more steps
      // This fixes the auto-approve issue where HSE Manager approval immediately completed the request
      let isHSEManagerStep = false;
      try {
        const axios = require('axios');
        const EXTERNAL_APPROVAL_URL = process.env.EXTERNAL_APPROVAL_URL || 'http://192.168.1.38/api/global-dev/v1/custom/list-approval-magang';
        const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
        const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];
        const matches = items.filter(i => String(i.Appr_ID) === String(verifierId));
        isHSEManagerStep = matches.some(m => Number(m.Appr_No) === 4 && String((m.Appr_DeptID || '').toUpperCase()) === 'KL');
      } catch (extErr) {
        // External API failed - fallback: check if current step is HSE Manager based on step name
        const currentStepName = permohonan.CurrentStep && permohonan.CurrentStep.step_name;
        isHSEManagerStep = currentStepName === 'HSE Manager';
        console.warn('[approvePermohonan] External approval API failed, using step name fallback:', extErr && extErr.message);
      }
  
      // 5. Find the next step in the workflow
      // Use the next greater step_level (min step_level > current) so that
      // appended verification steps at higher levels are respected and we
      // don't assume contiguous numbering.
      // Special rule: If the current step is Manager (step_level === 1)
      // and the request's golongan is NOT Prekursor / OOT nor Recall,
      // skip the APJ step (step_level === 2) and advance directly to the
      // next non-APJ step (typically Verifikasi Lapangan, step_level 3).
      const Op = require('sequelize').Op;

      // Determine golongan category name for this request
      const golongan = await GolonganLimbah.findByPk(permohonan.golongan_limbah_id, { transaction });
      const categoryName = (golongan && golongan.nama) ? String(golongan.nama).toLowerCase() : '';
      const isPrecursor = categoryName.includes('prekursor') || categoryName.includes('oot');
      const isRecall = categoryName.includes('recall');
      const isRecallPrecursor = categoryName.includes('recall') && categoryName.includes('prekursor');

      let nextStep;
      if (permohonan.CurrentStep.step_level === 1 && !isPrecursor && !isRecall && !isRecallPrecursor) {
        // For Standard workflow: Skip APJ (step level 2) and go directly to Verifikasi Lapangan (step level 3)
        nextStep = await ApprovalWorkflowStep.findOne({
          where: {
            approval_workflow_id: permohonan.approval_workflow_id,
            [Op.and]: [
              { step_level: { [Op.gt]: permohonan.CurrentStep.step_level } },
              { step_level: { [Op.ne]: 2 } }
            ]
          },
          order: [['step_level', 'ASC']],
          transaction
        });
      } else {
        nextStep = await ApprovalWorkflowStep.findOne({
          where: {
            approval_workflow_id: permohonan.approval_workflow_id,
            step_level: {
              [Op.gt]: permohonan.CurrentStep.step_level
            }
          },
          order: [['step_level', 'ASC']],
          transaction
        });
      }
  
      // 6. Update the permohonan to the next step
      // Special handling for steps that require multiple parallel approvals:
      // - Step 2 (APJ): May require multiple departments (PN1, QA, HC) for complex scenarios
      // - Step 3 (Verification): Requires all 4 verification roles
      
      // Check if all required approvals for this step are complete
      // Use required_approvals from database if available, otherwise use dynamic computation
      let requiredApprovals = 1;
      if (permohonan.CurrentStep && typeof permohonan.CurrentStep.required_approvals !== 'undefined' && permohonan.CurrentStep.required_approvals !== null) {
        requiredApprovals = permohonan.CurrentStep.required_approvals || 1;
      }

      const histories = await ApprovalHistory.findAll({
        where: {
          request_id: permohonan.request_id,
          step_id: permohonan.current_step_id,
          status: 'Approved'
        },
        transaction
      });

      if (permohonan.CurrentStep.step_level === 2) {
        // APJ step: Check which APJ roles have approved using APJ_ROLE markers
        const approvedApjRoles = new Set();
        histories.forEach(h => {
          const jab = h.approver_jabatan || '';
          const m = jab.match(/APJ_ROLE:(\w+)/);
          if (m && m[1]) approvedApjRoles.add(m[1]);
        });

        // Determine required APJ roles based on golongan and isProdukPangan
        let requiredApjRoles = [];
        try {
          const golongan = await GolonganLimbah.findByPk(permohonan.golongan_limbah_id);
          const categoryName = (golongan && golongan.nama) ? String(golongan.nama).toLowerCase() : '';
          const isPrecursor = categoryName.includes('prekursor') || categoryName.includes('oot');
          const isRecall = categoryName.includes('recall');
          const isRecallPrecursor = categoryName.includes('recall') && categoryName.includes('prekursor');
          const isProdukPangan = permohonan.is_produk_pangan === true;

          if (isRecallPrecursor) {
            // Recall & Precursor: need APJ PN and APJ QA
            requiredApjRoles = ['PN', 'QA'];
          } else if (isPrecursor) {
            // Pure Precursor: need APJ PN only
            requiredApjRoles = ['PN'];
          } else if (isRecall) {
            // Pure Recall: need APJ QA, plus HC if produk pangan
            if (isProdukPangan) {
              requiredApjRoles = ['QA', 'HC'];
            } else {
              requiredApjRoles = ['QA'];
            }
          }
        } catch (gErr) {
          console.warn('[approvePermohonan] Failed to determine required APJ roles:', gErr && gErr.message);
        }

        // Check if all required APJ roles have approved
        const allApjRolesApproved = requiredApjRoles.every(role => approvedApjRoles.has(role));

        if (allApjRolesApproved) {
          permohonan.current_step_id = nextStep ? nextStep.step_id : null;
          if (!nextStep) permohonan.status = 'Completed';
        } else {
          // Keep at same step until all required APJ roles approve
          permohonan.current_step_id = permohonan.current_step_id;
          permohonan.status = 'InProgress';
        }
      } else if (permohonan.CurrentStep.step_level === 3) {
        // Verification step: require all 4 verification roles to approve
        // Extract role markers from approver_jabatan like '... VERIF_ROLE:<id>'
        const approvedRoles = new Set();
        histories.forEach(h => {
          const jab = h.approver_jabatan || '';
          const m = jab.match(/VERIF_ROLE:(\d+)/);
          if (m && m[1]) approvedRoles.add(Number(m[1]));
        });

        // If all 4 roles approved (1..4), then advance; otherwise keep current step
        const requiredRoles = [1,2,3,4];
        const allRolesApproved = requiredRoles.every(r => approvedRoles.has(r));

        if (allRolesApproved && histories.length >= requiredApprovals) {
          permohonan.current_step_id = nextStep ? nextStep.step_id : null;
          if (!nextStep) permohonan.status = 'Completed';
        } else {
          // Keep at same step and don't advance until all roles approve
          permohonan.current_step_id = permohonan.current_step_id;
          permohonan.status = 'InProgress';
        }
      } else {
        // Other steps: use count-based approach with required_approvals
        if (histories.length >= requiredApprovals) {
          permohonan.current_step_id = nextStep ? nextStep.step_id : null;
          if (!nextStep) permohonan.status = 'Pembuatan BAP';
        } else {
          permohonan.current_step_id = permohonan.current_step_id;
          permohonan.status = 'InProgress';
        }
      }

      await permohonan.save({ transaction });
      
      // If everything succeeded, commit the changes
      await transaction.commit();
  
      res.status(200).json({
        message: `Request approved. ${nextStep ? 'Advanced to next step.' : 'Approval workflow complete.'}`,
        data: permohonan
      });
  
    } catch (error) {
      await transaction.rollback();
      console.error("Failed to approve permohonan:", error);
      res.status(500).json({ message: "Error approving permohonan", error: error.message });
    }
};

/**
 * Reject - POST /permohonan-pemusnahan-limbah/:id/reject
 * Handles rejecting a request.
 */
const rejectPermohonan = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { alasan_penolakan } = req.body;
        const { user, delegatedUser } = req;
        // Support explicit verifier metadata (when frontend authenticates a different verifier
        // locally in a modal). If a verifierId is passed in the request body, we'll use it
        // for the external authorization check (same pattern used in approvePermohonan).
        const verifierId = req.body?.verifierId || user.log_NIK;
        const authorizingUser = verifierId === user.log_NIK ? user : { log_NIK: verifierId };
        const actingUser = delegatedUser || user; // For audit trail - who the action is being performed as

        if (!alasan_penolakan) {
            await transaction.rollback();
            return res.status(400).json({ message: 'Rejection reason is required.' });
        }

        const permohonan = await PermohonanPemusnahanLimbah.findByPk(id, {
            include: [{ model: ApprovalWorkflowStep, as: 'CurrentStep', include: [ApprovalWorkflowApprover] }],
            transaction
        });

        if (!permohonan) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Permohonan not found' });
        }
        if (!permohonan.CurrentStep) {
            await transaction.rollback();
            return res.status(400).json({ message: 'Request is not currently in an approval step.'});
        }

        // Authorization Check using external API
        let isApprover = await checkApprovalAuthorization(authorizingUser, permohonan);

        // TEST BYPASS: allow developers to bypass Verifikasi Lapangan authorization when
        // process.env.TEST_BYPASS_VERIFICATION === 'true' AND a valid token header is provided.
        try {
          const bypassEnabled = String(process.env.TEST_BYPASS_VERIFICATION || '').toLowerCase() === 'true';
          const bypassToken = process.env.TEST_BYPASS_TOKEN || null;
          const providedToken = (req.headers['x-test-bypass-token'] || req.headers['X-Test-Bypass-Token'] || '').toString();
          const isVerificationStep = permohonan.CurrentStep && permohonan.CurrentStep.step_level === 3;
          if (!isApprover && bypassEnabled && bypassToken && providedToken && isVerificationStep) {
            if (providedToken === bypassToken) {
              isApprover = true;
              req.usedVerificationBypass = true;
              console.warn('[TEST_BYPASS] Verification bypass used for reject on request', permohonan.request_id, 'by', user && user.log_NIK);
            }
          }
        } catch (bypassErr) {
          console.warn('Error evaluating test bypass for reject:', bypassErr && bypassErr.message);
        }

        if (!isApprover) {
            await transaction.rollback();
            return res.status(403).json({ 
              message: 'You are not authorized to reject this request.',
              debug: {
                userId: authorizingUser.log_NIK,
                currentStepLevel: permohonan.CurrentStep.step_level,
                requestDepartment: permohonan.bagian || permohonan.requester_dept_id
              }
            });
        }

    // Record the rejection in history. Prefer explicit verifier metadata when provided
    // so that modal-authenticated verifiers are recorded correctly.
    // For Verifikasi Lapangan rejections, similarly ensure delegated snapshot is null
    const isVerificationStepReject = permohonan.CurrentStep && permohonan.CurrentStep.step_level === 3;

    await ApprovalHistory.create({
      request_id: permohonan.request_id,
      step_id: permohonan.current_step_id,
      status: 'Rejected',
      comments: alasan_penolakan,
      approver_id: verifierId,
      approver_name: req.body?.verifierName || user.Nama,
      approver_jabatan: req.body?.verifierJabatan || user.Jabatan,
      approver_id_delegated: isVerificationStepReject ? null : (delegatedUser ? delegatedUser.log_NIK : null),
      approver_name_delegated: isVerificationStepReject ? null : (delegatedUser ? delegatedUser.Nama : null),
      approver_jabatan_delegated: isVerificationStepReject ? null : (delegatedUser ? delegatedUser.Jabatan : null),
    }, { transaction });

        // Determine behavior based on current step level
        const currentStepLevel = permohonan.CurrentStep.step_level;
        
        if (currentStepLevel === 1) {
            // Manager rejection: Return to draft for pemohon to edit
            permohonan.current_step_id = null;
            permohonan.status = 'Draft';
            permohonan.alasan_penolakan = alasan_penolakan;
        } else {
            // HSE or higher level rejection: Final rejection
            permohonan.current_step_id = null;
            permohonan.status = 'Rejected';
            permohonan.alasan_penolakan = alasan_penolakan;
        }
        
        await permohonan.save({ transaction });

        await transaction.commit();
        
        const message = currentStepLevel === 1 
            ? 'Request rejected and returned to draft for revision.'
            : 'Request has been permanently rejected.';
            
        res.status(200).json({ message, data: permohonan });

    } catch (error) {
        await transaction.rollback();
        console.error("Failed to reject permohonan:", error);
        res.status(500).json({ message: "Error rejecting permohonan", error: error.message });
    }
};

/**
 * Update - PUT /permohonan-pemusnahan-limbah/:id
 * Handles updating a request. Permissions are conditional:
 * - If not yet submitted (current_step_id is null and no rejections), only the original requester can edit.
 * - If at the first approval step, only an authorized manager for that step can edit.
 * - No edits are allowed at subsequent steps.
 * All changes are logged to the audit table.
 */
const updatePermohonan = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const updatedData = req.body;
        const { user, delegatedUser } = req;
        const actingUser = delegatedUser || user;

        const permohonan = await PermohonanPemusnahanLimbah.findByPk(id, {
            include: [
                { model: DetailLimbah },
                { model: ApprovalWorkflowStep, as: 'CurrentStep', include: [ApprovalWorkflowApprover] }
            ],
            transaction
        });

        if (!permohonan) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Permohonan not found' });
        }

        // Prevent editing permanently rejected requests (rejected by HSE or higher)
        if (permohonan.status === 'Rejected') {
            await transaction.rollback();
            return res.status(403).json({ message: 'Permanently rejected requests cannot be edited. Please create a new request.' });
        }

        // Authorization Logic
        let isAuthorized = false;
        const isDraft = permohonan.status === 'Draft';
        const isManagerStep = permohonan.CurrentStep && permohonan.CurrentStep.step_level === 1;

        // Allow pemohon to edit draft (including drafts returned from manager rejection)
        // Accept either the original requester or the delegated requester
        if (isDraft && (permohonan.requester_id === actingUser.log_NIK || permohonan.requester_id_delegated === actingUser.log_NIK)) {
          isAuthorized = true;
        } 
        // Allow manager to edit at first approval step - use external API authorization
        else if (isManagerStep) {
            // Use the same external API authorization logic for editing permissions
            isAuthorized = await checkApprovalAuthorization(actingUser, permohonan);
        }

        if (!isAuthorized) {
            await transaction.rollback();
            return res.status(403).json({ message: 'You are not authorized to edit this request at its current stage.' });
        }
        
        // --- Track Changes for Audit Logging ---
        const changes = [];
        const mainFields = ['bagian', 'bentuk_limbah', 'golongan_limbah_id', 'jenis_limbah_b3_id', 'is_produk_pangan'];

        mainFields.forEach(field => {
            if (updatedData[field] !== undefined && String(permohonan[field]) !== String(updatedData[field])) {
                changes.push({
                    field: field,
                    old: permohonan[field],
                    new: updatedData[field]
                });
            }
        });

        // --- Perform Updates ---
        await permohonan.update(updatedData, { transaction });

        // --- Update Detail Limbah if provided ---
        if (updatedData.details && Array.isArray(updatedData.details)) {
            // Remove existing details
            const deletedCount = await DetailLimbah.destroy({ 
                where: { request_id: id }, 
                transaction 
            });

            // Insert new details
            const detailItems = updatedData.details.map(detail => ({ 
                ...detail, 
                request_id: parseInt(id) 
            }));
            
            const createdDetails = await DetailLimbah.bulkCreate(detailItems, { transaction });

            // Recompute jumlah_item for this permohonan and persist it
            try {
              const pairSet = new Set();
              (updatedData.details || []).forEach(d => {
                const name = (d.nama_limbah || '').toString().trim();
                const analisa = (d.nomor_analisa || '').toString().trim();
                pairSet.add(`${name}|||${analisa}`);
              });
              permohonan.jumlah_item = pairSet.size;
              await permohonan.save({ transaction });
            } catch (e) {
              console.warn('[updatePermohonan] Failed to compute jumlah_item:', e && e.message);
            }

            // Log detail changes
            changes.push({
                field: 'details',
                old: `${permohonan.DetailLimbahs?.length || 0} items`,
                new: `${updatedData.details.length} items`
            });
        }
        
        // --- Log the changes ---
        await logChanges(req, 'UPDATE', id, changes, transaction);
        
        await transaction.commit();
        
        // Fetch updated data to return
        const updatedPermohonan = await PermohonanPemusnahanLimbah.findByPk(id, {
            include: [{ model: DetailLimbah }]
        });
        
        res.status(200).json({ 
            message: 'Request updated successfully.',
            data: updatedPermohonan
        });

    } catch (error) {
        await transaction.rollback();
        console.error("Failed to update permohonan:", error);
        res.status(500).json({ message: "Error updating permohonan", error: error.message });
    }
};

/**
 * Delete - DELETE /permohonan-pemusnahan-limbah/:id
 * Deletes a request. Only allowed if the request is a draft (not submitted)
 * or if it has been rejected.
 */
const deletePermohonan = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { user, delegatedUser } = req;
        const actingUser = delegatedUser || user;

        const permohonan = await PermohonanPemusnahanLimbah.findByPk(id, { transaction });

        if (!permohonan) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Permohonan not found' });
        }

        // Allow deletion by original requester or delegated requester
        if (permohonan.requester_id !== actingUser.log_NIK && permohonan.requester_id_delegated !== actingUser.log_NIK) {
          await transaction.rollback();
          return res.status(403).json({ message: 'You are not authorized to delete this request.' });
        }
        
        // Allow deletion for drafts (including returned from manager) and permanently rejected requests
        const isDeletable = permohonan.status === 'Draft' || permohonan.status === 'Rejected';
        if (!isDeletable) {
            await transaction.rollback();
            return res.status(400).json({ message: 'This request cannot be deleted because it is currently in an active workflow.' });
        }
        
        // Log the deletion action before destroying the record
        await logChanges(
            req, 'REMOVE_ITEM', permohonan.request_id, 
            [{ field: 'request', old: `Request ID ${id}`, new: 'Deleted' }],
            transaction
        );

        await permohonan.destroy({ transaction });
        await transaction.commit();
        res.status(200).json({ message: 'Request has been deleted successfully.' });

    } catch (error) {
        await transaction.rollback();
        console.error("Failed to delete permohonan:", error);
        res.status(500).json({ message: "Error deleting permohonan", error: error.message });
    }
};

module.exports = {
    createPermohonan,
    getAllPermohonan,
    getPermohonanById,
    submitPermohonan,
    approvePermohonan,
    rejectPermohonan,
    updatePermohonan,
    deletePermohonan
};