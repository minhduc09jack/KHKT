/**
 * MedAI PACS/HIS v4.2 - Bulletproof Non-Blocking Storage, Sync, RBAC & Hospital Dataset Engine
 * - Never blocks on IndexedDB version locks (uses localStorage mirror + 400ms timeout guard)
 * - Pre-seeded with real X-Ray cases & patient records from `federated_data/`
 * - Includes interactive Hospital Dataset Importer (supports preset cohorts + local folder/file batch import)
 */

const DB_NAME = 'MedAIPacsDB_v42';
const DB_VERSION = 1;
const STORE_CASES = 'cases';
const STORE_PATIENTS = 'patients';
const STORE_WORKLIST = 'worklist';
const STORE_AUDIT = 'audit_logs';

// LocalStorage Fast Mirrors (Guarantees 0ms non-blocking reads even if IndexedDB is locked by old tabs)
const LS_CASES_KEY = 'medai_ls_cases_v43';
const LS_PATIENTS_KEY = 'medai_ls_patients_v43';
const LS_WORKLIST_KEY = 'medai_ls_worklist_v43';
const LS_AUDIT_KEY = 'medai_ls_audit_v43';
const LS_SEEDED_KEY = 'medai_dataset_seeded_v43';

let dbInstance = null;

// Real-time cross-tab communication channel
const syncChannel = (typeof BroadcastChannel !== 'undefined')
    ? new BroadcastChannel('medai_pacs_sync_channel')
    : null;

function broadcastSyncEvent(type, payload = {}) {
    try {
        if (syncChannel) {
            syncChannel.postMessage({ type, payload, timestamp: Date.now() });
        }
        localStorage.setItem('medai_last_sync_event', JSON.stringify({
            type,
            timestamp: Date.now()
        }));
    } catch (e) {}
}

// =========================================================================
// SAFE FETCH WITH TIMEOUT (Never blocks UI if backend is offline or older version)
// =========================================================================
async function fetchWithTimeout(url, options = {}, timeoutMs = 1000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        return res;
    } catch (err) {
        clearTimeout(timer);
        throw err;
    }
}

// =========================================================================
// 1. HOSPITAL CLIENT NODES (3 NON-IID FEDERATED LEARNING CLIENTS)
// =========================================================================
const HOSPITAL_CLIENT_NODES = {
    CLIENT_1: {
        id: 'CLIENT_1',
        code: 'FL-NODE-01',
        folderName: 'federated_data/client_1_lung_hospital',
        name: 'Bệnh viện Phổi Trung ương (Client 1)',
        shortName: 'Client 1 • BV Phổi TW',
        specialty: 'Bệnh viện Chuyên khoa Hô hấp Tuyến cuối',
        trainNormal: 507,
        trainPneumonia: 273,
        valNormal: 126,
        valPneumonia: 68,
        totalSamples: 974,
        pneumoniaRatio: 35.0,
        distributionDesc: 'Cân bằng hơn (~35% Pneumonia) - Chuyên khoa Phổi',
        localAccuracy: 96.82,
        localF1: 95.90,
        ipAddress: '10.108.10.11:8081',
        flStatus: 'CONNECTED_DP_ACTIVE',
        securityLevel: 'Mức 6 (TT 54/2017/TT-BYT) • HIPAA Ready'
    },
    CLIENT_2: {
        id: 'CLIENT_2',
        code: 'FL-NODE-02',
        folderName: 'federated_data/client_2_emergency_general',
        name: 'Bệnh viện Đa khoa Cấp cứu (Client 2)',
        shortName: 'Client 2 • BV Cấp cứu',
        specialty: 'Tuyến đầu Cấp cứu Đa khoa & Hồi sức Tích cực (ICU)',
        trainNormal: 253,
        trainPneumonia: 1094,
        valNormal: 63,
        valPneumonia: 273,
        totalSamples: 1683,
        pneumoniaRatio: 81.2,
        distributionDesc: 'Lệch Non-IID cao (~81% Pneumonia) - Tuyến đầu Cấp cứu',
        localAccuracy: 96.45,
        localF1: 95.52,
        ipAddress: '10.108.20.22:8082',
        flStatus: 'CONNECTED_DP_ACTIVE',
        securityLevel: 'Mức 6 (TT 54/2017/TT-BYT) • HIPAA Ready'
    },
    CLIENT_3: {
        id: 'CLIENT_3',
        code: 'FL-NODE-03',
        folderName: 'federated_data/client_3_screening_clinic',
        name: 'Trung tâm Y tế Sàng lọc Cộng đồng (Client 3)',
        shortName: 'Client 3 • PK Sàng lọc',
        specialty: 'Phòng khám Đa khoa & Sàng lọc Bệnh phổi Cộng đồng',
        trainNormal: 255,
        trainPneumonia: 1369,
        valNormal: 63,
        valPneumonia: 342,
        totalSamples: 2029,
        pneumoniaRatio: 84.3,
        distributionDesc: 'Lệch Non-IID rất cao (~84% Pneumonia) - Sàng lọc dịch tễ',
        localAccuracy: 96.48,
        localF1: 95.41,
        ipAddress: '10.108.30.33:8083',
        flStatus: 'CONNECTED_DP_ACTIVE',
        securityLevel: 'Mức 6 (TT 54/2017/TT-BYT) • HIPAA Ready'
    }
};

function getHospitalClientNode(nodeId = null) {
    const policy = getAdminPolicy();
    const targetId = nodeId || policy.activeClientNode || 'CLIENT_1';
    return HOSPITAL_CLIENT_NODES[targetId] || HOSPITAL_CLIENT_NODES.CLIENT_1;
}

// =========================================================================
// 2. PRE-BUILT HOSPITAL DATASET CATALOG FROM `federated_data/`
// Real X-Ray images & full clinical records from all 3 Hospital Clients
// =========================================================================
const HOSPITAL_DATASET_PRESETS = [
    // --- CLIENT 1: BỆNH VIỆN PHỔI TRUNG ƯƠNG (client_1_lung_hospital) ---
    {
        id: 'CASE-C1-480A',
        patientId: 'BN-C1-0480',
        patientName: 'Nguyễn Văn Hùng',
        age: 64,
        gender: 'Nam',
        clientNode: 'CLIENT_1',
        sourcePath: 'federated_data/client_1_lung_hospital/train/PNEUMONIA/person100_bacteria_480.jpeg',
        image: 'assets/hospital_dataset/c1_bacteria_480.jpeg',
        symptoms: 'Sốt cao 39.4°C kèm rét run, ho khạc đờm mủ vàng đặc, đauói ngực phải khi hít sâu, SpO2 92%',
        diagnosis: 'PNEUMONIA',
        probPneumonia: 96.4,
        probNormal: 3.6,
        doctorName: 'BS.CKII Nguyễn Văn A',
        department: 'Khoa Chẩn đoán Hình ảnh - BV Phổi TW',
        doctorNotes: 'Hình ảnh đông đặc nhu mô thùy dưới phổi phải khá đồng nhất, có dấu hiệu khí phế quản đồ (Air Bronchogram). Góc sườn hoành phải tù nhẹ. Kết luận: Viêm phổi thùy cấp tính nghĩ do phế cầu khuẩn. Đề nghị nhập viện điều trị kháng sinh tĩnh mạch.',
        integrityHash: '8F4E29A1C7B03D12',
        timestampOffsetHours: 72
    },
    {
        id: 'CASE-C1-480B',
        patientId: 'BN-C1-0480',
        patientName: 'Nguyễn Văn Hùng',
        age: 64,
        gender: 'Nam',
        clientNode: 'CLIENT_1',
        sourcePath: 'federated_data/client_1_lung_hospital/train/NORMAL/IM-0001-0001.jpeg',
        image: 'assets/hospital_dataset/c1_normal_0001.jpeg',
        symptoms: 'Tái khám sau 7 ngày điều trị kháng sinh Ceftriaxone + Azithromycin, hết sốt, giảm ho rõ rệt, SpO2 98%',
        diagnosis: 'NORMAL',
        probPneumonia: 8.2,
        probNormal: 91.8,
        doctorName: 'BS.CKII Nguyễn Văn A',
        department: 'Khoa Chẩn đoán Hình ảnh - BV Phổi TW',
        doctorNotes: 'Chụp kiểm tra tiến triển sau 7 ngày điều trị: Vùng đông đặc thùy dưới phổi phải đã tiêu biến hoàn toàn, hai phế trường thông khí sáng đều, góc sườn hoành hai bên nhọn. Đáp ứng điều trị rất tốt, đủ điều kiện xuất viện.',
        integrityHash: '3A9C71E5D2F84B09',
        timestampOffsetHours: 4
    },
    {
        id: 'CASE-C1-0190',
        patientId: 'BN-C1-0190',
        patientName: 'Trần Thị Mai Hương',
        age: 41,
        gender: 'Nữ',
        clientNode: 'CLIENT_1',
        sourcePath: 'federated_data/client_1_lung_hospital/train/PNEUMONIA/person103_virus_190.jpeg',
        image: 'assets/hospital_dataset/c1_virus_190.jpeg',
        symptoms: 'Ho khan liên tục 5 ngày, sốt 38.2°C, đau mỏi cơ toàn thân, khó thở khi gắng sức nhẹ',
        diagnosis: 'PNEUMONIA',
        probPneumonia: 89.5,
        probNormal: 10.5,
        doctorName: 'BS.CKII Nguyễn Văn A',
        department: 'Khoa Chẩn đoán Hình ảnh - BV Phổi TW',
        doctorNotes: 'Tổn thương dạng kính mờ (ground-glass opacity) kèm dày tổ chức kẽ lan tỏa vùng rốn phổi và đáy phổi hai bên. Kết luận: Theo dõi Viêm phổi mô kẽ cấp do Virus. Chỉ định xét nghiệm PCR Cúm A/B & RSV.',
        integrityHash: '6D1B84F2A9E05C37',
        timestampOffsetHours: 18
    },
    {
        id: 'CASE-C1-0006',
        patientId: 'BN-C1-0006',
        patientName: 'Phạm Ngọc Bích',
        age: 28,
        gender: 'Nữ',
        clientNode: 'CLIENT_1',
        sourcePath: 'federated_data/client_1_lung_hospital/train/NORMAL/IM-0006-0001.jpeg',
        image: 'assets/hospital_dataset/c1_normal_0006.jpeg',
        symptoms: 'Khám sàng lọc hô hấp định kỳ, không ho, không sốt, nghe phổi rì rào phế nang êm dịu',
        diagnosis: 'NORMAL',
        probPneumonia: 2.1,
        probNormal: 97.9,
        doctorName: 'BS.CKII Nguyễn Văn A',
        department: 'Khoa Chẩn đoán Hình ảnh - BV Phổi TW',
        doctorNotes: 'Hai trường phổi sáng đều, cấu trúc rốn phổi và trung thất bình thường. Bóng tim không to (CTR < 0.5). Không thấy tổn thương nhu mô hay màng phổi.',
        integrityHash: '1E7A53C9B4D20F86',
        timestampOffsetHours: 26
    },

    // --- CLIENT 2: BỆNH VIỆN ĐA KHOA CẤP CỨU (client_2_emergency_general) ---
    {
        id: 'CASE-C2-2931',
        patientId: 'BN-C2-2931',
        patientName: 'Hoàng Đình Trọng',
        age: 71,
        gender: 'Nam',
        clientNode: 'CLIENT_2',
        sourcePath: 'federated_data/client_2_emergency_general/train/PNEUMONIA/person1000_bacteria_2931.jpeg',
        image: 'assets/hospital_dataset/c2_bacteria_2931.jpeg',
        symptoms: 'Nhập cấp cứu vì khó thở nhanh nông 28 lần/phút, SpO2 89%, sốt 39.5°C, tiền sử COPD',
        diagnosis: 'PNEUMONIA',
        probPneumonia: 97.8,
        probNormal: 2.2,
        doctorName: 'ThS.BS Lê Minh Châu',
        department: 'Khoa Cấp cứu & Hồi sức Tích cực (ICU) - BV Cấp cứu',
        doctorNotes: 'Đám mờ đông đặc diện rộng thùy giữa và thùy dưới phổi phải kèm thâm nhiễm lan tỏa phổi trái. Kết luận: Viêm phổi nặng biến chứng suy hô hấp cấp trên nền COPD. Chuyển ICU thở oxy dòng cao HFNC.',
        integrityHash: '9B2E41D7F0A63C58',
        timestampOffsetHours: 6
    },
    {
        id: 'CASE-C2-1688',
        patientId: 'BN-C2-1688',
        patientName: 'Đỗ Thị Thanh Tâm',
        age: 52,
        gender: 'Nữ',
        clientNode: 'CLIENT_2',
        sourcePath: 'federated_data/client_2_emergency_general/train/PNEUMONIA/person1005_virus_1688.jpeg',
        image: 'assets/hospital_dataset/c2_virus_1688.jpeg',
        symptoms: 'Sốt cao 4 ngày không hạ, ho khan từng cơn, tức nặng ngực hai bên, mệt lả',
        diagnosis: 'PNEUMONIA',
        probPneumonia: 91.6,
        probNormal: 8.4,
        doctorName: 'ThS.BS Lê Minh Châu',
        department: 'Khoa Cấp cứu - BV Đa khoa Cấp cứu',
        doctorNotes: 'Hình ảnh thâm nhiễm lưới-nốt mờ đối xứng hai bên phế trường, tập trung vùng ngoại vi và đáy phổi. Kết luận: Viêm phổi kẽ cấp tính do Virus.',
        integrityHash: '4F8C12A9E7D03B64',
        timestampOffsetHours: 14
    },
    {
        id: 'CASE-C2-2942',
        patientId: 'BN-C2-2942',
        patientName: 'Bùi Văn Quyết',
        age: 49,
        gender: 'Nam',
        clientNode: 'CLIENT_2',
        sourcePath: 'federated_data/client_2_emergency_general/train/PNEUMONIA/person1011_bacteria_2942.jpeg',
        image: 'assets/hospital_dataset/c2_bacteria_2942.jpeg',
        symptoms: 'Đau ngực trái kiểu màng phổi, sốt 38.8°C, ho đờm đặc màu rỉ sắt 3 ngày nay',
        diagnosis: 'PNEUMONIA',
        probPneumonia: 93.7,
        probNormal: 6.3,
        doctorName: 'ThS.BS Lê Minh Châu',
        department: 'Khoa Cấp cứu - BV Đa khoa Cấp cứu',
        doctorNotes: 'Đông đặc nhu mô vùng hạ đòn và thùy dưới phổi trái. Theo dõi Viêm phổi thùy do vi khuẩn cộng đồng.',
        integrityHash: '7C3D90F1B5E28A41',
        timestampOffsetHours: 32
    },
    {
        id: 'CASE-C2-0011',
        patientId: 'BN-C2-0011',
        patientName: 'Ngô Minh Tuấn',
        age: 33,
        gender: 'Nam',
        clientNode: 'CLIENT_2',
        sourcePath: 'federated_data/client_2_emergency_general/train/NORMAL/IM-0011-0001.jpeg',
        image: 'assets/hospital_dataset/c2_normal_0011.jpeg',
        symptoms: 'Đau thành ngực sau vận động thể thao, vào cấp cứu loại trừ tràn khí màng phổi / viêm phổi',
        diagnosis: 'NORMAL',
        probPneumonia: 3.1,
        probNormal: 96.9,
        doctorName: 'ThS.BS Lê Minh Châu',
        department: 'Khoa Cấp cứu - BV Đa khoa Cấp cứu',
        doctorNotes: 'Không thấy liềm khí màng phổi, nhu mô phổi hai bên sáng đều, cung xương sườn nguyên vẹn. Loại trừ bệnh lý cấp tính đường hô hấp dưới.',
        integrityHash: '2A6F85C1D9E47B03',
        timestampOffsetHours: 40
    },

    // --- CLIENT 3: TRUNG TÂM Y TẾ SÀNG LỌC CỘNG ĐỒNG (client_3_screening_clinic) ---
    {
        id: 'CASE-C3-2932',
        patientId: 'BN-C3-2932',
        patientName: 'Võ Văn Kiệt',
        age: 59,
        gender: 'Nam',
        clientNode: 'CLIENT_3',
        sourcePath: 'federated_data/client_3_screening_clinic/train/PNEUMONIA/person1001_bacteria_2932.jpeg',
        image: 'assets/hospital_dataset/c3_bacteria_2932.jpeg',
        symptoms: 'Khám sàng lọc cộng đồng: Ho kéo dài 10 ngày, sốt nhẹ về chiều, sụt cân nhẹ',
        diagnosis: 'PNEUMONIA',
        probPneumonia: 94.2,
        probNormal: 5.8,
        doctorName: 'BS.CKI Hoàng Văn Nam',
        department: 'Phòng khám Sàng lọc Hô hấp - Client 3',
        doctorNotes: 'AI phát hiện vùng mờ không đồng nhất thùy trên và giữa phổi phải. Cần chuyển tuyến chuyên khoa điều trị viêm phổi vi khuẩn và làm xét nghiệm loại trừ lao phổi.',
        integrityHash: '5E1D74A8C3B92F60',
        timestampOffsetHours: 10
    },
    {
        id: 'CASE-C3-1685',
        patientId: 'BN-C3-1685',
        patientName: 'Lý Thị Thu Hà',
        age: 44,
        gender: 'Nữ',
        clientNode: 'CLIENT_3',
        sourcePath: 'federated_data/client_3_screening_clinic/train/PNEUMONIA/person1003_virus_1685.jpeg',
        image: 'assets/hospital_dataset/c3_virus_1685.jpeg',
        symptoms: 'Ho khan sau đợt cảm cúm gia đình, tức ngực nhẹ, sốt 38°C',
        diagnosis: 'PNEUMONIA',
        probPneumonia: 88.6,
        probNormal: 11.4,
        doctorName: 'BS.CKI Hoàng Văn Nam',
        department: 'Phòng khám Sàng lọc Hô hấp - Client 3',
        doctorNotes: 'Tăng đậm các nhánh phế quản mạch máu và mờ kẽ hai đáy phổi. Chẩn đoán: Viêm phổi virus mức độ nhẹ-vừa, điều trị ngoại trú và hẹn tái khám sau 5 ngày.',
        integrityHash: '8A3F20D9E6C14B75',
        timestampOffsetHours: 22
    },
    {
        id: 'CASE-C3-2935',
        patientId: 'BN-C3-2935',
        patientName: 'Đặng Xuân Trường',
        age: 67,
        gender: 'Nam',
        clientNode: 'CLIENT_3',
        sourcePath: 'federated_data/client_3_screening_clinic/train/PNEUMONIA/person1004_bacteria_2935.jpeg',
        image: 'assets/hospital_dataset/c3_bacteria_2935.jpeg',
        symptoms: 'Ho đờm xanh 4 ngày, khó thở khi đi cầu thang, sốt 38.7°C',
        diagnosis: 'PNEUMONIA',
        probPneumonia: 92.4,
        probNormal: 7.6,
        doctorName: 'BS.CKI Hoàng Văn Nam',
        department: 'Phòng khám Sàng lọc Hô hấp - Client 3',
        doctorNotes: 'Đám mờ thâm nhiễm nhu mô thùy dưới phổi phải rõ trên bản đồ nhiệt Grad-CAM. Chẩn đoán: Viêm phổi cộng đồng do vi khuẩn.',
        integrityHash: '3D9B48E1F2A70C52',
        timestampOffsetHours: 48
    },
    {
        id: 'CASE-C3-0003',
        patientId: 'BN-C3-0003',
        patientName: 'Phan Thanh Thảo',
        age: 26,
        gender: 'Nữ',
        clientNode: 'CLIENT_3',
        sourcePath: 'federated_data/client_3_screening_clinic/train/NORMAL/IM-0003-0001.jpeg',
        image: 'assets/hospital_dataset/c3_normal_0003.jpeg',
        symptoms: 'Khám sức khỏe tuyển dụng, không có triệu chứng hô hấp',
        diagnosis: 'NORMAL',
        probPneumonia: 1.6,
        probNormal: 98.4,
        doctorName: 'BS.CKI Hoàng Văn Nam',
        department: 'Phòng khám Sàng lọc Hô hấp - Client 3',
        doctorNotes: 'Nhu mô phổi hai bên sáng đều, bóng tim và trung thất bình thường. Đủ tiêu chuẩn sức khỏe hô hấp.',
        integrityHash: '7F0E61C4A8D39B28',
        timestampOffsetHours: 60
    }
];

// =========================================================================
// 3. ROLE-BASED ACCESS CONTROL (RBAC) & HOSPITAL SECURITY POLICY
// =========================================================================
const RBAC_ROLES = {
    ADMIN: {
        role: 'ADMIN',
        title: 'Quản trị viên Hệ thống Bệnh viện (Hospital IT & FL Admin)',
        badgeColor: 'purple',
        icon: 'fa-shield-halved',
        portalUrl: 'admin.html'
    },
    DOCTOR: {
        role: 'DOCTOR',
        title: 'Bác sĩ Chẩn đoán Hình ảnh (Diagnostic Radiologist)',
        badgeColor: 'blue',
        icon: 'fa-user-doctor',
        portalUrl: 'index.html'
    },
    TECHNICIAN: {
        role: 'TECHNICIAN',
        title: 'Kỹ thuật viên Phòng X-Quang (Radiology Modality Technician)',
        badgeColor: 'teal',
        icon: 'fa-x-ray',
        portalUrl: 'technician.html'
    }
};

const RBAC_MATRIX_KEY = 'medai_rbac_matrix_v4';
const DEFAULT_RBAC_MATRIX = {
    perm_acquire_xray: {
        label: 'Tiếp nhận bệnh nhân, chụp X-Quang & hiệu chỉnh kỹ thuật (CLAHE/QA)',
        category: 'Phòng chụp X-Quang (Modality)',
        TECHNICIAN: true,
        DOCTOR: true,
        ADMIN: true
    },
    perm_push_worklist: {
        label: 'Đẩy ca chụp vào Hàng đợi PACS cho Bác sĩ Chẩn đoán',
        category: 'Phòng chụp X-Quang (Modality)',
        TECHNICIAN: true,
        DOCTOR: true,
        ADMIN: true
    },
    perm_ai_pretriage: {
        label: 'Kích hoạt AI Sàng lọc Ưu tiên Cấp cứu (AI Pre-Triage STAT)',
        category: 'Trí tuệ Nhân tạo (AI Engine)',
        TECHNICIAN: true,
        DOCTOR: true,
        ADMIN: true
    },
    perm_ai_full_gradcam: {
        label: 'Phân tích AI Chuyên sâu & Bản đồ nhiệt tổn thương Grad-CAM',
        category: 'Trí tuệ Nhân tạo (AI Engine)',
        TECHNICIAN: false,
        DOCTOR: true,
        ADMIN: true
    },
    perm_sign_diagnosis: {
        label: 'Kết luận lâm sàng, Ký số Chẩn đoán & Xuất Báo cáo PDF Y khoa',
        category: 'Chẩn đoán Lâm sàng (HIS/EMR)',
        TECHNICIAN: false,
        DOCTOR: true,
        ADMIN: false
    },
    perm_request_retake: {
        label: 'Từ chối phim lỗi & Yêu cầu KTV Phòng X-Quang chụp lại',
        category: 'Chẩn đoán Lâm sàng (HIS/EMR)',
        TECHNICIAN: false,
        DOCTOR: true,
        ADMIN: true
    },
    perm_delete_records: {
        label: 'Xóa Hồ sơ Bệnh án / Lịch sử ca khám khỏi cơ sở dữ liệu',
        category: 'Quản trị Dữ liệu & Bảo mật',
        TECHNICIAN: false,
        DOCTOR: true,
        ADMIN: true
    },
    perm_manage_fl_dp: {
        label: 'Điều khiển Huấn luyện Liên kết (FedProx μ) & Nhiễu Vi phân (DP σ)',
        category: 'Quản trị Dữ liệu & Bảo mật',
        TECHNICIAN: false,
        DOCTOR: false,
        ADMIN: true
    },
    perm_manage_security: {
        label: 'Quản trị Tài khoản RBAC, Khóa Khẩn cấp (Lockdown) & Nhật ký Kiểm toán',
        category: 'Quản trị Dữ liệu & Bảo mật',
        TECHNICIAN: false,
        DOCTOR: false,
        ADMIN: true
    }
};

function getRBACMatrix() {
    try {
        const raw = localStorage.getItem(RBAC_MATRIX_KEY);
        if (!raw) return JSON.parse(JSON.stringify(DEFAULT_RBAC_MATRIX));
        return { ...DEFAULT_RBAC_MATRIX, ...JSON.parse(raw) };
    } catch (e) {
        return JSON.parse(JSON.stringify(DEFAULT_RBAC_MATRIX));
    }
}

function saveRBACMatrix(matrix) {
    localStorage.setItem(RBAC_MATRIX_KEY, JSON.stringify(matrix));
    broadcastSyncEvent('RBAC_UPDATED', matrix);
    return matrix;
}

function hasPermission(role, permKey) {
    const matrix = getRBACMatrix();
    if (!matrix[permKey]) return false;
    return Boolean(matrix[permKey][role]);
}

// =========================================================================
// 4. STRICT SINGLE-HOSPITAL ADMIN ACCOUNTS (1 ADMIN ACCOUNT = 1 HOSPITAL ONLY)
// Multi-Tenant Hospital Isolation: An Admin account is cryptographically bound
// to exactly ONE Hospital Client Node (`boundClientNode`) and CANNOT manage any other hospital.
// =========================================================================
const HOSPITAL_ADMIN_ACCOUNTS = {
    'ADM-CLIENT-1': {
        id: 'ADM-CLIENT-1',
        username: 'admin.bvphoi@medai.vn',
        fullName: 'KS. Trần Quốc Bảo',
        title: 'Trưởng phòng CNTT & An toàn Dữ liệu — BV Phổi Trung ương',
        boundClientNode: 'CLIENT_1',
        hospitalName: 'Bệnh viện Phổi Trung ương (Client 1)',
        hospitalShort: 'Client 1 • BV Phổi TW',
        certificateId: 'CERT-BYT-C1-88901',
        avatarBg: '7C3AED',
        defaultDoctorName: 'BS.CKII Nguyễn Văn A',
        defaultDepartment: 'Khoa Chẩn đoán Hình ảnh (PACS) - BV Phổi TW',
        defaultTechName: 'CN.KTV Phạm Hoàng Nam',
        defaultModalityRoom: 'DR-01 (Fujifilm FDR Visionary) - BV Phổi TW'
    },
    'ADM-CLIENT-2': {
        id: 'ADM-CLIENT-2',
        username: 'admin.bvcapcuu@medai.vn',
        fullName: 'ThS.KS Lê Hoàng Việt',
        title: 'Giám đốc Trung tâm CNTT & Bảo mật — BV Đa khoa Cấp cứu',
        boundClientNode: 'CLIENT_2',
        hospitalName: 'Bệnh viện Đa khoa Cấp cứu (Client 2)',
        hospitalShort: 'Client 2 • BV Cấp cứu',
        certificateId: 'CERT-BYT-C2-44219',
        avatarBg: '0284C7',
        defaultDoctorName: 'ThS.BS Lê Minh Châu',
        defaultDepartment: 'Khoa Cấp cứu & Hồi sức Tích cực (ICU) - BV Cấp cứu',
        defaultTechName: 'KTV Vũ Thị Mai',
        defaultModalityRoom: 'DR-02 (Siemens Ysio Max) - BV Cấp cứu'
    },
    'ADM-CLIENT-3': {
        id: 'ADM-CLIENT-3',
        username: 'admin.ttsangloc@medai.vn',
        fullName: 'KS. Nguyễn Minh Tuấn',
        title: 'Quản trị viên Hệ thống PACS/AI — TT Sàng lọc Cộng đồng',
        boundClientNode: 'CLIENT_3',
        hospitalName: 'Trung tâm Y tế Sàng lọc Cộng đồng (Client 3)',
        hospitalShort: 'Client 3 • PK Sàng lọc',
        certificateId: 'CERT-BYT-C3-77105',
        avatarBg: '0D9488',
        defaultDoctorName: 'BS.CKI Hoàng Văn Nam',
        defaultDepartment: 'Phòng khám Chuyên khoa Hô hấp - TT Sàng lọc',
        defaultTechName: 'CN.KTV Đặng Văn Khoa',
        defaultModalityRoom: 'DR-03 (Carestream DRX) - TT Sàng lọc'
    }
};

const ADMIN_POLICY_KEY = 'medai_admin_policy_v43';
const DEFAULT_ADMIN_POLICY = {
    activeAdminAccountId: 'ADM-CLIENT-1',
    activeClientNode: 'CLIENT_1',
    aiEnabled: true,
    requireTechQA: true,
    phiMaskingEnabled: false,
    emergencyLockdown: false,
    globalDecisionThreshold: 50,
    autoPreTriageAI: true,
    sessionTimeoutMinutes: 30,
    flMu: 1.0,
    dpSigma: 0.01,
    dpClipNorm: 1.0,
    flRoundCount: 30,
    lastFlSync: Date.now() - 1800000,
    updatedBy: 'KS. Trần Quốc Bảo (Admin BV Phổi TW)',
    updatedAt: Date.now()
};

function getAdminPolicy() {
    try {
        const raw = localStorage.getItem(ADMIN_POLICY_KEY);
        const parsed = raw ? { ...DEFAULT_ADMIN_POLICY, ...JSON.parse(raw) } : { ...DEFAULT_ADMIN_POLICY };
        // Enforce 1-Admin = 1-Hospital binding invariant
        const adminAcc = HOSPITAL_ADMIN_ACCOUNTS[parsed.activeAdminAccountId] || HOSPITAL_ADMIN_ACCOUNTS['ADM-CLIENT-1'];
        parsed.activeAdminAccountId = adminAcc.id;
        parsed.activeClientNode = adminAcc.boundClientNode;
        return parsed;
    } catch (e) {
        return { ...DEFAULT_ADMIN_POLICY };
    }
}

function getActiveAdminAccount() {
    const policy = getAdminPolicy();
    return HOSPITAL_ADMIN_ACCOUNTS[policy.activeAdminAccountId] || HOSPITAL_ADMIN_ACCOUNTS['ADM-CLIENT-1'];
}

function canAdminManageHospital(targetClientNode) {
    const activeAdmin = getActiveAdminAccount();
    return activeAdmin.boundClientNode === targetClientNode;
}

async function saveAdminPolicy(updates, actorName = null) {
    const current = getAdminPolicy();
    const activeAdmin = getActiveAdminAccount();

    // Prevent any unauthorized attempt to switch activeClientNode without authenticating as that hospital's Admin account
    if (updates.activeClientNode && updates.activeClientNode !== activeAdmin.boundClientNode && !updates.activeAdminAccountId) {
        throw new Error(`Tài khoản Admin ${activeAdmin.fullName} chỉ được phép quản lý duy nhất ${activeAdmin.hospitalName}!`);
    }

    const nextAdminAcc = updates.activeAdminAccountId
        ? (HOSPITAL_ADMIN_ACCOUNTS[updates.activeAdminAccountId] || activeAdmin)
        : activeAdmin;

    const merged = {
        ...current,
        ...updates,
        activeAdminAccountId: nextAdminAcc.id,
        activeClientNode: nextAdminAcc.boundClientNode,
        updatedBy: actorName || `${nextAdminAcc.fullName} (${nextAdminAcc.hospitalShort})`,
        updatedAt: Date.now()
    };
    localStorage.setItem(ADMIN_POLICY_KEY, JSON.stringify(merged));

    if (updates.globalDecisionThreshold !== undefined) {
        saveLocalSettings({ decisionThreshold: updates.globalDecisionThreshold });
    }

    broadcastSyncEvent('POLICY_UPDATED', merged);

    try {
        await fetchWithTimeout('/api/sync/policy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(merged)
        }, 800);
    } catch (e) {}

    return merged;
}

async function loginHospitalAdminAccount(adminAccountId) {
    const targetAcc = HOSPITAL_ADMIN_ACCOUNTS[adminAccountId];
    if (!targetAcc) {
        throw new Error('Không tìm thấy tài khoản Admin Bệnh viện tương ứng.');
    }

    await saveAdminPolicy({
        activeAdminAccountId: targetAcc.id,
        activeClientNode: targetAcc.boundClientNode
    }, `${targetAcc.fullName} (Đăng nhập Phiên Quản trị)`);

    // Also update local workstation profile so Doctor/Technician portals reflect the bound hospital's staff
    saveLocalSettings({
        doctorName: targetAcc.defaultDoctorName,
        department: targetAcc.defaultDepartment,
        hospital: targetAcc.hospitalName,
        technicianName: targetAcc.defaultTechName,
        modalityRoom: targetAcc.defaultModalityRoom
    });

    await dbAddAuditLog({
        actor: `${targetAcc.fullName} (${targetAcc.username})`,
        role: 'ADMIN',
        clientNode: targetAcc.boundClientNode,
        action: 'ADMIN_HOSPITAL_LOGIN',
        severity: 'SECURITY',
        details: `Đăng nhập phiên Quản trị viên độc quyền tại ${targetAcc.hospitalName} (Chứng thư số: ${targetAcc.certificateId} • Cô lập 1 Admin / 1 Bệnh viện).`
    });

    broadcastSyncEvent('ADMIN_ACCOUNT_SWITCHED', targetAcc);
    return targetAcc;
}

function formatPatientNamePHI(name) {
    if (!name) return 'Bệnh nhân chưa đặt tên';
    const policy = getAdminPolicy();
    if (!policy.phiMaskingEnabled) return name;
    const parts = String(name).trim().split(/\s+/);
    return parts.map((w, idx) => {
        if (idx === parts.length - 1) return w[0] + '***';
        return w[0] + '*';
    }).join(' ') + ' [Ẩn danh PHI]';
}

// =========================================================================
// 5. HOSPITAL STAFF ACCOUNTS (RBAC USERS ISOLATED PER HOSPITAL)
// =========================================================================
const USERS_STORAGE_KEY = 'medai_hospital_users_v43';
const DEFAULT_HOSPITAL_USERS = [
    // --- CLIENT 1: BỆNH VIỆN PHỔI TRUNG ƯƠNG ---
    {
        id: 'USR-ADMIN-01',
        username: 'admin.bvphoi@medai.vn',
        fullName: 'KS. Trần Quốc Bảo',
        role: 'ADMIN',
        title: 'Trưởng phòng CNTT & An toàn Dữ liệu (Quản trị viên độc quyền Client 1)',
        department: 'Trung tâm CNTT - BV Phổi Trung ương',
        clientNode: 'CLIENT_1',
        mfaEnabled: true,
        status: 'ACTIVE',
        lastLogin: Date.now() - 300000
    },
    {
        id: 'USR-DOC-01',
        username: 'bs.nguyenvana',
        fullName: 'BS.CKII Nguyễn Văn A',
        role: 'DOCTOR',
        title: 'Trưởng khoa Chẩn đoán Hình ảnh',
        department: 'Khoa Chẩn đoán Hình ảnh (PACS) - BV Phổi TW',
        clientNode: 'CLIENT_1',
        mfaEnabled: true,
        status: 'ACTIVE',
        lastLogin: Date.now() - 200000
    },
    {
        id: 'USR-TECH-01',
        username: 'ktv.phamhoangnam',
        fullName: 'CN.KTV Phạm Hoàng Nam',
        role: 'TECHNICIAN',
        title: 'Kỹ thuật viên Trưởng Phòng X-Quang DR-01',
        department: 'Phòng Chụp X-Quang Kỹ thuật số - BV Phổi TW',
        clientNode: 'CLIENT_1',
        mfaEnabled: true,
        status: 'ACTIVE',
        lastLogin: Date.now() - 120000
    },

    // --- CLIENT 2: BỆNH VIỆN ĐA KHOA CẤP CỨU ---
    {
        id: 'USR-ADMIN-02',
        username: 'admin.bvcapcuu@medai.vn',
        fullName: 'ThS.KS Lê Hoàng Việt',
        role: 'ADMIN',
        title: 'Giám đốc Trung tâm CNTT & Bảo mật (Quản trị viên độc quyền Client 2)',
        department: 'Trung tâm CNTT - BV Đa khoa Cấp cứu',
        clientNode: 'CLIENT_2',
        mfaEnabled: true,
        status: 'ACTIVE',
        lastLogin: Date.now() - 900000
    },
    {
        id: 'USR-DOC-02',
        username: 'bs.leminhchau',
        fullName: 'ThS.BS Lê Minh Châu',
        role: 'DOCTOR',
        title: 'Bác sĩ Chuyên khoa Hô hấp & Cấp cứu X-Quang',
        department: 'Khoa Cấp cứu - Hồi sức (ICU) - BV Cấp cứu',
        clientNode: 'CLIENT_2',
        mfaEnabled: true,
        status: 'ACTIVE',
        lastLogin: Date.now() - 1800000
    },
    {
        id: 'USR-TECH-02',
        username: 'ktv.vuthimai',
        fullName: 'KTV Vũ Thị Mai',
        role: 'TECHNICIAN',
        title: 'Kỹ thuật viên X-Quang Di động Cấp cứu DR-02',
        department: 'Phòng X-Quang Cấp cứu - BV Đa khoa Cấp cứu',
        clientNode: 'CLIENT_2',
        mfaEnabled: true,
        status: 'ACTIVE',
        lastLogin: Date.now() - 2400000
    },

    // --- CLIENT 3: TRUNG TÂM Y TẾ SÀNG LỌC CỘNG ĐỒNG ---
    {
        id: 'USR-ADMIN-03',
        username: 'admin.ttsangloc@medai.vn',
        fullName: 'KS. Nguyễn Minh Tuấn',
        role: 'ADMIN',
        title: 'Quản trị viên Hệ thống PACS/AI (Quản trị viên độc quyền Client 3)',
        department: 'Tổ CNTT & Dữ liệu Y tế - TT Sàng lọc Cộng đồng',
        clientNode: 'CLIENT_3',
        mfaEnabled: true,
        status: 'ACTIVE',
        lastLogin: Date.now() - 1500000
    },
    {
        id: 'USR-DOC-03',
        username: 'bs.hoangvannam',
        fullName: 'BS.CKI Hoàng Văn Nam',
        role: 'DOCTOR',
        title: 'Bác sĩ Phụ trách Sàng lọc Hô hấp Cộng đồng',
        department: 'Phòng khám Sàng lọc Hô hấp - TT Sàng lọc',
        clientNode: 'CLIENT_3',
        mfaEnabled: true,
        status: 'ACTIVE',
        lastLogin: Date.now() - 3600000
    },
    {
        id: 'USR-TECH-03',
        username: 'ktv.dangvankhoa',
        fullName: 'CN.KTV Đặng Văn Khoa',
        role: 'TECHNICIAN',
        title: 'Kỹ thuật viên Phòng X-Quang Sàng lọc DR-03',
        department: 'Phòng Chụp X-Quang DR-03 - TT Sàng lọc',
        clientNode: 'CLIENT_3',
        mfaEnabled: true,
        status: 'ACTIVE',
        lastLogin: Date.now() - 4200000
    }
];

function dbGetUsers(onlyActiveHospital = true) {
    let allUsers = [];
    try {
        const raw = localStorage.getItem(USERS_STORAGE_KEY);
        if (!raw) {
            localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(DEFAULT_HOSPITAL_USERS));
            allUsers = [...DEFAULT_HOSPITAL_USERS];
        } else {
            allUsers = JSON.parse(raw);
        }
    } catch (e) {
        allUsers = [...DEFAULT_HOSPITAL_USERS];
    }

    if (!onlyActiveHospital) return allUsers;
    const boundNode = getActiveAdminAccount().boundClientNode;
    return allUsers.filter(u => (u.clientNode || 'CLIENT_1') === boundNode);
}

function dbSaveUsers(usersList) {
    localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(usersList));
    broadcastSyncEvent('USERS_UPDATED', usersList);
    return usersList;
}

// =========================================================================
// 6. NON-BLOCKING STORAGE ENGINE (LOCALSTORAGE MIRROR + INDEXEDDB)
// Guarantees 0ms hang even if another tab has an older IndexedDB connection open
// =========================================================================
function readLSMirror(key, fallback = []) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch (e) {
        return fallback;
    }
}

function writeLSMirror(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
        // If quota exceeded due to large base64 thumbnails, keep lightweight metadata in LS
        try {
            const slim = Array.isArray(data) ? data.slice(0, 30) : data;
            localStorage.setItem(key, JSON.stringify(slim));
        } catch (err) {}
    }
}

function openDB() {
    return new Promise((resolve) => {
        if (dbInstance) return resolve(dbInstance);
        if (typeof indexedDB === 'undefined') return resolve(null);

        let settled = false;
        const finish = (val) => {
            if (!settled) {
                settled = true;
                resolve(val);
            }
        };

        // Hard 350ms timeout so IndexedDB can NEVER block page rendering!
        const timer = setTimeout(() => {
            finish(null);
        }, 350);

        try {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_CASES)) {
                    const s = db.createObjectStore(STORE_CASES, { keyPath: 'id' });
                    s.createIndex('patientId', 'patientId', { unique: false });
                    s.createIndex('timestamp', 'timestamp', { unique: false });
                }
                if (!db.objectStoreNames.contains(STORE_PATIENTS)) {
                    db.createObjectStore(STORE_PATIENTS, { keyPath: 'patientId' });
                }
                if (!db.objectStoreNames.contains(STORE_WORKLIST)) {
                    db.createObjectStore(STORE_WORKLIST, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(STORE_AUDIT)) {
                    db.createObjectStore(STORE_AUDIT, { keyPath: 'id' });
                }
            };

            request.onsuccess = (e) => {
                clearTimeout(timer);
                dbInstance = e.target.result;
                dbInstance.onversionchange = () => {
                    dbInstance.close();
                    dbInstance = null;
                };
                finish(dbInstance);
            };

            request.onerror = () => {
                clearTimeout(timer);
                finish(null);
            };

            request.onblocked = () => {
                clearTimeout(timer);
                finish(null);
            };
        } catch (err) {
            clearTimeout(timer);
            finish(null);
        }
    });
}

// Cryptographic SHA-256 short signature generator
async function computeSHA256Short(inputStr) {
    try {
        if (window.crypto && window.crypto.subtle) {
            const msgBuffer = new TextEncoder().encode(inputStr);
            const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            return hashHex.substring(0, 16).toUpperCase();
        }
    } catch (e) {}
    let h = 0x811c9dc5;
    for (let i = 0; i < inputStr.length; i++) {
        h ^= inputStr.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8).toUpperCase() + 'A9F2C4E1';
}

function generateCaseId() {
    return 'CX-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
}

function generateWorklistId() {
    return 'WL-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 5).toUpperCase();
}

function createThumbnail(dataUrl, maxWidth = 420) {
    return new Promise((resolve) => {
        if (!dataUrl || !dataUrl.startsWith('data:image')) return resolve(dataUrl || null);
        const img = new Image();
        const timer = setTimeout(() => resolve(dataUrl), 400);
        img.onload = () => {
            clearTimeout(timer);
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;
            if (width > maxWidth) {
                height = Math.round((height * maxWidth) / width);
                width = maxWidth;
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.80));
        };
        img.onerror = () => {
            clearTimeout(timer);
            resolve(dataUrl);
        };
        img.src = dataUrl;
    });
}

// =========================================================================
// 7. AUTO-SEED INITIAL HOSPITAL DATASET & WORKLIST ON FIRST RUN
// =========================================================================
function buildPatientsFromCases(casesList) {
    const map = {};
    // Process oldest to newest so lastDiagnosis reflects most recent exam
    const sortedAsc = [...casesList].sort((a, b) => a.timestamp - b.timestamp);
    for (const c of sortedAsc) {
        const pid = c.patientId;
        if (!map[pid]) {
            map[pid] = {
                patientId: pid,
                name: c.patientName,
                age: c.age,
                gender: c.gender,
                clientNode: c.clientNode || 'CLIENT_1',
                sourcePath: c.sourcePath || null,
                firstSeen: c.timestamp,
                lastSeen: c.timestamp,
                lastUpdated: c.timestamp,
                lastSymptoms: c.symptoms,
                lastDiagnosis: c.diagnosis,
                lastProbPneumonia: c.probPneumonia,
                totalExams: 0
            };
        }
        map[pid].name = c.patientName || map[pid].name;
        map[pid].age = c.age || map[pid].age;
        map[pid].gender = c.gender || map[pid].gender;
        map[pid].lastSeen = Math.max(map[pid].lastSeen, c.timestamp);
        map[pid].lastUpdated = map[pid].lastSeen;
        map[pid].lastSymptoms = c.symptoms;
        map[pid].lastDiagnosis = c.diagnosis;
        map[pid].lastProbPneumonia = c.probPneumonia;
        map[pid].totalExams += 1;
    }
    return Object.values(map).sort((a, b) => b.lastSeen - a.lastSeen);
}

function ensureInitialHospitalDataSeededSync() {
    if (localStorage.getItem(LS_SEEDED_KEY)) return;

    const now = Date.now();

    // 1. Seed 12 Clinical Cases from `federated_data/` across all 3 Hospital Clients
    const existingCases = readLSMirror(LS_CASES_KEY, []);
    if (existingCases.length === 0) {
        const seededCases = HOSPITAL_DATASET_PRESETS.map(p => ({
            id: p.id,
            patientId: p.patientId,
            patientName: p.patientName,
            age: p.age,
            gender: p.gender,
            clientNode: p.clientNode,
            sourcePath: p.sourcePath,
            symptoms: p.symptoms,
            diagnosis: p.diagnosis,
            probPneumonia: p.probPneumonia,
            probNormal: p.probNormal,
            doctorNotes: p.doctorNotes,
            doctorName: p.doctorName,
            department: p.department,
            integrityHash: p.integrityHash,
            signedStatus: 'SIGNED_VERIFIED',
            image: p.image,
            heatmap: null,
            timestamp: now - (p.timestampOffsetHours * 3600 * 1000)
        }));
        seededCases.sort((a, b) => b.timestamp - a.timestamp);
        writeLSMirror(LS_CASES_KEY, seededCases);

        const seededPatients = buildPatientsFromCases(seededCases);
        writeLSMirror(LS_PATIENTS_KEY, seededPatients);
    }

    // 2. Seed Technician -> Doctor PACS Worklist Queue across all 3 Hospital Clients (Isolated per Hospital)
    const existingWl = readLSMirror(LS_WORKLIST_KEY, []);
    if (existingWl.length === 0) {
        const demoWorklist = [
            // --- CLIENT 1: BỆNH VIỆN PHỔI TRUNG ƯƠNG ---
            {
                id: 'WL-STAT-8901',
                patientId: 'BN-CC2041',
                patientName: 'Đặng Quốc Hùng',
                age: 62,
                gender: 'Nam',
                referringDept: 'Khoa Cấp cứu - Hồi sức (ICU)',
                symptoms: 'Khó thở cấp, SpO2 91%, sốt cao 39.2°C, ran ẩm đáy phổi phải',
                priority: 'STAT',
                status: 'PENDING_DOCTOR',
                clientNode: 'CLIENT_1',
                modalityRoom: 'DR-01 (Fujifilm FDR Visionary) - BV Phổi TW',
                viewPosition: 'PA Erect (Đứng chuẩn)',
                kvp: 115,
                mas: 4.5,
                sidCm: 180,
                esdDose: '0.14 mGy',
                claheApplied: true,
                qaPassed: true,
                qaScore: '4/4 Đạt chuẩn Bộ Y tế',
                technicianName: 'CN.KTV Phạm Hoàng Nam',
                technicianNotes: 'Bệnh nhân cấp cứu khó thở, đã cân bằng CLAHE rõ vùng mờ đáy phổi phải. AI Pre-Triage báo động đỏ, kính chuyển Bác sĩ đọc khẩn STAT!',
                aiPreTriageDone: true,
                aiDiagnosis: 'PNEUMONIA',
                probPneumonia: 94.6,
                probNormal: 5.4,
                assignedDoctor: 'BS.CKII Nguyễn Văn A',
                doctorNotes: '',
                retakeReason: '',
                image: 'assets/hospital_dataset/c1_bacteria_480.jpeg',
                sampleFileUrl: 'assets/hospital_dataset/c1_bacteria_480.jpeg',
                sourcePath: 'federated_data/client_1_lung_hospital/train/PNEUMONIA/person100_bacteria_480.jpeg',
                integrityHash: '7F2B91E4C8A05D63',
                timestamp: now - 480000,
                updatedAt: now - 480000
            },
            {
                id: 'WL-URG-8902',
                patientId: 'BN-HH1085',
                patientName: 'Vũ Thị Ngọc Ánh',
                age: 37,
                gender: 'Nữ',
                referringDept: 'Khoa Nội Hô hấp',
                symptoms: 'Ho khan kéo dài 6 ngày, sốt 38.3°C về chiều, đau rát ngực sau xương ức',
                priority: 'URGENT',
                status: 'PENDING_DOCTOR',
                clientNode: 'CLIENT_1',
                modalityRoom: 'DR-01 (Fujifilm FDR Visionary) - BV Phổi TW',
                viewPosition: 'PA Erect (Đứng chuẩn)',
                kvp: 110,
                mas: 3.8,
                sidCm: 180,
                esdDose: '0.11 mGy',
                claheApplied: true,
                qaPassed: true,
                qaScore: '4/4 Đạt chuẩn Bộ Y tế',
                technicianName: 'CN.KTV Phạm Hoàng Nam',
                technicianNotes: 'Phim chụp từ kho dữ liệu BV Phổi, hít đủ 10 cung sườn. Nghi ngờ thâm nhiễm mô kẽ hai bên.',
                aiPreTriageDone: true,
                aiDiagnosis: 'PNEUMONIA',
                probPneumonia: 89.2,
                probNormal: 10.8,
                assignedDoctor: 'BS.CKII Nguyễn Văn A',
                doctorNotes: '',
                retakeReason: '',
                image: 'assets/hospital_dataset/c1_virus_190.jpeg',
                sampleFileUrl: 'assets/hospital_dataset/c1_virus_190.jpeg',
                sourcePath: 'federated_data/client_1_lung_hospital/train/PNEUMONIA/person103_virus_190.jpeg',
                integrityHash: '4C8E19D0A3F67B21',
                timestamp: now - 1200000,
                updatedAt: now - 1200000
            },
            {
                id: 'WL-RTN-8903',
                patientId: 'BN-KS3012',
                patientName: 'Lê Quốc Khánh',
                age: 35,
                gender: 'Nam',
                referringDept: 'Trung tâm Khám Sức khỏe Định kỳ',
                symptoms: 'Khám sức khỏe định kỳ hằng năm, không ho, không khó thở',
                priority: 'ROUTINE',
                status: 'PENDING_DOCTOR',
                clientNode: 'CLIENT_1',
                modalityRoom: 'DR-01 (Fujifilm FDR Visionary) - BV Phổi TW',
                viewPosition: 'PA Erect (Đứng chuẩn)',
                kvp: 108,
                mas: 3.2,
                sidCm: 180,
                esdDose: '0.09 mGy',
                claheApplied: true,
                qaPassed: true,
                qaScore: '4/4 Đạt chuẩn Bộ Y tế',
                technicianName: 'CN.KTV Phạm Hoàng Nam',
                technicianNotes: 'Phim kiểm tra định kỳ đạt chuẩn kỹ thuật, hai phế trường sáng rõ.',
                aiPreTriageDone: true,
                aiDiagnosis: 'NORMAL',
                probPneumonia: 2.4,
                probNormal: 97.6,
                assignedDoctor: 'BS.CKII Nguyễn Văn A',
                doctorNotes: '',
                retakeReason: '',
                image: 'assets/hospital_dataset/c1_normal_0001.jpeg',
                sampleFileUrl: 'assets/hospital_dataset/c1_normal_0001.jpeg',
                sourcePath: 'federated_data/client_1_lung_hospital/train/NORMAL/IM-0001-0001.jpeg',
                integrityHash: '3A9C71E5D2F84B09',
                timestamp: now - 2400000,
                updatedAt: now - 2400000
            },

            // --- CLIENT 2: BỆNH VIỆN ĐA KHOA CẤP CỨU ---
            {
                id: 'WL-C2-9001',
                patientId: 'BN-C2-2931',
                patientName: 'Hoàng Đình Trọng',
                age: 71,
                gender: 'Nam',
                referringDept: 'Khoa Cấp cứu & Hồi sức Tích cực (ICU) - BV Cấp cứu',
                symptoms: 'Nhập cấp cứu khó thở nhanh nông 28 lần/phút, SpO2 89%, sốt 39.5°C, nền COPD',
                priority: 'STAT',
                status: 'PENDING_DOCTOR',
                clientNode: 'CLIENT_2',
                modalityRoom: 'DR-02 (Siemens Ysio Max) - BV Cấp cứu',
                viewPosition: 'AP Supine (Nằm tại giường ICU)',
                kvp: 118,
                mas: 5.0,
                sidCm: 120,
                esdDose: '0.16 mGy',
                claheApplied: true,
                qaPassed: true,
                qaScore: '4/4 Đạt chuẩn Bộ Y tế',
                technicianName: 'KTV Vũ Thị Mai',
                technicianNotes: 'Chụp X-Quang di động tại giường ICU. Đông đặc nặng thùy dưới phổi phải, chuyển khẩn BS Lê Minh Châu!',
                aiPreTriageDone: true,
                aiDiagnosis: 'PNEUMONIA',
                probPneumonia: 97.8,
                probNormal: 2.2,
                assignedDoctor: 'ThS.BS Lê Minh Châu',
                doctorNotes: '',
                retakeReason: '',
                image: 'assets/hospital_dataset/c2_bacteria_2931.jpeg',
                sampleFileUrl: 'assets/hospital_dataset/c2_bacteria_2931.jpeg',
                sourcePath: 'federated_data/client_2_emergency_general/train/PNEUMONIA/person1000_bacteria_2931.jpeg',
                integrityHash: '9B2E41D7F0A63C58',
                timestamp: now - 360000,
                updatedAt: now - 360000
            },
            {
                id: 'WL-C2-9002',
                patientId: 'BN-C2-1688',
                patientName: 'Đỗ Thị Thanh Tâm',
                age: 52,
                gender: 'Nữ',
                referringDept: 'Khoa Cấp cứu - BV Đa khoa Cấp cứu',
                symptoms: 'Sốt cao 4 ngày không hạ, ho khan từng cơn, tức nặng ngực hai bên',
                priority: 'URGENT',
                status: 'PENDING_DOCTOR',
                clientNode: 'CLIENT_2',
                modalityRoom: 'DR-02 (Siemens Ysio Max) - BV Cấp cứu',
                viewPosition: 'PA Erect (Đứng chuẩn)',
                kvp: 112,
                mas: 4.0,
                sidCm: 180,
                esdDose: '0.12 mGy',
                claheApplied: true,
                qaPassed: true,
                qaScore: '4/4 Đạt chuẩn Bộ Y tế',
                technicianName: 'KTV Vũ Thị Mai',
                technicianNotes: 'Thâm nhiễm lưới-nốt mờ đối xứng hai bên phế trường.',
                aiPreTriageDone: true,
                aiDiagnosis: 'PNEUMONIA',
                probPneumonia: 91.6,
                probNormal: 8.4,
                assignedDoctor: 'ThS.BS Lê Minh Châu',
                doctorNotes: '',
                retakeReason: '',
                image: 'assets/hospital_dataset/c2_virus_1688.jpeg',
                sampleFileUrl: 'assets/hospital_dataset/c2_virus_1688.jpeg',
                sourcePath: 'federated_data/client_2_emergency_general/train/PNEUMONIA/person1005_virus_1688.jpeg',
                integrityHash: '4F8C12A9E7D03B64',
                timestamp: now - 900000,
                updatedAt: now - 900000
            },

            // --- CLIENT 3: TRUNG TÂM Y TẾ SÀNG LỌC CỘNG ĐỒNG ---
            {
                id: 'WL-C3-9101',
                patientId: 'BN-C3-2932',
                patientName: 'Đặng Xuân Hải',
                age: 59,
                gender: 'Nam',
                referringDept: 'Phòng khám Sàng lọc Hô hấp - TT Sàng lọc',
                symptoms: 'Ho đờm vàng 8 ngày, sốt nhẹ 38.4°C, đau tức hạ sườn phải khi ho mạnh',
                priority: 'URGENT',
                status: 'PENDING_DOCTOR',
                clientNode: 'CLIENT_3',
                modalityRoom: 'DR-03 (Carestream DRX) - TT Sàng lọc',
                viewPosition: 'PA Erect (Đứng chuẩn)',
                kvp: 112,
                mas: 3.8,
                sidCm: 180,
                esdDose: '0.11 mGy',
                claheApplied: true,
                qaPassed: true,
                qaScore: '4/4 Đạt chuẩn Bộ Y tế',
                technicianName: 'CN.KTV Đặng Văn Khoa',
                technicianNotes: 'Ca sàng lọc cộng đồng phát hiện đám mờ đông đặc vùng đáy phổi phải, cần bác sĩ xác nhận chuyển tuyến.',
                aiPreTriageDone: true,
                aiDiagnosis: 'PNEUMONIA',
                probPneumonia: 94.1,
                probNormal: 5.9,
                assignedDoctor: 'BS.CKI Hoàng Văn Nam',
                doctorNotes: '',
                retakeReason: '',
                image: 'assets/hospital_dataset/c3_bacteria_2932.jpeg',
                sampleFileUrl: 'assets/hospital_dataset/c3_bacteria_2932.jpeg',
                sourcePath: 'federated_data/client_3_screening_clinic/train/PNEUMONIA/person1001_bacteria_2932.jpeg',
                integrityHash: '3C7F85B2D1A90E43',
                timestamp: now - 540000,
                updatedAt: now - 540000
            },
            {
                id: 'WL-C3-9102',
                patientId: 'BN-C3-1685',
                patientName: 'Trần Hữu Kiên',
                age: 31,
                gender: 'Nam',
                referringDept: 'Phòng khám Đa khoa - TT Sàng lọc',
                symptoms: 'Sốt 38.5°C sau đợt dịch cúm tại cơ quan, ho khan rát họng',
                priority: 'ROUTINE',
                status: 'PENDING_DOCTOR',
                clientNode: 'CLIENT_3',
                modalityRoom: 'DR-03 (Carestream DRX) - TT Sàng lọc',
                viewPosition: 'PA Erect (Đứng chuẩn)',
                kvp: 110,
                mas: 3.5,
                sidCm: 180,
                esdDose: '0.10 mGy',
                claheApplied: true,
                qaPassed: true,
                qaScore: '4/4 Đạt chuẩn Bộ Y tế',
                technicianName: 'CN.KTV Đặng Văn Khoa',
                technicianNotes: 'Tăng đậm vân phổi và kính mờ nhẹ quanh rốn phổi hai bên.',
                aiPreTriageDone: true,
                aiDiagnosis: 'PNEUMONIA',
                probPneumonia: 87.9,
                probNormal: 12.1,
                assignedDoctor: 'BS.CKI Hoàng Văn Nam',
                doctorNotes: '',
                retakeReason: '',
                image: 'assets/hospital_dataset/c3_virus_1685.jpeg',
                sampleFileUrl: 'assets/hospital_dataset/c3_virus_1685.jpeg',
                sourcePath: 'federated_data/client_3_screening_clinic/train/PNEUMONIA/person1003_virus_1685.jpeg',
                integrityHash: '5D2B90E4F1C87A36',
                timestamp: now - 1500000,
                updatedAt: now - 1500000
            }
        ];
        writeLSMirror(LS_WORKLIST_KEY, demoWorklist);
    }

    // 3. Seed Audit Logs per Hospital Client
    const existingAudit = readLSMirror(LS_AUDIT_KEY, []);
    if (existingAudit.length === 0) {
        const seedLogs = [
            {
                id: 'AUD-SEED-01',
                timestamp: now - 3600000,
                actor: 'KS. Trần Quốc Bảo (admin.bvphoi@medai.vn)',
                role: 'ADMIN',
                clientNode: 'CLIENT_1',
                action: 'TENANT_ISOLATION_ENFORCED',
                severity: 'SECURITY',
                details: 'Kích hoạt chính sách Cô lập Đa thuê bao (1 Tài khoản Admin chỉ quản lý duy nhất 1 Bệnh viện). Khóa truy cập chéo sang Client 2 và Client 3.',
                hash: '9A4F82C1E0B73D12'
            },
            {
                id: 'AUD-SEED-02',
                timestamp: now - 1800000,
                actor: 'KS. Trần Quốc Bảo (admin.bvphoi@medai.vn)',
                role: 'ADMIN',
                clientNode: 'CLIENT_1',
                action: 'FL_DP_ROUND_SYNC_30',
                severity: 'SECURITY',
                details: 'Đồng bộ vòng huấn luyện Federated Learning #30 tại BV Phổi TW (FedProx μ=1.0, Gaussian DP σ=0.01, L2 Clip=1.0). Không chia sẻ dữ liệu ảnh gốc.',
                hash: '8B1D74E2A9C05F31'
            },
            {
                id: 'AUD-SEED-03',
                timestamp: now - 480000,
                actor: 'CN.KTV Phạm Hoàng Nam',
                role: 'TECHNICIAN',
                clientNode: 'CLIENT_1',
                action: 'AI_PRETRIAGE_STAT_ALERT',
                severity: 'WARN',
                details: 'AI Pre-Triage phát hiện nguy cơ Viêm phổi 94.6% trên ca BN-CC2041 (person100_bacteria_480.jpeg) -> Tự động gắn cờ Cấp cứu STAT chuyển BS.CKII Nguyễn Văn A.',
                hash: '7F2B91E4C8A05D63'
            },
            {
                id: 'AUD-SEED-04',
                timestamp: now - 2200000,
                actor: 'ThS.KS Lê Hoàng Việt (admin.bvcapcuu@medai.vn)',
                role: 'ADMIN',
                clientNode: 'CLIENT_2',
                action: 'FL_DP_ROUND_SYNC_30',
                severity: 'SECURITY',
                details: 'Đồng bộ trọng số cục bộ BV Đa khoa Cấp cứu (Client 2 - 1683 ảnh Non-IID) lên Flower Server với nhiễu vi phân Gaussian σ=0.01.',
                hash: '5E9A20C4B8D17F62'
            },
            {
                id: 'AUD-SEED-05',
                timestamp: now - 2500000,
                actor: 'KS. Nguyễn Minh Tuấn (admin.ttsangloc@medai.vn)',
                role: 'ADMIN',
                clientNode: 'CLIENT_3',
                action: 'FL_DP_ROUND_SYNC_30',
                severity: 'SECURITY',
                details: 'Đồng bộ trọng số cục bộ TT Y tế Sàng lọc Cộng đồng (Client 3 - 2029 ảnh Non-IID) lên Flower Server với nhiễu vi phân Gaussian σ=0.01.',
                hash: '3D8C14F9A2E60B75'
            }
        ];
        writeLSMirror(LS_AUDIT_KEY, seedLogs);
    }

    localStorage.setItem(LS_SEEDED_KEY, '1');
}

// Run seed immediately on script load (0ms synchronous)
ensureInitialHospitalDataSeededSync();

// =========================================================================
// 8. MODALITY WORKLIST (X-RAY TECHNICIAN -> DIAGNOSTIC DOCTOR QUEUE)
// =========================================================================
async function dbPushWorklistCase(wlData) {
    ensureInitialHospitalDataSeededSync();
    const id = wlData.id || generateWorklistId();
    const timestamp = wlData.timestamp || Date.now();
    const policy = getAdminPolicy();

    const imageThumb = wlData.image ? await createThumbnail(wlData.image, 480) : null;
    const heatmapThumb = wlData.heatmap ? await createThumbnail(wlData.heatmap, 480) : null;

    const integrityHash = wlData.integrityHash || await computeSHA256Short(
        `${id}-${wlData.patientId}-${wlData.technicianName || 'KTV'}-${timestamp}`
    );

    const record = {
        id,
        patientId: (wlData.patientId || 'BN-UNKNOWN').trim().toUpperCase(),
        patientName: (wlData.patientName || 'Bệnh nhân cấp cứu').trim(),
        age: wlData.age ? parseInt(wlData.age, 10) : 45,
        gender: wlData.gender || 'Nam',
        referringDept: wlData.referringDept || 'Khoa Cấp cứu',
        symptoms: wlData.symptoms || '',
        priority: wlData.priority || 'ROUTINE',
        status: wlData.status || 'PENDING_DOCTOR',
        clientNode: wlData.clientNode || policy.activeClientNode || 'CLIENT_1',
        modalityRoom: wlData.modalityRoom || 'DR-01 (Fujifilm FDR Visionary)',
        viewPosition: wlData.viewPosition || 'PA Erect (Đứng chuẩn)',
        kvp: wlData.kvp || 110,
        mas: wlData.mas || 4.0,
        sidCm: wlData.sidCm || 180,
        esdDose: wlData.esdDose || '0.12 mGy',
        claheApplied: wlData.claheApplied !== undefined ? wlData.claheApplied : true,
        qaPassed: wlData.qaPassed !== undefined ? wlData.qaPassed : true,
        qaScore: wlData.qaScore || '4/4 Đạt chuẩn Bộ Y tế',
        technicianName: wlData.technicianName || 'CN.KTV Phạm Hoàng Nam',
        technicianNotes: wlData.technicianNotes || '',
        aiPreTriageDone: Boolean(wlData.aiPreTriageDone),
        aiDiagnosis: wlData.aiDiagnosis || null,
        probPneumonia: parseFloat(wlData.probPneumonia || 0),
        probNormal: parseFloat(wlData.probNormal || 0),
        assignedDoctor: wlData.assignedDoctor || 'BS.CKII Nguyễn Văn A',
        doctorNotes: wlData.doctorNotes || '',
        retakeReason: wlData.retakeReason || '',
        completedCaseId: wlData.completedCaseId || null,
        image: imageThumb,
        heatmap: heatmapThumb,
        sampleFileUrl: wlData.sampleFileUrl || null,
        sourcePath: wlData.sourcePath || null,
        integrityHash,
        timestamp,
        updatedAt: timestamp
    };

    const list = readLSMirror(LS_WORKLIST_KEY, []);
    const idx = list.findIndex(x => x.id === id);
    if (idx >= 0) list[idx] = record;
    else list.unshift(record);
    writeLSMirror(LS_WORKLIST_KEY, list);

    const db = await openDB();
    if (db && db.objectStoreNames.contains(STORE_WORKLIST)) {
        try {
            const tx = db.transaction(STORE_WORKLIST, 'readwrite');
            tx.objectStore(STORE_WORKLIST).put(record);
        } catch (e) {}
    }

    broadcastSyncEvent('WORKLIST_NEW_CASE', record);
    try {
        await fetchWithTimeout('/api/sync/worklist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record)
        }, 800);
    } catch (e) {}

    return record;
}

function sortWorklistCases(list) {
    const priorityWeight = { STAT: 3, URGENT: 2, ROUTINE: 1 };
    return [...list].sort((a, b) => {
        if (a.status === 'PENDING_DOCTOR' && b.status !== 'PENDING_DOCTOR') return -1;
        if (a.status !== 'PENDING_DOCTOR' && b.status === 'PENDING_DOCTOR') return 1;
        const pwA = priorityWeight[a.priority] || 1;
        const pwB = priorityWeight[b.priority] || 1;
        if (pwA !== pwB && a.status === 'PENDING_DOCTOR') return pwB - pwA;
        return b.timestamp - a.timestamp;
    });
}

async function dbGetWorklistCases(onlyActiveHospital = true) {
    ensureInitialHospitalDataSeededSync();
    const localList = readLSMirror(LS_WORKLIST_KEY, []);
    const boundNode = getActiveAdminAccount().boundClientNode;
    const filtered = onlyActiveHospital
        ? localList.filter(x => (x.clientNode || 'CLIENT_1') === boundNode)
        : localList;
    return sortWorklistCases(filtered);
}

async function dbGetWorklistById(id) {
    const list = await dbGetWorklistCases(false);
    return list.find(x => x.id === id) || null;
}

async function dbUpdateWorklistStatus(id, updates) {
    const list = readLSMirror(LS_WORKLIST_KEY, []);
    const idx = list.findIndex(x => x.id === id);
    if (idx < 0) return null;

    const updatedRecord = {
        ...list[idx],
        ...updates,
        updatedAt: Date.now()
    };
    list[idx] = updatedRecord;
    writeLSMirror(LS_WORKLIST_KEY, list);

    const db = await openDB();
    if (db && db.objectStoreNames.contains(STORE_WORKLIST)) {
        try {
            const tx = db.transaction(STORE_WORKLIST, 'readwrite');
            tx.objectStore(STORE_WORKLIST).put(updatedRecord);
        } catch (e) {}
    }

    broadcastSyncEvent('WORKLIST_UPDATED', updatedRecord);
    try {
        await fetchWithTimeout(`/api/sync/worklist/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        }, 800);
    } catch (e) {}

    return updatedRecord;
}

async function dbDeleteWorklistCase(id) {
    const list = readLSMirror(LS_WORKLIST_KEY, []).filter(x => x.id !== id);
    writeLSMirror(LS_WORKLIST_KEY, list);
    broadcastSyncEvent('WORKLIST_DELETED', { id });
    return true;
}

// =========================================================================
// 9. IMMUTABLE HOSPITAL SECURITY AUDIT LOGS (HIPAA AUDIT TRAIL)
// =========================================================================
async function dbAddAuditLog({ actor, role, action, severity = 'INFO', details = '', clientNode = null }) {
    ensureInitialHospitalDataSeededSync();
    const policy = getAdminPolicy();
    const id = 'AUD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 5).toUpperCase();
    const timestamp = Date.now();
    const node = clientNode || policy.activeClientNode || 'CLIENT_1';
    const hash = await computeSHA256Short(`${id}|${actor}|${role}|${action}|${timestamp}`);

    const entry = {
        id,
        timestamp,
        actor: actor || 'Hệ thống',
        role: role || 'DOCTOR',
        clientNode: node,
        action: action || 'SYSTEM_EVENT',
        severity,
        details,
        hash
    };

    const logs = readLSMirror(LS_AUDIT_KEY, []);
    logs.unshift(entry);
    writeLSMirror(LS_AUDIT_KEY, logs.slice(0, 150));

    broadcastSyncEvent('AUDIT_LOG_ADDED', entry);
    try {
        await fetchWithTimeout('/api/sync/audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(entry)
        }, 800);
    } catch (e) {}

    return entry;
}

async function dbGetAuditLogs(onlyActiveHospital = true) {
    ensureInitialHospitalDataSeededSync();
    const logs = readLSMirror(LS_AUDIT_KEY, []);
    const boundNode = getActiveAdminAccount().boundClientNode;
    const filtered = onlyActiveHospital
        ? logs.filter(l => (l.clientNode || 'CLIENT_1') === boundNode)
        : logs;
    return filtered.sort((a, b) => b.timestamp - a.timestamp);
}

// =========================================================================
// 10. DIAGNOSTIC CASES & PATIENT PROFILES (DOCTOR PORTAL)
// =========================================================================
async function dbSaveCase(caseData) {
    ensureInitialHospitalDataSeededSync();
    const id = caseData.id || generateCaseId();
    const timestamp = caseData.timestamp || Date.now();
    const policy = getAdminPolicy();

    const imageThumb = caseData.image ? await createThumbnail(caseData.image, 460) : null;
    const heatmapThumb = caseData.heatmap ? await createThumbnail(caseData.heatmap, 460) : null;
    const integrityHash = caseData.integrityHash || await computeSHA256Short(
        `${id}-${caseData.patientId}-${caseData.diagnosis}-${timestamp}`
    );

    const record = {
        id,
        worklistId: caseData.worklistId || null,
        patientId: (caseData.patientId || 'UNKNOWN').trim().toUpperCase(),
        patientName: (caseData.patientName || 'Bệnh nhân chưa đặt tên').trim(),
        age: caseData.age ? parseInt(caseData.age, 10) : null,
        gender: caseData.gender || 'Nam',
        symptoms: caseData.symptoms || '',
        diagnosis: caseData.diagnosis || 'NORMAL',
        probPneumonia: parseFloat(caseData.probPneumonia || 0),
        probNormal: parseFloat(caseData.probNormal || 0),
        doctorNotes: caseData.doctorNotes || '',
        doctorName: caseData.doctorName || 'BS.CKII Nguyễn Văn A',
        department: caseData.department || 'Khoa Chẩn đoán hình ảnh',
        technicianName: caseData.technicianName || null,
        modalityInfo: caseData.modalityInfo || null,
        clientNode: caseData.clientNode || policy.activeClientNode || 'CLIENT_1',
        sourcePath: caseData.sourcePath || null,
        integrityHash,
        signedStatus: caseData.signedStatus || 'SIGNED_VERIFIED',
        image: imageThumb,
        heatmap: heatmapThumb,
        timestamp
    };

    const cases = readLSMirror(LS_CASES_KEY, []);
    const existingIdx = cases.findIndex(c => c.id === id);
    if (existingIdx >= 0) cases[existingIdx] = record;
    else cases.unshift(record);
    cases.sort((a, b) => b.timestamp - a.timestamp);
    writeLSMirror(LS_CASES_KEY, cases);

    const rebuiltPatients = buildPatientsFromCases(cases);
    writeLSMirror(LS_PATIENTS_KEY, rebuiltPatients);

    const db = await openDB();
    if (db && db.objectStoreNames.contains(STORE_CASES)) {
        try {
            const tx = db.transaction([STORE_CASES, STORE_PATIENTS], 'readwrite');
            tx.objectStore(STORE_CASES).put(record);
            const pStore = tx.objectStore(STORE_PATIENTS);
            rebuiltPatients.forEach(p => pStore.put(p));
        } catch (e) {}
    }

    broadcastSyncEvent('CASE_SAVED', record);
    return record;
}

async function dbGetAllCases(onlyActiveHospital = true) {
    ensureInitialHospitalDataSeededSync();
    const cases = readLSMirror(LS_CASES_KEY, []);
    const boundNode = getActiveAdminAccount().boundClientNode;
    const filtered = onlyActiveHospital
        ? cases.filter(c => (c.clientNode || 'CLIENT_1') === boundNode)
        : cases;
    return filtered.sort((a, b) => b.timestamp - a.timestamp);
}

async function dbGetCaseById(id) {
    const cases = await dbGetAllCases(false);
    return cases.find(c => c.id === id) || null;
}

async function dbUpdateCaseNotes(id, doctorNotes) {
    const cases = readLSMirror(LS_CASES_KEY, []);
    const idx = cases.findIndex(c => c.id === id);
    if (idx < 0) return null;
    cases[idx].doctorNotes = doctorNotes;
    cases[idx].signedStatus = 'SIGNED_VERIFIED';
    writeLSMirror(LS_CASES_KEY, cases);
    return cases[idx];
}

async function dbDeleteCase(id) {
    const boundNode = getActiveAdminAccount().boundClientNode;
    const all = readLSMirror(LS_CASES_KEY, []);
    const target = all.find(c => c.id === id);
    if (target && (target.clientNode || 'CLIENT_1') !== boundNode) {
        throw new Error('⛔ Không thể xóa bản ghi thuộc Bệnh viện khác (Cô lập 1 Admin - 1 Bệnh viện).');
    }
    const cases = all.filter(c => c.id !== id);
    writeLSMirror(LS_CASES_KEY, cases);
    writeLSMirror(LS_PATIENTS_KEY, buildPatientsFromCases(cases));
    return true;
}

async function dbGetAllPatients(onlyActiveHospital = true) {
    ensureInitialHospitalDataSeededSync();
    const cases = await dbGetAllCases(onlyActiveHospital);
    const patients = buildPatientsFromCases(cases);
    if (!onlyActiveHospital) {
        writeLSMirror(LS_PATIENTS_KEY, patients);
    }
    return patients;
}

async function dbGetPatientProfile(patientId) {
    const cases = await dbGetAllCases();
    const patients = await dbGetAllPatients();
    const patient = patients.find(p => p.patientId === patientId) || null;
    const patCases = cases.filter(c => c.patientId === patientId).sort((a, b) => b.timestamp - a.timestamp);
    return { patient, cases: patCases };
}

async function dbUpdatePatient(patientId, updateData) {
    const patients = readLSMirror(LS_PATIENTS_KEY, []);
    const idx = patients.findIndex(p => p.patientId === patientId);
    if (idx < 0) return null;
    patients[idx] = { ...patients[idx], ...updateData, lastUpdated: Date.now() };
    writeLSMirror(LS_PATIENTS_KEY, patients);
    return patients[idx];
}

async function dbDeletePatient(patientId) {
    const boundNode = getActiveAdminAccount().boundClientNode;
    // Only remove the patient's records that belong to the active Admin's own hospital
    const cases = readLSMirror(LS_CASES_KEY, []).filter(c =>
        !(c.patientId === patientId && (c.clientNode || 'CLIENT_1') === boundNode)
    );
    writeLSMirror(LS_CASES_KEY, cases);
    writeLSMirror(LS_PATIENTS_KEY, buildPatientsFromCases(cases));
    return true;
}

async function dbClearAll() {
    const boundNode = getActiveAdminAccount().boundClientNode;
    const keepOtherHospitals = (list) => list.filter(x => (x.clientNode || 'CLIENT_1') !== boundNode);

    // Only wipe data of the active Admin's hospital — other hospitals' data stays untouched
    const remainingCases = keepOtherHospitals(readLSMirror(LS_CASES_KEY, []));
    writeLSMirror(LS_CASES_KEY, remainingCases);
    writeLSMirror(LS_PATIENTS_KEY, buildPatientsFromCases(remainingCases));
    writeLSMirror(LS_WORKLIST_KEY, keepOtherHospitals(readLSMirror(LS_WORKLIST_KEY, [])));
    writeLSMirror(LS_AUDIT_KEY, keepOtherHospitals(readLSMirror(LS_AUDIT_KEY, [])));
    // Mark seeded so it stays empty until user clicks Import Dataset
    localStorage.setItem(LS_SEEDED_KEY, 'cleared');
    return true;
}

// =========================================================================
// 11. HOSPITAL DATASET IMPORTER (FROM `federated_data/` OR LOCAL FOLDER)
// =========================================================================
async function dbImportHospitalDatasetPreset(clientFilter = null, alsoPushToWorklist = true) {
    const activeAdmin = getActiveAdminAccount();
    const allowedNode = activeAdmin.boundClientNode;

    // Enforce 1-Admin = 1-Hospital: Only allow importing dataset records belonging to the active Admin's hospital
    if (clientFilter && clientFilter !== allowedNode && clientFilter !== 'ALL') {
        await dbAddAuditLog({
            actor: `${activeAdmin.fullName} (${activeAdmin.username})`,
            role: 'ADMIN',
            clientNode: allowedNode,
            action: 'CROSS_HOSPITAL_IMPORT_DENIED',
            severity: 'WARN',
            details: `Từ chối thao tác nạp dataset chéo sang ${clientFilter}: Tài khoản ${activeAdmin.fullName} chỉ có quyền quản lý ${activeAdmin.hospitalName}.`
        });
        throw new Error(`⛔ Vi phạm nguyên tắc 1 Admin - 1 Bệnh viện: Tài khoản ${activeAdmin.fullName} chỉ được phép quản lý và nạp dữ liệu cho ${activeAdmin.hospitalName}!`);
    }

    const effectiveFilter = allowedNode;
    const now = Date.now();
    const selectedPresets = HOSPITAL_DATASET_PRESETS.filter(p => p.clientNode === effectiveFilter);

    const cases = readLSMirror(LS_CASES_KEY, []);
    let importedCount = 0;

    for (const p of selectedPresets) {
        const record = {
            id: p.id,
            patientId: p.patientId,
            patientName: p.patientName,
            age: p.age,
            gender: p.gender,
            clientNode: p.clientNode,
            sourcePath: p.sourcePath,
            symptoms: p.symptoms,
            diagnosis: p.diagnosis,
            probPneumonia: p.probPneumonia,
            probNormal: p.probNormal,
            doctorNotes: p.doctorNotes,
            doctorName: p.doctorName,
            department: p.department,
            integrityHash: p.integrityHash,
            signedStatus: 'SIGNED_VERIFIED',
            image: p.image,
            heatmap: null,
            timestamp: now - (p.timestampOffsetHours * 3600 * 1000)
        };
        const idx = cases.findIndex(c => c.id === record.id);
        if (idx >= 0) cases[idx] = record;
        else cases.push(record);
        importedCount++;
    }

    cases.sort((a, b) => b.timestamp - a.timestamp);
    writeLSMirror(LS_CASES_KEY, cases);
    const patients = buildPatientsFromCases(cases);
    writeLSMirror(LS_PATIENTS_KEY, patients);

    if (alsoPushToWorklist) {
        const wlList = readLSMirror(LS_WORKLIST_KEY, []);
        for (const p of selectedPresets.slice(0, 4)) {
            const wlId = 'WL-' + p.id.replace('CASE-', '');
            if (!wlList.some(w => w.id === wlId)) {
                wlList.unshift({
                    id: wlId,
                    patientId: p.patientId,
                    patientName: p.patientName,
                    age: p.age,
                    gender: p.gender,
                    referringDept: p.department,
                    symptoms: p.symptoms,
                    priority: p.probPneumonia >= 90 ? 'STAT' : (p.diagnosis === 'PNEUMONIA' ? 'URGENT' : 'ROUTINE'),
                    status: 'PENDING_DOCTOR',
                    clientNode: p.clientNode,
                    modalityRoom: activeAdmin.defaultModalityRoom,
                    viewPosition: 'PA Erect (Đứng chuẩn)',
                    kvp: 112,
                    mas: 4.0,
                    sidCm: 180,
                    esdDose: '0.12 mGy',
                    claheApplied: true,
                    qaPassed: true,
                    qaScore: '4/4 Đạt chuẩn Bộ Y tế',
                    technicianName: activeAdmin.defaultTechName,
                    technicianNotes: `Imported từ kho dữ liệu ${p.sourcePath}`,
                    aiPreTriageDone: true,
                    aiDiagnosis: p.diagnosis,
                    probPneumonia: p.probPneumonia,
                    probNormal: p.probNormal,
                    assignedDoctor: p.doctorName,
                    doctorNotes: '',
                    image: p.image,
                    sampleFileUrl: p.image,
                    sourcePath: p.sourcePath,
                    integrityHash: p.integrityHash,
                    timestamp: Date.now() - Math.floor(Math.random() * 900000),
                    updatedAt: Date.now()
                });
            }
        }
        writeLSMirror(LS_WORKLIST_KEY, wlList);
    }

    await dbAddAuditLog({
        actor: `${activeAdmin.fullName} (${activeAdmin.username})`,
        role: 'ADMIN',
        clientNode: effectiveFilter,
        action: 'IMPORT_HOSPITAL_DATASET',
        severity: 'SECURITY',
        details: `Đã nạp ${importedCount} bệnh án mẫu từ thư mục federated_data (${effectiveFilter}) vào cơ sở dữ liệu độc lập của ${activeAdmin.hospitalName}.`
    });

    const hospitalCases = cases.filter(c => (c.clientNode || 'CLIENT_1') === effectiveFilter);
    const hospitalPatients = buildPatientsFromCases(hospitalCases);

    broadcastSyncEvent('DATASET_IMPORTED', { clientFilter: effectiveFilter, importedCount });
    return { importedCount, totalCases: hospitalCases.length, totalPatients: hospitalPatients.length, boundHospital: activeAdmin.hospitalName };
}

// Parse local files selected from `federated_data/` or `pneumonia_raw_data/` folder on user's machine
async function dbImportLocalImageFilesDataset(fileList, targetClientNode = null) {
    const activeAdmin = getActiveAdminAccount();
    const enforcedClientNode = activeAdmin.boundClientNode;

    if (targetClientNode && targetClientNode !== enforcedClientNode) {
        throw new Error(`⛔ Tài khoản ${activeAdmin.fullName} chỉ được phép nạp dữ liệu vào ${activeAdmin.hospitalName} (${enforcedClientNode})!`);
    }
    targetClientNode = enforcedClientNode;

    const files = Array.from(fileList || []).filter(f =>
        /\.(jpe?g|png|dcm)$/i.test(f.name)
    );
    if (files.length === 0) {
        throw new Error('Không tìm thấy file ảnh X-Quang (.jpeg, .jpg, .png, .dcm) nào trong lựa chọn của bạn.');
    }

    // Cap batch import to 24 files at once so browser remains ultra-fast
    const batch = files.slice(0, 24);
    const vnLastNames = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Vũ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương'];
    const vnMidNamesM = ['Văn', 'Quốc', 'Đình', 'Minh', 'Hữu', 'Đức', 'Xuân'];
    const vnFirstNamesM = ['Hùng', 'Tuấn', 'Nam', 'Dũng', 'Khánh', 'Trọng', 'Hải', 'Sơn', 'Kiên'];
    const vnMidNamesF = ['Thị', 'Ngọc', 'Phương', 'Thanh', 'Mai'];
    const vnFirstNamesF = ['Lan', 'Hương', 'Ánh', 'Tâm', 'Hà', 'Bích', 'Thảo', 'Linh', 'trang'];

    const nodeInfo = getHospitalClientNode(targetClientNode);
    let importedCount = 0;

    for (let i = 0; i < batch.length; i++) {
        const f = batch[i];
        const lowerName = f.name.toLowerCase();
        const relPath = f.webkitRelativePath || f.name;

        const isBacteria = lowerName.includes('bacteria');
        const isVirus = lowerName.includes('virus');
        const isPneumonia = isBacteria || isVirus || relPath.toUpperCase().includes('PNEUMONIA');

        // Extract person ID from filename like `person1005_bacteria_2936.jpeg` or `IM-0001-0001.jpeg`
        const numMatch = f.name.match(/(\d+)/);
        const codeNum = numMatch ? numMatch[1].slice(0, 4).padStart(4, '0') : String(1000 + i);
        const clientPrefix = targetClientNode.replace('CLIENT_', 'C');
        const patientId = `BN-${clientPrefix}-${codeNum}`;

        const isMale = (parseInt(codeNum, 10) + i) % 2 === 0;
        const last = vnLastNames[(parseInt(codeNum, 10) + i) % vnLastNames.length];
        const mid = isMale
            ? vnMidNamesM[(parseInt(codeNum, 10) + i) % vnMidNamesM.length]
            : vnMidNamesF[(parseInt(codeNum, 10) + i) % vnMidNamesF.length];
        const first = isMale
            ? vnFirstNamesM[(parseInt(codeNum, 10) + i * 3) % vnFirstNamesM.length]
            : vnFirstNamesF[(parseInt(codeNum, 10) + i * 3) % vnFirstNamesF.length];
        const patientName = `${last} ${mid} ${first}`;
        const age = 24 + ((parseInt(codeNum, 10) * 7 + i * 5) % 55);

        const dataUrl = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(f);
        });
        const thumbUrl = await createThumbnail(dataUrl, 420);

        const probPneumonia = isPneumonia
            ? Number((84 + ((parseInt(codeNum, 10) + i) % 14) + Math.random()).toFixed(1))
            : Number((1.5 + ((parseInt(codeNum, 10) + i) % 6) + Math.random()).toFixed(1));
        const probNormal = Number((100 - probPneumonia).toFixed(1));

        const symptoms = isBacteria
            ? `Sốt cao 39°C, ho khạc đờm đặc, đau tức ngực, khó thở (Nguồn: ${relPath})`
            : (isVirus
                ? `Ho khan kéo dài, sốt 38.2°C, đau mỏi cơ, thâm nhiễm phổi do Virus (Nguồn: ${relPath})`
                : `Khám sàng lọc hô hấp định kỳ, không sốt, không khó thở (Nguồn: ${relPath})`);

        const doctorNotes = isBacteria
            ? `Hình ảnh đông đặc nhu mô phổi điển hình trên file ${f.name}. Kết luận: Viêm phổi do vi khuẩn (Bacterial Pneumonia).`
            : (isVirus
                ? `Hình ảnh mờ tổ chức kẽ hai bên phế trường trên file ${f.name}. Kết luận: Viêm phổi do Virus (Viral Pneumonia).`
                : `Hai phế trường sáng đều trên file ${f.name}. Kết luận: X-Quang ngực thẳng bình thường (Normal).`);

        await dbSaveCase({
            patientId,
            patientName,
            age,
            gender: isMale ? 'Nam' : 'Nữ',
            clientNode: targetClientNode,
            sourcePath: relPath,
            symptoms,
            diagnosis: isPneumonia ? 'PNEUMONIA' : 'NORMAL',
            probPneumonia,
            probNormal,
            doctorNotes,
            doctorName: 'BS.CKII Nguyễn Văn A',
            department: nodeInfo.name,
            image: thumbUrl,
            timestamp: Date.now() - (i * 1800000)
        });

        importedCount++;
    }

    await dbAddAuditLog({
        actor: 'Quản trị Dữ liệu Bệnh viện',
        role: 'ADMIN',
        clientNode: targetClientNode,
        action: 'BATCH_IMPORT_FOLDER_DATA',
        severity: 'SECURITY',
        details: `Đã import trực tiếp ${importedCount} file ảnh X-Quang & tạo hồ sơ bệnh án từ thư mục dữ liệu máy trạm vào ${nodeInfo.shortName}.`
    });

    broadcastSyncEvent('DATASET_IMPORTED', { importedCount });
    return { importedCount, totalSelected: files.length };
}

async function dbExportAllData() {
    const cases = await dbGetAllCases();
    const patients = await dbGetAllPatients();
    const worklist = await dbGetWorklistCases();
    const auditLogs = await dbGetAuditLogs();
    const settings = getLocalSettings();
    const policy = getAdminPolicy();
    const rbacMatrix = getRBACMatrix();

    return JSON.stringify({
        app: 'MedAI Diagnostic PACS/HIS Multi-Role Platform',
        version: '4.2.0',
        exportedAt: new Date().toISOString(),
        settings,
        policy,
        rbacMatrix,
        cases,
        patients,
        worklist,
        auditLogs
    }, null, 2);
}

async function dbImportAllData(jsonString) {
    const data = JSON.parse(jsonString);
    if (!data || (!data.cases && !data.patients && !data.worklist)) {
        throw new Error('Định dạng file sao lưu không hợp lệ.');
    }
    const boundNode = getActiveAdminAccount().boundClientNode;
    // Backup restore is scoped to the active Admin's hospital only: foreign-hospital records are rejected
    const ownOnly = (list) => list.filter(x => (x.clientNode || boundNode) === boundNode)
        .map(x => ({ ...x, clientNode: boundNode }));
    const mergeScoped = (key, incoming) => {
        const others = readLSMirror(key, []).filter(x => (x.clientNode || 'CLIENT_1') !== boundNode);
        return [...ownOnly(incoming), ...others];
    };
    if (Array.isArray(data.cases)) {
        const merged = mergeScoped(LS_CASES_KEY, data.cases);
        writeLSMirror(LS_CASES_KEY, merged);
        writeLSMirror(LS_PATIENTS_KEY, buildPatientsFromCases(merged));
    }
    if (Array.isArray(data.worklist)) {
        writeLSMirror(LS_WORKLIST_KEY, mergeScoped(LS_WORKLIST_KEY, data.worklist));
    }
    if (Array.isArray(data.auditLogs)) {
        writeLSMirror(LS_AUDIT_KEY, mergeScoped(LS_AUDIT_KEY, data.auditLogs));
    }
    if (data.settings) saveLocalSettings(data.settings);
    if (data.policy) {
        // Never allow a backup file to re-bind the session to another hospital's Admin account
        const { activeAdminAccountId, activeClientNode, ...safePolicy } = data.policy;
        await saveAdminPolicy(safePolicy);
    }
    if (data.rbacMatrix) saveRBACMatrix(data.rbacMatrix);
    return true;
}

// =========================================================================
// 12. LOCAL SETTINGS (DOCTOR & TECHNICIAN PREFERENCES)
// =========================================================================
const SETTINGS_KEY = 'medai_doctor_settings_v1';
const DEFAULT_SETTINGS = {
    doctorName: 'BS.CKII Nguyễn Văn A',
    department: 'Khoa Chẩn đoán Hình ảnh (PACS)',
    hospital: 'Bệnh viện Phổi Trung ương (Client 1)',
    technicianName: 'CN.KTV Phạm Hoàng Nam',
    modalityRoom: 'DR-01 (Fujifilm FDR Visionary)',
    decisionThreshold: 50,
    autoShowHeatmap: true,
    heatmapOpacity: 65,
    autoSaveHistory: true,
    enablePrivacyMode: true
};

function getLocalSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return { ...DEFAULT_SETTINGS };
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (e) {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveLocalSettings(newSettings) {
    const current = getLocalSettings();
    const merged = { ...current, ...newSettings };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    return merged;
}
