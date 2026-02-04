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

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'User not authenticated'
            });
        }

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
                        requester_id: { [Op.ne]: userId }
                    }
                });

                // Filter out requests where current step needs user's approval but hasn't been processed yet
                const filteredApproved = approvedRequests.filter(request => {
                    // If no current step (completed), always show in Approved
                    if (!request.current_step_id || !request.CurrentStep) {
                        return true;
                    }
                    
                    // Check if user already processed current step
                    const hasProcessedCurrent = hasUserProcessedCurrentStep(request, userId);
                    return hasProcessedCurrent;
                });

                approvedCount = filteredApproved.length;

                // Group by golongan
                for (const request of filteredApproved) {
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

        // 5. Count "Verifikasi Lapangan" - requests at step 3 waiting for approval
        let verifikasiLapanganCount = 0;
        const verifikasiLapanganByGroup = initGroupBreakdown();
        
        if (hasApprovalAuth) {
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

                verifikasiLapanganCount = step3Requests.length;

                // Group by golongan
                for (const request of step3Requests) {
                    const golonganName = request.GolonganLimbah?.nama;
                    const group = determineGroupFromGolongan(golonganName);
                    if (group && verifikasiLapanganByGroup.hasOwnProperty(group)) {
                        verifikasiLapanganByGroup[group]++;
                    }
                }
            } catch (step3Error) {
                console.error('[getDashboardStats] Error checking step 3 requests:', step3Error.message);
            }
        }

        // 6. Count "Rejected (KL)" - requests with status Rejected
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