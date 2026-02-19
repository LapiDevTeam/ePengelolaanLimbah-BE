const axios = require('axios');

/**
 * Unified Approval Authorization Service
 * Single source of truth for determining if a user can approve a request
 * and whether they have already processed it.
 */

// Cache for external API calls (to avoid repeated calls in the same request)
let externalApprovalCache = null;
let externalApprovalCacheTime = 0;
const CACHE_TTL = 60000; // 1 minute

/**
 * Get external approval data with caching
 */
const getExternalApprovals = async () => {
  const now = Date.now();
  
  // Return cached data if still valid
  if (externalApprovalCache && (now - externalApprovalCacheTime) < CACHE_TTL) {
    return externalApprovalCache;
  }
  
  try {
    const EXTERNAL_APPROVAL_URL = process.env.EXTERNAL_APPROVAL_URL || 'http://192.168.1.38/api/global-dev/v1/custom/list-approval-magang';
    const externalRes = await axios.get(EXTERNAL_APPROVAL_URL);
    const items = Array.isArray(externalRes.data) ? externalRes.data : externalRes.data?.data || [];
    
    // Filter for ePengelolaan_Limbah approvers only
    const appItems = items.filter(i => String(i.Appr_ApplicationCode || '') === 'ePengelolaan_Limbah');
    
    // Update cache
    externalApprovalCache = appItems;
    externalApprovalCacheTime = now;
    
    return appItems;
  } catch (error) {
    console.warn('[getExternalApprovals] External API failed:', error.message);
    // Return cached data even if expired, or empty array
    return externalApprovalCache || [];
  }
};

/**
 * Get user's approval capabilities from external API
 */
const getUserApprovals = async (userId) => {
  const allApprovals = await getExternalApprovals();
  return allApprovals.filter(item => item.Appr_ID === userId);
};

/**
 * Check if a user can approve a specific request based on current step
 * This is the single source of truth for approval authorization logic
 * 
 * @param {string} userId - User's NIK
 * @param {object} request - Request object with CurrentStep, GolonganLimbah, bagian, etc.
 * @returns {Promise<boolean>}
 */
const checkUserCanApproveRequest = async (userId, request) => {
  try {
    // Special case: PJKPO always has approval authority
    const isPJKPO = userId === "PJKPO";
    
    const userApprovals = await getUserApprovals(userId);
    
    // If user has no approvals and isn't PJKPO, they can't approve
    if (userApprovals.length === 0 && !isPJKPO) {
      return false;
    }
    
    const currentStepLevel = request.CurrentStep?.step_level;
    if (!currentStepLevel) {
      return false;
    }
    
    // Step 1: Department Manager - must match department
    if (currentStepLevel === 1) {
      const userDepts = userApprovals
        .filter(a => a.Appr_No === 1)
        .map(a => String(a.Appr_DeptID || '').toUpperCase());
      
      const reqDept = String(request.bagian || request.requester_dept_id || '').toUpperCase();
      return userDepts.includes(reqDept);
    }
    
    // Step 2: APJ - depends on golongan and department
    if (currentStepLevel === 2) {
      const userAPJDepts = userApprovals
        .filter(a => a.Appr_No === 2)
        .map(a => String(a.Appr_DeptID || '').toUpperCase());
      
      // PJKPO special case
      if (isPJKPO) {
        userAPJDepts.push('PC');
      }
      
      if (userAPJDepts.length === 0) {
        return false;
      }
      
      const golonganName = String(request.GolonganLimbah?.nama || '').toLowerCase();
      
      // Determine what department is required for this golongan
      const requiresPN1 = golonganName.includes('prekursor') || golonganName.includes('oot');
      const requiresQA = golonganName.includes('recall') && !golonganName.includes('prekursor');
      const requiresHC = request.is_produk_pangan === true;
      
      // Check if user has the required department
      if (requiresPN1 && userAPJDepts.includes('PN1')) return true;
      if (requiresQA && userAPJDepts.includes('QA')) return true;
      if (requiresHC && userAPJDepts.includes('PC')) return true;
      
      // For "Recall & Prekursor" (both keywords), accept either PN1 or QA
      if (golonganName.includes('recall') && golonganName.includes('prekursor')) {
        if (userAPJDepts.includes('PN1') || userAPJDepts.includes('QA')) {
          return true;
        }
      }
      
      return false;
    }
    
    // Step 3: Verification - any user with step 3 authority can approve
    if (currentStepLevel === 3) {
      return userApprovals.some(a => a.Appr_No === 3) || isPJKPO;
    }
    
    // Step 4: HSE Manager - any user with step 4 authority can approve
    if (currentStepLevel === 4) {
      return userApprovals.some(a => a.Appr_No === 4) || isPJKPO;
    }
    
    return false;
  } catch (error) {
    console.error('[checkUserCanApproveRequest] Error:', error.message);
    return false;
  }
};

/**
 * Check if user has already processed the current step of a request
 * 
 * @param {object} request - Request object with ApprovalHistories and current_step_id
 * @param {string} userId - User's NIK
 * @returns {boolean}
 */
const hasUserProcessedCurrentStep = (request, userId) => {
  if (!request.current_step_id) {
    return false;
  }
  
  const histories = request.ApprovalHistories || [];
  
  return histories.some(h => {
    const approverIds = [h.approver_id, h.approver_id_delegated].filter(Boolean).map(String);
    const isUserApprover = approverIds.includes(String(userId));
    const isProcessed = ['Approved', 'Rejected'].includes(h.status);
    const isCurrentStep = String(h.step_id) === String(request.current_step_id);
    
    return isUserApprover && isProcessed && isCurrentStep;
  });
};

/**
 * Determine if user has any approval authority (for any step level)
 * 
 * @param {string} userId - User's NIK
 * @param {number} jobLevel - User's job level (optional, for fallback)
 * @returns {Promise<boolean>}
 */
const hasApprovalAuthority = async (userId, jobLevel = null) => {
  // PJKPO always has authority
  if (userId === "PJKPO") {
    return true;
  }
  
  try {
    const userApprovals = await getUserApprovals(userId);
    
    if (userApprovals.length > 0) {
      return true;
    }
    
    // Fallback: check by job level (Manager level = 3 or below)
    if (jobLevel && parseInt(jobLevel) <= 4) {
      return true;
    }
    
    return false;
  } catch (error) {
    console.warn('[hasApprovalAuthority] Check failed:', error.message);
    
    // Fallback to job level check
    return jobLevel && parseInt(jobLevel) <= 4;
  }
};

/**
 * Get all step levels a user can approve
 * 
 * @param {string} userId - User's NIK
 * @returns {Promise<number[]>}
 */
const getUserApprovalSteps = async (userId) => {
  try {
    const userApprovals = await getUserApprovals(userId);
    
    const stepLevels = userApprovals
      .map(item => item.Appr_No)
      .filter(stepNo => stepNo != null);
    
    return [...new Set(stepLevels)]; // Remove duplicates
  } catch (error) {
    console.warn('[getUserApprovalSteps] Error:', error.message);
    return [];
  }
};

module.exports = {
  checkUserCanApproveRequest,
  hasUserProcessedCurrentStep,
  hasApprovalAuthority,
  getUserApprovalSteps,
  getUserApprovals,
  getExternalApprovals
};
