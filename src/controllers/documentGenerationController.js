const ExcelJS = require('exceljs');
const axios = require('axios');
const {
    PermohonanPemusnahanLimbah,
    DetailLimbah,
    ApprovalHistory,
    ApprovalWorkflowStep,
    GolonganLimbah,
    JenisLimbahB3,
    BeritaAcara,
    SigningHistory,
    SigningWorkflowStep
} = require('../models');
const jakartaTime = require('../utils/jakartaTime');
const { getGolonganNamesByGroup, GOLONGAN_GROUP_MAP, determineGroupFromGolongan } = require('../utils/golonganGroupMapping');

/**
 * Helper function to fetch Inisial_Name from external API
 * @param {string} userId - The user ID (NIK)
 * @returns {Promise<string>} - The Inisial_Name or userId if not found
 */
const getInisialName = async (userId) => {
    if (!userId) return '';
    
    try {
        const EXTERNAL_APPROVAL_URL = process.env.EXTERNAL_APPROVAL_URL;
        const response = await axios.get(EXTERNAL_APPROVAL_URL);
        const items = Array.isArray(response.data) ? response.data : response.data?.data || [];
        
        // Find the user by Appr_ID matching userId
        const userRecord = items.find(item => 
            String(item.Appr_ID) === String(userId) && 
            String(item.Appr_ApplicationCode || '') === 'ePengelolaan_Limbah'
        );
        
        return userRecord?.Inisial_Name || userId;
    } catch (error) {
        console.warn(`Failed to fetch Inisial_Name for user ${userId}:`, error.message);
        return userId; // Fallback to userId if API call fails
    }
};

/**
 * GET /api/document-generation/permohonan/:id
 * Fetches and formats all necessary data for the Permohonan document.
 */
const getPermohonanDataForDoc = async (req, res) => {
    try {
        const { id } = req.params;

        const permohonan = await PermohonanPemusnahanLimbah.findByPk(id, {
            include: [
                { model: DetailLimbah },
                { 
                    model: ApprovalHistory,
                    include: [{ model: ApprovalWorkflowStep }]
                },
                { model: GolonganLimbah },
                { model: JenisLimbahB3 }
            ]
        });

        if (!permohonan) {
            return res.status(404).json({ message: 'Permohonan not found' });
        }

        // Filter for 'Approved' statuses, convert dates to numbers, and find the max.
        const approvalTimestamps = permohonan.ApprovalHistories
            .filter(h => h.status === 'Approved' && h.decision_date)
            .map(h => new Date(h.decision_date).getTime());

        const latestApprovalTimestamp = approvalTimestamps.length > 0 
            ? new Date(Math.max(...approvalTimestamps))
            : new Date(jakartaTime.nowJakarta()); // Fallback to Jakarta now if no approvals found
        
        // --- Process Data for the Document ---

        const bentuk_limbah_padat = permohonan.bentuk_limbah === 'Padat';
        const bentuk_limbah_cair = permohonan.bentuk_limbah === 'Cair';
        const bagian = permohonan.bagian;

        const nomor_permohonan = permohonan.nomor_permohonan;
        const jumlah_item = permohonan.jumlah_item;
        const jumlah_wadah = new Set(permohonan.DetailLimbahs.map(d => d.nomor_wadah)).size;
        const bobot_total = permohonan.DetailLimbahs.reduce((sum, d) => sum + parseFloat(d.bobot || 0), 0);
        const golongan_limbah = permohonan.GolonganLimbah ? permohonan.GolonganLimbah.nama : 'N/A';
        const jenis_limbah = permohonan.JenisLimbahB3 ? permohonan.JenisLimbahB3.nama : 'N/A';
        
        const verifikasi = {
            pelaksana_pemohon: { paraf: '', tgl: '' },
            supervisor_pemohon: { paraf: '', tgl: '' },
            pelaksana_hse: { paraf: '', tgl: '' },
            supervisor_hse: { paraf: '', tgl: '' }
        };

        // For these fields we want to return both the delegated 'paraf' id and the original 'user' id
        // so frontend can display "paraf a.n. user" when a delegation exists.
        const penyerah = { paraf: '', user: '', tgl: '' };
        const menyetujui_apj_qa = { paraf: '', user: '', tgl: '' };
        const menyetujui_apj_pn = { paraf: '', user: '', tgl: '' };
        const menyetujui_pjkpo = { paraf: '', user: '', tgl: '' }; // PJKPO for produk pangan
        const mengetahui = { paraf: '', user: '', tgl: '' };

         // Find verification approvals - check both "Verifikasi Lapangan" and step level 3
         // This handles different workflow structures where verification might be at different step levels
         const verificationApprovals = permohonan.ApprovalHistories.filter(h => {
            const stepName = h.ApprovalWorkflowStep?.step_name;
            const stepLevel = h.ApprovalWorkflowStep?.step_level;
            return h.status === 'Approved' && (
                stepName === 'Verifikasi Lapangan' || 
                (stepLevel === 3 && stepName !== 'HSE Manager') ||
                // Also check for step level 2 in Standard workflow
                (stepLevel === 2 && stepName === 'Verifikasi Lapangan')
            );
        });

        // For Verifikasi Lapangan we want the verifier to appear as themselves (they authenticate
        // inside the modal). Use approver_id (not approver_id_delegated) so printed docs show
        // the actual person who performed the verification.
        verificationApprovals.forEach(h => {
            if (h.approver_jabatan?.includes('VERIF_ROLE:1')) {
                verifikasi.pelaksana_pemohon = { paraf: h.approver_id || h.approver_id_delegated || '', tgl: h.decision_date };
            }
            if (h.approver_jabatan?.includes('VERIF_ROLE:2')) {
                verifikasi.supervisor_pemohon = { paraf: h.approver_id || h.approver_id_delegated || '', tgl: h.decision_date };
            }
            if (h.approver_jabatan?.includes('VERIF_ROLE:3')) {
                verifikasi.pelaksana_hse = { paraf: h.approver_id || h.approver_id_delegated || '', tgl: h.decision_date };
            }
            if (h.approver_jabatan?.includes('VERIF_ROLE:4')) {
                verifikasi.supervisor_hse = { paraf: h.approver_id || h.approver_id_delegated || '', tgl: h.decision_date };
            }
        });

        permohonan.ApprovalHistories.forEach(h => {
            if (h.status === 'Approved') {
                const stepName = h.ApprovalWorkflowStep?.step_name;

                if (stepName === 'Manager Approval') {
                    // prefer delegated id for paraf, but still keep original approver id as 'user'
                    penyerah.paraf = h.approver_id_delegated || '';
                    penyerah.user = h.approver_id || '';
                    // If no delegation, show paraf as the approver_id for backwards compatibility
                    if (!penyerah.paraf && penyerah.user) penyerah.paraf = penyerah.user;
                    penyerah.tgl = h.decision_date;
                } else if (stepName === 'HSE Manager') {
                    mengetahui.paraf = h.approver_id_delegated || '';
                    mengetahui.user = h.approver_id || '';
                    if (!mengetahui.paraf && mengetahui.user) mengetahui.paraf = mengetahui.user;
                    mengetahui.tgl = h.decision_date;
                } else if (stepName === 'APJ Approval' || stepName === 'PJKPO Approval' || 
                          (h.ApprovalWorkflowStep?.step_level === 2 && h.approver_jabatan)) {
                    // Handle APJ approvals - check role markers first, then fall back to step name and approver_id
                    const approverId = h.approver_id || h.approver_id_delegated;
                    const approverJabatan = h.approver_jabatan || '';
                    
                    // Check for APJ role markers in approver_jabatan
                    if (approverJabatan.includes('APJ_ROLE:HC') || approverId === 'PJKPO' || stepName === 'PJKPO Approval') {
                        // PJKPO approval (Workflow 5: Recall - Produk Pangan)
                        menyetujui_pjkpo.paraf = h.approver_id_delegated || '';
                        menyetujui_pjkpo.user = h.approver_id || '';
                        if (!menyetujui_pjkpo.paraf && menyetujui_pjkpo.user) menyetujui_pjkpo.paraf = menyetujui_pjkpo.user;
                        menyetujui_pjkpo.tgl = h.decision_date;
                    } else if (approverJabatan.includes('APJ_ROLE:QA')) {
                        // APJ QA approval (Workflow 2: Recall, Workflow 4: Recall & Precursor, Workflow 5: Recall - Produk Pangan)
                        menyetujui_apj_qa.paraf = h.approver_id_delegated || '';
                        menyetujui_apj_qa.user = h.approver_id || '';
                        if (!menyetujui_apj_qa.paraf && menyetujui_apj_qa.user) menyetujui_apj_qa.paraf = menyetujui_apj_qa.user;
                        menyetujui_apj_qa.tgl = h.decision_date;
                    } else if (approverJabatan.includes('APJ_ROLE:PN')) {
                        // APJ PN approval (Workflow 1: Precursor & OOT, Workflow 4: Recall & Precursor)
                        menyetujui_apj_pn.paraf = h.approver_id_delegated || '';
                        menyetujui_apj_pn.user = h.approver_id || '';
                        if (!menyetujui_apj_pn.paraf && menyetujui_apj_pn.user) menyetujui_apj_pn.paraf = menyetujui_apj_pn.user;
                        menyetujui_apj_pn.tgl = h.decision_date;
                    }
                }
            }
        });

        const rejection = permohonan.ApprovalHistories.find(h => h.status === 'Rejected');
        const alasan_reject = rejection ? rejection.comments : permohonan.alasan_penolakan || '';
        
        // --- Fetch Inisial_Name for all user IDs ---
        // Collect all unique user IDs that need Inisial_Name lookup
        const userIds = new Set();
        
        // Add verification user IDs
        if (verifikasi.pelaksana_pemohon.paraf) userIds.add(verifikasi.pelaksana_pemohon.paraf);
        if (verifikasi.supervisor_pemohon.paraf) userIds.add(verifikasi.supervisor_pemohon.paraf);
        if (verifikasi.pelaksana_hse.paraf) userIds.add(verifikasi.pelaksana_hse.paraf);
        if (verifikasi.supervisor_hse.paraf) userIds.add(verifikasi.supervisor_hse.paraf);
        
        // Add signature user IDs
        if (penyerah.paraf) userIds.add(penyerah.paraf);
        if (penyerah.user) userIds.add(penyerah.user);
        if (menyetujui_apj_qa.paraf) userIds.add(menyetujui_apj_qa.paraf);
        if (menyetujui_apj_qa.user) userIds.add(menyetujui_apj_qa.user);
        if (menyetujui_apj_pn.paraf) userIds.add(menyetujui_apj_pn.paraf);
        if (menyetujui_apj_pn.user) userIds.add(menyetujui_apj_pn.user);
        if (menyetujui_pjkpo.paraf) userIds.add(menyetujui_pjkpo.paraf);
        if (menyetujui_pjkpo.user) userIds.add(menyetujui_pjkpo.user);
        if (mengetahui.paraf) userIds.add(mengetahui.paraf);
        if (mengetahui.user) userIds.add(mengetahui.user);
        
        // Fetch Inisial_Name for all user IDs in parallel
        const inisialNameMap = {};
        await Promise.all(
            Array.from(userIds).map(async (userId) => {
                inisialNameMap[userId] = await getInisialName(userId);
            })
        );
        
        // Replace user IDs with Inisial_Name
        verifikasi.pelaksana_pemohon.paraf = inisialNameMap[verifikasi.pelaksana_pemohon.paraf] || verifikasi.pelaksana_pemohon.paraf;
        verifikasi.supervisor_pemohon.paraf = inisialNameMap[verifikasi.supervisor_pemohon.paraf] || verifikasi.supervisor_pemohon.paraf;
        verifikasi.pelaksana_hse.paraf = inisialNameMap[verifikasi.pelaksana_hse.paraf] || verifikasi.pelaksana_hse.paraf;
        verifikasi.supervisor_hse.paraf = inisialNameMap[verifikasi.supervisor_hse.paraf] || verifikasi.supervisor_hse.paraf;
        
        penyerah.paraf = inisialNameMap[penyerah.paraf] || penyerah.paraf;
        penyerah.user = inisialNameMap[penyerah.user] || penyerah.user;
        menyetujui_apj_qa.paraf = inisialNameMap[menyetujui_apj_qa.paraf] || menyetujui_apj_qa.paraf;
        menyetujui_apj_qa.user = inisialNameMap[menyetujui_apj_qa.user] || menyetujui_apj_qa.user;
        menyetujui_apj_pn.paraf = inisialNameMap[menyetujui_apj_pn.paraf] || menyetujui_apj_pn.paraf;
        menyetujui_apj_pn.user = inisialNameMap[menyetujui_apj_pn.user] || menyetujui_apj_pn.user;
        menyetujui_pjkpo.paraf = inisialNameMap[menyetujui_pjkpo.paraf] || menyetujui_pjkpo.paraf;
        menyetujui_pjkpo.user = inisialNameMap[menyetujui_pjkpo.user] || menyetujui_pjkpo.user;
        mengetahui.paraf = inisialNameMap[mengetahui.paraf] || mengetahui.paraf;
        mengetahui.user = inisialNameMap[mengetahui.user] || mengetahui.user;
        
            const docData = {
            is_padat: bentuk_limbah_padat,
            is_cair: bentuk_limbah_cair,
            bagian,
            tanggal_pengajuan: latestApprovalTimestamp,
            nomor_permohonan,
            jumlah_item,
            jumlah_wadah,
            bobot_total,
            golongan_limbah,
            jenis_limbah,
            verifikasi,
            alasan_reject,
            penyerah,
            menyetujui: {
              apj_qa: menyetujui_apj_qa,
              apj_pn: menyetujui_apj_pn,
              pjkpo: menyetujui_pjkpo
            },
            mengetahui,
                // Include detail records as-is (do not inject jumlah_item per detail)
                detail_limbah: (permohonan.DetailLimbahs || []).map(d => (
                    d.toJSON ? d.toJSON() : d
                ))
        };

        res.status(200).json({ success: true, data: docData });

    } catch (error) {
        console.error("Failed to get permohonan data for doc:", error);
        res.status(500).json({ message: "Error getting data for document", error: error.message });
    }
};

/**
 * GET /api/document-generation/berita-acara/:id
 * Fetches and formats all necessary data for the Berita Acara document.
 */
const getBeritaAcaraDataForDoc = async (req, res) => {
    try {
        const { id } = req.params;

        const beritaAcara = await BeritaAcara.findByPk(id, {
            include: [
                {
                    model: PermohonanPemusnahanLimbah,
                    include: [DetailLimbah, GolonganLimbah, JenisLimbahB3]
                },
                {
                    model: SigningHistory,
                    include: [SigningWorkflowStep]
                }
            ]
        });

        if (!beritaAcara) {
            return res.status(404).json({ message: 'Berita Acara not found' });
        }

        // --- Find the latest signing timestamp ---
        const signingTimestamps = beritaAcara.SigningHistories
            .filter(h => h.signed_at)
            .map(h => new Date(h.signed_at).getTime());
        
        const latestSigningTimestamp = signingTimestamps.length > 0
            ? new Date(Math.max(...signingTimestamps))
            : new Date(jakartaTime.nowJakarta()); // Fallback to Jakarta now if no signatures found

        // --- NEW: Format date and time strings separately ---

        // Options for formatting the date (e.g., "Jumat, 26 September 2025")
        // We specify 'id-ID' for Indonesian format and 'Asia/Jakarta' for the timezone.
        const dateOptions = { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric',
            timeZone: 'Asia/Jakarta'
        };
        const hari_tanggal = new Intl.DateTimeFormat('id-ID', dateOptions).format(latestSigningTimestamp);

        // Options for formatting the time (e.g., "17:00")
        const timeOptions = { 
            hour: '2-digit', 
            minute: '2-digit', 
            hour12: false,
            timeZone: 'Asia/Jakarta'
        };
        
        // Helper function to format time as HH:mm
        const formatTime = (date) => {
            const hours = date.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' });
            const minutes = date.toLocaleString('en-US', { minute: '2-digit', timeZone: 'Asia/Jakarta' });
            return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
        };
        
        // --- NEW: Get verification time range from ApprovalHistory (Verifikasi Lapangan step) ---
        // Collect all request IDs from the berita acara
        const requestIds = (beritaAcara.PermohonanPemusnahanLimbahs || []).map(p => p.request_id);
        
        let jam_waktu = '';
        
        if (requestIds.length > 0) {
            // Fetch all approval histories for Verifikasi Lapangan step across all linked requests
            const verificationHistories = await ApprovalHistory.findAll({
                where: {
                    request_id: { [require('sequelize').Op.in]: requestIds },
                    status: 'Approved'
                },
                include: [{
                    model: ApprovalWorkflowStep,
                    where: { step_name: 'Verifikasi Lapangan' },
                    required: true
                }]
            });

            if (verificationHistories.length > 0) {
                // Get all approval timestamps
                const approvalTimes = verificationHistories
                    .filter(h => h.decision_date)
                    .map(h => new Date(h.decision_date).getTime())
                    .filter(t => !isNaN(t) && isFinite(t));

                if (approvalTimes.length > 0) {
                    const earliestTime = new Date(Math.min(...approvalTimes));
                    const latestTime = new Date(Math.max(...approvalTimes));

                    const startTime = formatTime(earliestTime);
                    const endTime = formatTime(latestTime);

                    // If start and end are the same, just show one time
                    if (startTime === endTime) {
                        jam_waktu = startTime;
                    } else {
                        jam_waktu = `${startTime} - ${endTime}`;
                    }
                }
            }
        }
        
        // Fallback to latest signing timestamp if no verification time found
        if (!jam_waktu) {
            jam_waktu = formatTime(latestSigningTimestamp);
        }
        

        // --- Create a detailed list for each linked Permohonan ---
        const permohonan_list = (beritaAcara.PermohonanPemusnahanLimbahs || []).map(p => {
            const detailLimbah = p.DetailLimbahs || [];
            const golonganNama = p.GolonganLimbah?.nama || 'N/A';
            
            // Nomor izin PB-UMKU yang di-hardcode
            const NOMOR_IZIN_PBUMKU = '812011015253600060013';
            
            // Untuk Pangan Olahan (Recall), tambahkan nomor izin PB-UMKU
            let golonganLimbahDisplay = golonganNama;
            if (p.is_produk_pangan && golonganNama.toLowerCase().includes('recall')) {
                golonganLimbahDisplay = `${golonganNama} (${NOMOR_IZIN_PBUMKU})`;
            }
            
            return {
                nomor_permohonan: p.nomor_permohonan,
                bentuk_limbah: p.bentuk_limbah,
                golongan_limbah: golonganLimbahDisplay,
                jenis_limbah: p.JenisLimbahB3?.nama || 'N/A',
                jumlah_item_limbah: p.jumlah_item || detailLimbah.length,
                bobot_total: detailLimbah.reduce((sum, d) => sum + parseFloat(d.bobot || 0), 0),
                alasan_pemusnahan: [...new Set(detailLimbah.map(d => d.alasan_pemusnahan))].filter(Boolean).join('; ')
            };
        });

        // --- Signatures ---
        // hse_supervisor_officer is the creator from berita_acara table, not from signing workflow
        // Use creator_id instead of creator_name to fetch Inisial_Name
        const hse_supervisor_officer = { 
            nama: beritaAcara.creator_id_delegated || '', 
            user: beritaAcara.creator_id || '', 
            tgl: beritaAcara.created_at 
        };

        // For these fields we want to return both the delegated 'nama' and the original 'user' 
        // so frontend can display "nama a.n. user" when a delegation exists.
        const hse_manager = { nama: '', user: '', tgl: '' };
        const manager_pemohon = { nama: '', user: '', tgl: '' };
        const apj_qa = { nama: '', user: '', tgl: '' };
        const apj_pn = { nama: '', user: '', tgl: '' };
        const pjkpo = { nama: '', user: '', tgl: '' }; // PJKPO for produk pangan
        const head_of_plant = { nama: '', user: '', tgl: '' };

        beritaAcara.SigningHistories.forEach(h => {
            const stepName = h.SigningWorkflowStep?.step_name;
            const stepLevel = h.SigningWorkflowStep?.step_level;
            const signerJabatan = h.signer_jabatan || '';

            // Process signers from signing workflow steps
            // Use signer_id instead of signer_name to fetch Inisial_Name
            switch (stepName) {
                case 'HSE Manager Signature':
                    hse_manager.nama = h.signer_id_delegated || '';
                    hse_manager.user = h.signer_id || '';
                    // If no delegation, show nama as the signer_id for backwards compatibility
                    if (!hse_manager.nama && hse_manager.user) hse_manager.nama = hse_manager.user;
                    hse_manager.tgl = h.signed_at;
                    break;
                case 'Department Manager Signature':
                    manager_pemohon.nama = h.signer_id_delegated || '';
                    manager_pemohon.user = h.signer_id || '';
                    if (!manager_pemohon.nama && manager_pemohon.user) manager_pemohon.nama = manager_pemohon.user;
                    manager_pemohon.tgl = h.signed_at;
                    break;
                case 'APJ QA Signature':
                case 'APJ PN Signature':
                case 'PJKPO Signature':
                    // Handle APJ signatures with role markers (new system) or step names (legacy)
                    if (signerJabatan.includes('APJ_ROLE:QA') || stepName === 'APJ QA Signature') {
                        apj_qa.nama = h.signer_id_delegated || '';
                        apj_qa.user = h.signer_id || '';
                        if (!apj_qa.nama && apj_qa.user) apj_qa.nama = apj_qa.user;
                        apj_qa.tgl = h.signed_at;
                    } else if (signerJabatan.includes('APJ_ROLE:PN') || stepName === 'APJ PN Signature') {
                        apj_pn.nama = h.signer_id_delegated || '';
                        apj_pn.user = h.signer_id || '';
                        if (!apj_pn.nama && apj_pn.user) apj_pn.nama = apj_pn.user;
                        apj_pn.tgl = h.signed_at;
                    } else if (signerJabatan.includes('APJ_ROLE:HC') || stepName === 'PJKPO Signature') {
                        pjkpo.nama = h.signer_id_delegated || '';
                        pjkpo.user = h.signer_id || '';
                        if (!pjkpo.nama && pjkpo.user) pjkpo.nama = pjkpo.user;
                        pjkpo.tgl = h.signed_at;
                    }
                    break;
                case 'Head of Plant Signature':
                    head_of_plant.nama = h.signer_id_delegated || '';
                    head_of_plant.user = h.signer_id || '';
                    if (!head_of_plant.nama && head_of_plant.user) head_of_plant.nama = head_of_plant.user;
                    head_of_plant.tgl = h.signed_at;
                    break;
                default:
                    // Handle cases where step_level is 3 but step_name doesn't match the expected APJ signatures
                    // This covers new role-based signing system
                    if (stepLevel === 3) {
                        if (signerJabatan.includes('APJ_ROLE:QA')) {
                            apj_qa.nama = h.signer_id_delegated || '';
                            apj_qa.user = h.signer_id || '';
                            if (!apj_qa.nama && apj_qa.user) apj_qa.nama = apj_qa.user;
                            apj_qa.tgl = h.signed_at;
                        } else if (signerJabatan.includes('APJ_ROLE:PN')) {
                            apj_pn.nama = h.signer_id_delegated || '';
                            apj_pn.user = h.signer_id || '';
                            if (!apj_pn.nama && apj_pn.user) apj_pn.nama = apj_pn.user;
                            apj_pn.tgl = h.signed_at;
                        } else if (signerJabatan.includes('APJ_ROLE:HC')) {
                            pjkpo.nama = h.signer_id_delegated || '';
                            pjkpo.user = h.signer_id || '';
                            if (!pjkpo.nama && pjkpo.user) pjkpo.nama = pjkpo.user;
                            pjkpo.tgl = h.signed_at;
                        } else {
                            // Non-APJ role at level 3 (like Department Manager)
                            manager_pemohon.nama = h.signer_id_delegated || '';
                            manager_pemohon.user = h.signer_id || '';
                            if (!manager_pemohon.nama && manager_pemohon.user) manager_pemohon.nama = manager_pemohon.user;
                            manager_pemohon.tgl = h.signed_at;
                        }
                    }
                    break;
            }
        });

        // --- Fetch Inisial_Name for all user names/IDs ---
        // Collect all unique user names/IDs that need Inisial_Name lookup
        const userIds = new Set();
        
        // Add signature user names/IDs
        if (hse_supervisor_officer.nama) userIds.add(hse_supervisor_officer.nama);
        if (hse_supervisor_officer.user) userIds.add(hse_supervisor_officer.user);
        if (hse_manager.nama) userIds.add(hse_manager.nama);
        if (hse_manager.user) userIds.add(hse_manager.user);
        if (manager_pemohon.nama) userIds.add(manager_pemohon.nama);
        if (manager_pemohon.user) userIds.add(manager_pemohon.user);
        if (apj_qa.nama) userIds.add(apj_qa.nama);
        if (apj_qa.user) userIds.add(apj_qa.user);
        if (apj_pn.nama) userIds.add(apj_pn.nama);
        if (apj_pn.user) userIds.add(apj_pn.user);
        if (pjkpo.nama) userIds.add(pjkpo.nama);
        if (pjkpo.user) userIds.add(pjkpo.user);
        if (head_of_plant.nama) userIds.add(head_of_plant.nama);
        if (head_of_plant.user) userIds.add(head_of_plant.user);
        
        // Fetch Inisial_Name for all user IDs in parallel
        const inisialNameMap = {};
        await Promise.all(
            Array.from(userIds).map(async (userId) => {
                inisialNameMap[userId] = await getInisialName(userId);
            })
        );
        
        // Replace user names/IDs with Inisial_Name
        hse_supervisor_officer.nama = inisialNameMap[hse_supervisor_officer.nama] || hse_supervisor_officer.nama;
        hse_supervisor_officer.user = inisialNameMap[hse_supervisor_officer.user] || hse_supervisor_officer.user;
        hse_manager.nama = inisialNameMap[hse_manager.nama] || hse_manager.nama;
        hse_manager.user = inisialNameMap[hse_manager.user] || hse_manager.user;
        manager_pemohon.nama = inisialNameMap[manager_pemohon.nama] || manager_pemohon.nama;
        manager_pemohon.user = inisialNameMap[manager_pemohon.user] || manager_pemohon.user;
        apj_qa.nama = inisialNameMap[apj_qa.nama] || apj_qa.nama;
        apj_qa.user = inisialNameMap[apj_qa.user] || apj_qa.user;
        apj_pn.nama = inisialNameMap[apj_pn.nama] || apj_pn.nama;
        apj_pn.user = inisialNameMap[apj_pn.user] || apj_pn.user;
        pjkpo.nama = inisialNameMap[pjkpo.nama] || pjkpo.nama;
        pjkpo.user = inisialNameMap[pjkpo.user] || pjkpo.user;
        head_of_plant.nama = inisialNameMap[head_of_plant.nama] || head_of_plant.nama;
        head_of_plant.user = inisialNameMap[head_of_plant.user] || head_of_plant.user;

        // --- Determine whether BPOM signature field is applicable ---
        // BPOM is only required for 'recall' and 'recall-precursor' golongan groups.
        // For 'limbah-b3' group the field should display N/A instead of being empty.
        const show_bpom = (beritaAcara.PermohonanPemusnahanLimbahs || []).some(p => {
            const rawGolongan = p.GolonganLimbah?.nama || '';
            const group = determineGroupFromGolongan(rawGolongan);
            return group === 'recall' || group === 'recall-precursor';
        });

        // --- Final JSON Response ---
        const docData = {
            divisi: beritaAcara.bagian,
            hari_tanggal: hari_tanggal,
            jam_waktu: jam_waktu,
            lokasi_verifikasi: beritaAcara.lokasi_verifikasi,
            pelaksana_bagian: beritaAcara.pelaksana_bagian,
            pelaksana_hse: beritaAcara.pelaksana_hse,
            supervisor_bagian: beritaAcara.supervisor_bagian,
            supervisor_hse: beritaAcara.supervisor_hse,
            permohonan_list, // Use the new detailed list
            show_bpom,       // true = recall/precursor → kosong (tanda tangan fisik); false = limbah-b3 → N/A
            signatures: {
                hse_supervisor_officer,
                hse_manager,
                manager_pemohon,
                apj_qa,
                apj_pn,
                pjkpo,
                head_of_plant
            }
        };

        res.status(200).json({ success: true, data: docData });

    } catch (error) {
        console.error("Failed to get berita acara data for doc:", error);
        res.status(500).json({ message: "Error getting data for Berita Acara document", error: error.message });
    }
};

/**
 * NEW FUNCTION
 * GET /api/document-generation/permohonan/:id/excel
 * Generates an Excel file with the details of a specific Permohonan.
 */
const generatePermohonanExcel = async (req, res) => {
    try {
        const { id } = req.params;

        const permohonan = await PermohonanPemusnahanLimbah.findByPk(id, {
            include: [
                { model: DetailLimbah },
                { model: GolonganLimbah },
                { model: JenisLimbahB3 },
                { 
                    model: ApprovalHistory,
                    include: [{ model: ApprovalWorkflowStep }]
                }
            ]
        });

        if (!permohonan || !permohonan.DetailLimbahs) {
            return res.status(404).json({ message: 'Permohonan or its details not found' });
        }

        // --- Helper function to format date as DD/MM/YYYY ---
        const formatDate = (dateString) => {
            if (!dateString) return '';
            const date = new Date(dateString);
            const day = String(date.getDate()).padStart(2, "0");
            const month = String(date.getMonth() + 1).padStart(2, "0");
            const year = date.getFullYear();
            return `${day}/${month}/${year}`;
        };

        // --- Get Tanggal Pemusnahan from Verifikasi Lapangan (VERIF_ROLE) ---
        let tanggal_pemusnahan = '';
        
        if (permohonan.ApprovalHistories && permohonan.ApprovalHistories.length > 0) {
            // Filter for verification approvals (approver_jabatan contains VERIF_ROLE)
            const verificationApprovals = permohonan.ApprovalHistories.filter(
                h => h.status === 'Approved' && 
                     h.decision_date && 
                     h.approver_jabatan && 
                     h.approver_jabatan.includes('VERIF_ROLE')
            );
            
            if (verificationApprovals.length > 0) {
                // Sort by decision_date descending and take the latest verification
                const latestVerification = verificationApprovals
                    .sort((a, b) => new Date(b.decision_date) - new Date(a.decision_date))[0];
                
                tanggal_pemusnahan = formatDate(latestVerification.decision_date);
            }
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Detail Limbah');

        // --- Styling ---
        const headerStyle = {
            font: { bold: true, color: { argb: 'FFFFFFFF' } },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF70AD47' } },
            alignment: { vertical: 'middle', horizontal: 'center' }
        };

        // --- Define Columns ---
        worksheet.columns = [
            { header: 'Bagian', key: 'bagian', width: 15 },
            { header: 'Tanggal Pengajuan', key: 'tanggal_pengajuan', width: 20 },
            { header: 'No. Permohonan', key: 'nomor_permohonan', width: 20 },
            { header: 'Tanggal Pemusnahan', key: 'tanggal_pemusnahan', width: 20 },
            { header: 'Bentuk Limbah', key: 'bentuk_limbah', width: 15 },
            { header: 'Golongan Limbah', key: 'golongan_limbah', width: 30 },
            { header: 'Jenis Limbah', key: 'jenis_limbah', width: 30 },
            { header: 'Produk Pangan', key: 'is_produk_pangan', width: 15 },
            { header: 'No. Dokumen', key: 'nomor_referensi', width: 15 },
            { header: 'Nama Limbah', key: 'nama_limbah', width: 30 },
            { header: 'No. Bets/No. Analisa', key: 'nomor_analisa', width: 30 },
            { header: 'Jumlah Barang', key: 'jumlah_barang', width: 15},
            { header: 'Satuan', key: 'satuan', width: 15 },
            { header: 'No. Wadah', key: 'nomor_wadah', width: 15 },
            { header: 'Bobot (gram)', key: 'bobot', width: 15, style: { numFmt: '#,##0.00' } },
            { header: 'Alasan Pemusnahan', key: 'alasan_pemusnahan', width: 30 }
        ];
        
        worksheet.getRow(1).eachCell(cell => {
            cell.style = headerStyle;
        });

        // --- Add Data Rows ---
        const dataRows = permohonan.DetailLimbahs.map(detail => ({
            // Spread detail first, then override with our custom fields
            ...detail.toJSON(),
            nomor_permohonan: permohonan.nomor_permohonan,
            bagian: permohonan.bagian,
            tanggal_pengajuan: formatDate(permohonan.created_at),
            tanggal_pemusnahan: tanggal_pemusnahan,
            bentuk_limbah: permohonan.bentuk_limbah,
            golongan_limbah: permohonan.GolonganLimbah?.nama || 'N/A',
            jenis_limbah: permohonan.JenisLimbahB3?.nama || 'N/A',
            is_produk_pangan: permohonan.is_produk_pangan ? 'Ya' : 'Tidak',
            bobot: parseFloat(detail.bobot || 0),
        }));

        worksheet.addRows(dataRows);

        // --- Set Headers and Send File ---
        res.setHeader(
            'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition', `attachment; filename="detail-limbah-${permohonan.nomor_permohonan || id}.xlsx"`
        );

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error("Error generating Excel file:", error);
        res.status(500).json({ message: "An error occurred during Excel file generation.", error: error.message });
    }
};

/**
 * NEW FUNCTION
 * GET /api/document-generation/logbook/excel?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * Generates an Excel logbook file with multiple sheets grouped by jenis limbah.
 */
const generateLogbookExcel = async (req, res) => {
    try {
        const { start_date, end_date, golongan_group } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ 
                message: 'start_date and end_date query parameters are required (format: YYYY-MM-DD)' 
            });
        }

        // Determine golongan group filter
        // golongan_group: 'limbah-b3', 'recall', 'recall-precursor', or 'all' (default)
        const selectedGroup = golongan_group && golongan_group !== 'all' ? golongan_group : null;
        let golonganNameFilter = null;
        if (selectedGroup) {
            golonganNameFilter = getGolonganNamesByGroup(selectedGroup);
            if (!golonganNameFilter) {
                return res.status(400).json({
                    message: `Invalid golongan_group: ${golongan_group}. Valid values: limbah-b3, recall, recall-precursor, all`
                });
            }
        }

        // Group label map for display
        const GROUP_LABEL_MAP = {
            'limbah-b3': 'Limbah B3',
            'recall': 'Recall',
            'recall-precursor': 'Precursor & OOT'
        };
        const groupLabel = selectedGroup ? (GROUP_LABEL_MAP[selectedGroup] || selectedGroup) : 'Semua Golongan';

        // Parse dates and set time boundaries
        const startDate = new Date(start_date);
        startDate.setHours(0, 0, 0, 0);
        
        const endDate = new Date(end_date);
        endDate.setHours(23, 59, 59, 999);

        // --- Get all jenis limbah for template sheets ---
        const allJenisLimbah = await JenisLimbahB3.findAll({
            order: [['nama', 'ASC']]
        });

        // --- Get permohonan data with status Completed ---
        const permohonanWhere = { status: 'Completed' };
        const golonganInclude = golonganNameFilter
            ? { model: GolonganLimbah, where: { nama: { [require('sequelize').Op.in]: golonganNameFilter } } }
            : { model: GolonganLimbah };

        const allPermohonanData = await PermohonanPemusnahanLimbah.findAll({
            where: permohonanWhere,
            include: [
                { model: DetailLimbah },
                golonganInclude,
                { model: JenisLimbahB3 },
                { 
                    model: ApprovalHistory,
                    include: [{ model: ApprovalWorkflowStep }],
                    required: false
                }
            ]
        });

        // Filter based on verification date
        const permohonanData = allPermohonanData.filter(permohonan => {
            if (!permohonan.ApprovalHistories || permohonan.ApprovalHistories.length === 0) {
                return false;
            }
            
            const verificationApprovals = permohonan.ApprovalHistories.filter(
                h => h.status === 'Approved' && 
                     h.decision_date && 
                     h.approver_jabatan && 
                     h.approver_jabatan.includes('VERIF_ROLE')
            );
            
            if (verificationApprovals.length === 0) {
                return false;
            }
            
            return verificationApprovals.some(approval => {
                const decisionDate = new Date(approval.decision_date);
                return decisionDate >= startDate && decisionDate <= endDate;
            });
        });

        // --- Helper function to get verification date ---
        const getVerificationDate = (permohonan) => {
            if (!permohonan.ApprovalHistories || permohonan.ApprovalHistories.length === 0) {
                return '';
            }
            
            const verificationApprovals = permohonan.ApprovalHistories.filter(
                h => h.status === 'Approved' && 
                     h.decision_date && 
                     h.approver_jabatan && 
                     h.approver_jabatan.includes('VERIF_ROLE')
            );
            
            if (verificationApprovals.length > 0) {
                const latestVerification = verificationApprovals
                    .sort((a, b) => new Date(b.decision_date) - new Date(a.decision_date))[0];
                
                const date = new Date(latestVerification.decision_date);
                const day = String(date.getDate()).padStart(2, "0");
                const month = String(date.getMonth() + 1).padStart(2, "0");
                const year = date.getFullYear();
                return `${day}-${month}-${year}`;
            }
            
            return '';
        };

        // --- Group permohonan by kode (first token of jenis limbah name) ---
        const groupedData = {};
        
        permohonanData.forEach(permohonan => {
            const jenisLimbahRaw = permohonan.JenisLimbahB3?.nama || 'Tidak Diketahui';
            // Extract kode as the first word/token. Example: "A336-1 Produk kembalian" -> kode "A336-1"
            const kodeMatch = jenisLimbahRaw.match(/^(\S+)/);
            const groupKey = kodeMatch ? kodeMatch[1] : jenisLimbahRaw;
            // For Lain-lain, keep as a single bucket
            const safeGroupKey = groupKey === 'Lain-lain' ? 'Lain-lain' : groupKey;

            if (!groupedData[safeGroupKey]) {
                groupedData[safeGroupKey] = [];
            }
            
            const bobotTotal = permohonan.DetailLimbahs?.reduce((sum, detail) => {
                return sum + (parseFloat(detail.bobot || 0) / 1000);
            }, 0) || 0;
            
            groupedData[safeGroupKey].push({
                tanggal_pemusnahan: getVerificationDate(permohonan),
                no_permohonan: permohonan.nomor_permohonan,
                jumlah_kg: bobotTotal,
                tanggal_pengangkutan: '',
                dept: permohonan.bagian,
                kl_supervisor: '',
                satpam: '',
                pihak_ke_3: ''
            });
        });

        // --- Create Excel workbook ---
        const workbook = new ExcelJS.Workbook();

        // --- Header styling ---
        const headerStyle = {
            font: { bold: true, color: { argb: 'FFFFFFFF' } },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF70AD47' } },
            alignment: { vertical: 'middle', horizontal: 'center' }
        };

        // --- Define columns for individual jenis limbah sheets (without Jenis Limbah column) ---
        const jenisLimbahColumns = [
            { header: 'Tanggal Pemusnahan', key: 'tanggal_pemusnahan', width: 20 },
            { header: 'No Permohonan', key: 'no_permohonan', width: 20 },
            { header: 'Jumlah (KG)', key: 'jumlah_kg', width: 15, style: { numFmt: '#,##0.00' } },
            { header: 'Tanggal Pengangkutan', key: 'tanggal_pengangkutan', width: 20 },
            { header: 'Dept', key: 'dept', width: 15 },
            { header: 'KL Supervisor', key: 'kl_supervisor', width: 15 },
            { header: 'Satpam', key: 'satpam', width: 15 },
            { header: 'Pihak ke 3', key: 'pihak_ke_3', width: 15 }
        ];

        // --- Define columns for Total sheet (with Jenis Limbah column) ---
        const totalColumns = [
            { header: 'NO', key: 'no', width: 10 },
            { header: 'JENIS LIMBAH', key: 'jenis_limbah', width: 30 },
            { header: 'KODE', key: 'kode', width: 15 },
            { header: 'BOBOT', key: 'bobot', width: 15, style: { numFmt: '#,##0.00' } }
        ];

        // --- Create sheets for each jenis limbah ---
        let totalData = [];
        let totalBobot = 0;
        let sheetIndex = 1;

        Object.keys(groupedData).forEach((groupKey) => {
            const data = groupedData[groupKey];
            
            // Sheet name uses kode (or Lain-lain)
            const sheetDisplayName = groupKey;
            // Create worksheet for this jenis limbah (sanitize sheet name)
            let sanitizedSheetName = sheetDisplayName.replace(/[\\\/\[\]:\*\?]/g, '').substring(0, 31);
            
            // Prevent duplicate worksheet names, especially avoid "Total" which is reserved
            let finalSheetName = sanitizedSheetName;
            let counter = 1;
            while (workbook.getWorksheet(finalSheetName)) {
                finalSheetName = `${sanitizedSheetName}_${counter}`;
                counter++;
            }
            
            const worksheet = workbook.addWorksheet(finalSheetName);
            
            // Add title row
            const titleText = `Logbook ${sheetDisplayName}`;
            worksheet.mergeCells('A1:H1'); // Merge cells for title (8 columns total)
            const titleCell = worksheet.getCell('A1');
            titleCell.value = titleText;
            titleCell.style = {
                font: { bold: true, size: 14, color: { argb: 'FF000000' } },
                alignment: { vertical: 'middle', horizontal: 'center' },
                fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } }
            };
            
            // Set row height for title
            worksheet.getRow(1).height = 25;
            
            // Add empty row for spacing (row 2)
            worksheet.addRow([]);
            
            // Add column headers manually to row 3
            const headerRow = worksheet.getRow(3);
            jenisLimbahColumns.forEach((col, index) => {
                const cell = headerRow.getCell(index + 1);
                cell.value = col.header;
                cell.style = headerStyle;
                // Set column width
                worksheet.getColumn(index + 1).width = col.width;
            });

            // Add data rows for this jenis limbah (starting from row 4)
            const jenisDataRows = data.map(item => ({
                tanggal_pemusnahan: item.tanggal_pemusnahan,
                no_permohonan: item.no_permohonan,
                jumlah_kg: parseFloat(item.jumlah_kg || 0),
                tanggal_pengangkutan: '', // Empty for now
                dept: item.dept,
                kl_supervisor: '', // Empty for now  
                satpam: '', // Empty for now
                pihak_ke_3: '' // Empty for now
            }));

            // Add data rows starting from row 4
            jenisDataRows.forEach((rowData, index) => {
                const row = worksheet.getRow(4 + index);
                Object.keys(rowData).forEach((key, colIndex) => {
                    const cell = row.getCell(colIndex + 1);
                    cell.value = rowData[key];
                    
                    // Apply number format to Jumlah (KG) column (column 3)
                    if (key === 'jumlah_kg') {
                        cell.numFmt = '#,##0.00';
                    }
                });
            });

            // Calculate total bobot for this jenis limbah
            const jenisBobot = data.reduce((sum, item) => sum + parseFloat(item.jumlah_kg || 0), 0);
            totalBobot += jenisBobot;

            // Extract kode and jenis limbah name from the database value
            // Format in database: "A336-1 Bahan Baku" -> kode: "A336-1", jenis: "Bahan Baku"
            const kode = groupKey;
            const jenisLimbahName = groupKey;

            // Add to total data
            totalData.push({
                no: sheetIndex,
                jenis_limbah: jenisLimbahName, // Use kode as name
                kode: kode, // Kode as first token
                bobot: jenisBobot
            });

            sheetIndex++;
        });

        // --- Create Total sheet ---
        // Ensure the "Total" worksheet name is available
        let totalSheetName = 'Total';
        let totalCounter = 1;
        while (workbook.getWorksheet(totalSheetName)) {
            totalSheetName = `Total_${totalCounter}`;
            totalCounter++;
        }
        
        const totalWorksheet = workbook.addWorksheet(totalSheetName);
        
        // Add title row for Total sheet
        totalWorksheet.mergeCells('A1:D1'); // Merge cells for title (4 columns total)
        const totalTitleCell = totalWorksheet.getCell('A1');
        totalTitleCell.value = `Logbook Total ${groupLabel}`;
        totalTitleCell.style = {
            font: { bold: true, size: 14, color: { argb: 'FF000000' } },
            alignment: { vertical: 'middle', horizontal: 'center' },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } }
        };
        
        // Set row height for title
        totalWorksheet.getRow(1).height = 25;
        
        // Add empty row for spacing (row 2)
        totalWorksheet.addRow([]);
        
        // Add column headers manually to row 3
        const totalHeaderRow = totalWorksheet.getRow(3);
        totalColumns.forEach((col, index) => {
            const cell = totalHeaderRow.getCell(index + 1);
            cell.value = col.header;
            cell.style = headerStyle;
            // Set column width
            totalWorksheet.getColumn(index + 1).width = col.width;
        });

        // Add total data rows starting from row 4
        totalData.forEach((rowData, index) => {
            const row = totalWorksheet.getRow(4 + index);
            row.getCell(1).value = rowData.no;
            row.getCell(2).value = rowData.jenis_limbah;
            row.getCell(3).value = rowData.kode;
            
            // Set BOBOT column as number with format
            const bobotCell = row.getCell(4);
            bobotCell.value = rowData.bobot;
            bobotCell.numFmt = '#,##0.00';
        });

        // Add total row
        const totalRowNum = 4 + totalData.length;
        const totalRow = totalWorksheet.getRow(totalRowNum);
        totalRow.getCell(1).value = '';
        totalRow.getCell(2).value = 'TOTAL';
        totalRow.getCell(3).value = '';
        
        // Set total BOBOT as number with format
        const totalBobotCell = totalRow.getCell(4);
        totalBobotCell.value = totalBobot;
        totalBobotCell.numFmt = '#,##0.00';

        // Style the total row (apply to each cell individually to preserve numFmt)
        totalRow.eachCell((cell, colNumber) => {
            if (colNumber === 4) {
                // For BOBOT column, preserve the number format
                cell.style = {
                    font: { bold: true },
                    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } },
                    numFmt: '#,##0.00'
                };
            } else {
                // For other columns, apply standard styling
                cell.style = {
                    font: { bold: true },
                    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } }
                };
            }
        });

        // Check if no data found and create at least one sheet
        if (Object.keys(groupedData).length === 0) {
            // Create empty Total sheet if no data
            // Ensure the "Total" worksheet name is available
            let emptySheetName = 'Total';
            let emptyCounter = 1;
            while (workbook.getWorksheet(emptySheetName)) {
                emptySheetName = `Total_${emptyCounter}`;
                emptyCounter++;
            }
            
            const emptyWorksheet = workbook.addWorksheet(emptySheetName);
            
            // Add title row for empty sheet
            emptyWorksheet.mergeCells('A1:D1');
            const emptyTitleCell = emptyWorksheet.getCell('A1');
            emptyTitleCell.value = `Logbook Total ${groupLabel}`;
            emptyTitleCell.style = {
                font: { bold: true, size: 14, color: { argb: 'FF000000' } },
                alignment: { vertical: 'middle', horizontal: 'center' },
                fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } }
            };
            emptyWorksheet.getRow(1).height = 25;
            
            // Add empty row for spacing (row 2)
            emptyWorksheet.addRow([]);
            
            // Add column headers manually to row 3
            const emptyHeaderRow = emptyWorksheet.getRow(3);
            totalColumns.forEach((col, index) => {
                const cell = emptyHeaderRow.getCell(index + 1);
                cell.value = col.header;
                cell.style = headerStyle;
                // Set column width
                emptyWorksheet.getColumn(index + 1).width = col.width;
            });
            
            // Add a row indicating no data
            const noDataRow = emptyWorksheet.getRow(4);
            noDataRow.getCell(1).value = '';
            noDataRow.getCell(2).value = 'Tidak ada data dalam rentang tanggal yang dipilih';
            noDataRow.getCell(3).value = '';
            noDataRow.getCell(4).value = 0;
        }

        // --- Set response headers (exactly like generatePermohonanExcel) ---
        const startDateFormatted = start_date.replace(/-/g, '');
        const endDateFormatted = end_date.replace(/-/g, '');
        const fileLabel = groupLabel.replace(/[^a-zA-Z0-9&]/g, '_').replace(/_+/g, '_');
        const filename = `logbook-${fileLabel}-${startDateFormatted}-${endDateFormatted}.xlsx`;
        
        res.setHeader(
            'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition', `attachment; filename="${filename}"`
        );

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error("Error generating logbook Excel file:", error);
        res.status(500).json({ 
            message: "An error occurred during logbook Excel file generation.", 
            error: error.message 
        });
    }
};

/**
 * GET /api/document-generation/permohonan/range/excel?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&golongan_groups=limbah-b3,recall
 * Generates an Excel file with details of all permohonan within a date range (tanggal_pengajuan).
 * 
 * Filter by golongan and bagian based on user department:
 * - KL: All bagian for all golongan groups
 * - QA: All bagian for 'recall', own bagian for 'limbah-b3' and 'recall-precursor'
 * - PN1: All bagian for 'recall-precursor', own bagian for 'limbah-b3' and 'recall'
 * - Others: Own bagian for all golongan groups
 */
const downloadPermohonanByDateRangeExcel = async (req, res) => {
    try {
        const { start_date, end_date, golongan_groups } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ 
                message: 'start_date and end_date query parameters are required (format: YYYY-MM-DD)' 
            });
        }

        // Get user info from auth middleware
        const userBagian = req.user?.emp_DeptID;
        const normalizedUserBagian = userBagian ? String(userBagian).toUpperCase() : null;
        
        if (!userBagian) {
            return res.status(401).json({ 
                message: 'User bagian information not found' 
            });
        }

        // Parse golongan_groups parameter - default to all groups if not provided
        const validGroups = ['limbah-b3', 'recall', 'recall-precursor'];
        let selectedGroups = validGroups; // default: all groups
        
        if (golongan_groups && golongan_groups !== 'all') {
            selectedGroups = golongan_groups.split(',').map(g => g.trim()).filter(g => validGroups.includes(g));
            if (selectedGroups.length === 0) {
                return res.status(400).json({ 
                    message: 'Invalid golongan_groups parameter. Valid values: limbah-b3, recall, recall-precursor' 
                });
            }
        }

        console.log(`🔍 Download Lampiran - User: ${userBagian}, Selected Groups: ${selectedGroups.join(', ')}`);

        // Parse dates and set time boundaries
        const startDate = new Date(start_date);
        startDate.setHours(0, 0, 0, 0);
        
        const endDate = new Date(end_date);
        endDate.setHours(23, 59, 59, 999);

        // --- Helper function to format date as DD/MM/YYYY ---
        const formatDate = (dateString) => {
            if (!dateString) return '';
            const date = new Date(dateString);
            const day = String(date.getDate()).padStart(2, "0");
            const month = String(date.getMonth() + 1).padStart(2, "0");
            const year = date.getFullYear();
            return `${day}/${month}/${year}`;
        };

        // --- Helper function to check if permohonan has passed field verification ---
        const hasPassedVerification = (permohonan) => {
            if (!permohonan.ApprovalHistories || permohonan.ApprovalHistories.length === 0) {
                return false;
            }
            
            // Check if ALL 4 verification roles have approved (VERIF_ROLE:1, VERIF_ROLE:2, VERIF_ROLE:3, VERIF_ROLE:4)
            const verificationApprovals = permohonan.ApprovalHistories.filter(
                h => h.status === 'Approved' && 
                     h.approver_jabatan && 
                     h.approver_jabatan.includes('VERIF_ROLE')
            );
            
            // Check if all 4 roles are present
            const hasRole1 = verificationApprovals.some(h => h.approver_jabatan.includes('VERIF_ROLE:1'));
            const hasRole2 = verificationApprovals.some(h => h.approver_jabatan.includes('VERIF_ROLE:2'));
            const hasRole3 = verificationApprovals.some(h => h.approver_jabatan.includes('VERIF_ROLE:3'));
            const hasRole4 = verificationApprovals.some(h => h.approver_jabatan.includes('VERIF_ROLE:4'));
            
            // All 4 roles must have approved
            return hasRole1 && hasRole2 && hasRole3 && hasRole4;
        };

        // --- Helper function to determine if user can access all bagian for a specific group ---
        const canAccessAllBagianForGroup = (dept, group) => {
            const deptUpper = dept ? String(dept).toUpperCase() : null;
            
            // KL can access all bagian for all groups
            if (deptUpper === 'KL') return true;
            
            // QA can access all bagian for 'recall' only
            if (deptUpper === 'QA' && group === 'recall') return true;
            
            // PN1 can access all bagian for 'recall-precursor' only
            if (deptUpper === 'PN1' && group === 'recall-precursor') return true;
            
            // Others: own bagian only
            return false;
        };

        // --- Build golongan names list from selected groups ---
        const allSelectedGolonganNames = [];
        for (const group of selectedGroups) {
            const golonganNames = getGolonganNamesByGroup(group);
            if (golonganNames) {
                allSelectedGolonganNames.push(...golonganNames);
            }
        }

        // --- Build where clause ---
        const Op = require('sequelize').Op;
        const whereClause = {
            created_at: {
                [Op.between]: [startDate, endDate]
            }
        };

        // Add golongan filter
        if (allSelectedGolonganNames.length > 0) {
            whereClause['$GolonganLimbah.nama$'] = { [Op.in]: allSelectedGolonganNames };
        }

        // --- Get permohonan data ---
        const permohonanList = await PermohonanPemusnahanLimbah.findAll({
            where: whereClause,
            include: [
                { model: DetailLimbah },
                { model: GolonganLimbah, required: true },
                { model: JenisLimbahB3 },
                { 
                    model: ApprovalHistory,
                    include: [{ model: ApprovalWorkflowStep }],
                }
            ],
            order: [['created_at', 'DESC']]
        });

        // --- Apply scope-based filtering ---
        // This filters based on user's access to bagian for each golongan group
        const scopeFilteredList = permohonanList.filter(permohonan => {
            const golonganName = permohonan.GolonganLimbah?.nama;
            const golonganGroup = determineGroupFromGolonganName(golonganName);
            const permohonanBagian = permohonan.bagian ? String(permohonan.bagian).toUpperCase() : null;
            
            // Check if user can access all bagian for this group
            if (canAccessAllBagianForGroup(userBagian, golonganGroup)) {
                return true; // User can see all bagian for this group
            }
            
            // User can only see their own bagian for this group
            return permohonanBagian === normalizedUserBagian;
        });


        // --- Filter permohonan: Completed, Rejected, or InProgress with verification completed ---
        const filteredPermohonanList = scopeFilteredList.filter(permohonan => {
            const status = permohonan.status;
            const passedVerification = hasPassedVerification(permohonan);
            
            // Console log for debugging
            console.log(`\n📋 Permohonan: ${permohonan.nomor_permohonan}`);
            console.log(`   Status: ${status}`);
            console.log(`   Passed Verification: ${passedVerification}`);
            
            if (permohonan.ApprovalHistories && permohonan.ApprovalHistories.length > 0) {
                console.log(`   Approval History:`);
                const verifRoles = { role1: false, role2: false, role3: false, role4: false };
                permohonan.ApprovalHistories.forEach(history => {
                    console.log(`     - ${history.ApprovalWorkflowStep?.step_name || 'Unknown'} (Level ${history.ApprovalWorkflowStep?.step_level}) - ${history.status} - ${history.approver_jabatan || 'N/A'}`);
                    
                    // Track verification roles
                    if (history.status === 'Approved' && history.approver_jabatan) {
                        if (history.approver_jabatan.includes('VERIF_ROLE:1')) verifRoles.role1 = true;
                        if (history.approver_jabatan.includes('VERIF_ROLE:2')) verifRoles.role2 = true;
                        if (history.approver_jabatan.includes('VERIF_ROLE:3')) verifRoles.role3 = true;
                        if (history.approver_jabatan.includes('VERIF_ROLE:4')) verifRoles.role4 = true;
                    }
                });
                console.log(`   Verification Roles Completed:`, verifRoles);
            }
            
            // Include if: Completed, Rejected, or (InProgress AND has passed verification)
            const shouldInclude = status === 'Completed' || 
                                  status === 'Rejected' || 
                                  (status === 'InProgress' && passedVerification);
            
            console.log(`   ✓ Include in export: ${shouldInclude}`);
            
            return shouldInclude;
        });

        console.log(`\n✅ Filtered permohonan count: ${filteredPermohonanList.length}`);

        // --- Helper function to determine group from golongan name ---
        function determineGroupFromGolonganName(golonganName) {
            if (!golonganName) return 'limbah-b3'; // default
            
            const lowerName = String(golonganName).toLowerCase();
            
            // Check each group's golongan names
            for (const [group, golonganList] of Object.entries(GOLONGAN_GROUP_MAP)) {
                if (golonganList.some(g => String(g).toLowerCase() === lowerName)) {
                    return group;
                }
            }
            
            // Fallback pattern matching
            if (lowerName.includes('recall') && lowerName.includes('prekursor')) {
                return 'recall-precursor';
            }
            if (lowerName.includes('prekursor') || lowerName.includes('oot')) {
                return 'recall-precursor';
            }
            if (lowerName.includes('recall')) {
                return 'recall';
            }
            
            return 'limbah-b3'; // default
        }

        if (!filteredPermohonanList || filteredPermohonanList.length === 0) {
            return res.status(404).json({ 
                success: false,
                message: 'Tidak ada data permohonan yang ditemukan',
                details: {
                    totalFound: permohonanList.length,
                    afterScopeFilter: scopeFilteredList.length,
                    afterStatusFilter: filteredPermohonanList.length,
                    criteria: 'Data harus berstatus: Completed, Rejected, atau InProgress dengan verifikasi completed',
                    dateRange: `${start_date} s/d ${end_date}`,
                    selectedGroups: selectedGroups.join(', '),
                    userDept: userBagian
                }
            });
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Lampiran Permohonan');

        // --- Styling ---
        const headerStyle = {
            font: { bold: true, color: { argb: 'FFFFFFFF' } },
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF70AD47' } },
            alignment: { vertical: 'middle', horizontal: 'center', wrapText: true }
        };

        // --- Define Columns ---
        worksheet.columns = [
            { header: 'Bagian', key: 'bagian', width: 12 },
            { header: 'Tanggal Pengajuan', key: 'tanggal_pengajuan', width: 18 },
            { header: 'No. Permohonan', key: 'nomor_permohonan', width: 18 },
            { header: 'Tanggal Pemusnahan', key: 'tanggal_pemusnahan', width: 18 },
            { header: 'Bentuk Limbah', key: 'bentuk_limbah', width: 12 },
            { header: 'Golongan Limbah', key: 'golongan_limbah', width: 28 },
            { header: 'Jenis Limbah', key: 'jenis_limbah', width: 28 },
            { header: 'Produk Pangan', key: 'is_produk_pangan', width: 12 },
            { header: 'No. Dokumen', key: 'nomor_referensi', width: 12 },
            { header: 'Nama Limbah', key: 'nama_limbah', width: 28 },
            { header: 'No. Bets/Analisa', key: 'nomor_analisa', width: 28 },
            { header: 'Jumlah Barang', key: 'jumlah_barang', width: 12 },
            { header: 'Satuan', key: 'satuan', width: 12 },
            { header: 'No. Wadah', key: 'nomor_wadah', width: 12 },
            { header: 'Bobot (gram)', key: 'bobot', width: 12, style: { numFmt: '#,##0.00' } },
            { header: 'Alasan Pemusnahan', key: 'alasan_pemusnahan', width: 28 },
            { header: 'Status', key: 'status', width: 15 }
        ];
        
        worksheet.getRow(1).eachCell(cell => {
            cell.style = headerStyle;
        });

        // --- Process each permohonan and add rows ---
        const dataRows = [];
        
        filteredPermohonanList.forEach(permohonan => {
            // Get tanggal pemusnahan from verification approval
            let tanggal_pemusnahan = '';
            if (permohonan.ApprovalHistories && permohonan.ApprovalHistories.length > 0) {
                const verificationApprovals = permohonan.ApprovalHistories.filter(
                    h => h.status === 'Approved' && 
                         h.decision_date && 
                         h.approver_jabatan && 
                         h.approver_jabatan.includes('VERIF_ROLE')
                );
                
                if (verificationApprovals.length > 0) {
                    const latestVerification = verificationApprovals
                        .sort((a, b) => new Date(b.decision_date) - new Date(a.decision_date))[0];
                    tanggal_pemusnahan = formatDate(latestVerification.decision_date);
                }
            }

            // Create row for each detail limbah
            const details = permohonan.DetailLimbahs || [];
            
            if (details.length > 0) {
                details.forEach(detail => {
                    dataRows.push({
                        ...detail.toJSON(),
                        nomor_permohonan: permohonan.nomor_permohonan,
                        bagian: permohonan.bagian,
                        tanggal_pengajuan: formatDate(permohonan.created_at),
                        tanggal_pemusnahan: tanggal_pemusnahan,
                        bentuk_limbah: permohonan.bentuk_limbah,
                        golongan_limbah: permohonan.GolonganLimbah?.nama || 'N/A',
                        jenis_limbah: permohonan.JenisLimbahB3?.nama || 'N/A',
                        is_produk_pangan: permohonan.is_produk_pangan ? 'Ya' : 'Tidak',
                        bobot: parseFloat(detail.bobot || 0),
                        status: permohonan.status || 'N/A'
                    });
                });
            } else {
                // Add row even if no details (for tracking purposes)
                dataRows.push({
                    nomor_permohonan: permohonan.nomor_permohonan,
                    bagian: permohonan.bagian,
                    tanggal_pengajuan: formatDate(permohonan.created_at),
                    tanggal_pemusnahan: tanggal_pemusnahan,
                    bentuk_limbah: permohonan.bentuk_limbah,
                    golongan_limbah: permohonan.GolonganLimbah?.nama || 'N/A',
                    jenis_limbah: permohonan.JenisLimbahB3?.nama || 'N/A',
                    is_produk_pangan: permohonan.is_produk_pangan ? 'Ya' : 'Tidak',
                    status: permohonan.status || 'N/A'
                });
            }
        });

        worksheet.addRows(dataRows);

        // --- Set response headers and send file ---
        res.setHeader(
            'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition', `attachment; filename="lampiran-permohonan-${start_date}_to_${end_date}.xlsx"`
        );

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error("Error generating permohonan range Excel file:", error);
        res.status(500).json({ 
            message: "An error occurred during Excel file generation.", 
            error: error.message 
        });
    }
};

module.exports = {
    getPermohonanDataForDoc,
    getBeritaAcaraDataForDoc,
    generatePermohonanExcel,
    generateLogbookExcel,
    downloadPermohonanByDateRangeExcel
};