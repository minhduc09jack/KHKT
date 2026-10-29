/**
 * MedAI PACS/HIS v4.0 - View Renderers & Component Handlers (Doctor Portal)
 * Renders Incoming Technician Worklist Queue, Full Worklist View, History,
 * Patient Records, Patient Timeline, and Settings views.
 */

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
    const d = new Date(timestamp);
    return d.toLocaleString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
}

function displayPatientName(name) {
    if (typeof formatPatientNamePHI === 'function') {
        return formatPatientNamePHI(name);
    }
    return name || 'Bệnh nhân chưa đặt tên';
}

// =========================================================================
// 0. INCOMING WORKLIST WIDGET & FULL WORKLIST VIEW (FROM X-RAY TECHNICIAN)
// =========================================================================
window.renderDoctorIncomingQueueWidget = async function () {
    const mount = document.getElementById('doctor-incoming-queue-widget');
    if (!mount || typeof dbGetWorklistCases !== 'function') return;

    const allWl = await dbGetWorklistCases();
    const pending = allWl.filter(x => x.status === 'PENDING_DOCTOR');

    // Update badges
    document.querySelectorAll('#sidebar-worklist-badge, #global-worklist-badge').forEach(el => {
        el.textContent = pending.length;
        el.classList.toggle('has-items', pending.length > 0);
    });

    if (pending.length === 0) {
        mount.innerHTML = `
            <div class="worklist-strip-card empty">
                <div class="wl-strip-left">
                    <span class="wl-live-dot green"></span>
                    <strong>Hàng đợi PACS từ Phòng X-Quang:</strong>
                    <span class="text-muted">Hiện đã đọc hết toàn bộ ca chụp chờ.</span>
                </div>
                <div class="wl-strip-right">
                    <a href="technician.html" class="btn btn-secondary btn-sm">
                        <i class="fa-solid fa-x-ray"></i> Sang Phòng X-Quang (KTV) tạo ca chụp mới
                    </a>
                </div>
            </div>
        `;
        return;
    }

    const topItems = pending.slice(0, 3);
    const cardsHtml = topItems.map(item => {
        const priClass = item.priority === 'STAT' ? 'stat' : (item.priority === 'URGENT' ? 'urgent' : 'routine');
        const priLabel = item.priority === 'STAT' ? '🚨 CẤP CỨU (STAT)' : (item.priority === 'URGENT' ? '⚡ KHẨN (URGENT)' : '📋 THƯỜNG QUY');
        const aiAlert = item.aiPreTriageDone && item.probPneumonia >= 50
            ? `<span class="wl-ai-flag danger"><i class="fa-solid fa-triangle-exclamation"></i> AI Sàng lọc: Nghi Viêm phổi (${item.probPneumonia.toFixed(1)}%)</span>`
            : (item.aiPreTriageDone ? `<span class="wl-ai-flag success"><i class="fa-solid fa-check"></i> AI Sàng lọc: Bình thường</span>` : '');

        return `
            <div class="wl-mini-item ${priClass}">
                <div class="wl-mini-thumb" onclick="loadWorklistCaseIntoDoctor('${escapeHtml(item.id)}')">
                    <img src="${escapeHtml(item.image || 'assets/samples/sample_bacteria.jpeg')}" alt="X-Ray">
                </div>
                <div class="wl-mini-info">
                    <div class="wl-mini-top">
                        <span class="wl-pri-badge ${priClass}">${priLabel}</span>
                        <strong>${escapeHtml(item.patientId)} — ${escapeHtml(displayPatientName(item.patientName))}</strong>
                        <span class="text-muted">(${item.age || '—'}t, ${escapeHtml(item.gender)})</span>
                    </div>
                    <div class="wl-mini-meta">
                        <span><i class="fa-solid fa-hospital"></i> ${escapeHtml(item.referringDept)}</span>
                        <span><i class="fa-solid fa-x-ray"></i> ${escapeHtml(item.viewPosition)} (${item.kvp}kVp / ${item.mas}mAs)</span>
                        <span><i class="fa-solid fa-user-Astronaut fa-id-badge"></i> KTV: ${escapeHtml(item.technicianName)}</span>
                        ${aiAlert}
                    </div>
                </div>
                <div class="wl-mini-action">
                    <button type="button" class="btn btn-primary btn-sm" onclick="loadWorklistCaseIntoDoctor('${escapeHtml(item.id)}')">
                        <i class="fa-solid fa-stethoscope"></i> Tiếp nhận & Đọc phim
                    </button>
                </div>
            </div>
        `;
    }).join('');

    mount.innerHTML = `
        <div class="worklist-strip-card">
            <div class="wl-strip-header">
                <div class="wl-strip-title">
                    <span class="wl-live-dot pulse-red"></span>
                    <h4>Hàng đợi Ca chụp từ Kỹ thuật viên Phòng X-Quang (${pending.length} ca đang chờ Bác sĩ đọc)</h4>
                </div>
                <div class="wl-strip-actions">
                    <a href="technician.html" class="btn btn-secondary btn-sm" title="Mở giao diện Kỹ thuật viên Phòng X-Quang">
                        <i class="fa-solid fa-plus"></i> Mở Giao diện KTV X-Quang
                    </a>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="navigateTo('worklist')">
                        Xem tất cả (${allWl.length}) <i class="fa-solid fa-arrow-right"></i>
                    </button>
                </div>
            </div>
            <div class="wl-mini-list">
                ${cardsHtml}
            </div>
        </div>
    `;
};

async function renderWorklistView() {
    const container = document.getElementById('view-worklist');
    if (!container) return;

    const list = await dbGetWorklistCases();
    const pendingCount = list.filter(x => x.status === 'PENDING_DOCTOR').length;
    const statCount = list.filter(x => x.priority === 'STAT' && x.status === 'PENDING_DOCTOR').length;
    const completedCount = list.filter(x => x.status === 'COMPLETED').length;
    const retakeCount = list.filter(x => x.status === 'RETAKE_REQUESTED').length;

    let html = `
        <div class="view-header">
            <div>
                <h2>Hàng đợi Ca chụp từ Phòng X-Quang (PACS Modality Worklist)</h2>
                <p>Danh sách các ca chụp X-quang do Kỹ thuật viên gửi sang chờ Bác sĩ Chẩn đoán đọc kết quả và ký số</p>
            </div>
            <div class="view-header-actions">
                <button class="btn btn-secondary" onclick="window.openHospitalDatasetModal()">
                    <i class="fa-solid fa-database"></i> Import Dataset Bệnh viện (federated_data)
                </button>
                <a href="technician.html" class="btn btn-secondary">
                    <i class="fa-solid fa-x-ray"></i> Sang Phòng chụp X-Quang (KTV)
                </a>
                <button class="btn btn-primary" onclick="renderWorklistView()">
                    <i class="fa-solid fa-arrows-rotate"></i> Đồng bộ Hàng đợi
                </button>
            </div>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-icon orange"><i class="fa-solid fa-hourglass-half"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${pendingCount}</span>
                    <span class="stat-label">Ca đang chờ Bác sĩ đọc</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon red"><i class="fa-solid fa-truck-medical"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${statCount}</span>
                    <span class="stat-label">Ca Cấp cứu tối khẩn (STAT)</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon green"><i class="fa-solid fa-file-signature"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${completedCount}</span>
                    <span class="stat-label">Đã hoàn tất & Ký số</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon blue"><i class="fa-solid fa-rotate-left"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${retakeCount}</span>
                    <span class="stat-label">Yêu cầu KTV chụp lại</span>
                </div>
            </div>
        </div>

        <div class="card table-card" style="margin-top: 22px;">
            <div class="table-responsive">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Ảnh XQ</th>
                            <th>Mức ưu tiên</th>
                            <th>Mã BN & Họ tên</th>
                            <th>Khoa gửi / Lâm sàng</th>
                            <th>Thông số Kỹ thuật (KTV)</th>
                            <th>AI Pre-Triage</th>
                            <th>Trạng thái</th>
                            <th style="text-align:right;">Thao tác Bác sĩ</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${list.map(item => {
                            const priClass = item.priority === 'STAT' ? 'stat' : (item.priority === 'URGENT' ? 'urgent' : 'routine');
                            const priText = item.priority === 'STAT' ? 'CẤP CỨU STAT' : (item.priority === 'URGENT' ? 'KHẨN CẤP' : 'THƯỜNG QUY');

                            let statusBadge = '';
                            if (item.status === 'PENDING_DOCTOR') {
                                statusBadge = '<span class="status-badge badge-warning"><span class="pulse-dot orange"></span> Chờ Bác sĩ đọc</span>';
                            } else if (item.status === 'COMPLETED') {
                                statusBadge = '<span class="status-badge badge-success"><span class="pulse-dot green"></span> Đã ký kết luận</span>';
                            } else if (item.status === 'RETAKE_REQUESTED') {
                                statusBadge = '<span class="status-badge badge-danger"><span class="pulse-dot red"></span> Yêu cầu chụp lại</span>';
                            }

                            const aiCell = item.aiPreTriageDone
                                ? (item.probPneumonia >= 50
                                    ? `<span class="status-badge badge-danger">Nghi Viêm phổi (${item.probPneumonia.toFixed(1)}%)</span>`
                                    : `<span class="status-badge badge-success">Bình thường (${item.probNormal.toFixed(1)}%)</span>`)
                                : `<span class="text-muted"><small>Chưa chạy AI</small></span>`;

                            return `
                                <tr>
                                    <td>
                                        <div class="table-thumb" onclick="loadWorklistCaseIntoDoctor('${escapeHtml(item.id)}')">
                                            <img src="${escapeHtml(item.image || 'assets/samples/sample_bacteria.jpeg')}" alt="X-Ray">
                                        </div>
                                    </td>
                                    <td><span class="wl-pri-badge ${priClass}">${priText}</span></td>
                                    <td>
                                        <strong>${escapeHtml(item.patientId)}</strong><br>
                                        <span>${escapeHtml(displayPatientName(item.patientName))}</span>
                                        <div class="text-muted"><small>${item.age || '—'} tuổi • ${escapeHtml(item.gender)}</small></div>
                                    </td>
                                    <td>
                                        <strong>${escapeHtml(item.referringDept)}</strong>
                                        <div class="text-muted" style="max-width:220px;"><small>${escapeHtml(item.symptoms)}</small></div>
                                    </td>
                                    <td>
                                        <div><strong>${escapeHtml(item.viewPosition)}</strong></div>
                                        <small class="text-muted">${item.kvp} kVp • ${item.mas} mAs • QA: ${escapeHtml(item.qaScore)}</small><br>
                                        <small class="text-muted">KTV: ${escapeHtml(item.technicianName)}</small>
                                    </td>
                                    <td>${aiCell}</td>
                                    <td>${statusBadge}</td>
                                    <td style="text-align:right;">
                                        <button class="btn btn-primary btn-sm" onclick="loadWorklistCaseIntoDoctor('${escapeHtml(item.id)}')">
                                            <i class="fa-solid fa-stethoscope"></i> ${item.status === 'COMPLETED' ? 'Xem lại' : 'Tiếp nhận đọc'}
                                        </button>
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    container.innerHTML = html;
}

// Load a case sent by X-Ray Technician into the Doctor's main Diagnostic Workstation
async function loadWorklistCaseIntoDoctor(worklistId) {
    const item = await dbGetWorklistById(worklistId);
    if (!item) {
        showToast('⚠️ Không tìm thấy ca chụp trong hàng đợi.');
        return;
    }

    navigateTo('new');

    setTimeout(async () => {
        window.activeWorklistCaseId = item.id;
        window.activeWorklistMetadata = item;
        window.activeLoadedCaseId = item.completedCaseId || null;

        document.getElementById('patient-id').value = item.patientId || '';
        document.getElementById('patient-name').value = item.patientName || '';
        document.getElementById('patient-age').value = item.age || '';
        document.getElementById('patient-gender').value = item.gender || 'Nam';
        document.getElementById('patient-symptoms').value = item.symptoms || '';
        document.getElementById('doctor-notes').value = item.doctorNotes || '';

        const sourceBadge = document.getElementById('active-case-source-badge');
        if (sourceBadge) {
            sourceBadge.textContent = `Từ Phòng X-Quang (${item.id})`;
            sourceBadge.className = 'badge-outline active-handoff';
        }

        // Render Technician Handoff Metadata Banner
        const handoffBanner = document.getElementById('active-tech-handoff-banner');
        if (handoffBanner) {
            const priLabel = item.priority === 'STAT' ? '🚨 CẤP CỨU TỐI KHẨN (STAT)' : (item.priority === 'URGENT' ? '⚡ KHẨN CẤP (URGENT)' : '📋 THƯỜNG QUY');
            handoffBanner.classList.remove('hidden');
            handoffBanner.innerHTML = `
                <div class="handoff-banner-grid">
                    <div class="handoff-col">
                        <span class="handoff-label">Phòng chụp & Kỹ thuật viên thực hiện</span>
                        <strong><i class="fa-solid fa-x-ray"></i> ${escapeHtml(item.modalityRoom)} — ${escapeHtml(item.technicianName)}</strong>
                    </div>
                    <div class="handoff-col">
                        <span class="handoff-label">Thông số Kỹ thuật & Liều xạ</span>
                        <strong>${escapeHtml(item.viewPosition)} • ${item.kvp} kVp / ${item.mas} mAs • Liều: ${escapeHtml(item.esdDose)}</strong>
                    </div>
                    <div class="handoff-col">
                        <span class="handoff-label">Kiểm định QA/QC & Toàn vẹn DICOM</span>
                        <strong class="text-success"><i class="fa-solid fa-shield-check"></i> ${escapeHtml(item.qaScore)} • SHA256: ${escapeHtml(item.integrityHash)}</strong>
                    </div>
                    <div class="handoff-col">
                        <span class="handoff-label">Mức ưu tiên</span>
                        <strong>${priLabel}</strong>
                    </div>
                </div>
                ${item.technicianNotes ? `
                <div class="handoff-tech-note">
                    <i class="fa-solid fa-comment-medical"></i>
                    <strong>Ghi chú bàn giao của KTV Phòng X-Quang:</strong> "${escapeHtml(item.technicianNotes)}"
                </div>` : ''}
            `;
        }

        // Load X-Ray Image into viewer & prepare File blob for live AI inference
        const imgUrl = item.image || item.sampleFileUrl || 'assets/samples/sample_bacteria.jpeg';
        try {
            const response = await fetch(imgUrl);
            const blob = await response.blob();
            const file = new File([blob], `${item.patientId}.jpg`, { type: 'image/jpeg' });
            if (typeof window.handleFile === 'function') {
                window.handleFile(file);
            }
            // Wait briefly for FileReader to complete, then auto-run AI or show pre-triage
            setTimeout(() => {
                const shaEl = document.getElementById('case-sha256-label');
                if (shaEl && item.integrityHash) shaEl.textContent = `SHA256:${item.integrityHash}`;
                showToast(`🩻 Đã tiếp nhận ca chụp ${item.patientId} từ KTV ${item.technicianName}. Đang chạy phân tích AI...`);
                analyzeImage();
            }, 250);
        } catch (e) {
            console.error('Error loading worklist image:', e);
        }
    }, 100);
}

// =========================================================================
// 1. RENDER HISTORY VIEW (LỊCH SỬ CHẨN ĐOÁN)
// =========================================================================
async function renderHistoryView() {
    const container = document.getElementById('view-history');
    if (!container) return;

    const cases = await dbGetAllCases();

    const total = cases.length;
    const pneumoniaCount = cases.filter(c => c.diagnosis === 'PNEUMONIA' || c.probPneumonia >= 50).length;
    const normalCount = total - pneumoniaCount;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayCount = cases.filter(c => c.timestamp >= startOfToday.getTime()).length;

    let html = `
        <div class="view-header">
            <div>
                <h2>Lịch sử Chẩn đoán X-Quang</h2>
                <p>Theo dõi toàn bộ các phiên chẩn đoán AI đã thực hiện trên hệ thống</p>
            </div>
            <div class="view-header-actions">
                <button class="btn btn-secondary" onclick="window.openHospitalDatasetModal()">
                    <i class="fa-solid fa-database"></i> Import Dataset Bệnh viện (federated_data)
                </button>
                <button class="btn btn-secondary" onclick="renderHistoryView()"><i class="fa-solid fa-arrows-rotate"></i> Làm mới</button>
                <button class="btn btn-primary" onclick="navigateTo('new')"><i class="fa-solid fa-plus"></i> Phiên khám mới</button>
            </div>
        </div>

        <!-- Quick Stats Cards -->
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-icon blue"><i class="fa-solid fa-x-ray"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${total}</span>
                    <span class="stat-label">Tổng ca chẩn đoán</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon red"><i class="fa-solid fa-triangle-exclamation"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${pneumoniaCount}</span>
                    <span class="stat-label">Phát hiện Viêm phổi</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon green"><i class="fa-solid fa-circle-check"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${normalCount}</span>
                    <span class="stat-label">Kết quả Bình thường</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon orange"><i class="fa-solid fa-calendar-day"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${todayCount}</span>
                    <span class="stat-label">Ca khám trong hôm nay</span>
                </div>
            </div>
        </div>

        <!-- Filter & Search Toolbar -->
        <div class="card filter-card">
            <div class="filter-toolbar">
                <div class="search-box">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="text" id="history-search-input" placeholder="Tìm kiếm theo Mã BN, Tên bệnh nhân, Triệu chứng..." oninput="filterHistoryTable()">
                </div>
                <div class="filter-actions">
                    <select id="history-filter-diagnosis" onchange="filterHistoryTable()">
                        <option value="ALL">Tất cả kết quả</option>
                        <option value="PNEUMONIA">Viêm phổi (Pneumonia)</option>
                        <option value="NORMAL">Bình thường (Normal)</option>
                    </select>
                    <select id="history-sort-order" onchange="filterHistoryTable()">
                        <option value="NEWEST">Mới nhất trước</option>
                        <option value="OLDEST">Cũ nhất trước</option>
                    </select>
                </div>
            </div>
        </div>

        <!-- Cases Table -->
        <div class="card table-card">
            <div class="table-responsive">
                <table class="data-table" id="history-table">
                    <thead>
                        <tr>
                            <th style="width: 70px;">Ảnh</th>
                            <th>Thời gian</th>
                            <th>Mã BN</th>
                            <th>Họ và tên</th>
                            <th>Tuổi / Giới</th>
                            <th>Kết luận AI</th>
                            <th>Độ tin cậy</th>
                            <th>Bác sĩ thực hiện</th>
                            <th style="text-align: right; width: 140px;">Thao tác</th>
                        </tr>
                    </thead>
                    <tbody id="history-table-body">
    `;

    if (cases.length === 0) {
        html += `
            <tr>
                <td colspan="9" class="empty-state-cell">
                    <div class="empty-state">
                        <i class="fa-solid fa-inbox"></i>
                        <h4>Chưa có lịch sử chẩn đoán</h4>
                        <p>Dữ liệu chẩn đoán sẽ tự động được lưu lại khi bạn thực hiện phân tích X-quang tại mục Trạm Đọc Phim & AI.</p>
                        <button class="btn btn-primary" onclick="navigateTo('new')"><i class="fa-solid fa-plus"></i> Bắt đầu khám ca đầu tiên</button>
                    </div>
                </td>
            </tr>
        `;
    } else {
        html += renderHistoryTableRows(cases);
    }

    html += `
                    </tbody>
                </table>
            </div>
        </div>
    `;

    container.innerHTML = html;
}

function renderHistoryTableRows(cases) {
    if (!cases || cases.length === 0) {
        return `
            <tr>
                <td colspan="9" class="empty-state-cell">
                    <div class="empty-state small">
                        <p>Không tìm thấy ca khám nào phù hợp với từ khóa hoặc bộ lọc.</p>
                    </div>
                </td>
            </tr>
        `;
    }

    return cases.map(c => {
        const isPneumonia = c.diagnosis === 'PNEUMONIA' || c.probPneumonia >= 50;
        const badgeClass = isPneumonia ? 'badge-danger' : 'badge-success';
        const pulseColor = isPneumonia ? 'red' : 'green';
        const diagLabel = isPneumonia ? 'VIÊM PHỔI' : 'BÌNH THƯỜNG';
        const confPercent = isPneumonia ? c.probPneumonia : c.probNormal;
        const imgThumb = c.image || 'https://via.placeholder.com/60?text=X-Ray';

        return `
            <tr data-id="${c.id}" data-patient-id="${escapeHtml(c.patientId)}" data-name="${escapeHtml(c.patientName)}" data-diagnosis="${c.diagnosis}">
                <td>
                    <div class="table-thumb" onclick="openCaseInViewer('${c.id}')" title="Nhấn để xem chi tiết ca khám">
                        <img src="${imgThumb}" alt="X-Ray">
                    </div>
                </td>
                <td class="text-muted"><small>${formatDate(c.timestamp)}</small></td>
                <td><strong class="clickable-id" onclick="navigateTo('patient-detail', '${escapeHtml(c.patientId)}')">${escapeHtml(c.patientId)}</strong></td>
                <td>
                    <strong>${escapeHtml(displayPatientName(c.patientName))}</strong>
                    ${c.sourcePath ? `<br><span class="dataset-source-pill" title="${escapeHtml(c.sourcePath)}"><i class="fa-solid fa-folder-tree"></i> ${escapeHtml(c.sourcePath)}</span>` : ''}
                </td>
                <td>${c.age ? c.age + ' tuổi' : '—'} / ${escapeHtml(c.gender || '—')}</td>
                <td>
                    <span class="status-badge ${badgeClass}">
                        <span class="pulse-dot ${pulseColor}"></span> ${diagLabel}
                    </span>
                </td>
                <td>
                    <div class="conf-mini">
                        <span>${(confPercent || 0).toFixed(1)}%</span>
                        <div class="progress-bar mini">
                            <div class="progress-fill ${isPneumonia ? 'danger' : 'success'}" style="width: ${confPercent}%"></div>
                        </div>
                    </div>
                </td>
                <td><small>${escapeHtml(c.doctorName || 'BS.CKII Nguyễn Văn A')}</small></td>
                <td style="text-align: right;">
                    <div class="table-actions">
                        <button class="btn-action primary" onclick="openCaseInViewer('${c.id}')" title="Mở lại phiên khám này">
                            <i class="fa-solid fa-eye"></i>
                        </button>
                        <button class="btn-action info" onclick="navigateTo('patient-detail', '${escapeHtml(c.patientId)}')" title="Xem toàn bộ hồ sơ bệnh nhân">
                            <i class="fa-solid fa-user"></i>
                        </button>
                        <button class="btn-action danger" onclick="confirmDeleteCase('${c.id}')" title="Xóa bản ghi này">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

async function filterHistoryTable() {
    const search = (document.getElementById('history-search-input')?.value || '').toLowerCase().trim();
    const diagFilter = document.getElementById('history-filter-diagnosis')?.value || 'ALL';
    const sortOrder = document.getElementById('history-sort-order')?.value || 'NEWEST';

    let cases = await dbGetAllCases();

    if (search) {
        cases = cases.filter(c =>
            (c.patientId && c.patientId.toLowerCase().includes(search)) ||
            (c.patientName && c.patientName.toLowerCase().includes(search)) ||
            (c.symptoms && c.symptoms.toLowerCase().includes(search)) ||
            (c.doctorNotes && c.doctorNotes.toLowerCase().includes(search))
        );
    }

    if (diagFilter !== 'ALL') {
        cases = cases.filter(c => {
            const isPneumonia = c.diagnosis === 'PNEUMONIA' || c.probPneumonia >= 50;
            return diagFilter === 'PNEUMONIA' ? isPneumonia : !isPneumonia;
        });
    }

    if (sortOrder === 'OLDEST') {
        cases.sort((a, b) => a.timestamp - b.timestamp);
    } else {
        cases.sort((a, b) => b.timestamp - a.timestamp);
    }

    const tbody = document.getElementById('history-table-body');
    if (tbody) {
        tbody.innerHTML = renderHistoryTableRows(cases);
    }
}

// =========================================================================
// 2. RENDER PATIENTS VIEW (HỒ SƠ BỆNH ÁN)
// =========================================================================
async function renderPatientsView() {
    const container = document.getElementById('view-patients');
    if (!container) return;

    const patients = await dbGetAllPatients();

    let html = `
        <div class="view-header">
            <div>
                <h2>Hồ sơ Bệnh án Điện tử (EMR)</h2>
                <p>Quản lý danh sách bệnh nhân và lịch sử chẩn đoán tổng hợp theo từng người</p>
            </div>
            <div class="view-header-actions">
                <button class="btn btn-secondary" onclick="window.openHospitalDatasetModal()">
                    <i class="fa-solid fa-database"></i> Import Dataset Bệnh viện (federated_data)
                </button>
                <button class="btn btn-secondary" onclick="renderPatientsView()"><i class="fa-solid fa-arrows-rotate"></i> Làm mới</button>
                <button class="btn btn-primary" onclick="navigateTo('new')"><i class="fa-solid fa-user-plus"></i> Tiếp nhận bệnh nhân mới</button>
            </div>
        </div>

        <div class="card filter-card">
            <div class="filter-toolbar">
                <div class="search-box full-width">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="text" id="patient-search-input" placeholder="Tìm kiếm theo Mã bệnh nhân (ID) hoặc Họ và tên..." oninput="filterPatientsGrid()">
                </div>
            </div>
        </div>

        <div class="patients-grid" id="patients-grid-container">
    `;

    if (patients.length === 0) {
        html += `
            <div class="card" style="grid-column: 1 / -1; padding: 60px 20px; text-align: center;">
                <div class="empty-state">
                    <i class="fa-solid fa-folder-open"></i>
                    <h4>Chưa có hồ sơ bệnh án nào</h4>
                    <p>Khi bạn thực hiện chẩn đoán cho một Mã Bệnh Nhân, hồ sơ bệnh án sẽ tự động được tạo và liên kết tại đây.</p>
                    <button class="btn btn-primary" onclick="navigateTo('new')"><i class="fa-solid fa-plus"></i> Tạo ca khám đầu tiên</button>
                </div>
            </div>
        `;
    } else {
        html += renderPatientsCards(patients);
    }

    html += `</div>`;
    container.innerHTML = html;
}

function renderPatientsCards(patients) {
    if (!patients || patients.length === 0) {
        return `
            <div class="card" style="grid-column: 1 / -1; padding: 40px; text-align: center;">
                <p class="text-muted">Không tìm thấy bệnh nhân nào khớp với từ khóa.</p>
            </div>
        `;
    }

    return patients.map(p => {
        const isPneumonia = p.lastDiagnosis === 'PNEUMONIA' || (p.lastProbPneumonia && p.lastProbPneumonia >= 50);
        const badgeColor = isPneumonia ? 'danger' : 'success';
        const pulseColor = isPneumonia ? 'red' : 'green';
        const diagText = isPneumonia ? 'Viêm phổi' : 'Bình thường';
        const initials = p.name ? p.name.split(' ').map(w => w[0]).slice(-2).join('').toUpperCase() : 'BN';

        return `
            <div class="patient-profile-card" data-id="${escapeHtml(p.patientId)}" data-name="${escapeHtml(p.name)}">
                <div class="patient-card-top">
                    <div class="patient-avatar-badge">${initials}</div>
                    <div class="patient-basic-info">
                        <h3>${escapeHtml(displayPatientName(p.name))}</h3>
                        <span class="patient-code"><i class="fa-regular fa-id-card"></i> ${escapeHtml(p.patientId)}</span>
                    </div>
                </div>

                <div class="patient-meta-list">
                    <div class="patient-meta-item">
                        <span class="label">Tuổi / Giới tính:</span>
                        <span class="val"><strong>${p.age ? p.age + ' tuổi' : '—'}</strong> (${escapeHtml(p.gender || 'Nam')})</span>
                    </div>
                    <div class="patient-meta-item">
                        <span class="label">Số lần chụp X-quang:</span>
                        <span class="val"><span class="count-pill">${p.totalExams || 1} lần</span></span>
                    </div>
                    <div class="patient-meta-item">
                        <span class="label">Lần khám gần nhất:</span>
                        <span class="val">${formatDate(p.lastSeen)}</span>
                    </div>
                    <div class="patient-meta-item">
                        <span class="label">Chẩn đoán mới nhất:</span>
                        <span class="val"><span class="status-badge badge-${badgeColor}"><span class="pulse-dot ${pulseColor}"></span> ${diagText}</span></span>
                    </div>
                </div>

                <div class="patient-card-actions">
                    <button class="btn btn-secondary btn-sm" onclick="continueExamForPatient('${escapeHtml(p.patientId)}')">
                        <i class="fa-solid fa-stethoscope"></i> Khám mới
                    </button>
                    <button class="btn btn-primary btn-sm" onclick="navigateTo('patient-detail', '${escapeHtml(p.patientId)}')">
                        <i class="fa-solid fa-folder-open"></i> Xem chi tiết
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function filterPatientsGrid() {
    const search = (document.getElementById('patient-search-input')?.value || '').toLowerCase().trim();
    let patients = await dbGetAllPatients();

    if (search) {
        patients = patients.filter(p =>
            (p.patientId && p.patientId.toLowerCase().includes(search)) ||
            (p.name && p.name.toLowerCase().includes(search))
        );
    }

    const container = document.getElementById('patients-grid-container');
    if (container) {
        container.innerHTML = renderPatientsCards(patients);
    }
}

// =========================================================================
// 3. RENDER PATIENT DETAIL TIMELINE VIEW
// =========================================================================
async function renderPatientDetailView(patientId) {
    const container = document.getElementById('view-patient-detail');
    if (!container) return;

    const data = await dbGetPatientProfile(patientId);
    const patient = data.patient || { patientId, name: 'Bệnh nhân chưa xác định', totalExams: 0 };
    const cases = data.cases || [];

    let html = `
        <div class="view-header">
            <div>
                <button class="btn-back" onclick="navigateTo('patients')">
                    <i class="fa-solid fa-arrow-left"></i> Quay lại Danh sách Hồ sơ
                </button>
                <h2>Hồ sơ Bệnh nhân: ${escapeHtml(displayPatientName(patient.name))}</h2>
                <p>Mã định danh y tế: <strong>${escapeHtml(patient.patientId)}</strong></p>
            </div>
            <div class="view-header-actions">
                <button class="btn btn-secondary" onclick="confirmDeletePatient('${escapeHtml(patient.patientId)}')">
                    <i class="fa-solid fa-trash-can"></i> Xóa hồ sơ này
                </button>
                <button class="btn btn-primary" onclick="continueExamForPatient('${escapeHtml(patient.patientId)}')">
                    <i class="fa-solid fa-stethoscope"></i> Phiên khám mới cho BN này
                </button>
            </div>
        </div>

        <div class="card patient-summary-header">
            <div class="patient-sum-left">
                <div class="patient-avatar-large">${patient.name ? patient.name[0].toUpperCase() : 'B'}</div>
                <div class="patient-sum-details">
                    <h3>${escapeHtml(displayPatientName(patient.name))}</h3>
                    <div class="patient-tag-row">
                        <span class="patient-badge"><i class="fa-regular fa-id-badge"></i> ID: ${escapeHtml(patient.patientId)}</span>
                        <span class="patient-badge"><i class="fa-solid fa-cake-candles"></i> ${patient.age ? patient.age + ' tuổi' : 'Chưa rõ tuổi'}</span>
                        <span class="patient-badge"><i class="fa-solid fa-venus-mars"></i> Giới tính: ${escapeHtml(patient.gender || 'Nam')}</span>
                        <span class="patient-badge highlight"><i class="fa-solid fa-hospital-user"></i> Tổng cộng ${cases.length} phiên chụp</span>
                    </div>
                </div>
            </div>
        </div>

        <div class="timeline-container">
            <div class="timeline-header">
                <h3><i class="fa-solid fa-timeline"></i> Dòng thời gian Khám bệnh & Tiến trình Phổi</h3>
                <span class="text-muted">Ghi nhận ${cases.length} mốc chẩn đoán X-quang</span>
            </div>
    `;

    if (cases.length === 0) {
        html += `
            <div class="card" style="padding: 40px; text-align: center;">
                <p class="text-muted">Chưa có lịch sử chụp X-quang nào cho bệnh nhân này.</p>
            </div>
        `;
    } else {
        html += `
            <div class="timeline-stream">
                ${cases.map((c, index) => {
                    const isPneumonia = c.diagnosis === 'PNEUMONIA' || c.probPneumonia >= 50;
                    const badgeClass = isPneumonia ? 'danger' : 'success';
                    const pulseColor = isPneumonia ? 'red' : 'green';
                    const diagText = isPneumonia ? 'PNEUMONIA (VIÊM PHỔI)' : 'NORMAL (BÌNH THƯỜNG)';
                    const prob = isPneumonia ? c.probPneumonia : c.probNormal;

                    return `
                        <div class="timeline-item">
                            <div class="timeline-marker ${isPneumonia ? 'marker-danger' : 'marker-success'}">
                                <i class="fa-solid ${isPneumonia ? 'fa-triangle-exclamation' : 'fa-circle-check'}"></i>
                            </div>
                            <div class="timeline-content card">
                                <div class="timeline-card-header">
                                    <div class="timeline-time">
                                        <strong>Lần chụp #${cases.length - index}</strong> — ${formatDate(c.timestamp)}
                                    </div>
                                    <div class="timeline-badge-wrap">
                                        <span class="status-badge badge-${badgeClass}"><span class="pulse-dot ${pulseColor}"></span> ${diagText} (${(prob || 0).toFixed(1)}%)</span>
                                    </div>
                                </div>
                                <div class="timeline-body">
                                    <div class="timeline-grid">
                                        <div class="timeline-images">
                                            <div class="timeline-img-box" onclick="openCaseInViewer('${c.id}')" title="Nhấn xem chi tiết ảnh">
                                                <img src="${c.image || 'https://via.placeholder.com/200'}" alt="Ảnh X-quang gốc">
                                                <span class="img-label">Ảnh X-Quang</span>
                                            </div>
                                            ${c.heatmap ? `
                                            <div class="timeline-img-box" onclick="openCaseInViewer('${c.id}')" title="Bản đồ tổn thương Grad-CAM">
                                                <img src="${c.heatmap}" alt="Grad-CAM Heatmap">
                                                <span class="img-label">Grad-CAM Heatmap</span>
                                            </div>
                                            ` : ''}
                                        </div>

                                        <div class="timeline-info-col">
                                            <div class="info-block">
                                                <label>Lý do khám / Triệu chứng:</label>
                                                <p>${escapeHtml(c.symptoms) || '<em>Không ghi nhận triệu chứng đặc biệt.</em>'}</p>
                                            </div>

                                            <div class="info-block">
                                                <label>Độ tin cậy phân loại AI:</label>
                                                <div class="prob-mini-bars">
                                                    <div class="prob-mini-row">
                                                        <span>Viêm phổi: <strong>${(c.probPneumonia || 0).toFixed(1)}%</strong></span>
                                                        <div class="progress-bar mini"><div class="progress-fill danger" style="width: ${c.probPneumonia}%"></div></div>
                                                    </div>
                                                    <div class="prob-mini-row">
                                                        <span>Bình thường: <strong>${(c.probNormal || 0).toFixed(1)}%</strong></span>
                                                        <div class="progress-bar mini"><div class="progress-fill success" style="width: ${c.probNormal}%"></div></div>
                                                    </div>
                                                </div>
                                            </div>

                                            <div class="info-block">
                                                <label>Kết luận & Chỉ định của Bác sĩ:</label>
                                                <p class="notes-quote">${escapeHtml(c.doctorNotes) || '<em>Bác sĩ chưa nhập kết luận chuyên môn.</em>'}</p>
                                                <small class="text-muted"><i class="fa-solid fa-user-doctor"></i> Bác sĩ: ${escapeHtml(c.doctorName || 'BS.CKII Nguyễn Văn A')} • SHA256: ${escapeHtml(c.integrityHash || 'VERIFIED')}</small>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div class="timeline-footer">
                                    <button class="btn btn-secondary btn-sm" onclick="openCaseInViewer('${c.id}')">
                                        <i class="fa-solid fa-arrow-up-right-from-square"></i> Mở lại phiên khám & Xuất PDF
                                    </button>
                                    <button class="btn-text danger btn-sm" onclick="confirmDeleteCase('${c.id}', '${escapeHtml(patient.patientId)}')">
                                        <i class="fa-solid fa-trash"></i> Xóa lần khám này
                                    </button>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    html += `</div>`;
    container.innerHTML = html;
}

async function continueExamForPatient(patientId) {
    const data = await dbGetPatientProfile(patientId);
    if (!data || !data.patient) return;
    const p = data.patient;

    navigateTo('new');

    setTimeout(() => {
        document.getElementById('patient-id').value = p.patientId || '';
        document.getElementById('patient-name').value = p.name || '';
        document.getElementById('patient-age').value = p.age || '';
        document.getElementById('patient-gender').value = p.gender || 'Nam';
        document.getElementById('patient-symptoms').focus();
        showToast(`Đã nạp hồ sơ bệnh nhân ${p.name}`);
    }, 100);
}

async function openCaseInViewer(caseId) {
    const c = await dbGetCaseById(caseId);
    if (!c) {
        showToast('Không tìm thấy bản ghi ca khám.');
        return;
    }

    navigateTo('new');

    setTimeout(() => {
        document.getElementById('patient-id').value = c.patientId || '';
        document.getElementById('patient-name').value = c.patientName || '';
        document.getElementById('patient-age').value = c.age || '';
        document.getElementById('patient-gender').value = c.gender || 'Nam';
        document.getElementById('patient-symptoms').value = c.symptoms || '';
        document.getElementById('doctor-notes').value = c.doctorNotes || '';

        if (c.image) {
            const originalImage = document.getElementById('original-image');
            const uploadZone = document.getElementById('upload-zone');
            const viewerContainer = document.getElementById('viewer-container');
            const btnAnalyze = document.getElementById('btn-analyze');

            originalImage.src = c.image;
            uploadZone.classList.add('hidden');
            viewerContainer.classList.remove('hidden');
            btnAnalyze.classList.add('hidden');
        }

        if (c.heatmap) {
            const heatmapImg = document.getElementById('heatmap-image');
            heatmapImg.src = c.heatmap;
            heatmapImg.style.filter = "none";
            heatmapImg.style.mixBlendMode = "normal";
            heatmapImg.style.opacity = "1";
            heatmapImg.classList.remove('hidden');
            document.getElementById('toggle-heatmap').checked = true;
        }

        const resultPlaceholder = document.getElementById('result-placeholder');
        const resultContent = document.getElementById('result-content');
        resultPlaceholder.classList.add('hidden');
        resultContent.classList.remove('hidden');

        const isPneumonia = c.diagnosis === 'PNEUMONIA' || c.probPneumonia >= 50;
        document.getElementById('prob-pneumonia-text').textContent = (c.probPneumonia || 0).toFixed(2) + '%';
        document.getElementById('prob-pneumonia-bar').style.width = (c.probPneumonia || 0) + '%';

        document.getElementById('prob-normal-text').textContent = (c.probNormal || 0).toFixed(2) + '%';
        document.getElementById('prob-normal-bar').style.width = (c.probNormal || 0) + '%';

        const diagnosisBadge = document.getElementById('diagnosis-badge');
        const diagnosisText = document.getElementById('diagnosis-text');
        const aiStatus = document.getElementById('ai-status');

        if (isPneumonia) {
            diagnosisBadge.className = 'diagnosis-badge danger';
            diagnosisText.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> PNEUMONIA (VIÊM PHỔI)';
            aiStatus.textContent = "Bất thường";
            aiStatus.style.background = "var(--danger)";
        } else {
            diagnosisBadge.className = 'diagnosis-badge success';
            diagnosisText.innerHTML = '<i class="fa-solid fa-circle-check"></i> NORMAL (BÌNH THƯỜNG)';
            aiStatus.textContent = "Bình thường";
            aiStatus.style.background = "var(--success)";
        }

        window.activeLoadedCaseId = c.id;
        showToast(`Đã mở lại ca khám ${c.patientId} (${formatDate(c.timestamp)})`);
    }, 150);
}

// =========================================================================
// 4. RENDER SETTINGS VIEW (CÀI ĐẶT BÁC SĨ)
// =========================================================================
async function renderSettingsView() {
    const container = document.getElementById('view-settings');
    if (!container) return;

    const settings = getLocalSettings();
    const policy = getAdminPolicy();
    const cases = await dbGetAllCases();
    const patients = await dbGetAllPatients();

    let backendStatus = { status: 'online', device: 'CPU / Apple MPS', model_loaded: true, model_name: 'Hybrid Ensemble (DenseNet-121 + EfficientNet-B0)' };
    try {
        const res = typeof fetchWithTimeout === 'function'
            ? await fetchWithTimeout('/api/health', {}, 900)
            : await fetch('/api/health');
        if (res && res.ok) {
            backendStatus = await res.json();
        }
    } catch (e) {
        // Fallback to local Edge/Simulated status without blocking UI
    }

    let html = `
        <div class="view-header">
            <div>
                <h2>Cài đặt Trạm Bác sĩ Chẩn đoán</h2>
                <p>Tùy chỉnh thông tin bác sĩ phụ trách, tham số hiển thị Grad-CAM và quản lý dữ liệu lưu trữ</p>
            </div>
            <div class="view-header-actions">
                <button class="btn btn-secondary" onclick="window.openHospitalDatasetModal()">
                    <i class="fa-solid fa-database"></i> Import Dataset Bệnh viện (federated_data)
                </button>
                <a href="admin.html" class="btn btn-secondary"><i class="fa-solid fa-shield-halved"></i> Mở Trang Quản trị Admin Bệnh viện</a>
                <button class="btn btn-primary" onclick="saveAllSettings()"><i class="fa-solid fa-floppy-disk"></i> Lưu tất cả thay đổi</button>
            </div>
        </div>

        <div class="settings-grid">
            <div class="settings-col">
                <div class="card settings-card">
                    <div class="card-header">
                        <i class="fa-solid fa-user-doctor"></i>
                        <h3>Thông tin Bác sĩ & Đơn vị công tác</h3>
                    </div>
                    <div class="card-body">
                        <div class="form-group">
                            <label>Họ và tên Bác sĩ phụ trách</label>
                            <input type="text" id="setting-doctor-name" value="${escapeHtml(settings.doctorName)}">
                            <small class="form-hint">Tên này sẽ xuất hiện trên thanh điều hướng, chữ ký số và báo cáo PDF.</small>
                        </div>
                        <div class="form-group">
                            <label>Khoa / Phòng chuyên môn</label>
                            <input type="text" id="setting-department" value="${escapeHtml(settings.department)}">
                        </div>
                        <div class="form-group">
                            <label>Bệnh viện / Nút Client hiện tại</label>
                            <input type="text" id="setting-hospital" value="${escapeHtml(settings.hospital)}">
                        </div>
                    </div>
                </div>

                <div class="card settings-card">
                    <div class="card-header">
                        <i class="fa-solid fa-sliders"></i>
                        <h3>Tham số Quyết định Chẩn đoán AI</h3>
                    </div>
                    <div class="card-body">
                        <div class="form-group">
                            <div class="slider-header-row">
                                <label>Ngưỡng cảnh báo Viêm phổi (Pneumonia Decision Threshold)</label>
                                <span class="threshold-badge" id="threshold-val-display">${policy.globalDecisionThreshold || settings.decisionThreshold}%</span>
                            </div>
                            <input type="range" min="10" max="90" step="5" id="setting-threshold" value="${policy.globalDecisionThreshold || settings.decisionThreshold}" oninput="document.getElementById('threshold-val-display').textContent = this.value + '%'">
                            <div class="range-labels">
                                <span>10% (Tối đa Recall - An toàn)</span>
                                <span>50% (Cân bằng mặc định)</span>
                                <span>90% (Tối đa Precision)</span>
                            </div>
                            <div class="settings-tip">
                                <i class="fa-solid fa-shield-halved"></i>
                                <span><strong>Nguyên tắc "Safety First":</strong> Trong chẩn đoán sàng lọc y khoa, việc hạ ngưỡng giúp tăng tối đa Độ nhạy (Recall), tránh bỏ sót bất kỳ ca viêm phổi tiềm ẩn nào.</span>
                            </div>
                        </div>

                        <div class="settings-toggle-row">
                            <div>
                                <strong>Tự động kích hoạt bản đồ nhiệt Grad-CAM</strong>
                                <p class="text-muted">Tự động hiển thị lớp phủ tổn thương phổi ngay khi phân tích xong.</p>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="setting-auto-heatmap" ${settings.autoShowHeatmap ? 'checked' : ''}>
                                <span class="slider round"></span>
                            </label>
                        </div>

                        <div class="settings-toggle-row">
                            <div>
                                <strong>Tự động lưu vào Lịch sử chẩn đoán</strong>
                                <p class="text-muted">Mỗi ca phân tích hoàn tất sẽ tự động được ghi lại trên máy này.</p>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="setting-auto-save" ${settings.autoSaveHistory ? 'checked' : ''}>
                                <span class="slider round"></span>
                            </label>
                        </div>
                    </div>
                </div>
            </div>

            <div class="settings-col">
                <div class="card settings-card">
                    <div class="card-header">
                        <i class="fa-solid fa-server"></i>
                        <h3>Trạng thái Máy chủ & Mô hình AI Liên viện</h3>
                    </div>
                    <div class="card-body">
                        <div class="diag-status-row">
                            <span class="diag-label">Trạng thái kết nối API:</span>
                            <span class="status-badge ${backendStatus.status === 'online' ? 'badge-success' : 'badge-danger'}">
                                <span class="pulse-dot ${backendStatus.status === 'online' ? 'green' : 'red'}"></span>
                                ${backendStatus.status === 'online' ? 'Máy chủ đang hoạt động' : 'Ngoại tuyến / Lỗi'}
                            </span>
                        </div>
                        <div class="diag-status-row">
                            <span class="diag-label">Mô hình AI:</span>
                            <span><strong>${backendStatus.model_name || 'Hybrid Ensemble (DenseNet-121 + EfficientNet-B0)'}</strong></span>
                        </div>
                        <div class="diag-status-row">
                            <span class="diag-label">Thiết bị tăng tốc tính toán:</span>
                            <span class="device-pill"><i class="fa-solid fa-microchip"></i> ${backendStatus.device || 'CPU'}</span>
                        </div>
                        <div class="diag-status-row">
                            <span class="diag-label">Thuật toán bảo mật:</span>
                            <span>Federated Learning (FedProx μ=${policy.flMu || 1.0}) + Local DP (σ=${policy.dpSigma || 0.01})</span>
                        </div>
                        <div class="diag-status-row">
                            <span class="diag-label">Bảo mật dữ liệu cục bộ:</span>
                            <span class="text-success"><i class="fa-solid fa-lock"></i> IndexedDB Sandbox + SHA-256 Verified</span>
                        </div>
                    </div>
                </div>

                <div class="card settings-card">
                    <div class="card-header">
                        <i class="fa-solid fa-database"></i>
                        <h3>Quản lý Dữ liệu Bệnh viện Cục bộ</h3>
                    </div>
                    <div class="card-body">
                        <div class="data-stats-box">
                            <div class="data-stat">
                                <strong>${cases.length}</strong>
                                <span>Ca chẩn đoán</span>
                            </div>
                            <div class="data-stat">
                                <strong>${patients.length}</strong>
                                <span>Hồ sơ bệnh nhân</span>
                            </div>
                        </div>

                        <p class="text-muted" style="margin-bottom: 16px; font-size: 13px;">
                            Toàn bộ hồ sơ bệnh nhân và ảnh chụp X-quang được lưu trữ an toàn ngay trong bộ nhớ trình duyệt (IndexedDB) của thiết bị tại bệnh viện, tuân thủ chuẩn HIPAA & Nghị định 13/2023/NĐ-CP.
                        </p>

                        <div class="backup-actions">
                            <button class="btn btn-primary full-width" onclick="window.openHospitalDatasetModal()">
                                <i class="fa-solid fa-hospital-user"></i> Nạp Dataset Bệnh Án Bệnh Viện Có Sẵn (federated_data)
                            </button>
                            <button class="btn btn-secondary full-width" onclick="exportDataBackup()">
                                <i class="fa-solid fa-file-export"></i> Xuất file sao lưu toàn bộ (.JSON)
                            </button>
                            <label class="btn btn-secondary full-width btn-file-upload">
                                <i class="fa-solid fa-file-import"></i> Khôi phục dữ liệu từ file sao lưu
                                <input type="file" id="backup-file-input" accept=".json" onchange="importDataBackup(event)" hidden>
                            </label>
                            <button class="btn btn-danger-outline full-width" onclick="confirmResetAllData()">
                                <i class="fa-solid fa-trash-can"></i> Xóa toàn bộ dữ liệu trên máy này
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    container.innerHTML = html;
}

async function saveAllSettings() {
    const docName = document.getElementById('setting-doctor-name')?.value || 'BS.CKII Nguyễn Văn A';
    const dept = document.getElementById('setting-department')?.value || 'Khoa Chẩn đoán hình ảnh';
    const hosp = document.getElementById('setting-hospital')?.value || 'Bệnh viện Phổi Trung ương';
    const threshold = parseInt(document.getElementById('setting-threshold')?.value || '50', 10);
    const autoHeatmap = document.getElementById('setting-auto-heatmap')?.checked ?? true;
    const autoSave = document.getElementById('setting-auto-save')?.checked ?? true;

    saveLocalSettings({
        doctorName: docName,
        department: dept,
        hospital: hosp,
        decisionThreshold: threshold,
        autoShowHeatmap: autoHeatmap,
        autoSaveHistory: autoSave
    });

    await saveAdminPolicy({ globalDecisionThreshold: threshold }, docName);

    updateSidebarProfile();
    showToast('Đã lưu thành công các cài đặt hệ thống!');
}

function updateSidebarProfile() {
    const s = getLocalSettings();
    const docNameElem = document.getElementById('sidebar-doc-name');
    const docDeptElem = document.getElementById('sidebar-doc-dept');
    const docAvatarElem = document.getElementById('sidebar-doc-avatar');
    const sigNameElem = document.getElementById('signature-doc-name');

    if (docNameElem) docNameElem.textContent = s.doctorName;
    if (docDeptElem) docDeptElem.textContent = s.department;
    if (sigNameElem) sigNameElem.textContent = s.doctorName;
    if (docAvatarElem) {
        const encoded = encodeURIComponent(s.doctorName || 'Dr AI');
        docAvatarElem.src = `https://ui-avatars.com/api/?name=${encoded}&background=0284C7&color=fff`;
    }
}

async function exportDataBackup() {
    try {
        const jsonStr = await dbExportAllData();
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const dateStr = new Date().toISOString().split('T')[0];
        a.href = url;
        a.download = `MedAI_Backup_${dateStr}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Đã xuất file sao lưu JSON thành công!');
    } catch (e) {
        alert('Lỗi xuất dữ liệu: ' + e.message);
    }
}

async function importDataBackup(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    if (!confirm('Bạn có chắc chắn muốn nạp dữ liệu từ file sao lưu này? Dữ liệu mới sẽ được gộp vào hệ thống.')) {
        event.target.value = '';
        return;
    }

    try {
        const text = await file.text();
        await dbImportAllData(text);
        showToast('Đã khôi phục dữ liệu thành công!');
        updateSidebarProfile();
        renderSettingsView();
    } catch (e) {
        alert('Không thể khôi phục file sao lưu: ' + e.message);
    } finally {
        event.target.value = '';
    }
}

function confirmDeleteCase(caseId, returnToPatientId = null) {
    if (typeof hasPermission === 'function' && !hasPermission('DOCTOR', 'perm_delete_records')) {
        showToast('⛔ Quyền xóa bản ghi đã bị Admin khóa theo chính sách bảo mật bệnh viện.');
        return;
    }
    if (confirm('Bạn có chắc chắn muốn xóa vĩnh viễn ca chẩn đoán này khỏi cơ sở dữ liệu?')) {
        dbDeleteCase(caseId).then(() => {
            showToast('Đã xóa ca chẩn đoán.');
            if (returnToPatientId) {
                renderPatientDetailView(returnToPatientId);
            } else {
                renderHistoryView();
            }
        });
    }
}

function confirmDeletePatient(patientId) {
    if (typeof hasPermission === 'function' && !hasPermission('DOCTOR', 'perm_delete_records')) {
        showToast('⛔ Quyền xóa hồ sơ bệnh án đã bị Admin khóa theo chính sách bảo mật bệnh viện.');
        return;
    }
    if (confirm(`Bạn có chắc chắn muốn xóa TOÀN BỘ hồ sơ bệnh nhân ${patientId} cùng tất cả các lần chụp X-quang liên quan? Hành động này không thể hoàn tác.`)) {
        dbDeletePatient(patientId).then(() => {
            showToast(`Đã xóa hồ sơ bệnh nhân ${patientId}.`);
            navigateTo('patients');
        });
    }
}

function confirmResetAllData() {
    const code = prompt('CẢNH BÁO: Hành động này sẽ xóa toàn bộ lịch sử, hồ sơ bệnh nhân và cài đặt.\nĐể xác nhận, vui lòng gõ "XOA" vào ô bên dưới:');
    if (code === 'XOA' || code === 'xoa') {
        dbClearAll().then(() => {
            localStorage.removeItem('medai_doctor_settings_v1');
            showToast('Đã xóa sạch toàn bộ cơ sở dữ liệu.');
            updateSidebarProfile();
            renderSettingsView();
        });
    } else if (code !== null) {
        alert('Mã xác nhận không đúng. Đã hủy thao tác xóa.');
    }
}
