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

/**
 * Helper function to fetch Inisial_Name from external API
 * @param {string} userId - The user ID (NIK)
 * @returns {Promise<string>} - The Inisial_Name or userId if not found
 */
const getInisialName = async (userId) => {
    if (!userId) return '';
    
    try {
        const EXTERNAL_APPROVAL_URL = process.env.EXTERNAL_APPROVAL_URL || 'http://192.168.1.38/api/global-dev/v1/custom/list-approval-magang';
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

        // Options for formatting the time (e.g., "10:11")
        const timeOptions = { 
            hour: '2-digit', 
            minute: '2-digit', 
            hour12: false,
            timeZone: 'Asia/Jakarta'
        };
        const jam_waktu = new Intl.DateTimeFormat('id-ID', timeOptions).format(latestSigningTimestamp);
        

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
        const { start_date, end_date } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ 
                message: 'start_date and end_date query parameters are required (format: YYYY-MM-DD)' 
            });
        }

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
        const allPermohonanData = await PermohonanPemusnahanLimbah.findAll({
            where: {
                status: 'Completed'
            },
            include: [
                { model: DetailLimbah },
                { model: GolonganLimbah },
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

        // --- Group permohonan by jenis limbah ---
        const groupedData = {};
        
        permohonanData.forEach(permohonan => {
            const jenisLimbah = permohonan.JenisLimbahB3?.nama || 'Tidak Diketahui';
            
            if (!groupedData[jenisLimbah]) {
                groupedData[jenisLimbah] = [];
            }
            
            const bobotTotal = permohonan.DetailLimbahs?.reduce((sum, detail) => {
                return sum + (parseFloat(detail.bobot || 0) / 1000);
            }, 0) || 0;
            
            groupedData[jenisLimbah].push({
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

        Object.keys(groupedData).forEach((jenisLimbah) => {
            const data = groupedData[jenisLimbah];
            
            // Extract jenis limbah name without kode for sheet name
            let sheetDisplayName = jenisLimbah;
            const sheetKodeMatch = jenisLimbah.match(/^([A-B]\d{3}d?-?\d*)\s+(.+)$/);
            if (sheetKodeMatch) {
                sheetDisplayName = sheetKodeMatch[2]; // Use the name part without kode
            } else {
                const sheetFallbackMatch = jenisLimbah.match(/^([A-B]\d{2,3}[a-z]?-?\d*)\s+(.+)$/);
                if (sheetFallbackMatch) {
                    sheetDisplayName = sheetFallbackMatch[2];
                }
            }
            
            // Create worksheet for this jenis limbah (sanitize sheet name)
            const sanitizedSheetName = sheetDisplayName.replace(/[\\\/\[\]:\*\?]/g, '').substring(0, 31);
            const worksheet = workbook.addWorksheet(sanitizedSheetName);
            
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
            let kode = '';
            let jenisLimbahName = jenisLimbah;
            
            // Check if jenisLimbah contains a kode pattern (like "A336-1" at the beginning)
            const kodeMatch = jenisLimbah.match(/^([A-B]\d{3}d?-?\d*)\s+(.+)$/);
            if (kodeMatch) {
                kode = kodeMatch[1]; // Extract the kode part
                jenisLimbahName = kodeMatch[2]; // Extract the name part
            } else {
                // Fallback: try to extract any pattern with letters, numbers, and dash at the beginning
                const fallbackMatch = jenisLimbah.match(/^([A-B]\d{2,3}[a-z]?-?\d*)\s+(.+)$/);
                if (fallbackMatch) {
                    kode = fallbackMatch[1];
                    jenisLimbahName = fallbackMatch[2];
                } else {
                    // If no pattern found, use the original jenisLimbah as name and generate a simple kode
                    kode = `B${100 + sheetIndex}d`;
                    jenisLimbahName = jenisLimbah;
                }
            }

            // Add to total data
            totalData.push({
                no: sheetIndex,
                jenis_limbah: jenisLimbahName, // Use the extracted name without kode
                kode: kode, // Use the extracted kode
                bobot: jenisBobot
            });

            sheetIndex++;
        });

        // --- Create Total sheet ---
        const totalWorksheet = workbook.addWorksheet('Total');
        
        // Add title row for Total sheet
        totalWorksheet.mergeCells('A1:D1'); // Merge cells for title (4 columns total)
        const totalTitleCell = totalWorksheet.getCell('A1');
        totalTitleCell.value = 'Logbook Total Limbah B3';
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
            const emptyWorksheet = workbook.addWorksheet('Total');
            
            // Add title row for empty sheet
            emptyWorksheet.mergeCells('A1:D1');
            const emptyTitleCell = emptyWorksheet.getCell('A1');
            emptyTitleCell.value = 'Logbook Total Limbah B3';
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
        const filename = `logbook-limbah-b3-${startDateFormatted}-${endDateFormatted}.xlsx`;
        
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
 * NEW FUNCTION
 * GET /api/document-generation/permohonan/range/excel?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * Generates an Excel file with details of all permohonan within a date range (tanggal_pengajuan).
 * Filter by bagian: KL users can download all, others can only download their own bagian.
 */
const downloadPermohonanByDateRangeExcel = async (req, res) => {
    try {
        const { start_date, end_date } = req.query;

        if (!start_date || !end_date) {
            return res.status(400).json({ 
                message: 'start_date and end_date query parameters are required (format: YYYY-MM-DD)' 
            });
        }

        // Get user info from auth middleware
        // Prefer delegatedUser if exists (when user is acting on behalf of another user)
        const activeUser = req.delegatedUser || req.user;
        const userBagian = activeUser?.emp_DeptID;
        
        if (!userBagian) {
            return res.status(401).json({ 
                message: 'User bagian information not found' 
            });
        }

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

        // --- Build where clause based on user bagian ---
        const whereClause = {
            created_at: {
                [require('sequelize').Op.between]: [startDate, endDate]
            }
        };
        
        // If user bagian is not 'KL', filter by user's bagian
        if (userBagian !== 'KL') {
            whereClause.bagian = userBagian;
        }
        // If user bagian is 'KL', no bagian filter - download all

        // --- Get permohonan data filtered by tanggal_pengajuan range and bagian ---
        const permohonanList = await PermohonanPemusnahanLimbah.findAll({
            where: whereClause,
            include: [
                { model: DetailLimbah },
                { model: GolonganLimbah },
                { model: JenisLimbahB3 },
                { 
                    model: ApprovalHistory,
                    include: [{ model: ApprovalWorkflowStep }],
                    required: false
                }
            ],
            order: [['created_at', 'DESC']]
        });

        if (!permohonanList || permohonanList.length === 0) {
            return res.status(404).json({ 
                message: 'No permohonan found in the specified date range' 
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
            { header: 'Alasan Pemusnahan', key: 'alasan_pemusnahan', width: 28 }
        ];
        
        worksheet.getRow(1).eachCell(cell => {
            cell.style = headerStyle;
        });

        // --- Process each permohonan and add rows ---
        const dataRows = [];
        
        permohonanList.forEach(permohonan => {
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
                        bobot: parseFloat(detail.bobot || 0)
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
                    is_produk_pangan: permohonan.is_produk_pangan ? 'Ya' : 'Tidak'
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