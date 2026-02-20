const {
    PermohonanPemusnahanLimbah,
    ApprovalWorkflowStep,
    ApprovalHistory,
    GolonganLimbah
} = require('../models');
const { Op } = require('sequelize');
const { 
    checkUserCanApproveRequest, 
    hasUserProcessedCurrentStep,
    hasApprovalAuthority: checkHasApprovalAuthority
} = require('../services/approvalAuthorizationService');
const { determineGroupFromGolongan } = require('../utils/golonganGroupMapping');

// Department and scope constants (mirrored from FE accessRights.js)
const KL_DEPARTMENT_ID = 'KL';
const QA_DEPARTMENT_ID = 'QA';
const PN1_DEPARTMENT_ID = 'PN1';
const DAFTAR_AJUAN_APPROVAL_ROLES = ['Manager', 'HSE', 'APJ'];
const SPECIAL_USER_IDS = { PJKPO: 'PJKPO' };

// GOLONGAN GROUPS
const GOLONGAN_GROUPS = {
    LIMBAH_B3: 'limbah-b3',
    RECALL: 'recall',
    RECALL_PRECURSOR: 'recall-precursor'
};

/**
 * Check if user has approval authority
 */
const hasApprovalAuthorityLocal = (user) => {
    if (!user) return false;
    if (user.log_NIK === SPECIAL_USER_IDS.PJKPO) return true;
    if (user.role && DAFTAR_AJUAN_APPROVAL_ROLES.includes(user.role)) return true;
    return false;
};

/**
 * Get user scope for verifikasi lapangan / pembuatan BAP
 * Returns: { scope: 'all'|'bagian_plus_group'|'own', filterByBagian: boolean, additionalGroups: string[] }
 * NOTE: Only KL users see all data. Approvers don't see these cards (they have Pending Approval)
 */
const getUserDataScope = (user) => {
    if (!user) return { scope: 'none', filterByBagian: false, additionalGroups: [] };
    
    const deptId = user.emp_DeptID ? String(user.emp_DeptID).toUpperCase() : null;
    
    // KL users can see all data (only KL, not approvers)
    if (deptId === KL_DEPARTMENT_ID) {
        return { scope: 'all', filterByBagian: false, additionalGroups: [] };
    }
    
    // QA users can see their own bagian data + all 'recall' group data
    if (deptId === QA_DEPARTMENT_ID) {
        return { scope: 'bagian_plus_group', filterByBagian: true, additionalGroups: [GOLONGAN_GROUPS.RECALL] };
    }
    
    // PN1 users can see their own bagian data + all 'recall-precursor' group data
    if (deptId === PN1_DEPARTMENT_ID) {
        return { scope: 'bagian_plus_group', filterByBagian: true, additionalGroups: [GOLONGAN_GROUPS.RECALL_PRECURSOR] };
    }
    
    // Regular users can only see data from their own department (bagian)
    return { scope: 'own', filterByBagian: true, additionalGroups: [] };
};

/**
 * Get dashboard statistics for the current user
 * Returns counts for:
 * - My Requests: Total requests created by the user (with group breakdown)
 * - Pending Approvals: Requests waiting for user's approval (with group breakdown)
 * - Approved: Requests already approved by the user (with group breakdown)
 */
exports.getDashboardStats = async (req, res) => {
    try {
        const userId = req.user?.log_NIK;
        const userJobLevel = req.user?.emp_JobLevelID || req.user?.Job_LevelID;
        const userBagian = req.user?.emp_DeptID;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'User not authenticated'
            });
        }

        // Get user's data scope
        const userScope = getUserDataScope(req.user);

        // Initialize group breakdowns
        const initGroupBreakdown = () => ({
            'limbah-b3': 0,
            'recall': 0,
            'recall-precursor': 0
        });

        // 1. Count "My Requests" - all requests created by this user (excluding Completed) with group breakdown
        let myRequestsCount = 0;
        const myRequestsByGroup = initGroupBreakdown();
        
        try {
            const myRequests = await PermohonanPemusnahanLimbah.findAll({
                where: { 
                    requester_id: userId,
                    status: { [Op.ne]: 'Completed' } // Exclude completed requests
                },
                include: [{
                    model: GolonganLimbah,
                    required: false
                }]
            });

            myRequestsCount = myRequests.length;

            // Group by golongan
            for (const request of myRequests) {
                const golonganName = request.GolonganLimbah?.nama;
                const group = determineGroupFromGolongan(golonganName);
                if (group && myRequestsByGroup.hasOwnProperty(group)) {
                    myRequestsByGroup[group]++;
                }
            }
        } catch (countError) {
            console.error('[getDashboardStats] Error counting my requests:', countError.message);
        }

        // 2. Count "Pending Approvals" - requests waiting for this user's approval
        let pendingApprovalsCount = 0;
        const pendingApprovalsByGroup = initGroupBreakdown();
        
        // Check if user has approval authority
        const hasApprovalAuth = await checkHasApprovalAuthority(userId, userJobLevel);
        
        if (hasApprovalAuth) {
            try {
                // Fetch all InProgress requests with necessary includes
                const pendingRequests = await PermohonanPemusnahanLimbah.findAll({
                    where: {
                        status: 'InProgress',
                        current_step_id: { [Op.ne]: null }
                    },
                    include: [
                        {
                            model: ApprovalWorkflowStep,
                            as: 'CurrentStep',
                            required: true
                        },
                        {
                            model: GolonganLimbah,
                            required: false
                        },
                        {
                            model: ApprovalHistory,
                            required: false
                        }
                    ]
                });

                // Filter using unified service
                const userPendingRequests = [];
                for (const request of pendingRequests) {
                    const canApprove = await checkUserCanApproveRequest(userId, request);
                    const hasProcessed = hasUserProcessedCurrentStep(request, userId);
                    
                    if (canApprove && !hasProcessed) {
                        userPendingRequests.push(request);
                    }
                }

                pendingApprovalsCount = userPendingRequests.length;

                // Group by golongan
                for (const request of userPendingRequests) {
                    const golonganName = request.GolonganLimbah?.nama;
                    const group = determineGroupFromGolongan(golonganName);
                    if (group && pendingApprovalsByGroup.hasOwnProperty(group)) {
                        pendingApprovalsByGroup[group]++;
                    }
                }
            } catch (pendingError) {
                console.error('[getDashboardStats] Error checking pending approvals:', pendingError.message);
            }
        }

        // 3. Count "Approved" - requests that user has already processed
        let approvedCount = 0;
        const approvedByGroup = initGroupBreakdown();
        
        if (hasApprovalAuth) {
            try {
                // Get all requests where user has processed (approved or rejected)
                const approvedRequests = await PermohonanPemusnahanLimbah.findAll({
                    include: [
                        {
                            model: ApprovalHistory,
                            required: true,
                            where: {
                                [Op.and]: [
                                    {
                                        [Op.or]: [
                                            { approver_id: userId },
                                            { approver_id_delegated: userId }
                                        ]
                                    },
                                    { 
                                        status: { 
                                            [Op.in]: ['Approved', 'Rejected'] 
                                        } 
                                    }
                                ]
                            }
                        },
                        {
                            model: ApprovalWorkflowStep,
                            as: 'CurrentStep',
                            required: false
                        },
                        {
                            model: GolonganLimbah,
                            required: false
                        }
                    ],
                    where: {
                        requester_id: { [Op.ne]: userId },
                        status: { [Op.ne]: 'Completed' }
                    }
                });

                // Data persists in Approved tab until request becomes Completed
                // (already excluded at SQL level above)
                approvedCount = approvedRequests.length;

                // Group by golongan
                for (const request of approvedRequests) {
                    const golonganName = request.GolonganLimbah?.nama;
                    const group = determineGroupFromGolongan(golonganName);
                    if (group && approvedByGroup.hasOwnProperty(group)) {
                        approvedByGroup[group]++;
                    }
                }
            } catch (approvedError) {
                console.error('[getDashboardStats] Error checking approved count:', approvedError.message);
            }
        }

        // 4. Count "Waiting HSE Manager" - requests at step 4 waiting for approval
        let waitingHseManagerCount = 0;
        const waitingHseManagerByGroup = initGroupBreakdown();
        
        if (hasApprovalAuth) {
            try {
                const step4Requests = await PermohonanPemusnahanLimbah.findAll({
                    where: {
                        status: 'InProgress'
                    },
                    include: [
                        {
                            model: ApprovalWorkflowStep,
                            as: 'CurrentStep',
                            required: true,
                            where: { step_level: 4 }
                        },
                        {
                            model: GolonganLimbah,
                            required: false
                        }
                    ]
                });

                waitingHseManagerCount = step4Requests.length;

                // Group by golongan
                for (const request of step4Requests) {
                    const golonganName = request.GolonganLimbah?.nama;
                    const group = determineGroupFromGolongan(golonganName);
                    if (group && waitingHseManagerByGroup.hasOwnProperty(group)) {
                        waitingHseManagerByGroup[group]++;
                    }
                }
            } catch (step4Error) {
                console.error('[getDashboardStats] Error checking step 4 requests:', step4Error.message);
            }
        }

        // 5. Count "Verifikasi Lapangan" - requests at step 3 waiting for approval (available for all users)
        let verifikasiLapanganCount = 0;
        const verifikasiLapanganByGroup = initGroupBreakdown();
        
        // Verifikasi Lapangan is available for all users with different scopes based on department
        // Normalize userBagian for comparison (convert to uppercase string)
        const normalizedUserBagian = userBagian ? String(userBagian).toUpperCase() : null;
        
        try {
            const step3Requests = await PermohonanPemusnahanLimbah.findAll({
                where: {
                    status: 'InProgress'
                },
                include: [
                    {
                        model: ApprovalWorkflowStep,
                        as: 'CurrentStep',
                        required: true,
                        where: { step_level: 3 }
                    },
                    {
                        model: GolonganLimbah,
                        required: false
                    }
                ]
            });

            // Filter based on user scope
            const filteredStep3Requests = step3Requests.filter(request => {
                const golonganName = request.GolonganLimbah?.nama;
                const group = determineGroupFromGolongan(golonganName);
                // Normalize request bagian for comparison
                const normalizedRequestBagian = request.bagian ? String(request.bagian).toUpperCase() : null;
                
                // scope 'all' - no filtering needed
                if (userScope.scope === 'all') {
                    return true;
                }
                
                // scope 'bagian_plus_group' - user can see their bagian OR additional groups
                if (userScope.scope === 'bagian_plus_group') {
                    // Check if request is from user's bagian
                    if (normalizedRequestBagian === normalizedUserBagian) {
                        return true;
                    }
                    // Check if request is in user's additional groups
                    if (userScope.additionalGroups.includes(group)) {
                        return true;
                    }
                    return false;
                }
                
                // scope 'own' - only user's bagian
                if (userScope.scope === 'own') {
                    return normalizedRequestBagian === normalizedUserBagian;
                }
                
                return false;
            });

            verifikasiLapanganCount = filteredStep3Requests.length;

            // Group by golongan
            for (const request of filteredStep3Requests) {
                const golonganName = request.GolonganLimbah?.nama;
                const group = determineGroupFromGolongan(golonganName);
                if (group && verifikasiLapanganByGroup.hasOwnProperty(group)) {
                    verifikasiLapanganByGroup[group]++;
                }
            }
        } catch (step3Error) {
            console.error('[getDashboardStats] Error checking step 3 requests:', step3Error.message);
        }

        // 6. Count "Pembuatan BAP" - requests with status 'Pembuatan BAP' (available for all users)
        let pembuatanBAPCount = 0;
        const pembuatanBAPByGroup = initGroupBreakdown();
        
        try {
            const bapRequests = await PermohonanPemusnahanLimbah.findAll({
                where: {
                    status: 'Pembuatan BAP'
                },
                include: [
                    {
                        model: GolonganLimbah,
                        required: false
                    }
                ]
            });

            // Filter based on user scope (using normalizedUserBagian from verifikasi section)
            const filteredBapRequests = bapRequests.filter(request => {
                const golonganName = request.GolonganLimbah?.nama;
                const group = determineGroupFromGolongan(golonganName);
                // Normalize request bagian for comparison
                const normalizedRequestBagian = request.bagian ? String(request.bagian).toUpperCase() : null;
                
                // scope 'all' - no filtering needed
                if (userScope.scope === 'all') {
                    return true;
                }
                
                // scope 'bagian_plus_group' - user can see their bagian OR additional groups
                if (userScope.scope === 'bagian_plus_group') {
                    // Check if request is from user's bagian
                    if (normalizedRequestBagian === normalizedUserBagian) {
                        return true;
                    }
                    // Check if request is in user's additional groups
                    if (userScope.additionalGroups.includes(group)) {
                        return true;
                    }
                    return false;
                }
                
                // scope 'own' - only user's bagian
                if (userScope.scope === 'own') {
                    return normalizedRequestBagian === normalizedUserBagian;
                }
                
                return false;
            });

            pembuatanBAPCount = filteredBapRequests.length;

            // Group by golongan
            for (const request of filteredBapRequests) {
                const golonganName = request.GolonganLimbah?.nama;
                const group = determineGroupFromGolongan(golonganName);
                if (group && pembuatanBAPByGroup.hasOwnProperty(group)) {
                    pembuatanBAPByGroup[group]++;
                }
            }
        } catch (bapError) {
            console.error('[getDashboardStats] Error checking Pembuatan BAP requests:', bapError.message);
        }

        // 7. Count "Rejected (KL)" - requests with status Rejected
        let rejectedKLCount = 0;
        const rejectedKLByGroup = initGroupBreakdown();
        
        try {
            const rejectedRequests = await PermohonanPemusnahanLimbah.findAll({
                where: {
                    status: 'Rejected'
                },
                include: [
                    {
                        model: GolonganLimbah,
                        required: false
                    }
                ]
            });

            rejectedKLCount = rejectedRequests.length;

            // Group by golongan
            for (const request of rejectedRequests) {
                const golonganName = request.GolonganLimbah?.nama;
                const group = determineGroupFromGolongan(golonganName);
                if (group && rejectedKLByGroup.hasOwnProperty(group)) {
                    rejectedKLByGroup[group]++;
                }
            }
        } catch (rejectedError) {
            console.error('[getDashboardStats] Error checking rejected requests:', rejectedError.message);
        }

        // Return enhanced stats with group breakdowns
        return res.json({
            success: true,
            data: {
                myRequests: {
                    total: myRequestsCount,
                    byGroup: myRequestsByGroup
                },
                pendingApprovals: {
                    total: pendingApprovalsCount,
                    byGroup: pendingApprovalsByGroup
                },
                approved: {
                    total: approvedCount,
                    byGroup: approvedByGroup
                },
                // KL-specific stats
                waitingHseManager: waitingHseManagerCount,
                waitingHseManagerByGroup: waitingHseManagerByGroup,
                verifikasiLapangan: verifikasiLapanganCount,
                verifikasiLapanganByGroup: verifikasiLapanganByGroup,
                pembuatanBAP: pembuatanBAPCount,
                pembuatanBAPByGroup: pembuatanBAPByGroup,
                rejectedKL: rejectedKLCount,
                rejectedKLByGroup: rejectedKLByGroup,
                // Legacy fields for backward compatibility
                myRequestsCount,
                pendingApprovalsCount,
                approvedCount
            }
        });

    } catch (error) {
        console.error('[getDashboardStats] Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch dashboard statistics',
            error: error.message
        });
    }
};