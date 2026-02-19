const {
    ApprovalWorkflow,
    ApprovalWorkflowStep,
    ApprovalWorkflowApprover,
    SigningWorkflow,
    SigningWorkflowStep,
    SigningWorkflowSigner,
    BeritaAcara,
    SigningHistory,
    GolonganLimbah,
    JenisLimbahB3,
    PermohonanPemusnahanLimbah,
    ApprovalHistory
} = require('../models');

const axios = require('axios');
const EXTERNAL_APPROVAL_URL = process.env.EXTERNAL_APPROVAL_URL || 'http://192.168.1.38/api/global-dev/v1/custom/list-approval-magang';

const { getUsersByCriteria, fetchUsersWithCache } = require('./userController');

/**
 * Dynamically determines the appropriate approver for a step based on requester department and waste category
 * @param {number} stepId - The workflow step ID
 * @param {string} requesterDeptId - The department of the person making the request
 * @param {number} golonganLimbahId - The waste category ID
 * @param {number} workflowId - The workflow ID
 * @returns {Promise<Object>} - The appropriate approver details
 */
const getDynamicApprover = async (stepId, requesterDeptId, golonganLimbahId, workflowId) => {
    try {
        // Get all configured approvers for this step
        const stepApprovers = await ApprovalWorkflowApprover.findAll({
            where: { step_id: stepId },
            include: [{
                model: ApprovalWorkflowStep,
                attributes: ['step_level', 'step_name']
            }]
        });

        if (stepApprovers.length === 0) {
            throw new Error('No approvers configured for this step');
        }

        // Get waste category details
        const golonganLimbah = await GolonganLimbah.findByPk(golonganLimbahId);
        const categoryName = golonganLimbah?.nama?.toLowerCase() || '';

        // Get step information
        const step = stepApprovers[0].ApprovalWorkflowStep;
        const stepLevel = step.step_level;
        const stepName = step.step_name.toLowerCase();

        // Dynamic assignment logic based on step level and requester department
        let selectedApprover = null;

        // For all steps, first try to find an approver from the same department as requester
        // This allows flexible assignment where admins can configure multiple users per step
        selectedApprover = stepApprovers.find(approver => 
            approver.approver_dept_id === requesterDeptId
        );

        // If no department-specific approver found, use the first available approver
        if (!selectedApprover && stepApprovers.length > 0) {
            selectedApprover = stepApprovers[0];
        }

        if (!selectedApprover) {
            throw new Error('No suitable approver found for this step');
        }

        return selectedApprover;
    } catch (error) {
        console.error('Error getting dynamic approver:', error);
        throw error;
    }
};

/**
 * GET /api/workflows/approval-workflows -> Get all available approval workflows
 */
const getApprovalWorkflows = async (req, res) => {
    try {
        // Try external API first
        try {
            const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
            const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];

            // Map external items into DB-shaped ApprovalWorkflow objects
            // Group by application code -> workflow
            const workflowsMap = {};
            items.forEach(it => {
                const app = it.Appr_ApplicationCode || 'unknown';
                workflowsMap[app] = workflowsMap[app] || { 
                    approval_workflow_id: null, 
                    workflow_name: app, 
                    ApprovalWorkflowSteps: {} 
                };
                const stepKey = String(it.Appr_No != null ? it.Appr_No : '0');
                const wf = workflowsMap[app];
                // Normalize special step names from external API to friendly labels
                let stepName = it.Appr_CC || `Step ${stepKey}`;
                if (String(stepKey) === '3') stepName = 'Verifikasi Lapangan';
                if (String(stepKey) === '4') stepName = 'HSE Manager';
                wf.ApprovalWorkflowSteps[stepKey] = wf.ApprovalWorkflowSteps[stepKey] || { 
                    step_id: Number(stepKey), 
                    step_level: Number(stepKey), 
                    step_name: stepName, 
                    ApprovalWorkflowApprovers: [] 
                };
                wf.ApprovalWorkflowSteps[stepKey].ApprovalWorkflowApprovers.push({
                    approver_id: it.Appr_ID,
                    approver_name: it.emp_Name,
                    approver_cc: it.Appr_CC,
                    approver_dept_id: it.Appr_DeptID,
                    approver_identity: it.Appr_ID,
                    raw: it
                });
            });

            // Convert map to array and normalize ApprovalWorkflowSteps to arrays
            const workflows = Object.keys(workflowsMap).map((appCode, idx) => {
                const wf = workflowsMap[appCode];
                wf.approval_workflow_id = idx + 1;
                wf.ApprovalWorkflowSteps = Object.keys(wf.ApprovalWorkflowSteps)
                    .sort((a,b)=>Number(a)-Number(b))
                    .map(k => wf.ApprovalWorkflowSteps[k]);
                return wf;
            });

            return res.status(200).json({ success: true, data: workflows });
        } catch (err) {
            console.warn('External approval API failed, falling back to DB:', err.message || err);
            // Fall back to DB-based logic if external API fails
        }

        // Fallback: original DB behavior
        const workflows = await ApprovalWorkflow.findAll({
            where: { is_active: true },
            include: [{
                model: ApprovalWorkflowStep,
                include: [{
                    model: ApprovalWorkflowApprover,
                    separate: true  // Fix for Sequelize nested include issue
                }]
            }]
        });

        // Enrich approver data with directory user information (non-destructive)
        const users = await fetchUsersWithCache();
        const userMap = {};
        (users || []).forEach(u => { if (u && u.emp_NIK) userMap[String(u.emp_NIK)] = u; });

        const enrichedWorkflows = (workflows || []).map(wf => {
            wf.ApprovalWorkflowSteps = (wf.ApprovalWorkflowSteps || []).map(step => {
                step.ApprovalWorkflowApprovers = (step.ApprovalWorkflowApprovers || []).map(a => {
                    const identity = a.approver_identity || a.approver_id;
                    const user = identity ? userMap[String(identity)] : null;
                    if (user) {
                        a.approver_dept_name = user.emp_Dept || null;
                        a.approver_job_level = user.emp_JobLevel || null;
                    }
                    return a;
                });
                return step;
            });
            return wf;
        });

        return res.status(200).json({ success: true, data: enrichedWorkflows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/workflows/signing-workflows -> Get all available signing workflows
 */
const getSigningWorkflows = async (req, res) => {
    try {
        // Try external API first
        try {
            const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
            const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];

            // Filter signing items (Berita Acara application code)
            const signingItems = items.filter(i => String(i.Appr_ApplicationCode || '').toLowerCase().includes('berita'));

            // Build SigningWorkflow-shaped object
            const signingWorkflow = {
                signing_workflow_id: 1,
                workflow_name: 'ePengelolaan_Limbah_Berita_Acara',
                SigningWorkflowSteps: {}
            };

            signingItems.forEach(it => {
                const stepKey = String(it.Appr_No != null ? it.Appr_No : '0');
                // Normalize signing step names for clarity
                let sName = it.Appr_CC || `Step ${stepKey}`;
                if (String(stepKey) === '3') sName = 'Verifikasi Lapangan';
                if (String(stepKey) === '4') sName = 'HSE Manager';
                signingWorkflow.SigningWorkflowSteps[stepKey] = signingWorkflow.SigningWorkflowSteps[stepKey] || {
                    step_id: Number(stepKey),
                    step_level: Number(stepKey),
                    step_name: sName,
                    SigningWorkflowSigners: [],
                    // No per-request signed_at information available in global listing
                    signed_at: null
                };
                signingWorkflow.SigningWorkflowSteps[stepKey].SigningWorkflowSigners.push({
                    log_nik: it.Appr_ID,
                    signer_name: it.emp_Name,
                    signer_cc: it.Appr_CC,
                    signer_dept_id: it.Appr_DeptID,
                    raw: it
                });
            });

            // Normalize steps to array
            signingWorkflow.SigningWorkflowSteps = Object.keys(signingWorkflow.SigningWorkflowSteps)
                .sort((a,b)=>Number(a)-Number(b))
                .map(k => signingWorkflow.SigningWorkflowSteps[k]);

            return res.status(200).json({ success: true, data: [signingWorkflow] });
        } catch (err) {
            console.warn('External approval API failed for signing, falling back to DB:', err.message || err);
        }

        // Fallback to DB
        const workflows = await SigningWorkflow.findAll({
            where: { is_active: true },
            include: [{
                model: SigningWorkflowStep,
                include: [{
                    model: SigningWorkflowSigner,
                    separate: true  // Fix for Sequelize nested include issue
                }]
            }]
        });

        // Enrich signer data with user information from external API (use log_nik mapping)
        const users = await fetchUsersWithCache();
        const userMap = {};
        (users || []).forEach(user => { if (user && user.emp_NIK) userMap[String(user.emp_NIK)] = user; });

        // Enrich each workflow's signer data
        workflows.forEach(workflow => {
            (workflow.SigningWorkflowSteps || []).forEach(step => {
                // Ensure signed_at field exists for consistency
                step.signed_at = step.signed_at || null;
                (step.SigningWorkflowSigners || []).forEach(signer => {
                    const userData = signer && signer.log_nik ? userMap[String(signer.log_nik)] : null;
                    if (userData) {
                        // Enrich signer data with user details using standard backend field names
                        signer.dataValues.signer_name = userData.emp_Name;
                        signer.dataValues.signer_cc = userData.emp_Email;
                        signer.dataValues.signer_dept_id = userData.emp_DeptID;
                        signer.dataValues.signer_identity = userData.emp_NIK;
                        signer.dataValues.signer_dept_name = userData.emp_Dept;
                        signer.dataValues.signer_job_level = userData.emp_JobLevel;
                    } else {
                        // Ensure fields exist even if no directory data found
                        signer.dataValues.signer_name = signer.dataValues.signer_name || null;
                        signer.dataValues.signer_cc = signer.dataValues.signer_cc || null;
                        signer.dataValues.signer_dept_id = signer.dataValues.signer_dept_id || null;
                        signer.dataValues.signer_identity = signer.dataValues.signer_identity || null;
                        signer.dataValues.signer_dept_name = signer.dataValues.signer_dept_name || null;
                        signer.dataValues.signer_job_level = signer.dataValues.signer_job_level || null;
                    }
                });
            });
        });

    res.status(200).json({ success: true, data: workflows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/workflows/approval/:requestId -> Get approval workflow for specific request
 */
const getApprovalWorkflowByRequest = async (req, res) => {
    try {
        const { requestId } = req.params;
        
        const permohonan = await PermohonanPemusnahanLimbah.findByPk(requestId);
        if (!permohonan) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }

        // Get approval history for this request FIRST
        const approvalHistory = await ApprovalHistory.findAll({
            where: { request_id: requestId },
            order: [['decision_date', 'DESC']]
        });

        // Build a map of the latest history entry per step_level (not step_id)
        const historyByStepLevel = {};
        approvalHistory.forEach(history => {
            // We need to match history entries to step levels
            // This requires getting the step info from the history
            const stepLevel = history.step_level; // If this field exists
            if (!stepLevel && history.step_id) {
                // If step_level not in history, we'll need to look it up
                // For now, let's use a mapping approach
                // This will be resolved below
            }
        });

        // Try external API first to build request-specific approval steps
        try {
            const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
            const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];

            // Filter items for ePengelolaan_Limbah application code
            const appCode = 'ePengelolaan_Limbah';
            const appItems = items.filter(i => String(i.Appr_ApplicationCode || '') === appCode);

            if (appItems.length === 0) {
                throw new Error('No approval items for ePengelolaan_Limbah in external API');
            }

            // Group by step number
            const grouped = {};
            appItems.forEach(it => {
                const step = it.Appr_No != null ? String(it.Appr_No) : '0';
                grouped[step] = grouped[step] || [];
                grouped[step].push(it);
            });

            // Determine requester's department and golongan for filtering
            const requesterDeptId = (permohonan.requester_dept_id || permohonan.bagian || '').toString();
            const golonganLimbah = await GolonganLimbah.findByPk(permohonan.golongan_limbah_id);
            const categoryName = golonganLimbah?.nama?.toLowerCase() || '';

            // Load directory users for verification role assignment
            const users = await fetchUsersWithCache();
            const userMap = {};
            (users || []).forEach(u => { if (u && u.emp_NIK) userMap[String(u.emp_NIK)] = u; });

            // Build step-level to step-id mapping for history lookup
            const stepLevelToStepId = {};
            
            // Get workflow steps to map step_level to step_id
            const workflow = await ApprovalWorkflow.findByPk(permohonan.approval_workflow_id, {
                include: [{
                    model: ApprovalWorkflowStep,
                    attributes: ['step_id', 'step_level']
                }]
            });
            
            if (workflow && workflow.ApprovalWorkflowSteps) {
                workflow.ApprovalWorkflowSteps.forEach(step => {
                    stepLevelToStepId[step.step_level] = step.step_id;
                });
            }

            // Now build history map by step_level
            const historyByStepLevel = {};
            approvalHistory.forEach(history => {
                // Find step_level for this step_id
                const stepLevel = Object.keys(stepLevelToStepId).find(level => 
                    stepLevelToStepId[level] === history.step_id
                );
                if (stepLevel && !historyByStepLevel[stepLevel]) {
                    historyByStepLevel[stepLevel] = history;
                }
            });

                const workflowSteps = Object.keys(grouped).sort((a,b)=>Number(a)-Number(b)).map(stepKey => {
                const rawApprovers = grouped[stepKey] || [];
                let filteredApprovers = rawApprovers;
                const stepLevel = Number(stepKey);

                // Get the correct step_id for this level
                const stepId = stepLevelToStepId[stepLevel];

                // Get approval history for this step level
                const stepHistory = historyByStepLevel[stepLevel];
                
                // Determine actual status based on history
                let actualStatus = 'pending';
                let actualTimestamp = null;
                let actualApprover = null;
                
                if (stepHistory) {
                    actualStatus = stepHistory.status === 'Approved' ? 'approved' : 'rejected';
                    actualTimestamp = stepHistory.decision_date || null;
                    actualApprover = stepHistory.approver_name || stepHistory.approver_id;
                }                // Manager (step 1) filter by requester department when possible
                if (String(stepKey) === '1' && requesterDeptId) {
                    const byDept = rawApprovers.filter(a => String(a.Appr_DeptID || '').toUpperCase() === String(requesterDeptId || '').toUpperCase());
                    if (byDept.length > 0) filteredApprovers = byDept;
                }

                // APJ (step 2): include only for specific golongan and Appr_DeptID mapping, else skip
                if (String(stepKey) === '2') {
                    const isPrecursor = categoryName.includes('prekursor') || categoryName.includes('oot');
                    const isRecall = categoryName.includes('recall');
                    const isRecallPrecursor = categoryName.includes('recall') && categoryName.includes('prekursor');
                    const isProdukPangan = permohonan.is_produk_pangan === true;

                    let requiredDepts = [];
                    
                    if (isRecallPrecursor) {
                        requiredDepts = ['PN1', 'QA'];
                    } else if (isPrecursor) {
                        requiredDepts = ['PN1'];
                    } else if (isRecall) {
                        // For pure Recall with produk pangan, need both QA and PC (PJKPO)
                        if (isProdukPangan) {
                            requiredDepts = ['QA', 'PC'];
                        } else {
                            requiredDepts = ['QA'];
                        }
                    }

                    if (requiredDepts.length > 0) {
                        const apjMatches = rawApprovers.filter(a => 
                            String(a.Appr_CC || '').toUpperCase() === 'APJ' && 
                            requiredDepts.includes(String(a.Appr_DeptID || '').toUpperCase())
                        );
                        if (apjMatches.length > 0) {
                            filteredApprovers = apjMatches;
                        } else {
                            // Fallback: create synthetic approvers for required departments
                            // This handles cases where external API doesn't have the expected data structure
                            filteredApprovers = requiredDepts.map(dept => {
                                if (dept === 'PC') {
                                    // Create synthetic PJKPO approver
                                    return {
                                        Appr_ID: 'PJKPO',
                                        emp_Name: 'PJKPO',
                                        Appr_DeptID: 'PC',
                                        Appr_CC: 'APJ'
                                    };
                                } else if (dept === 'QA') {
                                    // Create synthetic APJ QA approver
                                    return {
                                        Appr_ID: 'APJ_QA',
                                        emp_Name: 'APJ QA',
                                        Appr_DeptID: 'QA',
                                        Appr_CC: 'APJ'
                                    };
                                } else if (dept === 'PN1') {
                                    // Create synthetic APJ PN approver
                                    return {
                                        Appr_ID: 'APJ_PN',
                                        emp_Name: 'APJ PN',
                                        Appr_DeptID: 'PN1',
                                        Appr_CC: 'APJ'
                                    };
                                }
                                return null;
                            }).filter(Boolean);
                        }
                    } else {
                        // For other categories without special requirements, skip APJ step entirely
                        return null;
                    }
                }

                // Special handling for verification step (Appr_No === 3)
                if (String(stepKey) === '3') {
                    // Build four-role group: pelaksana_pemohon, supervisor_pemohon, pelaksana_hse, supervisor_hse
                    // Pemohon-side department is determined by requester's department
                    const selected = {
                        pelaksana_pemohon: null,
                        supervisor_pemohon: null,
                        pelaksana_hse: null,
                        supervisor_hse: null
                    };

                    rawApprovers.forEach(a => {
                        try {
                            const apprDept = (a.Appr_DeptID || '').toString().toUpperCase();
                            const userData = userMap[String(a.Appr_ID)] || {};
                            // job level may be in emp_JobLevelID or emp_JobLevel
                            const jobLevelRaw = (userData.emp_JobLevelID || userData.emp_JobLevel || '').toString();
                            const jobLevel = jobLevelRaw ? Number(jobLevelRaw) : null;

                            // HSE side: Appr_DeptID === 'KL'
                            if (apprDept === 'KL') {
                                if (!selected.pelaksana_hse && jobLevel === 7) {
                                    selected.pelaksana_hse = { approver_id: a.Appr_ID, approver_name: a.emp_Name, approver_dept_id: a.Appr_DeptID, approver_cc: a.Appr_CC, approver_job_level: jobLevel };
                                }
                                if (!selected.supervisor_hse && (jobLevel === 5 || jobLevel === 6)) {
                                    selected.supervisor_hse = { approver_id: a.Appr_ID, approver_name: a.emp_Name, approver_dept_id: a.Appr_DeptID, approver_cc: a.Appr_CC, approver_job_level: jobLevel };
                                }
                            }

                            // Pemohon side: Appr_DeptID matches requester's department
                            if (requesterDeptId && apprDept === String(requesterDeptId).toUpperCase()) {
                                if (!selected.pelaksana_pemohon && jobLevel === 7) {
                                    selected.pelaksana_pemohon = { approver_id: a.Appr_ID, approver_name: a.emp_Name, approver_dept_id: a.Appr_DeptID, approver_cc: a.Appr_CC, approver_job_level: jobLevel };
                                }
                                if (!selected.supervisor_pemohon && (jobLevel === 5 || jobLevel === 6)) {
                                    selected.supervisor_pemohon = { approver_id: a.Appr_ID, approver_name: a.emp_Name, approver_dept_id: a.Appr_DeptID, approver_cc: a.Appr_CC, approver_job_level: jobLevel };
                                }
                            }
                        } catch (err) {
                            // ignore mapping errors for individual approvers
                        }
                    });

                    // Compose approver array. For Verifikasi step (Appr_No 3) these approvers are not sequential.
                    // Any of these four roles may approve using the Verification modal.
                    const approverList = [];
                    if (selected.pelaksana_pemohon) approverList.push({ ...selected.pelaksana_pemohon, role_type: 'pelaksana_pemohon' });
                    if (selected.supervisor_pemohon) approverList.push({ ...selected.supervisor_pemohon, role_type: 'supervisor_pemohon' });
                    if (selected.pelaksana_hse) approverList.push({ ...selected.pelaksana_hse, role_type: 'pelaksana_hse' });
                    if (selected.supervisor_hse) approverList.push({ ...selected.supervisor_hse, role_type: 'supervisor_hse' });

                    // If none matched via user directory, fall back to configured rawApprovers (map to minimal shape)
                    const finalApprovers = approverList.length > 0 ? approverList : filteredApprovers.map(a => ({ approver_id: a.Appr_ID, approver_name: a.emp_Name, approver_dept_id: a.Appr_DeptID, approver_cc: a.Appr_CC }));

                    // Build per-role verification status by inspecting ApprovalHistory entries
                    // Roles mapping: 1=Pelaksana Pemohon, 2=Supervisor Pemohon, 3=Pelaksana HSE, 4=Supervisor HSE
                    const verificationRoleDefs = [
                        { id:1, key: 'pelaksana_pemohon', title: 'Pelaksana Pemohon' },
                        { id:2, key: 'supervisor_pemohon', title: 'Supervisor/Officer Pemohon' },
                        { id:3, key: 'pelaksana_hse', title: 'Pelaksana HSE' },
                        { id:4, key: 'supervisor_hse', title: 'Supervisor/Officer HSE' }
                    ];

                    // Load approval history entries for this request+step to determine per-role approvals
                    const roleHistories = approvalHistory.filter(h => h.step_id === stepLevelToStepId[3] || h.step_id === stepLevelToStepId[stepLevel] || h.step_id === Number(stepKey));

                    const verificationRoles = verificationRoleDefs.map(def => {
                        const matcher = roleHistories.find(h => {
                            const jab = h.approver_jabatan || '';
                            const m = jab.match(/VERIF_ROLE:(\d+)/);
                            return m && Number(m[1]) === def.id && h.status === 'Approved';
                        });
                        return {
                            id: def.id,
                            key: def.key,
                            title: def.title,
                            approved: !!matcher,
                            approved_at: matcher ? matcher.decision_date : null,
                            approver_name: matcher ? (matcher.approver_name || matcher.approver_id) : null
                        };
                    });

                    return {
                        step_id: Number(stepKey),
                        step_level: Number(stepKey),
                        action_type: 'Verifikasi',
                        role_name: 'Verifikasi Lapangan',
                        // Use actual approver from history if available
                        approver_name: actualApprover || null,
                        approver_id: stepHistory ? stepHistory.approver_id : null,
                        approved_at: actualTimestamp,
                        status: actualStatus,
                        comments: stepHistory ? stepHistory.comments : null,
                        // ApprovalWorkflowApprovers contains the candidate set - UI should allow any to approve
                        ApprovalWorkflowApprovers: finalApprovers,
                        VerificationRoles: verificationRoles
                    };
                }

                // For APJ steps (step 2) with multiple departments OR synthetic approvers, create separate step objects
                if (String(stepKey) === '2' && (filteredApprovers.length > 1 || 
                    (filteredApprovers.length > 0 && filteredApprovers.some(a => a.Appr_ID === 'PJKPO' || a.Appr_ID === 'APJ_QA' || a.Appr_ID === 'APJ_PN')))) {
                    // Group approvers by department
                    const apjByDept = {};
                    filteredApprovers.forEach(a => {
                        const dept = String(a.Appr_DeptID || '').toUpperCase();
                        if (!apjByDept[dept]) apjByDept[dept] = [];
                        apjByDept[dept].push(a);
                    });

                    // Use existing approval history that was already fetched
                    const allHistories = approvalHistory;

                    // Create separate step objects for each department
                    const stepObjects = [];
                    Object.keys(apjByDept).forEach((dept, index) => {
                        const deptApprovers = apjByDept[dept];
                        const approver = deptApprovers[0];
                        
                        // Determine role name and step name based on department (following seed.js)
                        let roleName = 'APJ';
                        let stepName = 'APJ Approval';
                        if (dept === 'PN1') {
                            roleName = 'APJ PN';
                        } else if (dept === 'QA') {
                            roleName = 'APJ QA';
                        } else if (dept === 'PC') {
                            roleName = 'PJKPO';
                            stepName = 'PJKPO Approval';
                        }
                        
                        // Check if this specific department has approved
                        let deptStatus = 'pending';
                        let deptApproverName = null;
                        let deptApproverId = null;
                        let deptApprovedAt = null;
                        let deptComments = null;
                        
                        // Find approval from this department
                        const deptHistory = allHistories.find(h => {
                            const historyStepLevel = Object.keys(stepLevelToStepId).find(level => 
                                stepLevelToStepId[level] === h.step_id
                            );
                            if (Number(historyStepLevel) !== 2) return false;
                            
                            // Check if approver belongs to this department
                            const historyApproverId = h.approver_id || h.approver_id_delegated;
                            const historyApproverName = h.approver_name;
                            
                            const matchResult = deptApprovers.some(a => {
                                // Match by ID
                                const idMatch = String(a.Appr_ID) === String(historyApproverId);
                                // Match by name (case insensitive)
                                const nameMatch = historyApproverName && a.emp_Name && 
                                    String(a.emp_Name).toLowerCase() === String(historyApproverName).toLowerCase();
                                // For APJ PJKPO department, also check if approver_id is 'PJKPO'
                                const pjkpoMatch = dept === 'PC' && String(historyApproverId) === 'PJKPO';
                                
                                return idMatch || nameMatch || pjkpoMatch;
                            });
                            
                            return matchResult;
                        });
                        
                        if (deptHistory) {
                            deptStatus = deptHistory.status === 'Approved' ? 'approved' : 'rejected';
                            deptApproverName = deptHistory.approver_name || deptHistory.approver_id;
                            deptApproverId = deptHistory.approver_id;
                            deptApprovedAt = deptHistory.decision_date;
                            deptComments = deptHistory.comments;
                        }
                        
                        // Use the correct step_id from database mapping
                        const stepIdFromDb = stepLevelToStepId[Number(stepKey)];
                        
                        stepObjects.push({
                            step_id: stepIdFromDb,
                            step_level: Number(stepKey),
                            action_type: 'Menyetujui',
                            role_name: roleName,
                            step_name: stepName,
                            // Use department-specific approval data
                            approver_name: deptApproverName || approver.emp_Name || null,
                            approver_id: deptApproverId || approver.Appr_ID || null,
                            approved_at: deptApprovedAt,
                            status: deptStatus,
                            comments: deptComments,
                            Appr_DeptID: dept,
                            ApprovalWorkflowApprovers: deptApprovers.map(a => ({ 
                                approver_id: a.Appr_ID, 
                                approver_name: a.emp_Name, 
                                approver_dept_id: a.Appr_DeptID, 
                                approver_cc: a.Appr_CC 
                            }))
                        });
                    });
                    
                    return stepObjects;
                }

                // Handle single department APJ steps (when only one department is required)
                if (String(stepKey) === '2' && filteredApprovers.length === 1) {
                    const approver = filteredApprovers[0];
                    const dept = String(approver.Appr_DeptID || '').toUpperCase();
                    
                    let roleName = 'APJ';
                    let stepName = 'APJ';
                    if (dept === 'PN1') {
                        roleName = 'APJ PN';
                        stepName = 'APJ Approval';
                    } else if (dept === 'QA') {
                        roleName = 'APJ QA';
                        stepName = 'APJ Approval';
                    } else if (dept === 'PC') {
                        roleName = 'PJKPO';
                        stepName = 'PJKPO Approval';
                    }
                    
                    // Find approval from this department
                    const deptHistory = approvalHistory.find(h => {
                        const historyStepLevel = Object.keys(stepLevelToStepId).find(level => 
                            stepLevelToStepId[level] === h.step_id
                        );
                        if (Number(historyStepLevel) !== 2) return false;
                        
                        const historyApproverId = h.approver_id || h.approver_id_delegated;
                        const historyApproverName = h.approver_name;
                        
                        // Check if approver belongs to this department
                        const idMatch = String(approver.Appr_ID) === String(historyApproverId);
                        const nameMatch = historyApproverName && approver.emp_Name && 
                            String(approver.emp_Name).toLowerCase() === String(historyApproverName).toLowerCase();
                        const pjkpoMatch = dept === 'PC' && String(historyApproverId) === 'PJKPO';
                        
                        return idMatch || nameMatch || pjkpoMatch;
                    });
                    
                    let deptStatus = 'pending';
                    let deptApproverName = null;
                    let deptApproverId = null;
                    let deptApprovedAt = null;
                    let deptComments = null;
                    
                    if (deptHistory) {
                        deptStatus = deptHistory.status === 'Approved' ? 'approved' : 'rejected';
                        deptApproverName = deptHistory.approver_name || deptHistory.approver_id;
                        deptApproverId = deptHistory.approver_id;
                        deptApprovedAt = deptHistory.decision_date;
                        deptComments = deptHistory.comments;
                    }
                    
                    return [{
                        step_id: stepLevelToStepId[Number(stepKey)],
                        step_level: Number(stepKey),
                        action_type: 'Menyetujui',
                        role_name: roleName,
                        step_name: stepName,
                        approver_name: deptApproverName || approver.emp_Name || null,
                        approver_id: deptApproverId || approver.Appr_ID || null,
                        approved_at: deptApprovedAt,
                        status: deptStatus,
                        comments: deptComments,
                        Appr_DeptID: dept,
                        ApprovalWorkflowApprovers: [{ 
                            approver_id: approver.Appr_ID, 
                            approver_name: approver.emp_Name, 
                            approver_dept_id: approver.Appr_DeptID, 
                            approver_cc: approver.Appr_CC 
                        }]
                    }];
                }

                // Use the first approver (after filtering) for display purposes for non-verification steps
                const approver = filteredApprovers[0] || rawApprovers[0] || {};

                // Default action_type is 'Menyetujui', but for step 4 (HSE Manager / KL) we want 'Mengetahui'
                const defaultAction = (String(stepKey) === '4') ? 'Mengetahui' : 'Menyetujui';

                return {
                    step_id: stepLevelToStepId[Number(stepKey)],
                    step_level: Number(stepKey),
                    action_type: defaultAction,
                    role_name: approver.Appr_CC || null,
                    // Use actual approver from history if available, otherwise use configured approver
                    approver_name: actualApprover || approver.emp_Name || null,
                    approver_id: (stepHistory ? stepHistory.approver_id : null) || approver.Appr_ID || null,
                    approved_at: actualTimestamp,
                    status: actualStatus,
                    comments: stepHistory ? stepHistory.comments : null,
                    ApprovalWorkflowApprovers: filteredApprovers.map(a => ({ approver_id: a.Appr_ID, approver_name: a.emp_Name, approver_dept_id: a.Appr_DeptID, approver_cc: a.Appr_CC }))
                };
            }).filter(Boolean).flat();

            return res.status(200).json({ success: true, data: workflowSteps });
        } catch (err) {
            console.warn('External approval API failed for request-specific approval, falling back to DB:', err.message || err);
        }

        // [Keep your existing DB fallback logic here...]
        const workflow = await ApprovalWorkflow.findByPk(permohonan.approval_workflow_id, {
            include: [{
                model: ApprovalWorkflowStep,
                include: [ApprovalWorkflowApprover],
                order: [['step_level', 'ASC']]
            }]
        });

        if (!workflow) {
            return res.status(404).json({ success: false, message: 'Approval workflow not found' });
        }

        // Build a map of the latest history entry per step_id
        const latestHistoryByStep = {};
        approvalHistory.forEach(history => {
            const sid = history.step_id;
            if (!sid) return;
            const existing = latestHistoryByStep[sid];
            if (!existing) {
                latestHistoryByStep[sid] = history;
            } else {
                const existingDate = existing.decision_date ? new Date(existing.decision_date) : null;
                const newDate = history.decision_date ? new Date(history.decision_date) : null;
                if (newDate && (!existingDate || newDate > existingDate)) {
                    latestHistoryByStep[sid] = history;
                }
            }
        });

        // Determine category to know if APJ step should be presented
        const golonganLimbah = await GolonganLimbah.findByPk(permohonan.golongan_limbah_id);
        const categoryName = golonganLimbah?.nama?.toLowerCase() || '';
        const isPrecursor = categoryName.includes('prekursor') || categoryName.includes('oot');
        const isRecall = categoryName.includes('recall');
        const isRecallPrecursor = categoryName.includes('recall') && categoryName.includes('prekursor');

        const workflowSteps = workflow.ApprovalWorkflowSteps
            // If not precursor/oot/recall/recall&precursor, remove APJ step (step_level === 2)
            .filter(s => !(s.step_level === 2 && !isPrecursor && !isRecall && !isRecallPrecursor))
            .map(step => {
            const stepHistory = latestHistoryByStep[step.step_id] || null;
            const approver = step.ApprovalWorkflowApprovers[0];

            const approverNameFromHistory = stepHistory ? (stepHistory.approver_name || null) : null;
            const approverIdFromHistory = stepHistory ? (stepHistory.approver_id || null) : null;

            // Default to 'Menyetujui' but if this is step_level 4 and approver dept is KL, use 'Mengetahui'
            let actionType = step.action_type || "Menyetujui";
            try {
                const firstApproverDept = approver && approver.approver_dept_id ? String(approver.approver_dept_id).toUpperCase() : null;
                if (Number(step.step_level) === 4 && firstApproverDept === 'KL') {
                    actionType = 'Mengetahui';
                }
            } catch (e) {
                // ignore and keep default
            }

            return {
                step_id: step.step_id,
                step_level: step.step_level,
                action_type: actionType,
                role_name: step.role_name,
                approver_name: approverNameFromHistory || (approver ? approver.approver_name : step.role_name),
                approver_id: approverIdFromHistory || (approver ? approver.approver_id : null),
                approved_at: stepHistory ? stepHistory.decision_date : null,
                status: stepHistory ? (stepHistory.status === 'Approved' ? "approved" : "rejected") : "pending",
                comments: stepHistory ? stepHistory.comments : null
            };
        });

        res.status(200).json({ success: true, data: workflowSteps });
    } catch (error) {
        console.error('Error getting approval workflow:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/workflows/signing/:requestId -> Get signing workflow for specific request
 */
const getSigningWorkflowByRequest = async (req, res) => {
    try {
        const { requestId } = req.params;
        
        // Find the permohonan to see if it's linked to a Berita Acara
        const permohonan = await PermohonanPemusnahanLimbah.findByPk(requestId);
        if (!permohonan) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }

        if (!permohonan.berita_acara_id) {
            // No berita acara created yet for this request
            return res.status(200).json({ 
                success: true, 
                data: [], 
                message: 'No Berita Acara associated with this request' 
            });
        }

        // Get signing history for this berita acara FIRST
        const signingHistory = await SigningHistory.findAll({
            where: { berita_acara_id: permohonan.berita_acara_id },
            order: [['signed_at', 'DESC']]
        });

        // Try external API first to build signing steps for Berita Acara
        try {
            const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
            const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];

            // Filter items for ePengelolaan_Limbah_Berita_Acara application code
            const appCode = 'ePengelolaan_Limbah_Berita_Acara';
            const appItems = items.filter(i => String(i.Appr_ApplicationCode || '') === appCode);

            if (appItems.length === 0) {
                throw new Error('No signing items for berita acara in external API');
            }

            // Group by step number
            const grouped = {};
            appItems.forEach(it => {
                const step = it.Appr_No != null ? String(it.Appr_No) : '0';
                grouped[step] = grouped[step] || [];
                grouped[step].push(it);
            });

            // Load berita acara and its related permohonan items to gather all golongan present
            const beritaAcara = await BeritaAcara.findByPk(permohonan.berita_acara_id, {
                include: [{ model: PermohonanPemusnahanLimbah, include: [GolonganLimbah] }]
            });

            if (!beritaAcara) {
                throw new Error('Berita Acara not found');
            }

            // Get signing workflow and its steps to get correct step_ids from database
            const workflow = await SigningWorkflow.findByPk(beritaAcara.signing_workflow_id, {
                include: [{
                    model: SigningWorkflowStep,
                    include: [SigningWorkflowSigner],
                    order: [['step_level', 'ASC']]
                }]
            });

            if (!workflow) {
                throw new Error('Signing workflow not found');
            }

            // Build step_level to step_id mapping from database
            const stepLevelToStepId = {};
            workflow.SigningWorkflowSteps.forEach(step => {
                stepLevelToStepId[step.step_level] = step.step_id;
            });

            // Now build history map by step_level
            const historyByStepLevel = {};
            signingHistory.forEach(history => {
                // Find step_level for this step_id
                const stepLevel = Object.keys(stepLevelToStepId).find(level => 
                    stepLevelToStepId[level] === history.step_id
                );
                if (stepLevel && !historyByStepLevel[stepLevel]) {
                    historyByStepLevel[stepLevel] = history;
                }
            });

            // Determine requester's department and golongan for filtering
            const bagian = (beritaAcara && (beritaAcara.bagian || beritaAcara.creator_dept_id)) ? String(beritaAcara.bagian || beritaAcara.creator_dept_id).toUpperCase() : null;

            // Collect golongan names from all linked permohonan entries
            const golonganNames = new Set();
            let hasProdukPangan = false;
            if (beritaAcara && Array.isArray(beritaAcara.PermohonanPemusnahanLimbahs)) {
                beritaAcara.PermohonanPemusnahanLimbahs.forEach(p => {
                    const g = p.GolonganLimbah && p.GolonganLimbah.nama ? String(p.GolonganLimbah.nama).toLowerCase() : null;
                    if (g) golonganNames.add(g);
                    
                    // Only consider isProdukPangan for pure Recall (not Recall & Prekursor)
                    if (p.is_produk_pangan === true && g && g.includes('recall') && !g.includes('prekursor')) {
                        hasProdukPangan = true;
                    }
                });
            }

            const workflowSteps = Object.keys(grouped).sort((a,b)=>Number(a)-Number(b)).map(stepKey => {
                const rawSigners = grouped[stepKey] || [];
                let filteredSigners = rawSigners;
                const stepLevel = Number(stepKey);

                // Get the correct step_id for this level
                const stepId = stepLevelToStepId[stepLevel];

                // Get signing history for this step level
                const stepHistory = historyByStepLevel[stepLevel];
                
                // Determine actual status based on history
                let actualStatus = 'pending';
                let actualTimestamp = null;
                let actualSigner = null;
                
                if (stepHistory) {
                    actualStatus = 'signed';
                    actualTimestamp = stepHistory.signed_at || null;
                    actualSigner = stepHistory.signer_name || stepHistory.signer_id;
                }

                // HSE Manager (step 2) filter by KL department
                if (String(stepKey) === '2') {
                    const byDept = rawSigners.filter(a => String(a.Appr_DeptID || '').toUpperCase() === 'KL');
                    if (byDept.length > 0) filteredSigners = byDept;
                }

                // APJ (step 3): include only for specific golongan and Appr_DeptID mapping
                if (String(stepKey) === '3') {
                    const hasPrecursor = Array.from(golonganNames).some(n => n.includes('prekursor') || n.includes('oot'));
                    const hasRecall = Array.from(golonganNames).some(n => n.includes('recall'));
                    const hasRecallPrecursor = Array.from(golonganNames).some(n => n.includes('recall') && n.includes('prekursor'));

                    let requiredDepts = [];
                    
                    if (hasRecallPrecursor) {
                        requiredDepts = ['PN1', 'QA'];
                    } else if (hasPrecursor) {
                        requiredDepts = ['PN1'];
                    } else if (hasRecall) {
                        // For pure Recall with produk pangan, need both QA and PC (PJKPO)
                        if (hasProdukPangan) {
                            requiredDepts = ['QA', 'PC'];
                        } else {
                            requiredDepts = ['QA'];
                        }
                    } else if (bagian) {
                        // Standard workflow - Department Manager based on bagian
                        requiredDepts = [bagian];
                    }

                    if (requiredDepts.length > 0) {
                        const matches = rawSigners.filter(a => 
                            requiredDepts.includes(String(a.Appr_DeptID || '').toUpperCase())
                        );
                        if (matches.length > 0) {
                            filteredSigners = matches;
                        } else {
                            // Fallback: create synthetic signers for required departments
                            filteredSigners = requiredDepts.map(dept => {
                                if (dept === 'PC') {
                                    return {
                                        Appr_ID: 'PJKPO',
                                        emp_Name: 'PJKPO',
                                        Appr_DeptID: 'PC',
                                        Appr_CC: 'APJ'
                                    };
                                } else if (dept === 'QA') {
                                    return {
                                        Appr_ID: 'APJ_QA',
                                        emp_Name: 'APJ QA',
                                        Appr_DeptID: 'QA',
                                        Appr_CC: 'APJ'
                                    };
                                } else if (dept === 'PN1') {
                                    return {
                                        Appr_ID: 'APJ_PN',
                                        emp_Name: 'APJ PN',
                                        Appr_DeptID: 'PN1',
                                        Appr_CC: 'APJ'
                                    };
                                } else {
                                    return {
                                        Appr_ID: 'DEPT_MGR',
                                        emp_Name: 'Department Manager',
                                        Appr_DeptID: dept,
                                        Appr_CC: 'Manager'
                                    };
                                }
                            }).filter(Boolean);
                        }
                    } else {
                        // Skip this step if no requirements
                        return null;
                    }
                }

                // Head of Plant (step 4) filter by PL department
                if (String(stepKey) === '4') {
                    const byDept = rawSigners.filter(a => String(a.Appr_DeptID || '').toUpperCase() === 'PL');
                    if (byDept.length > 0) filteredSigners = byDept;
                }

                // For APJ steps (step 3) with multiple departments, create separate step objects
                if (String(stepKey) === '3' && filteredSigners.length > 1) {
                    // Group signers by department
                    const signersByDept = {};
                    filteredSigners.forEach(a => {
                        const dept = String(a.Appr_DeptID || '').toUpperCase();
                        if (!signersByDept[dept]) signersByDept[dept] = [];
                        signersByDept[dept].push(a);
                    });

                    // Create separate step objects for each department
                    const stepObjects = [];
                    Object.keys(signersByDept).forEach((dept, index) => {
                        const deptSigners = signersByDept[dept];
                        const signer = deptSigners[0];
                        
                        // Determine role name based on department
                        let roleName = 'APJ';
                        let stepName = 'APJ Signature';
                        if (dept === 'PN1') {
                            roleName = 'APJ PN';
                        } else if (dept === 'QA') {
                            roleName = 'APJ QA';
                        } else if (dept === 'PC') {
                            roleName = 'PJKPO';
                            stepName = 'PJKPO Approval';
                        } else {
                            roleName = 'Department Manager';
                            stepName = 'Department Manager Signature';
                        }
                        
                        // Check if this specific department has signed
                        let deptStatus = 'pending';
                        let deptSignerName = null;
                        let deptSignerId = null;
                        let deptSignedAt = null;
                        let deptComments = null;
                        
                        // Find signing history entries for this department
                        const deptHistory = signingHistory.filter(h => {
                            const jab = h.signer_jabatan || '';
                            const roleMatch = jab.match(/APJ_ROLE:(\w+)/);
                            if (dept === 'PN1' && roleMatch && roleMatch[1] === 'PN') return true;
                            if (dept === 'QA' && roleMatch && roleMatch[1] === 'QA') return true;
                            if (dept === 'PC' && roleMatch && roleMatch[1] === 'PC') return true;
                            // Fallback: match by signer_id
                            return h.signer_id === signer.Appr_ID;
                        });

                        if (deptHistory.length > 0) {
                            const latest = deptHistory[0];
                            deptStatus = 'signed';
                            deptSignerName = latest.signer_name || latest.signer_name_delegated;
                            deptSignerId = latest.signer_id;
                            deptSignedAt = latest.signed_at;
                            deptComments = latest.comments;
                        }

                        stepObjects.push({
                            step_id: stepId + index, // Use offset for multiple step objects
                            step_level: stepLevel,
                            action_type: 'Menandatangani',
                            step_name: stepName,
                            role_name: roleName,
                            signer_name: deptSignerName,
                            signer_id: deptSignerId,
                            signed_at: deptSignedAt,
                            status: deptStatus,
                            comments: deptComments,
                            SigningWorkflowSigners: deptSigners.map(s => ({ 
                                log_nik: s.Appr_ID, 
                                signer_name: s.emp_Name, 
                                signer_dept_id: s.Appr_DeptID, 
                                signer_cc: s.Appr_CC,
                                signed_at: deptStatus === 'signed' ? deptSignedAt : null,
                                status: deptStatus,
                                comments: deptStatus === 'signed' ? deptComments : null
                            }))
                        });
                    });

                    return stepObjects;
                }

                // Single step object
                return {
                    step_id: stepId,
                    step_level: stepLevel,
                    action_type: 'Menandatangani',
                    step_name: workflow.SigningWorkflowSteps.find(s => s.step_level === stepLevel)?.step_name || 'Signature',
                    // Use actual signer from history if available
                    signer_name: actualSigner || null,
                    signer_id: stepHistory ? stepHistory.signer_id : null,
                    signed_at: actualTimestamp,
                    status: actualStatus,
                    comments: stepHistory ? stepHistory.comments : null,
                    // SigningWorkflowSigners contains the candidate set
                    signers: filteredSigners.map(s => ({ 
                        log_nik: s.Appr_ID, 
                        signer_name: s.emp_Name, 
                        signer_dept_id: s.Appr_DeptID, 
                        signer_cc: s.Appr_CC,
                        signed_at: actualStatus === 'signed' ? actualTimestamp : null,
                        status: actualStatus,
                        comments: actualStatus === 'signed' ? (stepHistory ? stepHistory.comments : null) : null
                    })),
                    required_signatures: workflow.SigningWorkflowSteps.find(s => s.step_level === stepLevel)?.required_signatures || 1
                };
            }).filter(Boolean).flat(); // Flatten in case of multiple step objects

            return res.status(200).json({ success: true, data: workflowSteps, current_signing_step_id: null });
        } catch (err) {
            console.warn('External approval API failed for request-specific signing, falling back to DB:', err.message || err);
        }

        // Fallback: Use database-based signing workflow logic (similar to getApprovalWorkflowByRequest)
        // Find the berita acara first
        const beritaAcara = await BeritaAcara.findByPk(permohonan.berita_acara_id);
        if (!beritaAcara) {
            return res.status(404).json({ success: false, message: 'Berita Acara not found' });
        }

        // Get the signing workflow
        const workflow = await SigningWorkflow.findByPk(beritaAcara.signing_workflow_id, {
            include: [{
                model: SigningWorkflowStep,
                include: [SigningWorkflowSigner],
                order: [['step_level', 'ASC']]
            }]
        });

        if (!workflow) {
            return res.status(404).json({ success: false, message: 'Signing workflow not found' });
        }

        // Build a map of the latest signing entry per step_id
        const latestSigningByStep = {};
        signingHistory.forEach(history => {
            const sid = history.step_id;
            if (!sid) return;
            const existing = latestSigningByStep[sid];
            if (!existing) {
                latestSigningByStep[sid] = history;
            } else {
                const existingDate = existing.signed_at ? new Date(existing.signed_at) : null;
                const newDate = history.signed_at ? new Date(history.signed_at) : null;
                if (newDate && (!existingDate || newDate > existingDate)) {
                    latestSigningByStep[sid] = history;
                }
            }
        });

        // Determine category and bagian to know which steps should be presented (following approval logic)
        const allPermohonan = await PermohonanPemusnahanLimbah.findAll({
            where: { berita_acara_id: permohonan.berita_acara_id },
            include: [GolonganLimbah]
        });

        // Collect golongan names from all linked permohonan entries
        const golonganNames = new Set();
        allPermohonan.forEach(p => {
            const g = p.GolonganLimbah && p.GolonganLimbah.nama ? String(p.GolonganLimbah.nama).toLowerCase() : null;
            if (g) golonganNames.add(g);
        });

        const hasPrecursor = Array.from(golonganNames).some(n => n.includes('prekursor') || n.includes('oot'));
        const hasRecall = Array.from(golonganNames).some(n => n.includes('recall'));
        const isRecallPrecursor = Array.from(golonganNames).some(n => n.includes('recall') && n.includes('prekursor'));

        // Check for produk pangan in Recall cases
        let hasProdukPangan = false;
        allPermohonan.forEach(p => {
            const golonganName = String(p.GolonganLimbah?.nama || '').toLowerCase();
            if (p.is_produk_pangan === true && golonganName.includes('recall') && !golonganName.includes('prekursor')) {
                hasProdukPangan = true;
            }
        });

        // Load users for enrichment
        const users = await fetchUsersWithCache();
        const userMap = {};
        (users || []).forEach(u => { if (u && u.emp_NIK) userMap[String(u.emp_NIK)] = u; });

        // Build step-level to step-id mapping for history lookup
        const stepLevelToStepId = {};
        workflow.SigningWorkflowSteps.forEach(step => {
            stepLevelToStepId[step.step_level] = step.step_id;
        });

        // Build history map by step_level
        const historyByStepLevel = {};
        signingHistory.forEach(history => {
            const stepLevel = Object.keys(stepLevelToStepId).find(level => 
                stepLevelToStepId[level] === history.step_id
            );
            if (stepLevel && !historyByStepLevel[stepLevel]) {
                historyByStepLevel[stepLevel] = history;
            }
        });

        const workflowSteps = workflow.SigningWorkflowSteps
            .map(step => {
                const stepHistory = signingHistory.filter(h => h.step_id === step.step_id);
                
                // Build signers array from database signers
                const signers = step.SigningWorkflowSigners.map(signer => {
                    const userData = userMap[String(signer.log_nik)];
                    const signerHistory = stepHistory.find(h => h.signer_id === signer.log_nik);
                    
                    return {
                        log_nik: signer.log_nik,
                        signer_name: userData ? userData.emp_Name : signer.log_nik,
                        signer_dept_id: userData ? userData.emp_DeptID : null,
                        signer_cc: userData ? userData.emp_Title : null,
                        role: signer.peran || null,
                        dept: userData ? userData.emp_DeptID : null,
                        signed_at: signerHistory ? signerHistory.signed_at : null,
                        status: signerHistory ? 'signed' : 'pending',
                        comments: signerHistory ? signerHistory.comments : null
                    };
                });
                
                // For APJ step (level 3), check role-based completion
                if (step.step_level === 3) {
                    const signedRoles = new Set();
                    
                    stepHistory.forEach(h => {
                        const jab = h.signer_jabatan || '';
                        const m = jab.match(/APJ_ROLE:(\w+)/);
                        if (m && m[1]) signedRoles.add(m[1]);
                    });
                    
                    // Determine required roles based on golongan
                    const requiredRoles = [];
                    if (hasPrecursor) requiredRoles.push('PN');
                    if (hasRecall) requiredRoles.push('QA');
                    if (hasRecall && hasProdukPangan) requiredRoles.push('PC');
                    
                    const allRolesSigned = requiredRoles.every(role => signedRoles.has(role));
                    const isStepSigned = allRolesSigned && stepHistory.length >= requiredRoles.length;
                    
                    const latest = stepHistory.length > 0 ? stepHistory.reduce((acc, cur) => {
                        const d = cur.signed_at ? new Date(cur.signed_at) : null;
                        if (!acc) return cur;
                        const ad = acc.signed_at ? new Date(acc.signed_at) : null;
                        if (!ad) return cur;
                        return d && ad && d > ad ? cur : acc;
                    }, null) : null;
                    
                    return {
                        step_id: step.step_id,
                        step_level: step.step_level,
                        action_type: 'Menandatangani',
                        role_name: step.role_name,
                        step_name: step.step_name,
                        signer_name: isStepSigned && latest ? (latest.signer_name || latest.signer_name_delegated || null) : null,
                        signer_id: isStepSigned && latest ? latest.signer_id : null,
                        signed_at: isStepSigned && latest ? latest.signed_at : null,
                        status: isStepSigned ? 'signed' : 'pending',
                        comments: isStepSigned && latest ? latest.comments : null,
                        signers: signers,
                        required_signatures: requiredRoles.length || step.required_signatures || 1
                    };
                } else {
                    // Other steps: use simple history lookup
                    const stepHistory = latestSigningByStep[step.step_id] || null;
                    const signer = step.SigningWorkflowSigners[0];

                    const signerNameFromHistory = stepHistory ? 
                        (stepHistory.signer_name || stepHistory.signer_name_delegated || null) : null;
                    const signerIdFromHistory = stepHistory ? 
                        (stepHistory.signer_id || stepHistory.signer_id_delegated || null) : null;

                    // Enrich with user directory data
                    let signerNameFromDirectory = null;
                    let signerIdFromDirectory = null;
                    
                    if (signer && signer.log_nik) {
                        const userData = userMap[String(signer.log_nik)];
                        if (userData) {
                            signerNameFromDirectory = userData.emp_Name;
                            signerIdFromDirectory = userData.emp_NIK;
                        }
                    }

                    // Default action_type is 'Menandatangani', but for step 2 (HSE Manager) we want 'Mengetahui'
                    const defaultAction = (step.step_level === 2) ? 'Mengetahui' : 'Menandatangani';

                    return {
                        step_id: step.step_id,
                        step_level: step.step_level,
                        action_type: step.action_type || defaultAction,
                        role_name: step.role_name,
                        step_name: step.step_name,
                        signer_name: signerNameFromHistory || signerNameFromDirectory || 
                                   (signer ? signer.log_nik : step.step_name),
                        signer_id: signerIdFromHistory || signerIdFromDirectory || 
                                  (signer ? signer.log_nik : null),
                        signed_at: stepHistory ? stepHistory.signed_at : null,
                        status: stepHistory ? "signed" : "pending",
                        comments: stepHistory ? stepHistory.comments : null,
                        signers: signers,
                        required_signatures: step.required_signatures || 1
                    };
                }
            });

        res.status(200).json({ 
            success: true, 
            data: workflowSteps,
            current_signing_step_id: beritaAcara.current_signing_step_id
        });

    } catch (error) {
        console.error('Error getting signing workflow:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * POST /api/workflows/approval-steps/:stepId/approvers -> Add an approver to a step
 */
const addApproverToStep = async (req, res) => {
    try {
        const { stepId } = req.params;
        const { approver_id, approver_name } = req.body;

        const step = await ApprovalWorkflowStep.findByPk(stepId);
        if (!step) return res.status(404).json({ message: 'Approval step not found.' });

        const newApprover = await ApprovalWorkflowApprover.create({
            step_id: stepId,
            approver_id,
            approver_name, // Snapshotting the name for convenience
            approver_cc: req.body.approver_cc || null,
            approver_dept_id: req.body.approver_dept_id || null,
            approver_identity: req.body.approver_identity || approver_id
        });

        res.status(201).json({ 
            success: true,
            message: 'Approver added successfully',
            data: newApprover
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * DELETE /api/workflows/approval-steps/:stepId/approvers/:approverId -> Remove an approver from a step
 */
const removeApproverFromStep = async (req, res) => {
    try {
        const { stepId, approverId } = req.params;

        const approver = await ApprovalWorkflowApprover.findOne({
            where: { 
                step_id: stepId,
                approver_id: approverId
            }
        });

        if (!approver) {
            return res.status(404).json({ success: false, message: 'Approver not found.' });
        }

        await approver.destroy();

        res.status(200).json({ 
            success: true,
            message: 'Approver removed successfully'
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * POST /api/workflows/signing-steps/:stepId/signers -> Add a signer to a step
 */
const addSignerToStep = async (req, res) => {
    try {
        const { stepId } = req.params;
        const { log_nik, peran } = req.body;

        const step = await SigningWorkflowStep.findByPk(stepId);
        if (!step) return res.status(404).json({ message: 'Signing step not found.' });

        const newSigner = await SigningWorkflowSigner.create({
            step_id: stepId,
            log_nik,
            peran: peran || null
        });

        res.status(201).json({
            success: true,
            message: 'Signer added successfully',
            data: newSigner
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * DELETE /api/workflows/signing-steps/:stepId/signers/:signerNik -> Remove a signer from a step
 */
const removeSignerFromStep = async (req, res) => {
    try {
        const { stepId, signerNik } = req.params;

        const signer = await SigningWorkflowSigner.findOne({
            where: { 
                step_id: stepId,
                log_nik: signerNik
            }
        });

        if (!signer) {
            return res.status(404).json({ success: false, message: 'Signer not found.' });
        }

        await signer.destroy();

        res.status(200).json({ 
            success: true,
            message: 'Signer removed successfully'
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/workflows/approval-steps/:stepId/approvers -> Get approvers for a specific step
 */
const getApproversForStep = async (req, res) => {
    try {
        const { stepId } = req.params;
        // Try external API: map stepId -> step_level, then filter items by Appr_No
        try {
            const step = await ApprovalWorkflowStep.findByPk(stepId);
            if (step) {
                const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
                const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];
                const matched = items.filter(i => Number(i.Appr_No) === Number(step.step_level) && String(i.Appr_ApplicationCode || '').includes('ePengelolaan_Limbah'));
                const approvers = matched.map(i => ({ 
                    approver_id: i.Appr_ID, 
                    approver_name: i.emp_Name, 
                    approver_dept_id: i.Appr_DeptID, 
                    approver_cc: i.Appr_CC, 
                    raw: i 
                }));
                return res.status(200).json({ success: true, data: approvers });
            }
        } catch (err) {
            console.warn('External approval API failed for approvers for step, falling back to DB:', err.message || err);
        }

        // Fallback to DB
        const approvers = await ApprovalWorkflowApprover.findAll({
            where: { step_id: stepId },
            include: [{
                model: ApprovalWorkflowStep,
                attributes: ['step_name', 'step_level']
            }]
        });
        res.status(200).json({ success: true, data: approvers });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/workflows/signing-steps/:stepId/signers -> Get signers for a specific step
 */
const getSignersForStep = async (req, res) => {
    try {
        const { stepId } = req.params;
        // Try external API using SigningWorkflowStep.step_level -> Appr_No for Berita Acara
        try {
            const step = await SigningWorkflowStep.findByPk(stepId);
            if (step) {
                const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
                const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];
                const matched = items.filter(i => Number(i.Appr_No) === Number(step.step_level) && String(i.Appr_ApplicationCode || '').includes('Berita_Acara'));
                const signers = matched.map(i => ({ 
                    log_nik: i.Appr_ID, 
                    signer_name: i.emp_Name, 
                    signer_dept_id: i.Appr_DeptID, 
                    signer_cc: i.Appr_CC, 
                    raw: i 
                }));
                return res.status(200).json({ success: true, data: signers });
            }
        } catch (err) {
            console.warn('External approval API failed for signers for step, falling back to DB:', err.message || err);
        }

        // Fallback to DB
        const signers = await SigningWorkflowSigner.findAll({
            where: { step_id: stepId },
            include: [{
                model: SigningWorkflowStep,
                attributes: ['step_name', 'step_level']
            }]
        });
        res.status(200).json({ success: true, data: signers });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/workflows/admin/workflows -> Get all workflows for admin management
 */
const getAllWorkflowsAdmin = async (req, res) => {
    try {
        // Try external API to build admin view (read-only) of workflows
        try {
            const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
            const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];

            // Build approvalWorkflows grouped by application code excluding Berita Acara
            const approvalMap = {};
            const signingMap = {};

            items.forEach(it => {
                const app = it.Appr_ApplicationCode || 'unknown';
                const stepKey = String(it.Appr_No != null ? it.Appr_No : '0');
                if (String(app).toLowerCase().includes('berita')) {
                    signingMap[app] = signingMap[app] || { signing_workflow_id: null, workflow_name: app, SigningWorkflowSteps: {} };
                    const wf = signingMap[app];
                    let sName = it.Appr_CC || `Step ${stepKey}`;
                    if (String(stepKey) === '3') sName = 'Verifikasi Lapangan';
                    if (String(stepKey) === '4') sName = 'HSE Manager';
                    wf.SigningWorkflowSteps[stepKey] = wf.SigningWorkflowSteps[stepKey] || { 
                        step_id: Number(stepKey), 
                        step_level: Number(stepKey), 
                        step_name: sName, 
                        SigningWorkflowSigners: [] 
                    };
                    wf.SigningWorkflowSteps[stepKey].SigningWorkflowSigners.push({ 
                        log_nik: it.Appr_ID, 
                        signer_name: it.emp_Name, 
                        signer_cc: it.Appr_CC, 
                        signer_dept_id: it.Appr_DeptID, 
                        raw: it 
                    });
                } else {
                    approvalMap[app] = approvalMap[app] || { approval_workflow_id: null, workflow_name: app, ApprovalWorkflowSteps: {} };
                    const wf = approvalMap[app];
                    let sName = it.Appr_CC || `Step ${stepKey}`;
                    if (String(stepKey) === '3') sName = 'Verifikasi Lapangan';
                    if (String(stepKey) === '4') sName = 'HSE Manager';
                    wf.ApprovalWorkflowSteps[stepKey] = wf.ApprovalWorkflowSteps[stepKey] || { 
                        step_id: Number(stepKey), 
                        step_level: Number(stepKey), 
                        step_name: sName, 
                        ApprovalWorkflowApprovers: [] 
                    };
                    wf.ApprovalWorkflowSteps[stepKey].ApprovalWorkflowApprovers.push({ 
                        approver_id: it.Appr_ID, 
                        approver_name: it.emp_Name, 
                        approver_cc: it.Appr_CC, 
                        approver_dept_id: it.Appr_DeptID, 
                        raw: it 
                    });
                }
            });

            const approvalWorkflows = Object.keys(approvalMap).map((k, idx) => { 
                approvalMap[k].approval_workflow_id = idx+1; 
                approvalMap[k].ApprovalWorkflowSteps = Object.keys(approvalMap[k].ApprovalWorkflowSteps)
                    .sort((a,b)=>Number(a)-Number(b))
                    .map(s => approvalMap[k].ApprovalWorkflowSteps[s]); 
                return approvalMap[k]; 
            });
            
            const signingWorkflows = Object.keys(signingMap).map((k, idx) => { 
                signingMap[k].signing_workflow_id = idx+1; 
                signingMap[k].SigningWorkflowSteps = Object.keys(signingMap[k].SigningWorkflowSteps)
                    .sort((a,b)=>Number(a)-Number(b))
                    .map(s => signingMap[k].SigningWorkflowSteps[s]); 
                return signingMap[k]; 
            });

            return res.status(200).json({ success: true, data: { approvalWorkflows, signingWorkflows } });
        } catch (err) {
            console.warn('External approval API failed for admin workflows, falling back to DB:', err.message || err);
        }

        // Fallback to DB
        const approvalWorkflows = await ApprovalWorkflow.findAll({
            where: { is_active: true },
            include: [{
                model: ApprovalWorkflowStep,
                include: [ApprovalWorkflowApprover],
                order: [['step_level', 'ASC']]
            }],
            order: [
                ['approval_workflow_id', 'ASC'],
                [ApprovalWorkflowStep, 'step_level', 'ASC']
            ]
        });

        const signingWorkflows = await SigningWorkflow.findAll({
            where: { is_active: true },
            include: [{
                model: SigningWorkflowStep,
                include: [SigningWorkflowSigner],
                order: [['step_level', 'ASC']]
            }],
            order: [
                ['signing_workflow_id', 'ASC'],
                [SigningWorkflowStep, 'step_level', 'ASC']
            ]
        });

        res.status(200).json({ 
            success: true, 
            data: {
                approvalWorkflows,
                signingWorkflows
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * PUT /api/workflows/admin/approval-steps/:stepId/bulk-approvers -> Bulk update approvers for a step
 */
const bulkUpdateApprovers = async (req, res) => {
    try {
        const { stepId } = req.params;
        const { approvers } = req.body;

        // Validate step exists
        const step = await ApprovalWorkflowStep.findByPk(stepId);
        if (!step) {
            return res.status(404).json({ success: false, message: 'Approval step not found.' });
        }

        // Remove existing approvers
        await ApprovalWorkflowApprover.destroy({ where: { step_id: stepId } });

        // Add new approvers
        const newApprovers = await Promise.all(
            approvers.map(approver => 
                ApprovalWorkflowApprover.create({
                    step_id: stepId,
                    approver_id: approver.approver_id,
                    approver_name: approver.approver_name,
                    approver_cc: approver.approver_cc,
                    approver_dept_id: approver.approver_dept_id,
                    approver_identity: approver.approver_identity
                })
            )
        );

        res.status(200).json({ 
            success: true, 
            message: 'Approvers updated successfully',
            data: newApprovers 
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * PUT /api/workflows/admin/signing-steps/:stepId/bulk-signers -> Bulk update signers for a step
 */
const bulkUpdateSigners = async (req, res) => {
    try {
        const { stepId } = req.params;
        const { signers } = req.body;

        // Validate step exists
        const step = await SigningWorkflowStep.findByPk(stepId);
        if (!step) {
            return res.status(404).json({ success: false, message: 'Signing step not found.' });
        }

        // Remove existing signers
        await SigningWorkflowSigner.destroy({ where: { step_id: stepId } });

        // Add new signers
        const newSigners = await Promise.all(
            signers.map(signer => 
                SigningWorkflowSigner.create({
                    step_id: stepId,
                    log_nik: signer.log_nik,
                    peran: signer.peran
                })
            )
        );

        res.status(200).json({ 
            success: true, 
            message: 'Signers updated successfully',
            data: newSigners 
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Helper function to get next approver for a request (for compatibility)
 */
const getNextApproverForRequest = async (requestId) => {
    try {
        const permohonan = await PermohonanPemusnahanLimbah.findByPk(requestId);
        if (!permohonan) {
            throw new Error('Request not found');
        }

        // Simple implementation - get first approver from first step
        const workflow = await ApprovalWorkflow.findByPk(permohonan.approval_workflow_id, {
            include: [{
                model: ApprovalWorkflowStep,
                include: [ApprovalWorkflowApprover],
                order: [['step_level', 'ASC']]
            }]
        });

        if (!workflow || !workflow.ApprovalWorkflowSteps || workflow.ApprovalWorkflowSteps.length === 0) {
            throw new Error('No workflow steps found');
        }

        const firstStep = workflow.ApprovalWorkflowSteps[0];
        const firstApprover = firstStep.ApprovalWorkflowApprovers[0];

        if (!firstApprover) {
            throw new Error('No approver found for first step');
        }

        return {
            approver_id: firstApprover.approver_id,
            approver_name: firstApprover.approver_name,
            approver_dept_id: firstApprover.approver_dept_id
        };
    } catch (error) {
        console.error('Error getting next approver:', error);
        throw error;
    }
};

/**
 * GET /api/workflows/current-approver/:requestId -> Get the current approver for a request
 */
const getCurrentApproverForRequest = async (req, res) => {
    try {
        const { requestId } = req.params;
        // Try to use external API to compute current approver dynamically
        try {
            const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
            const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];

            // Find items for ePengelolaan_Limbah and pick first step (simple heuristic)
            const appItems = items.filter(i => String(i.Appr_ApplicationCode || '') === 'ePengelolaan_Limbah');
            if (appItems.length > 0) {
                // Pick first approver of the lowest Appr_No
                appItems.sort((a,b)=>Number(a.Appr_No)-Number(b.Appr_No));
                const candidate = appItems[0];
                return res.status(200).json({ 
                    success: true, 
                    data: { 
                        approver_id: candidate.Appr_ID, 
                        approver_name: candidate.emp_Name, 
                        approver_dept_id: candidate.Appr_DeptID 
                    } 
                });
            }
        } catch (err) {
            console.warn('External approval API failed for current approver, falling back to DB:', err.message || err);
        }

        const approver = await getNextApproverForRequest(requestId);
        
        res.status(200).json({ 
            success: true, 
            data: approver 
        });
    } catch (error) {
        console.error('Error getting current approver:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
};

/**
 * Helper functions for workflow determination (for compatibility)
 */
const determineApprovalWorkflow = async (categoryId, jenisLimbahId = null, isProdukPangan = false) => {
    try {
        // Get the golongan limbah name to determine workflow
        const golongan = await GolonganLimbah.findByPk(categoryId);
        if (!golongan) return 3; // default to Standard
        
        const categoryName = golongan.nama?.toLowerCase() || '';
        
        // Check for Recall & Precursor combination
        if (categoryName.includes('recall') && categoryName.includes('prekursor')) {
            return 4; // New Recall & Precursor workflow
        }
        
        // Check for individual categories
        const isPrecursor = categoryName.includes('prekursor') || categoryName.includes('oot');
        if (isPrecursor) return 1; // Precursor & OOT workflow
        
        const isRecall = categoryName.includes('recall');
        if (isRecall) {
            // For pure Recall cases, check if it's produk pangan
            if (isProdukPangan && !categoryName.includes('prekursor')) {
                return 5; // Recall (Produk Pangan) workflow with PJKPO
            }
            return 2; // Standard Recall workflow
        }
        
        return 3; // Standard workflow
    } catch (error) {
        console.warn('determineApprovalWorkflow fallback to default due to error:', error?.message);
        return 3; // default to Standard
    }
};

/**
 * Determine appropriate signing workflow id.
 * Accepts either:
 *  - an array of request objects (PermohonanPemusnahanLimbah) where each may include GolonganLimbah
 *  - or a numeric categoryId for backward compatibility
 */
const determineSigningWorkflow = async (input) => {
    try {
        // If input is an array of requests, collect golongan names
        let golonganNames = [];
        if (Array.isArray(input)) {
            input.forEach(req => {
                const g = req.GolonganLimbah && (req.GolonganLimbah.nama || req.GolonganLimbah.name) ? String(req.GolonganLimbah.nama || req.GolonganLimbah.name).toLowerCase() : null;
                if (g) golonganNames.push(g);
            });
        } else if (input && typeof input === 'object' && input.GolonganLimbah) {
            const g = input.GolonganLimbah.nama ? String(input.GolonganLimbah.nama).toLowerCase() : null;
            if (g) golonganNames.push(g);
        } else if (typeof input === 'number' || (typeof input === 'string' && input.match(/^\d+$/))) {
            // If numeric id provided, try to map directly (fallback to default)
            const id = Number(input);
            if (id === 1) return 1;
            if (id === 2) return 2;
            return 3;
        }

        // Heuristics based on seeded workflow names:
        // 1 => Precursor & OOT
        // 2 => Recall
        // 3 => Standard (default)
        // 4 => Recall & Precursor  
        // 5 => Recall (Produk Pangan)
        
        // Check for exact match with "Recall & Prekursor" golongan first
        const hasRecallAndPrekursor = golonganNames.some(n => n && n.toLowerCase().includes('recall') && n.toLowerCase().includes('prekursor'));
        if (hasRecallAndPrekursor) {
            return 4;
        }
        
        // Check for "Prekursor & OOT" golongan
        const hasPrekursorOOT = golonganNames.some(n => n && n.toLowerCase().includes('prekursor') && n.toLowerCase().includes('oot'));
        if (hasPrekursorOOT) {
            return 1;
        }

        // Check for pure Recall golongan (not combined with Prekursor)
        const hasRecall = golonganNames.some(n => n && n.toLowerCase().includes('recall') && !n.toLowerCase().includes('prekursor'));
        if (hasRecall) {
            // Check if any request has is_produk_pangan = true for Recall (Produk Pangan)
            let hasProdukPangan = false;
            if (Array.isArray(input)) {
                hasProdukPangan = input.some(req => {
                    if (req.is_produk_pangan !== true) return false;
                    const g = req.GolonganLimbah && (req.GolonganLimbah.nama || req.GolonganLimbah.name) ? 
                        String(req.GolonganLimbah.nama || req.GolonganLimbah.name).toLowerCase() : null;
                    return g && g.includes('recall') && !g.includes('prekursor');
                });
            }
            
            if (hasProdukPangan) {
                return 5; // Recall (Produk Pangan) workflow
            }
            return 2; // Standard Recall workflow
        }

        return 3; // default to Standard workflow
    } catch (err) {
        console.warn('determineSigningWorkflow fallback to default due to error:', err && err.message);
        return 3;
    }
};

module.exports = {
    getDynamicApprover,
    getApprovalWorkflows,
    getSigningWorkflows,
    getApprovalWorkflowByRequest,
    getSigningWorkflowByRequest,
    addApproverToStep,
    removeApproverFromStep,
    addSignerToStep,
    removeSignerFromStep,
    getApproversForStep,
    getSignersForStep,
    getAllWorkflowsAdmin,
    bulkUpdateApprovers,
    bulkUpdateSigners,
    getNextApproverForRequest,
    getCurrentApproverForRequest,
    determineApprovalWorkflow,
    determineSigningWorkflow
};
