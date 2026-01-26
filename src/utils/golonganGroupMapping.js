/**
 * Golongan Limbah Group Mapping
 * 
 * Centralized mapping of group parameter to golongan limbah names.
 * Used by both permohonanController and beritaAcaraController for consistent filtering.
 */

const GOLONGAN_GROUP_MAP = {
  'limbah-b3': [
    'Hormon',
    'Sefalosporin',
    'Probiotik',
    'Non Betalaktam',
    'Betalaktam',
    'Limbah mikrobiologi',
    'Sisa Analisa Lab',
    'Lain-lain'
  ],
  'recall': [
    'Recall'
  ],
  'recall-precursor': [
    'Prekursor & OOT',
    'Recall & Prekursor'
  ]
};

/**
 * Signing Workflow Name Mapping
 * Maps group to workflow_name in signing_workflows table for filtering Berita Acara
 */
const WORKFLOW_NAME_MAP = {
  'limbah-b3': ['Standard'],
  'recall': ['Recall', 'Recall (Produk Pangan)'],
  'recall-precursor': ['Precursor & OOT', 'Recall & Precursor']
};

/**
 * Get golongan names for a given group
 * @param {string} group - The group key ('limbah-b3', 'recall', 'recall-precursor')
 * @returns {string[]|null} Array of golongan names or null if group not found
 */
const getGolonganNamesByGroup = (group) => {
  if (!group || !GOLONGAN_GROUP_MAP[group]) {
    return null;
  }
  return GOLONGAN_GROUP_MAP[group];
};

/**
 * Check if a golongan name belongs to a specific group
 * @param {string} golonganName - The golongan name to check
 * @param {string} group - The group key to check against
 * @returns {boolean} True if golongan belongs to group
 */
const isGolonganInGroup = (golonganName, group) => {
  const golonganNames = getGolonganNamesByGroup(group);
  if (!golonganNames) return false;
  return golonganNames.includes(golonganName);
};

/**
 * Get workflow names for a given group (for Berita Acara filtering)
 * @param {string} group - The group key ('limbah-b3', 'recall', 'recall-precursor')
 * @returns {string[]|null} Array of workflow names or null if group not found
 */
const getWorkflowNamesByGroup = (group) => {
  if (!group || !WORKFLOW_NAME_MAP[group]) {
    return null;
  }
  return WORKFLOW_NAME_MAP[group];
};

module.exports = {
  GOLONGAN_GROUP_MAP,
  WORKFLOW_NAME_MAP,
  getGolonganNamesByGroup,
  isGolonganInGroup,
  getWorkflowNamesByGroup
};
