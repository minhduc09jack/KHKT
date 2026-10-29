/**
 * MedAI PACS/HIS v4.0 - X-Ray Room Technician (Modality Workstation) Logic
 * Handles image acquisition, DICOM/JPEG calibration, QA/QC verification,
 * AI Pre-Triage, and pushing exams to the Diagnostic Doctor Worklist.
 */

let techCurrentFile = null;
let techCurrentImageDataUrl = null;
let techSampleUrl = null;
let techPreTriageResult = null;
let techEditingWorklistId = null;

// Darkroom transform states
let techInverted = false;
let techRotation = 0;
let techFlippedX = false;

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatDate(timestamp) {
    if (!timestamp) return '—';
    return new Date(timestamp).toLocaleString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
}

function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3200);
}

// =========================================================================
// ROUTER & INITIALIZATION
// =========================================================================
function techNavigateTo(route) {
    const hash = '#/' + route;
    if (window.location.hash !== hash) {
        window.location.hash = hash;
    }

    document.querySelectorAll('.view-panel').forEach(p => {
        p.classList.add('hidden');
        p.classList.remove('active');
    });

    document.querySelectorAll('.nav-links .nav-item').forEach(item => {
        item.classList.remove('active');
    });

    const activeNav = document.querySelector(`.nav-links .nav-item[data-route="${route}"]`);
    if (activeNav) activeNav.classList.add('active');

    const panel = document.getElementById('view-' + route);
    if (panel) {
        panel.classList.remove('hidden');
        panel.classList.add('active');
    }

    const mainContent = document.getElementById('tech-main-content');
    if (mainContent) mainContent.scrollTop = 0;

    if (route === 'acquire') {
        renderRetakeAlertStrip();
    } else if (route === 'worklist-sent') {
        renderTechSentWorklistView();
    } else if (route === 'modality-qa') {
        renderModalityQAView();
    } else if (route === 'tech-profile') {
        renderTechProfileView();
    }
}

window.addEventListener('hashchange', () => {
    const route = window.location.hash.replace(/^#\/?/, '') || 'acquire';
    if (['acquire', 'worklist-sent', 'modality-qa', 'tech-profile'].includes(route)) {
        techNavigateTo(route);
    } else {
        techNavigateTo('acquire');
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    applyTechProfileSidebar();
    recalcRadiationDose();
    updateTechQAScore();

    const uploadZone = document.getElementById('tech-upload-zone');
    const fileInput = document.getElementById('tech-file-input');

    if (uploadZone && fileInput) {
        uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadZone.classList.add('dragover');
        });
        uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('dragover');
            if (e.dataTransfer.files.length) {
                handleTechFile(e.dataTransfer.files[0]);
            }
        });
        uploadZone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length) {
                handleTechFile(e.target.files[0]);
            }
        });
    }

    const route = window.location.hash.replace(/^#\/?/, '') || 'acquire';
    techNavigateTo(route);
    await refreshTechBadges();
});

window.refreshTechnicianViews = async function () {
    await refreshTechBadges();
    await renderRetakeAlertStrip();
    const route = window.location.hash.replace(/^#\/?/, '') || 'acquire';
    if (route === 'worklist-sent') {
        renderTechSentWorklistView();
    }
};

async function refreshTechBadges() {
    if (typeof dbGetWorklistCases !== 'function') return;
    const list = await dbGetWorklistCases();
    const sentBadge = document.getElementById('tech-sent-badge');
    if (sentBadge) sentBadge.textContent = list.length;
    const docPendingBadge = document.getElementById('sidebar-worklist-badge');
    if (docPendingBadge) {
        const pending = list.filter(x => x.status === 'PENDING_DOCTOR').length;
        docPendingBadge.textContent = pending;
        docPendingBadge.classList.toggle('has-items', pending > 0);
    }
}

function applyTechProfileSidebar() {
    const s = typeof getLocalSettings === 'function' ? getLocalSettings() : {};
    const nameEl = document.getElementById('sidebar-tech-name');
    const roomEl = document.getElementById('sidebar-tech-room');
    const avatarEl = document.getElementById('sidebar-tech-avatar');

    const techName = s.technicianName || 'CN.KTV Phạm Hoàng Nam';
    const roomName = s.modalityRoom || 'DR-01 (Fujifilm FDR Visionary)';

    if (nameEl) nameEl.textContent = techName;
    if (roomEl) roomEl.textContent = roomName;
    if (avatarEl) {
        avatarEl.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(techName)}&background=0D9488&color=fff`;
    }
}

// =========================================================================
// RADIATION DOSE CALCULATOR & DARKROOM IMAGE TOOLS
// =========================================================================
function recalcRadiationDose() {
    const kvp = parseFloat(document.getElementById('tech-kvp')?.value || 110);
    const mas = parseFloat(document.getElementById('tech-mas')?.value || 4.0);
    const sid = parseFloat(document.getElementById('tech-sid')?.value || 180);
    const viewPos = document.getElementById('tech-view-pos')?.value || 'PA Erect';

    // Standard diagnostic X-ray entrance skin dose (ESD) approximation in mGy
    const esd = (0.024 * Math.pow(kvp / 100, 2) * mas * Math.pow(180 / Math.max(sid, 80), 2)).toFixed(2);
    const esdEl = document.getElementById('tech-esd-val');
    const boxEl = document.getElementById('tech-dose-readout');

    if (esdEl) esdEl.textContent = `${esd} mGy`;
    if (boxEl) {
        const statusSpan = boxEl.querySelector('span');
        if (parseFloat(esd) <= 0.30) {
            statusSpan.className = 'dose-status-ok';
            statusSpan.textContent = 'Đạt chuẩn ALARA (<0.30 mGy)';
        } else {
            statusSpan.className = 'dose-status-warn';
            statusSpan.textContent = 'Cảnh báo liều cao (>0.30 mGy)';
        }
    }

    const overlayMeta = document.getElementById('overlay-kvp-mas');
    if (overlayMeta) {
        const shortPos = viewPos.split(' ')[0] || 'PA';
        overlayMeta.textContent = `${shortPos} • ${kvp} kVp • ${mas} mAs • ${esd} mGy`;
    }
    return `${esd} mGy`;
}

function handleTechFile(file, sampleUrl = null) {
    techCurrentFile = file;
    techSampleUrl = sampleUrl;
    techPreTriageResult = null;

    const pretriageResEl = document.getElementById('tech-pretriage-result');
    if (pretriageResEl) {
        pretriageResEl.classList.add('hidden');
        pretriageResEl.innerHTML = '';
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        techCurrentImageDataUrl = e.target.result;
        const previewImg = document.getElementById('tech-preview-image');
        if (previewImg) previewImg.src = techCurrentImageDataUrl;

        document.getElementById('tech-upload-zone')?.classList.add('hidden');
        document.getElementById('tech-viewer-container')?.classList.remove('hidden');
        resetTechDarkroomFilters();
        recalcRadiationDose();
    };
    reader.readAsDataURL(file);
}

function applyTechDarkroomFilters() {
    const img = document.getElementById('tech-preview-image');
    if (!img) return;

    const b = document.getElementById('tech-slider-bright')?.value || 100;
    const c = document.getElementById('tech-slider-contrast')?.value || 105;

    const lblB = document.getElementById('lbl-bright');
    const lblC = document.getElementById('lbl-contrast');
    if (lblB) lblB.textContent = b + '%';
    if (lblC) lblC.textContent = c + '%';

    const filters = [`brightness(${b}%)`, `contrast(${c}%)`];
    if (techInverted) filters.push('invert(1)');
    img.style.filter = filters.join(' ');

    const scaleX = techFlippedX ? -1 : 1;
    img.style.transform = `rotate(${techRotation}deg) scaleX(${scaleX})`;
}

function toggleTechInvert() {
    techInverted = !techInverted;
    applyTechDarkroomFilters();
}

function rotateTechImage() {
    techRotation = (techRotation + 90) % 360;
    applyTechDarkroomFilters();
}

function flipTechImage() {
    techFlippedX = !techFlippedX;
    applyTechDarkroomFilters();
}

function resetTechDarkroomFilters() {
    techInverted = false;
    techRotation = 0;
    techFlippedX = false;
    const sb = document.getElementById('tech-slider-bright');
    const sc = document.getElementById('tech-slider-contrast');
    if (sb) sb.value = 100;
    if (sc) sc.value = 105;
    applyTechDarkroomFilters();
}

function clearTechUploadedImage() {
    techCurrentFile = null;
    techCurrentImageDataUrl = null;
    techSampleUrl = null;
    techPreTriageResult = null;
    const fi = document.getElementById('tech-file-input');
    if (fi) fi.value = '';
    document.getElementById('tech-viewer-container')?.classList.add('hidden');
    document.getElementById('tech-upload-zone')?.classList.remove('hidden');
    document.getElementById('tech-pretriage-result')?.classList.add('hidden');
}

function updateTechQAScore() {
    const checks = Array.from(document.querySelectorAll('.tech-qa-checkbox'));
    const passedCount = checks.filter(c => c.checked).length;
    const badge = document.getElementById('tech-qa-status-badge');
    if (badge) {
        badge.textContent = `${passedCount}/${checks.length} Đạt chuẩn`;
        badge.style.background = passedCount === checks.length ? 'rgba(5, 150, 105, 0.9)' : 'rgba(217, 119, 6, 0.9)';
    }
    return {
        passed: passedCount === checks.length,
        scoreText: `${passedCount}/${checks.length} Đạt chuẩn Bộ Y tế`
    };
}

// =========================================================================
// QUICK SAMPLE LOADER FOR TECHNICIAN
// =========================================================================
async function loadTechSampleCase(type) {
    let filename = '';
    let info = {};

    if (type === 'bacteria') {
        filename = 'assets/samples/sample_bacteria.jpeg';
        info = {
            id: 'BN-CC' + Math.floor(1000 + Math.random() * 8999),
            name: 'Nguyễn Văn Minh',
            age: 58,
            gender: 'Nam',
            dept: 'Khoa Cấp cứu - Hồi sức (ICU)',
            priority: 'STAT',
            viewPos: 'PA Erect (Đứng chuẩn sau-trước)',
            kvp: 115,
            mas: 4.5,
            symptoms: 'Sốt cao 39.2°C, khó thở cấp, SpO2 92%, ho đờm đặc, đau tức ngực phải',
            notes: 'Bệnh nhân cấp cứu khó thở, đã cân bằng sáng CLAHE rõ vùng đông đặc thùy dưới phổi phải. Kính chuyển Bác sĩ đọc khẩn STAT!'
        };
    } else if (type === 'virus') {
        filename = 'assets/samples/sample_virus.jpeg';
        info = {
            id: 'BN-HH' + Math.floor(1000 + Math.random() * 8999),
            name: 'Lê Hoàng Anh',
            age: 34,
            gender: 'Nữ',
            dept: 'Khoa Nội Hô hấp',
            priority: 'URGENT',
            viewPos: 'PA Erect (Đứng chuẩn sau-trước)',
            kvp: 110,
            mas: 3.8,
            symptoms: 'Sốt 38.3°C kéo dài 5 ngày, ho khan liên tục, đau mỏi cơ, nghi viêm phổi virus',
            notes: 'Phim đạt chuẩn QA 4/4, hít đủ 10 cung sườn sau, thấy mờ mô kẽ hai bên phế trường.'
        };
    } else {
        filename = 'assets/samples/sample_normal.jpeg';
        info = {
            id: 'BN-KS' + Math.floor(1000 + Math.random() * 8999),
            name: 'Phạm Thị Lan',
            age: 29,
            gender: 'Nữ',
            dept: 'Trung tâm Khám Sức khỏe Định kỳ',
            priority: 'ROUTINE',
            viewPos: 'PA Erect (Đứng chuẩn sau-trước)',
            kvp: 108,
            mas: 3.2,
            symptoms: 'Khám sức khỏe định kỳ tổng quát, không ho, không sốt, không khó thở',
            notes: 'Phim chụp chuẩn tư thế PA đứng, trường phổi hai bên sáng rõ, chuyển Bác sĩ ký xác nhận.'
        };
    }

    document.getElementById('tech-patient-id').value = info.id;
    document.getElementById('tech-patient-name').value = info.name;
    document.getElementById('tech-patient-age').value = info.age;
    document.getElementById('tech-patient-gender').value = info.gender;
    document.getElementById('tech-referring-dept').value = info.dept;
    document.getElementById('tech-priority').value = info.priority;
    document.getElementById('tech-view-pos').value = info.viewPos;
    document.getElementById('tech-kvp').value = info.kvp;
    document.getElementById('tech-mas').value = info.mas;
    document.getElementById('tech-symptoms').value = info.symptoms;
    document.getElementById('tech-notes').value = info.notes;

    recalcRadiationDose();

    try {
        const res = await fetch(filename);
        const blob = await res.blob();
        const file = new File([blob], filename.split('/').pop(), { type: 'image/jpeg' });
        handleTechFile(file, filename);
        showToast(`🩻 Đã nạp ca chụp ${info.id} (${info.name}). Sẵn sàng kiểm chuẩn & gửi Bác sĩ!`);
    } catch (e) {
        showToast('⚠️ Không thể tải ảnh mẫu.');
    }
}

// =========================================================================
// AI PRE-TRIAGE AT X-RAY ROOM (STRICTLY FOR PRIORITY TRIAGE)
// =========================================================================
async function runTechAIPreTriage() {
    const policy = typeof getAdminPolicy === 'function' ? getAdminPolicy() : {};
    if (policy.emergencyLockdown) {
        showToast('🔒 Hệ thống đang Khóa Khẩn Cấp bởi Admin Bệnh viện.');
        return;
    }
    if (typeof hasPermission === 'function' && !hasPermission('TECHNICIAN', 'perm_ai_pretriage')) {
        showToast('⛔ Quyền chạy AI Pre-Triage của Kỹ thuật viên hiện đang bị Admin giới hạn.');
        return;
    }
    if (!techCurrentFile && !techCurrentImageDataUrl) {
        showToast('⚠️ Vui lòng thu nhận ảnh X-Quang trước khi chạy AI Sàng lọc!');
        return;
    }

    const btn = document.getElementById('btn-tech-pretriage');
    const resultBox = document.getElementById('tech-pretriage-result');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Đang sàng lọc...';
    }

    try {
        const formData = new FormData();
        if (techCurrentFile) {
            formData.append('file', techCurrentFile);
        } else {
            const r = await fetch(techCurrentImageDataUrl);
            const b = await r.blob();
            formData.append('file', b, 'tech_xray.jpg');
        }

        const response = await fetch('/api/predict', { method: 'POST', body: formData });
        const data = await response.json();

        if (data.status === 'success') {
            const probP = data.probabilities.pneumonia;
            const probN = data.probabilities.normal;
            const threshold = policy.globalDecisionThreshold || 50;
            const isPneumonia = probP >= threshold;

            techPreTriageResult = {
                aiPreTriageDone: true,
                aiDiagnosis: isPneumonia ? 'PNEUMONIA' : 'NORMAL',
                probPneumonia: probP,
                probNormal: probN,
                heatmap: data.heatmap_base64 ? ('data:image/jpeg;base64,' + data.heatmap_base64) : null,
                imageSha256: data.image_sha256
            };

            if (isPneumonia) {
                // Auto escalate priority to STAT
                const priSelect = document.getElementById('tech-priority');
                if (priSelect) priSelect.value = 'STAT';
            }

            if (resultBox) {
                resultBox.classList.remove('hidden');
                resultBox.innerHTML = isPneumonia
                    ? `<div class="pretriage-alert danger">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <div>
                            <strong>CẢNH BÁO SÀNG LỌC AI: Nghi ngờ tổn thương Viêm phổi (${probP.toFixed(1)}%)</strong>
                            <div>Hệ thống đã tự động nâng mức ưu tiên lên <strong>🚨 STAT (Cấp cứu tối khẩn)</strong> để đẩy lên đầu hàng đợi của Bác sĩ Chẩn đoán.</div>
                        </div>
                       </div>`
                    : `<div class="pretriage-alert success">
                        <i class="fa-solid fa-circle-check"></i>
                        <div>
                            <strong>SÀNG LỌC AI: Chưa phát hiện bất thường cấp tính (Normal: ${probN.toFixed(1)}%)</strong>
                            <div>Phim đủ điều kiện chuyển sang Hàng đợi Bác sĩ đọc kết quả thường quy.</div>
                        </div>
                       </div>`;
            }
            showToast('✅ Đã hoàn tất AI Sàng lọc Ưu tiên (AI Pre-Triage)!');
        } else {
            showToast('⚠️ ' + (data.error || 'Không thể chạy AI Pre-Triage'));
        }
    } catch (e) {
        showToast('❌ Lỗi kết nối API khi chạy AI Pre-Triage.');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Chạy AI Sàng lọc';
        }
    }
}

// =========================================================================
// PUSH EXAM TO DOCTOR WORKLIST (CORE WORKFLOW)
// =========================================================================
async function pushExamToDoctorWorklist(openDoctorPortalAfter = false) {
    const policy = typeof getAdminPolicy === 'function' ? getAdminPolicy() : {};
    if (policy.emergencyLockdown) {
        showToast('🔒 Hệ thống đang Khóa Khẩn Cấp bởi Admin Bệnh viện!');
        return;
    }
    if (typeof hasPermission === 'function' && !hasPermission('TECHNICIAN', 'perm_push_worklist')) {
        showToast('⛔ Tài khoản KTV không có quyền đẩy ca chụp vào hàng đợi theo cấu hình RBAC.');
        return;
    }

    const patientId = (document.getElementById('tech-patient-id')?.value || '').trim();
    const patientName = (document.getElementById('tech-patient-name')?.value || '').trim();
    if (!patientId || !patientName) {
        showToast('⚠️ Vui lòng nhập đầy đủ Mã Bệnh Nhân và Họ tên trước khi gửi Bác sĩ!');
        document.getElementById('tech-patient-id')?.focus();
        return;
    }

    if (!techCurrentImageDataUrl) {
        showToast('⚠️ Vui lòng thu nhận hoặc chọn ảnh X-Quang trước khi gửi sang Bác sĩ!');
        return;
    }

    const qaStatus = updateTechQAScore();
    if (policy.requireTechQA && !qaStatus.passed) {
        showToast('⚠️ Chính sách Bệnh viện yêu cầu KTV hoàn thành đủ 4/4 tiêu chí Kiểm định Chất lượng Phim (QA/QC) trước khi gửi Bác sĩ!');
        return;
    }

    const settings = getLocalSettings();
    const esdDose = recalcRadiationDose();

    const wlPayload = {
        id: techEditingWorklistId || undefined,
        patientId,
        patientName,
        age: parseInt(document.getElementById('tech-patient-age')?.value || '45', 10),
        gender: document.getElementById('tech-patient-gender')?.value || 'Nam',
        referringDept: document.getElementById('tech-referring-dept')?.value || 'Khoa Cấp cứu',
        priority: document.getElementById('tech-priority')?.value || 'ROUTINE',
        status: 'PENDING_DOCTOR',
        assignedDoctor: document.getElementById('tech-assigned-doc')?.value || 'BS.CKII Nguyễn Văn A',
        symptoms: document.getElementById('tech-symptoms')?.value || '',
        modalityRoom: document.getElementById('tech-modality-room')?.value || 'DR-01 (Fujifilm FDR Visionary)',
        viewPosition: document.getElementById('tech-view-pos')?.value || 'PA Erect (Đứng chuẩn)',
        kvp: parseInt(document.getElementById('tech-kvp')?.value || '110', 10),
        mas: parseFloat(document.getElementById('tech-mas')?.value || '4.0'),
        sidCm: parseInt(document.getElementById('tech-sid')?.value || '180', 10),
        esdDose,
        claheApplied: true,
        qaPassed: qaStatus.passed,
        qaScore: qaStatus.scoreText,
        technicianName: settings.technicianName || 'CN.KTV Phạm Hoàng Nam',
        technicianNotes: document.getElementById('tech-notes')?.value || '',
        aiPreTriageDone: Boolean(techPreTriageResult?.aiPreTriageDone),
        aiDiagnosis: techPreTriageResult?.aiDiagnosis || null,
        probPneumonia: techPreTriageResult?.probPneumonia || 0,
        probNormal: techPreTriageResult?.probNormal || 0,
        image: techCurrentImageDataUrl,
        heatmap: techPreTriageResult?.heatmap || null,
        sampleFileUrl: techSampleUrl || null,
        integrityHash: techPreTriageResult?.imageSha256 || undefined,
        retakeReason: ''
    };

    const savedWl = await dbPushWorklistCase(wlPayload);

    await dbAddAuditLog({
        actor: wlPayload.technicianName,
        role: 'TECHNICIAN',
        action: 'MODALITY_PUSH_TO_DOCTOR',
        severity: wlPayload.priority === 'STAT' ? 'WARN' : 'INFO',
        details: `KTV gửi ca chụp ${savedWl.patientId} (${savedWl.patientName}) [${savedWl.priority}] sang Hàng đợi Bác sĩ ${savedWl.assignedDoctor}. Mã SHA256: ${savedWl.integrityHash}.`
    });

    techEditingWorklistId = null;
    await refreshTechBadges();
    await renderRetakeAlertStrip();

    showToast(`✅ Đã gửi ca chụp ${savedWl.patientId} sang Hàng đợi Bác sĩ Chẩn đoán (${savedWl.assignedDoctor})!`);

    if (openDoctorPortalAfter) {
        setTimeout(() => {
            window.location.href = 'index.html#/new';
        }, 500);
    } else {
        resetTechForm(false);
    }
}

function resetTechForm(toast = true) {
    document.getElementById('tech-order-form')?.reset();
    document.getElementById('tech-notes').value = '';
    clearTechUploadedImage();
    techEditingWorklistId = null;
    document.querySelectorAll('.tech-qa-checkbox').forEach(c => { c.checked = true; });
    updateTechQAScore();
    recalcRadiationDose();
    if (toast) showToast('Đã làm mới trạm chụp X-Quang sẵn sàng tiếp nhận bệnh nhân tiếp theo.');
}

// =========================================================================
// RETAKE ALERT STRIP & SENT WORKLIST TRACKING VIEW
// =========================================================================
async function renderRetakeAlertStrip() {
    const mount = document.getElementById('tech-retake-alert-strip');
    if (!mount || typeof dbGetWorklistCases !== 'function') return;

    const list = await dbGetWorklistCases();
    const retakes = list.filter(x => x.status === 'RETAKE_REQUESTED');

    if (retakes.length === 0) {
        mount.innerHTML = '';
        return;
    }

    mount.innerHTML = `
        <div class="worklist-strip-card retake-alert">
            <div class="wl-strip-header">
                <div class="wl-strip-title">
                    <span class="wl-live-dot pulse-red"></span>
                    <h4>⚠️ Yêu cầu Chụp lại từ Bác sĩ Chẩn đoán (${retakes.length} ca cần thực hiện lại)</h4>
                </div>
            </div>
            <div class="wl-mini-list">
                ${retakes.map(item => `
                    <div class="wl-mini-item stat">
                        <div class="wl-mini-info">
                            <div class="wl-mini-top">
                                <span class="wl-pri-badge stat">YÊU CẦU CHỤP LẠI</span>
                                <strong>${escapeHtml(item.patientId)} — ${escapeHtml(item.patientName)}</strong>
                                <span class="text-muted">• BS yêu cầu: ${escapeHtml(item.assignedDoctor)}</span>
                            </div>
                            <div class="wl-mini-meta" style="color: var(--danger); font-weight:600;">
                                <i class="fa-solid fa-comment-dots"></i> Lý do: "${escapeHtml(item.retakeReason || 'Đề nghị chụp lại đảm bảo độ nét')}"
                            </div>
                        </div>
                        <div class="wl-mini-action">
                            <button class="btn btn-primary btn-sm" onclick="loadRetakeIntoTechStation('${escapeHtml(item.id)}')">
                                <i class="fa-solid fa-camera-rotate"></i> Nạp lại & Chụp lại ngay
                            </button>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

async function loadRetakeIntoTechStation(worklistId) {
    const item = await dbGetWorklistById(worklistId);
    if (!item) return;

    techNavigateTo('acquire');
    techEditingWorklistId = item.id;

    document.getElementById('tech-patient-id').value = item.patientId || '';
    document.getElementById('tech-patient-name').value = item.patientName || '';
    document.getElementById('tech-patient-age').value = item.age || 45;
    document.getElementById('tech-patient-gender').value = item.gender || 'Nam';
    document.getElementById('tech-referring-dept').value = item.referringDept || 'Khoa Cấp cứu - Hồi sức (ICU)';
    document.getElementById('tech-priority').value = 'STAT';
    document.getElementById('tech-symptoms').value = item.symptoms || '';
    document.getElementById('tech-notes').value = `Đã chụp lại lần 2 theo yêu cầu của ${item.assignedDoctor}. Đã kiểm tra kỹ tư thế và độ hít sâu.`;

    if (item.image) {
        const res = await fetch(item.image);
        const blob = await res.blob();
        const file = new File([blob], 'retake.jpg', { type: 'image/jpeg' });
        handleTechFile(file, item.sampleFileUrl);
    }
    showToast(`🔄 Đã nạp thông tin ca ${item.patientId} để thực hiện chụp lại.`);
}

async function renderTechSentWorklistView() {
    const container = document.getElementById('view-worklist-sent');
    if (!container) return;

    const list = await dbGetWorklistCases();
    const pending = list.filter(x => x.status === 'PENDING_DOCTOR').length;
    const completed = list.filter(x => x.status === 'COMPLETED').length;
    const retakes = list.filter(x => x.status === 'RETAKE_REQUESTED').length;

    container.innerHTML = `
        <div class="view-header">
            <div>
                <h2>Danh sách Ca Chụp Đã Gửi Bác Sĩ Chẩn Đoán</h2>
                <p>Theo dõi trạng thái tiếp nhận, kết quả đọc phim và chữ ký số phản hồi từ Bác sĩ theo thời gian thực</p>
            </div>
            <div class="view-header-actions">
                <button class="btn btn-secondary" onclick="renderTechSentWorklistView()"><i class="fa-solid fa-arrows-rotate"></i> Làm mới</button>
                <button class="btn btn-primary" onclick="techNavigateTo('acquire')"><i class="fa-solid fa-camera"></i> Chụp ca mới</button>
            </div>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-icon blue"><i class="fa-solid fa-paper-plane"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${list.length}</span>
                    <span class="stat-label">Tổng ca đã chụp & gửi</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon orange"><i class="fa-solid fa-clock"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${pending}</span>
                    <span class="stat-label">Đang chờ Bác sĩ đọc</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon green"><i class="fa-solid fa-file-circle-check"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${completed}</span>
                    <span class="stat-label">Bác sĩ đã ký kết luận</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon red"><i class="fa-solid fa-rotate-left"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${retakes}</span>
                    <span class="stat-label">Yêu cầu chụp lại</span>
                </div>
            </div>
        </div>

        <div class="card table-card" style="margin-top: 22px;">
            <div class="table-responsive">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Ảnh XQ</th>
                            <th>Thời gian gửi</th>
                            <th>Mã BN & Họ tên</th>
                            <th>Ưu tiên</th>
                            <th>Thông số Kỹ thuật & QA</th>
                            <th>Bác sĩ Tiếp nhận & Phản hồi</th>
                            <th>Trạng thái</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${list.map(item => {
                            const priClass = item.priority === 'STAT' ? 'stat' : (item.priority === 'URGENT' ? 'urgent' : 'routine');
                            let statusHtml = '';
                            if (item.status === 'PENDING_DOCTOR') {
                                statusHtml = '<span class="status-badge badge-warning"><span class="pulse-dot orange"></span> Chờ Bác sĩ đọc</span>';
                            } else if (item.status === 'COMPLETED') {
                                statusHtml = '<span class="status-badge badge-success"><span class="pulse-dot green"></span> BS Đã ký kết luận</span>';
                            } else {
                                statusHtml = `<span class="status-badge badge-danger"><span class="pulse-dot red"></span> Cần chụp lại</span>
                                    <div style="margin-top:4px;"><button class="btn btn-primary btn-sm" onclick="loadRetakeIntoTechStation('${escapeHtml(item.id)}')">Chụp lại</button></div>`;
                            }

                            return `
                                <tr>
                                    <td>
                                        <div class="table-thumb">
                                            <img src="${escapeHtml(item.image || 'assets/samples/sample_bacteria.jpeg')}" alt="X-Ray">
                                        </div>
                                    </td>
                                    <td class="text-muted"><small>${formatDate(item.timestamp)}<br>SHA: ${escapeHtml(item.integrityHash)}</small></td>
                                    <td>
                                        <strong>${escapeHtml(item.patientId)}</strong><br>
                                        <span>${escapeHtml(formatPatientNamePHI(item.patientName))}</span>
                                    </td>
                                    <td><span class="wl-pri-badge ${priClass}">${escapeHtml(item.priority)}</span></td>
                                    <td>
                                        <strong>${escapeHtml(item.viewPosition)}</strong><br>
                                        <small class="text-muted">${item.kvp} kVp • ${item.mas} mAs • ${escapeHtml(item.esdDose)}</small><br>
                                        <small class="text-success">${escapeHtml(item.qaScore)}</small>
                                    </td>
                                    <td>
                                        <strong>${escapeHtml(item.assignedDoctor)}</strong>
                                        ${item.doctorNotes ? `<div class="notes-quote" style="margin-top:4px;font-size:12px;">"${escapeHtml(item.doctorNotes)}"</div>` : ''}
                                        ${item.retakeReason ? `<div class="text-danger" style="margin-top:4px;font-size:12px;"><strong>Lý do chụp lại:</strong> ${escapeHtml(item.retakeReason)}</div>` : ''}
                                    </td>
                                    <td>${statusHtml}</td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

// =========================================================================
// VIEW 3: MODALITY HARDWARE QA & RADIATION SAFETY
// =========================================================================
function renderModalityQAView() {
    const container = document.getElementById('view-modality-qa');
    if (!container) return;

    container.innerHTML = `
        <div class="view-header">
            <div>
                <h2>Kiểm chuẩn Thiết bị X-Quang & Giám sát An toàn Bức xạ</h2>
                <p>Tuân thủ Thông tư Liên tịch 13/2014/TTLT-BKHCN-BYT về An toàn bức xạ trong Y tế & Chuẩn DICOM PACS</p>
            </div>
            <div class="view-header-actions">
                <button class="btn btn-primary" onclick="showToast('✅ Đã chạy quy trình Tự kiểm chuẩn Đầu đèn & Tấm nhận ảnh phẳng (Flat-Panel Calibration)!')">
                    <i class="fa-solid fa-gauge-high"></i> Chạy Hiệu chuẩn Flat-Panel (Calibration)
                </button>
            </div>
        </div>

        <div class="settings-grid">
            <div class="card settings-card">
                <div class="card-header">
                    <i class="fa-solid fa-x-ray"></i>
                    <h3>Trạng thái Phần cứng Các Máy Chụp X-Quang Kỹ thuật số (DR)</h3>
                </div>
                <div class="card-body">
                    <div class="diag-status-row">
                        <span class="diag-label">Máy DR-01 (Fujifilm FDR Visionary Suite):</span>
                        <span class="status-badge badge-success"><span class="pulse-dot green"></span> Hoạt động Tốt (Nhiệt bóng: 24% HU)</span>
                    </div>
                    <div class="diag-status-row">
                        <span class="diag-label">Máy DR-02 (Siemens Ysio Max):</span>
                        <span class="status-badge badge-success"><span class="pulse-dot green"></span> Hoạt động Tốt (Nhiệt bóng: 18% HU)</span>
                    </div>
                    <div class="diag-status-row">
                        <span class="diag-label">Máy MOBILE-01 (GE Optima Cấp cứu tại giường):</span>
                        <span class="status-badge badge-success"><span class="pulse-dot green"></span> Sẵn sàng • Pin 96%</span>
                    </div>
                    <div class="diag-status-row">
                        <span class="diag-label">Tấm cảm biến CsI (Flat-Panel Detector):</span>
                        <span>Độ phân giải 3000×3000 px • 16-bit Grayscale • Đã chuẩn hóa CLAHE</span>
                    </div>
                    <div class="diag-status-row">
                        <span class="diag-label">Kết nối truyền tải nội viện PACS:</span>
                        <span class="text-success"><i class="fa-solid fa-lock"></i> DICOM over TLS 1.3 + SHA-256 Checksum</span>
                    </div>
                </div>
            </div>

            <div class="card settings-card">
                <div class="card-header">
                    <i class="fa-solid fa-radiation"></i>
                    <h3>Chỉ số Kiểm soát Liều Bức Xạ & Bảo hộ Y tế (ALARA)</h3>
                </div>
                <div class="card-body">
                    <div class="diag-status-row">
                        <span class="diag-label">Liều tham chiếu Quốc gia (X-Quang Ngực PA):</span>
                        <strong>≤ 0.40 mGy (Mức khuyến nghị ALARA: &lt; 0.30 mGy)</strong>
                    </div>
                    <div class="diag-status-row">
                        <span class="diag-label">Liều trung bình tại Phòng DR-01 hôm nay:</span>
                        <span class="text-success"><strong>0.12 mGy (An toàn tuyệt đối)</strong></span>
                    </div>
                    <div class="diag-status-row">
                        <span class="diag-label">Liều kế cá nhân KTV (TLD Dosimeter):</span>
                        <span>0.42 mSv / năm (Giới hạn cho phép: 20 mSv / năm)</span>
                    </div>
                    <div class="diag-status-row">
                        <span class="diag-label">Hệ thống cảnh báo cửa chì & đèn tia X:</span>
                        <span class="status-badge badge-success">Đang bật Khóa liên động (Interlock OK)</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// =========================================================================
// VIEW 4: TECHNICIAN PROFILE & RBAC SCOPE
// =========================================================================
function renderTechProfileView() {
    const container = document.getElementById('view-tech-profile');
    if (!container) return;

    const s = getLocalSettings();

    container.innerHTML = `
        <div class="view-header">
            <div>
                <h2>Hồ sơ Ca trực Kỹ thuật viên & Quy chế Phân quyền Bảo mật</h2>
                <p>Cấu hình thông tin Kỹ thuật viên thực hiện chụp và quy định phân tách nhiệm vụ (Separation of Duties)</p>
            </div>
            <div class="view-header-actions">
                <button class="btn btn-primary" onclick="saveTechProfileSettings()">
                    <i class="fa-solid fa-floppy-disk"></i> Lưu thông tin ca trực
                </button>
            </div>
        </div>

        <div class="settings-grid">
            <div class="card settings-card">
                <div class="card-header">
                    <i class="fa-solid fa-id-card-clip"></i>
                    <h3>Thông tin Kỹ thuật viên Phòng X-Quang</h3>
                </div>
                <div class="card-body">
                    <div class="form-group">
                        <label>Họ và tên Kỹ thuật viên Phụ trách</label>
                        <input type="text" id="input-tech-name" value="${escapeHtml(s.technicianName || 'CN.KTV Phạm Hoàng Nam')}">
                    </div>
                    <div class="form-group">
                        <label>Phòng Máy X-Quang Mặc định</label>
                        <input type="text" id="input-tech-room" value="${escapeHtml(s.modalityRoom || 'DR-01 (Fujifilm FDR Visionary)')}">
                    </div>
                </div>
            </div>

            <div class="card settings-card">
                <div class="card-header">
                    <i class="fa-solid fa-shield-halved"></i>
                    <h3>Giới hạn Phân quyền RBAC dành cho Kỹ thuật viên</h3>
                </div>
                <div class="card-body">
                    <div class="settings-tip" style="margin-top:0;">
                        <i class="fa-solid fa-user-lock"></i>
                        <span><strong>Quy định Bảo mật Bệnh viện:</strong> Tài khoản Kỹ thuật viên chỉ có quyền thu nhận ảnh, kiểm chuẩn chất lượng kỹ thuật (QA/QC), chạy AI Sàng lọc ưu tiên (Pre-Triage) và chuyển ca chụp tới Bác sĩ Chẩn đoán. Kỹ thuật viên <strong>không có quyền ký số kết luận lâm sàng</strong> hoặc thay đổi tham số mô hình Federated Learning.</span>
                    </div>
                    <button class="btn btn-secondary full-width" onclick="window.openRBACSecurityModal()">
                        <i class="fa-solid fa-table-list"></i> Xem Bảng Ma trận Phân quyền RBAC Toàn viện
                    </button>
                </div>
            </div>
        </div>
    `;
}

function saveTechProfileSettings() {
    const name = document.getElementById('input-tech-name')?.value || 'CN.KTV Phạm Hoàng Nam';
    const room = document.getElementById('input-tech-room')?.value || 'DR-01 (Fujifilm FDR Visionary)';
    saveLocalSettings({ technicianName: name, modalityRoom: room });
    applyTechProfileSidebar();
    showToast('✅ Đã cập nhật thông tin ca trực Kỹ thuật viên!');
}
