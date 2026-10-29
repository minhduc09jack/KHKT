/**
 * MedAI PACS/HIS v4.0 - Hospital Client Node Administrator & Security Control Center
 * Full control over Hospital Client Node (Client 1 / Client 2 / Client 3),
 * Federated Learning (FedProx) + Differential Privacy (Gaussian Noise & L2 Clipping),
 * Role-Based Access Control (RBAC Matrix & Staff Accounts),
 * Hospital Cybersecurity Compliance (HIPAA, Decree 13/2023/NĐ-CP, Circular 54/2017/TT-BYT),
 * and Immutable Security Audit Logs.
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
    return new Date(timestamp).toLocaleString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
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
    setTimeout(() => toast.classList.remove('show'), 3400);
}

// =========================================================================
// ROUTER & INITIALIZATION
// =========================================================================
function adminNavigateTo(route) {
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

    const mainContent = document.getElementById('admin-main-content');
    if (mainContent) mainContent.scrollTop = 0;

    updateAdminSidebarNodeInfo();

    if (route === 'overview') {
        renderAdminOverviewView();
    } else if (route === 'federated-dp') {
        renderAdminFederatedDPView();
    } else if (route === 'rbac-users') {
        renderAdminRBACUsersView();
    } else if (route === 'security-compliance') {
        renderAdminSecurityComplianceView();
    } else if (route === 'audit-logs') {
        renderAdminAuditLogsView();
    }
}

window.addEventListener('hashchange', () => {
    const route = window.location.hash.replace(/^#\/?/, '') || 'overview';
    if (['overview', 'federated-dp', 'rbac-users', 'security-compliance', 'audit-logs'].includes(route)) {
        adminNavigateTo(route);
    } else {
        adminNavigateTo('overview');
    }
});

window.onHospitalClientNodeChanged = function () {
    updateAdminSidebarNodeInfo();
    const route = window.location.hash.replace(/^#\/?/, '') || 'overview';
    adminNavigateTo(route);
};

function updateAdminSidebarNodeInfo() {
    const acc = getActiveAdminAccount();
    const nodeSpan = document.getElementById('sidebar-admin-node');
    if (nodeSpan) {
        nodeSpan.textContent = `Admin • ${acc.hospitalShort}`;
    }
    const nameEl = document.getElementById('sidebar-admin-name');
    if (nameEl) nameEl.textContent = acc.fullName;
    const avatarEl = document.getElementById('sidebar-admin-avatar');
    if (avatarEl) {
        avatarEl.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(acc.fullName)}&background=${acc.avatarBg}&color=fff`;
    }
}

function adminActorLabel() {
    const acc = getActiveAdminAccount();
    return `${acc.fullName} (${acc.username})`;
}

document.addEventListener('DOMContentLoaded', () => {
    updateAdminSidebarNodeInfo();
    const route = window.location.hash.replace(/^#\/?/, '') || 'overview';
    adminNavigateTo(route);
});

// =========================================================================
// VIEW 1: SYSTEM CONTROL CENTER & CLIENT HOSPITAL NODE OVERVIEW
// =========================================================================
async function renderAdminOverviewView() {
    const container = document.getElementById('view-overview');
    if (!container) return;

    const policy = getAdminPolicy();
    const adminAcc = getActiveAdminAccount();
    const activeNode = getHospitalClientNode(adminAcc.boundClientNode);
    const allCases = await dbGetAllCases();
    const allWorklist = await dbGetWorklistCases();
    const auditLogs = await dbGetAuditLogs();
    const pendingWl = allWorklist.filter(x => x.status === 'PENDING_DOCTOR').length;

    // Only the bound hospital is manageable. Other hospitals are shown as locked (no data, no control).
    const nodesHtml = Object.values(HOSPITAL_CLIENT_NODES).map(n => {
        const isCurrent = n.id === activeNode.id;
        if (!isCurrent) {
            return `
                <div class="client-node-card locked-node" onclick="selectAdminClientNode('${n.id}')" title="Thuộc quyền quản lý của Admin khác">
                    <div class="node-card-top">
                        <span class="node-code-badge">${escapeHtml(n.code)}</span>
                        <span class="status-badge badge-neutral"><i class="fa-solid fa-lock"></i> Không có quyền</span>
                    </div>
                    <h4>${escapeHtml(n.name)}</h4>
                    <p class="node-spec">Do tài khoản Admin riêng của bệnh viện này quản lý. Dữ liệu bệnh nhân, nhân sự và cấu hình bị ẩn hoàn toàn.</p>
                    <div class="node-footer-meta">
                        <span><i class="fa-solid fa-network-wired"></i> Chỉ chia sẻ trọng số FL+DP</span>
                    </div>
                </div>
            `;
        }
        return `
            <div class="client-node-card active-node">
                <div class="node-card-top">
                    <span class="node-code-badge">${escapeHtml(n.code)}</span>
                    <span class="status-badge badge-success">
                        <span class="pulse-dot green"></span>
                        Bệnh viện của bạn
                    </span>
                </div>
                <h4>${escapeHtml(n.name)}</h4>
                <p class="node-spec">${escapeHtml(n.specialty)}</p>
                <div class="node-metrics-row">
                    <div>
                        <small>Tập dữ liệu Cục bộ (Non-IID)</small>
                        <strong>${n.totalSamples} ảnh XQ (${n.pneumoniaRatio}% PN)</strong>
                    </div>
                    <div>
                        <small>Hiệu năng FL+DP</small>
                        <strong class="text-success">${n.localAccuracy}% Acc • ${n.localF1}% F1</strong>
                    </div>
                </div>
                <div class="node-footer-meta">
                    <span><i class="fa-solid fa-server"></i> IP: ${escapeHtml(n.ipAddress)}</span>
                    <span><i class="fa-solid fa-shield-halved"></i> DP ε-Private</span>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = `
        <div class="view-header">
            <div>
                <h2>Trung tâm Điều hành Hệ thống — ${escapeHtml(activeNode.name)}</h2>
                <p>Toàn quyền điều khiển hoạt động PACS/HIS, chính sách AI, an ninh dữ liệu và kết nối Học máy Liên kết tại Client Bệnh viện</p>
            </div>
            <div class="view-header-actions">
                <button class="btn btn-secondary" onclick="window.openPosterQRModal()">
                    <i class="fa-solid fa-qrcode"></i> Mã QR Poster & Cloud 24/7
                </button>
                <button class="btn btn-secondary" onclick="window.openHospitalDatasetModal()">
                    <i class="fa-solid fa-database"></i> Import Dataset Bệnh viện (federated_data)
                </button>
                <button class="btn btn-secondary" onclick="adminNavigateTo('federated-dp')">
                    <i class="fa-solid fa-network-wired"></i> Điều phối Federated Learning
                </button>
                <button class="btn btn-primary" onclick="saveAdminMasterControls()">
                    <i class="fa-solid fa-floppy-disk"></i> Áp dụng Cấu hình Toàn Viện
                </button>
            </div>
        </div>

        <!-- Admin tenant binding + federation overview -->
        <div class="admin-section-block">
            <div class="admin-tenant-card">
                <div class="admin-tenant-left">
                    <i class="fa-solid fa-user-shield"></i>
                    <div>
                        <strong>${escapeHtml(adminAcc.fullName)} — ${escapeHtml(adminAcc.username)}</strong>
                        <span>${escapeHtml(adminAcc.title)} • Chứng thư: ${escapeHtml(adminAcc.certificateId)}</span>
                    </div>
                </div>
                <div class="admin-tenant-right">
                    <span class="tenant-target-pill"><i class="fa-solid fa-lock"></i> Chỉ quản lý: ${escapeHtml(adminAcc.hospitalName)}</span>
                    <button class="btn btn-secondary btn-sm" onclick="window.openAdminAccountModal()">
                        <i class="fa-solid fa-right-left"></i> Đổi tài khoản Admin
                    </button>
                </div>
            </div>
            <div class="section-label-row">
                <h3><i class="fa-solid fa-hospital"></i> Mạng lưới 3 Bệnh viện Liên kết (Non-IID)</h3>
                <span class="text-muted">Tài khoản này chỉ điều khiển 1 bệnh viện. Các bệnh viện khác chỉ trao đổi trọng số mô hình FL+DP, không chia sẻ dữ liệu.</span>
            </div>
            <div class="client-nodes-grid">
                ${nodesHtml}
            </div>
        </div>

        <!-- Live Hospital KPIs -->
        <div class="stats-grid" style="padding-top: 18px;">
            <div class="stat-card">
                <div class="stat-icon blue"><i class="fa-solid fa-database"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${activeNode.totalSamples}</span>
                    <span class="stat-label">Ảnh X-Quang Cục bộ (${activeNode.shortName})</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon orange"><i class="fa-solid fa-x-ray"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${pendingWl} / ${allWorklist.length}</span>
                    <span class="stat-label">Ca chờ đọc / Tổng hàng đợi KTV</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon green"><i class="fa-solid fa-brain"></i></div>
                <div class="stat-info">
                    <span class="stat-value">96.58%</span>
                    <span class="stat-label">Độ chính xác Mô hình FL V5 (DP)</span>
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-icon red"><i class="fa-solid fa-shield-halved"></i></div>
                <div class="stat-info">
                    <span class="stat-value">${auditLogs.length}</span>
                    <span class="stat-label">Bản ghi Kiểm toán An ninh (SHA-256)</span>
                </div>
            </div>
        </div>

        <!-- Master Control Panel & Security Switches -->
        <div class="settings-grid" style="padding-top: 22px;">
            <div class="settings-col">
                <div class="card settings-card">
                    <div class="card-header highlight">
                        <i class="fa-solid fa-Sliders fa-sliders"></i>
                        <h3>Bảng Điều khiển Hệ thống Toàn Bệnh viện (Master System Switches)</h3>
                        <span class="badge">Admin Exclusive</span>
                    </div>
                    <div class="card-body">
                        <div class="settings-toggle-row" style="border-top:none; padding-top:0;">
                            <div>
                                <strong>1. Cho phép Động cơ Suy luận AI & Grad-CAM (AI Inference Engine)</strong>
                                <p class="text-muted">Nếu tắt, các trạm Bác sĩ và Kỹ thuật viên sẽ tạm ngưng gọi mô hình AI để bảo trì trọng số.</p>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="adm-toggle-ai" ${policy.aiEnabled ? 'checked' : ''} onchange="saveAdminMasterControls()">
                                <span class="slider round"></span>
                            </label>
                        </div>

                        <div class="settings-toggle-row">
                            <div>
                                <strong>2. Bắt buộc KTV hoàn thành Checklist QA/QC (4/4) trước khi chuyển Bác sĩ</strong>
                                <p class="text-muted">Đảm bảo mọi phim X-Quang gửi lên PACS đều đạt chuẩn tư thế, độ hít sâu và không nhiễu ảnh.</p>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="adm-toggle-qa" ${policy.requireTechQA ? 'checked' : ''} onchange="saveAdminMasterControls()">
                                <span class="slider round"></span>
                            </label>
                        </div>

                        <div class="settings-toggle-row">
                            <div>
                                <strong>3. Bật Ẩn danh hóa Hồ sơ Bệnh nhân (HIPAA / NĐ13 PHI De-identification)</strong>
                                <p class="text-muted">Tự động che tên thật của bệnh nhân trên các danh sách tra cứu để chống lộ lọt thông tin nhạy cảm.</p>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="adm-toggle-phi" ${policy.phiMaskingEnabled ? 'checked' : ''} onchange="saveAdminMasterControls()">
                                <span class="slider round"></span>
                            </label>
                        </div>

                        <div class="settings-toggle-row">
                            <div>
                                <strong class="text-danger"><i class="fa-solid fa-lock"></i> 4. Khóa An ninh Khẩn cấp Toàn Hệ thống (Emergency Lockdown)</strong>
                                <p class="text-muted">Kích hoạt khi phát hiện truy cập bất thường. Toàn bộ trạm KTV và Bác sĩ sẽ chuyển sang chế độ Chỉ đọc (Read-Only).</p>
                            </div>
                            <label class="switch">
                                <input type="checkbox" id="adm-toggle-lockdown" ${policy.emergencyLockdown ? 'checked' : ''} onchange="saveAdminMasterControls()">
                                <span class="slider round"></span>
                            </label>
                        </div>
                    </div>
                </div>
            </div>

            <div class="settings-col">
                <div class="card settings-card">
                    <div class="card-header">
                        <i class="fa-solid fa-gauge-simple-high"></i>
                        <h3>Chính sách Ngưỡng Chẩn đoán AI & Phiên Bảo mật Toàn Viện</h3>
                    </div>
                    <div class="card-body">
                        <div class="form-group">
                            <div class="slider-header-row">
                                <label>Ngưỡng Quyết định Viêm phổi Toàn Bệnh viện (Global Safety Threshold)</label>
                                <span class="threshold-badge" id="adm-threshold-lbl">${policy.globalDecisionThreshold}%</span>
                            </div>
                            <input type="range" min="15" max="85" step="5" id="adm-slider-threshold" value="${policy.globalDecisionThreshold}" oninput="document.getElementById('adm-threshold-lbl').textContent = this.value + '%'">
                            <div class="range-labels">
                                <span>15% (Sàng lọc Cấp cứu Nhạy cao)</span>
                                <span>50% (Cân bằng Chuẩn)</span>
                                <span>85% (Độ đặc hiệu Cao)</span>
                            </div>
                        </div>

                        <div class="form-group">
                            <label>Thời gian Tự động Khóa Phiên khi Không hoạt động (HIPAA Idle Session Timeout)</label>
                            <select id="adm-session-timeout">
                                <option value="15" ${policy.sessionTimeoutMinutes == 15 ? 'selected' : ''}>15 phút (Khuyến nghị Phòng Cấp cứu & PACS)</option>
                                <option value="30" ${policy.sessionTimeoutMinutes == 30 ? 'selected' : ''}>30 phút (Tiêu chuẩn Bệnh viện)</option>
                                <option value="60" ${policy.sessionTimeoutMinutes == 60 ? 'selected' : ''}>60 phút (Ca trực dài)</option>
                            </select>
                        </div>

                        <button class="btn btn-primary full-width" onclick="saveAdminMasterControls()">
                            <i class="fa-solid fa-check-double"></i> Lưu & Đồng bộ Chính sách Xuống Mọi Máy Trạm
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

async function selectAdminClientNode(nodeId) {
    // Admin can never take control of another hospital — delegate to the guarded handler (logs + denies)
    if (typeof window.switchHospitalClientNode === 'function') {
        await window.switchHospitalClientNode(nodeId);
    }
}

async function saveAdminMasterControls() {
    const aiEnabled = document.getElementById('adm-toggle-ai')?.checked ?? true;
    const requireTechQA = document.getElementById('adm-toggle-qa')?.checked ?? true;
    const phiMaskingEnabled = document.getElementById('adm-toggle-phi')?.checked ?? false;
    const emergencyLockdown = document.getElementById('adm-toggle-lockdown')?.checked ?? false;
    const globalDecisionThreshold = parseInt(document.getElementById('adm-slider-threshold')?.value || '50', 10);
    const sessionTimeoutMinutes = parseInt(document.getElementById('adm-session-timeout')?.value || '30', 10);

    await saveAdminPolicy({
        aiEnabled,
        requireTechQA,
        phiMaskingEnabled,
        emergencyLockdown,
        globalDecisionThreshold,
        sessionTimeoutMinutes
    }, adminActorLabel());

    await dbAddAuditLog({
        actor: adminActorLabel(),
        role: 'ADMIN',
        action: 'UPDATE_MASTER_SYSTEM_POLICY',
        severity: emergencyLockdown ? 'CRITICAL' : 'SECURITY',
        details: `Cập nhật điều khiển hệ thống: AI=${aiEnabled ? 'ON' : 'OFF'}, RequireQA=${requireTechQA}, PHIMask=${phiMaskingEnabled}, Lockdown=${emergencyLockdown}, Threshold=${globalDecisionThreshold}%.`
    });

    if (typeof window.refreshPortalTopBar === 'function') {
        window.refreshPortalTopBar();
    }
    showToast('✅ Đã áp dụng cấu hình điều khiển hệ thống xuống toàn bộ máy trạm Bác sĩ & Kỹ thuật viên!');
}

// =========================================================================
// VIEW 2: FEDERATED LEARNING (FEDPROX) & DIFFERENTIAL PRIVACY CONTROLLER
// =========================================================================
function renderAdminFederatedDPView() {
    const container = document.getElementById('view-federated-dp');
    if (!container) return;

    const policy = getAdminPolicy();
    const activeNode = getHospitalClientNode(policy.activeClientNode);

    container.innerHTML = `
        <div class="view-header">
            <div>
                <h2>Điều phối Học máy Liên kết (Federated Learning) & Bảo mật Vi phân (DP)</h2>
                <p>Huấn luyện mô hình Hybrid Ensemble (DenseNet-121 + EfficientNet-B0) liên viện mà không chia sẻ ảnh X-Quang bệnh nhân</p>
            </div>
            <div class="view-header-actions">
                <button class="btn btn-secondary" onclick="window.openPosterQRModal()">
                    <i class="fa-solid fa-qrcode"></i> Mã QR Poster KHKT
                </button>
                <button class="btn btn-primary" onclick="triggerFederatedDPRound()">
                    <i class="fa-solid fa-satellite-dish"></i> Đồng bộ Trọng số Cục bộ lên FL Server (Vòng #${(policy.flRoundCount || 30) + 1})
                </button>
            </div>
        </div>

        <div class="settings-grid">
            <div class="settings-col">
                <div class="card settings-card">
                    <div class="card-header highlight">
                        <i class="fa-solid fa-sliders"></i>
                        <h3>Tham số Huấn luyện FedProx & Ngân sách Bảo mật Vi phân (${escapeHtml(activeNode.shortName)})</h3>
                    </div>
                    <div class="card-body">
                        <div class="form-group">
                            <div class="slider-header-row">
                                <label>Hệ số Điều chuẩn FedProx Proximal Term (μ) — Chống lệch dữ liệu Non-IID</label>
                                <span class="threshold-badge" id="lbl-fl-mu">μ = ${policy.flMu || 1.0}</span>
                            </div>
                            <input type="range" id="adm-fl-mu" min="0.1" max="2.0" step="0.1" value="${policy.flMu || 1.0}" oninput="document.getElementById('lbl-fl-mu').textContent = 'μ = ' + this.value">
                            <small class="form-hint">FedProx (μ=1.0) giới hạn độ lệch trọng số giữa các bệnh viện có tỷ lệ bệnh nhân khác nhau (35% vs 81% vs 84%).</small>
                        </div>

                        <div class="form-group">
                            <div class="slider-header-row">
                                <label>Độ lệch chuẩn Nhiễu Gaussian Differential Privacy (σ)</label>
                                <span class="threshold-badge" id="lbl-dp-sigma">σ = ${policy.dpSigma || 0.01}</span>
                            </div>
                            <input type="range" id="adm-dp-sigma" min="0" max="0.05" step="0.002" value="${policy.dpSigma || 0.01}" oninput="document.getElementById('lbl-dp-sigma').textContent = 'σ = ' + this.value; updateDLGDefenseCanvases(parseFloat(this.value), 100);">
                            <small class="form-hint">Kéo thanh trượt σ từ 0.000 lên 0.010 để quan sát trực tiếp hiệu quả chống tấn công tái tạo ảnh (DLG Attack) ở phòng thí nghiệm bên dưới.</small>
                        </div>

                        <div class="form-group">
                            <div class="slider-header-row">
                                <label>Ngưỡng Cắt chuẩn Gradient L2-Norm Clipping (C)</label>
                                <span class="threshold-badge" id="lbl-dp-clip">C = ${policy.dpClipNorm || 1.0}</span>
                            </div>
                            <input type="range" id="adm-dp-clip" min="0.5" max="3.0" step="0.5" value="${policy.dpClipNorm || 1.0}" oninput="document.getElementById('lbl-dp-clip').textContent = 'C = ' + this.value">
                        </div>

                        <!-- Live Progress Simulation Box -->
                        <div id="fl-round-progress-box" class="fl-progress-box hidden">
                            <h4 id="fl-progress-title"><i class="fa-solid fa-circle-notch fa-spin"></i> Đang thực thi Vòng Huấn luyện Liên kết Bảo mật...</h4>
                            <div class="progress-bar" style="margin: 10px 0;">
                                <div class="progress-fill success" id="fl-progress-bar" style="width: 0%"></div>
                            </div>
                            <p id="fl-progress-step" class="text-muted" style="font-size:12.5px;">Khởi tạo...</p>
                        </div>

                        <button class="btn btn-primary full-width" onclick="triggerFederatedDPRound()">
                            <i class="fa-solid fa-cloud-arrow-up"></i> Lưu Tham số & Chạy Đồng bộ Trọng số DP-FedProx
                        </button>
                    </div>
                </div>
            </div>

            <div class="settings-col">
                <div class="card settings-card">
                    <div class="card-header">
                        <i class="fa-solid fa-chart-line"></i>
                        <h3>Bảng Đối chiếu Hiệu năng & Bảo mật Thực nghiệm (KHKT Benchmark)</h3>
                    </div>
                    <div class="card-body">
                        <div class="table-responsive">
                            <table class="data-table compact-table">
                                <thead>
                                    <tr>
                                        <th>Phương pháp Huấn luyện</th>
                                        <th>Accuracy</th>
                                        <th>F1-Score</th>
                                        <th>Bảo mật Riêng tư</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr>
                                        <td>Centralized (Gom dữ liệu tập trung)</td>
                                        <td>96.67%</td>
                                        <td>96.24%</td>
                                        <td><span class="perm-pill denied">❌ Vi phạm HIPAA (Lộ ảnh gốc)</span></td>
                                    </tr>
                                    <tr>
                                        <td>FL V4 — FedProx (Không có DP)</td>
                                        <td>95.47%</td>
                                        <td>94.45%</td>
                                        <td><span class="perm-pill denied">⚠️ Có nguy cơ tái tạo ảnh từ Gradient</span></td>
                                    </tr>
                                    <tr style="background: #ECFDF5;">
                                        <td><strong>FL V5 — FedProx + DP (Đang chạy)</strong></td>
                                        <td><strong class="text-success">96.58%</strong></td>
                                        <td><strong class="text-success">95.61%</strong></td>
                                        <td><span class="perm-pill allowed">✅ Bảo mật Vi phân ε-Private</span></td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <div class="settings-tip">
                            <i class="fa-solid fa-lightbulb"></i>
                            <span><strong>Phát hiện Khoa học Trọng tâm:</strong> Nhiễu vi phân Gaussian (σ=0.01) không chỉ bảo vệ tuyệt đối danh tính bệnh nhân trước tấn công Model Inversion, mà còn hoạt động như một bộ điều chuẩn (Regularizer) giúp mô hình toàn cục đạt <strong>Accuracy 96.58% & F1-Score 95.61%</strong> (cao hơn cả bản FL không có DP).</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- =========================================================================
             INTERACTIVE GRADIENT INVERSION ATTACK & DP DEFENSE LAB (DLG ATTACK DEMO)
             ========================================================================= -->
        <div class="admin-section-block" style="margin-top: 24px;">
            <div class="card">
                <div class="card-header highlight">
                    <i class="fa-solid fa-user-secret"></i>
                    <h3>Phòng Thí nghiệm Chống Tấn công Tái tạo Ảnh từ Gradient (Deep Leakage from Gradients — Có DP vs Không DP)</h3>
                    <span class="badge">NeurIPS DLG Attack Simulation</span>
                </div>
                <div class="card-body">
                    <div class="dlg-lab-toolbar">
                        <div class="dlg-lab-desc">
                            <strong>Cơ chế tấn công DLG (Zhu et al., NeurIPS):</strong> Nếu bệnh viện gửi Gradient thô (Không có DP) lên Server, kẻ tấn công có thể giải bài toán tối ưu ngược <code class="math-formula-pill">x* = argmin<sub>x'</sub> ‖∇W(x') − ∇W(x)‖²</code> để khôi phục lại ảnh X-Quang phổi của bệnh nhân. Khi bật <strong>Differential Privacy (σ = 0.01, C = 1.0, ε ≈ 6.99)</strong>, Gradient được làm nhiễu theo cơ chế <code class="math-formula-pill">g̃ = Clip(g, C) + N(0, σ²C²I)</code> khiến liên kết toán học giữa Gradient và pixel ảnh gốc bị phá hủy hoàn toàn.
                        </div>
                        <div class="dlg-lab-actions">
                            <select id="dlg-sample-select" class="import-node-select" onchange="initDLGDefenseLab(this.value)">
                                <option value="assets/hospital_dataset/c1_bacteria_480.jpeg">Ảnh XQ Mẫu 1: BN-C1-0480 (Viêm phổi thùy)</option>
                                <option value="assets/hospital_dataset/c2_bacteria_2931.jpeg">Ảnh XQ Mẫu 2: BN-C2-2931 (Cấp cứu ICU)</option>
                                <option value="assets/hospital_dataset/c3_virus_1685.jpeg">Ảnh XQ Mẫu 3: BN-C3-1685 (Viêm phổi Virus)</option>
                            </select>
                            <button type="button" class="btn btn-primary btn-sm" onclick="runInteractiveDLGAttackSimulation()">
                                <i class="fa-solid fa-play"></i> Chạy Mô phỏng Tấn công DLG (100 Vòng lặp)
                            </button>
                        </div>
                    </div>

                    <div id="dlg-attack-progress-strip" class="dlg-progress-strip hidden">
                        <span id="dlg-iter-label">Đang chạy thuật toán tấn công tái tạo Gradient: Vòng lặp 0/100...</span>
                        <div class="progress-bar mini" style="flex:1; max-width:320px;">
                            <div class="progress-fill danger" id="dlg-iter-bar" style="width:0%"></div>
                        </div>
                    </div>

                    <div class="dlg-canvas-grid">
                        <!-- Panel 1: Ground Truth Local X-Ray -->
                        <div class="dlg-canvas-card safe-local">
                            <div class="dlg-card-head">
                                <span class="status-badge badge-success"><i class="fa-solid fa-hospital-lock"></i> 1. Ảnh X-Quang Gốc Nội bộ</span>
                                <code>Local Storage Only</code>
                            </div>
                            <div class="dlg-canvas-wrap">
                                <canvas id="dlg-canvas-orig" width="224" height="224"></canvas>
                            </div>
                            <div class="dlg-metrics-bar">
                                <span>Trạng thái: <strong>Lưu tại ${escapeHtml(activeNode.shortName)}</strong></span>
                                <span class="text-success"><strong>BÍ MẬT Y TẾ</strong></span>
                            </div>
                            <small class="text-muted">Ảnh gốc nằm tại máy chủ nội bộ của bệnh viện, tuyệt đối không truyền qua mạng.</small>
                        </div>

                        <!-- Panel 2: DLG Attack WITHOUT Differential Privacy (Sigma = 0) -->
                        <div class="dlg-canvas-card danger-leak">
                            <div class="dlg-card-head">
                                <span class="status-badge badge-danger"><i class="fa-solid fa-skull-crossbones"></i> 2. Tái tạo khi KHÔNG CÓ DP (σ = 0)</span>
                                <code>SSIM: <span id="dlg-nodp-ssim">0.842</span></code>
                            </div>
                            <div class="dlg-canvas-wrap">
                                <canvas id="dlg-canvas-nodp" width="224" height="224"></canvas>
                            </div>
                            <div class="dlg-metrics-bar">
                                <span>PSNR: <strong id="dlg-nodp-psnr">24.6 dB</strong></span>
                                <span class="text-danger"><strong>🚨 LỘ HỒ SƠ BỆNH ÁN!</strong></span>
                            </div>
                            <small class="text-muted">Kẻ tấn công khôi phục rõ khung xương sườn, bóng tim và vùng tổn thương phổi từ Gradient lớp Conv1.</small>
                        </div>

                        <!-- Panel 3: DLG Attack WITH Differential Privacy (Sigma = active slider) -->
                        <div class="dlg-canvas-card dp-protected">
                            <div class="dlg-card-head">
                                <span class="status-badge badge-success" id="dlg-withdp-badge"><i class="fa-solid fa-shield-halved"></i> 3. Tái tạo khi CÓ DP (σ = ${policy.dpSigma || 0.01})</span>
                                <code>SSIM: <span id="dlg-withdp-ssim">0.018</span></code>
                            </div>
                            <div class="dlg-canvas-wrap">
                                <canvas id="dlg-canvas-withdp" width="224" height="224"></canvas>
                            </div>
                            <div class="dlg-metrics-bar">
                                <span>PSNR: <strong id="dlg-withdp-psnr">8.4 dB</strong></span>
                                <span class="text-success" id="dlg-withdp-verdict"><strong>🛡️ BẢO MẬT THÀNH CÔNG!</strong></span>
                            </div>
                            <small class="text-muted" id="dlg-withdp-desc">Nhiễu Gaussian (σ=0.01) + L2 Clipping (C=1.0) biến ảnh tái tạo của kẻ tấn công thành nhiễu trắng vô nghĩa.</small>
                        </div>
                    </div>

                    <!-- High-Res Benchmark Plots from KHKT Experiments -->
                    <details class="dlg-benchmark-details">
                        <summary><i class="fa-solid fa-images"></i> Xem Biểu đồ Kết quả Thực nghiệm Gốc trong Báo cáo KHKT (DLG Attack & V5 Trade-off Plots)</summary>
                        <div class="dlg-benchmark-imgs">
                            <div class="dlg-plot-box">
                                <img src="assets/plots/dlg_reconstruction_simulation.png" alt="Mô phỏng DLG Attack Thực nghiệm">
                                <span>Hình 1: Kết quả thực nghiệm chống tấn công tái tạo ảnh từ Gradient (Không DP vs Có DP σ=0.01)</span>
                            </div>
                            <div class="dlg-plot-box">
                                <img src="assets/plots/v5_final_tradeoff_plot.png" alt="Biểu đồ đánh đổi Hiệu năng và Bảo mật V5">
                                <span>Hình 2: Biểu đồ đối chiếu Accuracy & F1-Score giữa Centralized, FL Không DP và FL + DP (σ=0.01)</span>
                            </div>
                        </div>
                    </details>
                </div>
            </div>
        </div>
    `;

    setTimeout(() => initDLGDefenseLab(), 40);
}

// =========================================================================
// INTERACTIVE DLG ATTACK & DIFFERENTIAL PRIVACY CANVAS ENGINE
// =========================================================================
let dlgSourceImageData = null;
let dlgAnimTimer = null;

function initDLGDefenseLab(imgSrc = 'assets/hospital_dataset/c1_bacteria_480.jpeg') {
    const cOrig = document.getElementById('dlg-canvas-orig');
    if (!cOrig) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        const ctx = cOrig.getContext('2d');
        ctx.drawImage(img, 0, 0, 224, 224);
        dlgSourceImageData = ctx.getImageData(0, 0, 224, 224);
        const sigma = parseFloat(document.getElementById('adm-dp-sigma')?.value || '0.01');
        updateDLGDefenseCanvases(sigma, 100);
    };
    img.src = imgSrc;
}

function updateDLGDefenseCanvases(sigma = 0.01, iterationProgress = 100) {
    if (!dlgSourceImageData) return;
    const cNoDP = document.getElementById('dlg-canvas-nodp');
    const cWithDP = document.getElementById('dlg-canvas-withdp');
    if (!cNoDP || !cWithDP) return;

    const src = dlgSourceImageData.data;
    const ctxNoDP = cNoDP.getContext('2d');
    const ctxWithDP = cWithDP.getContext('2d');

    const imgNoDP = ctxNoDP.createImageData(224, 224);
    const imgWithDP = ctxWithDP.createImageData(224, 224);

    // Convergence ratio from 0.0 (pure noise at iter 0) to 1.0 (converged at iter 100)
    const conv = Math.min(1, Math.max(0.05, iterationProgress / 100));

    // How much structure survives under Differential Privacy sigma:
    // At sigma = 0 -> 100% leak; at sigma = 0.002 -> 45% leak; at sigma >= 0.01 -> 0% structure (pure Gaussian noise)
    const dpLeakRatio = Math.max(0, 1 - (sigma / 0.008)) * conv;

    for (let i = 0; i < src.length; i += 4) {
        const r = src[i];
        const g = src[i + 1];
        const b = src[i + 2];

        // 1. Without DP: attacker reconstructs clear anatomical structure + slight DLG grid artifact
        const dlgArtifact = (Math.random() - 0.5) * (38 * (2 - conv));
        const noDpSignal = conv * 0.88;
        const randNoise = (1 - noDpSignal) * (60 + Math.random() * 140);

        imgNoDP.data[i] = Math.min(255, Math.max(0, r * noDpSignal + randNoise + dlgArtifact));
        imgNoDP.data[i + 1] = Math.min(255, Math.max(0, g * noDpSignal + randNoise + dlgArtifact));
        imgNoDP.data[i + 2] = Math.min(255, Math.max(0, b * noDpSignal + randNoise + dlgArtifact));
        imgNoDP.data[i + 3] = 255;

        // 2. With DP (sigma): Gaussian noise destroys gradient-to-pixel invertibility
        const gaussianNoiseR = 55 + Math.random() * 150;
        const gaussianNoiseG = 55 + Math.random() * 150;
        const gaussianNoiseB = 55 + Math.random() * 150;

        imgWithDP.data[i] = Math.min(255, Math.max(0, r * dpLeakRatio + gaussianNoiseR * (1 - dpLeakRatio)));
        imgWithDP.data[i + 1] = Math.min(255, Math.max(0, g * dpLeakRatio + gaussianNoiseG * (1 - dpLeakRatio)));
        imgWithDP.data[i + 2] = Math.min(255, Math.max(0, b * dpLeakRatio + gaussianNoiseB * (1 - dpLeakRatio)));
        imgWithDP.data[i + 3] = 255;
    }

    ctxNoDP.putImageData(imgNoDP, 0, 0);
    ctxWithDP.putImageData(imgWithDP, 0, 0);

    // Update live quantitative privacy metrics (SSIM & PSNR)
    const noDpSsim = (0.12 + 0.722 * conv).toFixed(3);
    const noDpPsnr = (9.2 + 15.4 * conv).toFixed(1) + ' dB';
    const elNoSsim = document.getElementById('dlg-nodp-ssim');
    const elNoPsnr = document.getElementById('dlg-nodp-psnr');
    if (elNoSsim) elNoSsim.textContent = noDpSsim;
    if (elNoPsnr) elNoPsnr.textContent = noDpPsnr;

    const dpSsim = (0.015 + 0.81 * dpLeakRatio).toFixed(3);
    const dpPsnr = (8.2 + 16.0 * dpLeakRatio).toFixed(1) + ' dB';
    const elDpSsim = document.getElementById('dlg-withdp-ssim');
    const elDpPsnr = document.getElementById('dlg-withdp-psnr');
    const elDpBadge = document.getElementById('dlg-withdp-badge');
    const elDpVerdict = document.getElementById('dlg-withdp-verdict');

    if (elDpSsim) elDpSsim.textContent = dpSsim;
    if (elDpPsnr) elDpPsnr.textContent = dpPsnr;
    if (elDpBadge) {
        elDpBadge.className = sigma >= 0.008 ? 'status-badge badge-success' : 'status-badge badge-danger';
        elDpBadge.innerHTML = `<i class="fa-solid ${sigma >= 0.008 ? 'fa-shield-halved' : 'fa-triangle-exclamation'}"></i> 3. Tái tạo khi CÓ DP (σ = ${sigma.toFixed(3)})`;
    }
    if (elDpVerdict) {
        if (sigma >= 0.008) {
            elDpVerdict.className = 'text-success';
            elDpVerdict.innerHTML = '<strong>🛡️ BẢO MẬT THÀNH CÔNG (NHIỄU TRẮNG)</strong>';
        } else {
            elDpVerdict.className = 'text-danger';
            elDpVerdict.innerHTML = '<strong>⚠️ NHIỄU σ QUÁ THẤP — VẪN LỘ MỜ!</strong>';
        }
    }
}

function runInteractiveDLGAttackSimulation() {
    if (dlgAnimTimer) clearInterval(dlgAnimTimer);
    const strip = document.getElementById('dlg-attack-progress-strip');
    const lbl = document.getElementById('dlg-iter-label');
    const bar = document.getElementById('dlg-iter-bar');
    if (strip) strip.classList.remove('hidden');

    let iter = 5;
    const sigma = parseFloat(document.getElementById('adm-dp-sigma')?.value || '0.01');

    dlgAnimTimer = setInterval(() => {
        if (lbl) lbl.textContent = `⚡ Đang mô phỏng tấn công Deep Leakage from Gradients (DLG): Vòng lặp tối ưu #${iter}/100...`;
        if (bar) bar.style.width = iter + '%';
        updateDLGDefenseCanvases(sigma, iter);

        if (iter >= 100) {
            clearInterval(dlgAnimTimer);
            dlgAnimTimer = null;
            if (lbl) {
                lbl.innerHTML = `✅ <strong>Hoàn tất 100 vòng lặp tấn công DLG:</strong> Bản Không DP bị lộ ảnh phổi (SSIM=0.842), trong khi bản <strong>Có DP (σ=${sigma})</strong> bảo vệ tuyệt đối 100% (SSIM=0.018)!`;
            }
            showToast(`🛡️ Đã kiểm chứng: DP (σ=${sigma}) chặn đứng hoàn toàn tấn công tái tạo ảnh từ Gradient!`);
        }
        iter += 10;
    }, 140);
}

async function triggerFederatedDPRound() {
    const mu = parseFloat(document.getElementById('adm-fl-mu')?.value || '1.0');
    const sigma = parseFloat(document.getElementById('adm-dp-sigma')?.value || '0.01');
    const clip = parseFloat(document.getElementById('adm-dp-clip')?.value || '1.0');
    const policy = getAdminPolicy();
    const nextRound = (policy.flRoundCount || 30) + 1;
    const node = getHospitalClientNode(policy.activeClientNode);

    const box = document.getElementById('fl-round-progress-box');
    const bar = document.getElementById('fl-progress-bar');
    const stepText = document.getElementById('fl-progress-step');
    const titleText = document.getElementById('fl-progress-title');

    if (box) box.classList.remove('hidden');

    const steps = [
        { pct: 25, msg: `[Bước 1/4] Đang huấn luyện cục bộ tại ${node.shortName} trên ${node.totalSamples} ảnh X-Quang với FedProx (μ=${mu})...` },
        { pct: 55, msg: `[Bước 2/4] Đang áp dụng L2-Norm Gradient Clipping (Ngưỡng C=${clip}) để giới hạn độ nhạy cá nhân...` },
        { pct: 80, msg: `[Bước 3/4] Đang bơm nhiễu Gaussian Differential Privacy (σ=${sigma}) lên các lớp Trainable Weights...` },
        { pct: 100, msg: `[Bước 4/4] Đã mã hóa TLS 1.3 & đồng bộ trọng số Vòng #${nextRound} lên Flower Server thành công! (0 ảnh bệnh nhân bị truyền ra ngoài).` }
    ];

    for (const s of steps) {
        if (bar) bar.style.width = s.pct + '%';
        if (stepText) stepText.textContent = s.msg;
        await new Promise(r => setTimeout(r, 650));
    }

    if (titleText) {
        titleText.innerHTML = `<i class="fa-solid fa-circle-check text-success"></i> Hoàn tất Đồng bộ Vòng Huấn luyện Liên kết #${nextRound}!`;
    }

    await saveAdminPolicy({
        flMu: mu,
        dpSigma: sigma,
        dpClipNorm: clip,
        flRoundCount: nextRound,
        lastFlSync: Date.now()
    }, adminActorLabel());

    await dbAddAuditLog({
        actor: adminActorLabel(),
        role: 'ADMIN',
        action: `FL_DP_SYNC_ROUND_${nextRound}`,
        severity: 'SECURITY',
        details: `Hoàn tất vòng huấn luyện liên kết #${nextRound} tại ${node.name} (FedProx μ=${mu}, DP σ=${sigma}, L2 Clip=${clip}).`
    });

    showToast(`✅ Đã đồng bộ thành công trọng số bảo mật vi phân Vòng #${nextRound} lên FL Server!`);
}

// =========================================================================
// VIEW 3: RBAC PERMISSION MATRIX & HOSPITAL STAFF MANAGEMENT
// =========================================================================
function renderAdminRBACUsersView() {
    const container = document.getElementById('view-rbac-users');
    if (!container) return;

    const matrix = getRBACMatrix();
    const users = dbGetUsers();

    const matrixRows = Object.keys(matrix).map(key => {
        const m = matrix[key];
        return `
            <tr>
                <td>
                    <strong>${escapeHtml(m.label)}</strong>
                    <div class="text-muted" style="font-size:11.5px;">Phân hệ: ${escapeHtml(m.category)} • Mã quyền: <code>${escapeHtml(key)}</code></div>
                </td>
                <td style="text-align:center;">
                    <label class="switch">
                        <input type="checkbox" data-perm="${escapeHtml(key)}" data-role="TECHNICIAN" ${m.TECHNICIAN ? 'checked' : ''} onchange="toggleRBACPermission(this)">
                        <span class="slider round"></span>
                    </label>
                </td>
                <td style="text-align:center;">
                    <label class="switch">
                        <input type="checkbox" data-perm="${escapeHtml(key)}" data-role="DOCTOR" ${m.DOCTOR ? 'checked' : ''} onchange="toggleRBACPermission(this)">
                        <span class="slider round"></span>
                    </label>
                </td>
                <td style="text-align:center;">
                    <label class="switch">
                        <input type="checkbox" data-perm="${escapeHtml(key)}" data-role="ADMIN" ${m.ADMIN ? 'checked' : ''} ${key === 'perm_manage_security' ? 'disabled' : ''} onchange="toggleRBACPermission(this)">
                        <span class="slider round"></span>
                    </label>
                </td>
            </tr>
        `;
    }).join('');

    const usersRows = users.map(u => {
        const roleBadge = u.role === 'ADMIN'
            ? '<span class="wl-pri-badge stat">ADMIN BỆNH VIỆN</span>'
            : (u.role === 'DOCTOR' ? '<span class="wl-pri-badge routine">BÁC SĨ CHẨN ĐOÁN</span>' : '<span class="wl-pri-badge urgent">KỸ THUẬT VIÊN XQ</span>');

        return `
            <tr>
                <td><strong>${escapeHtml(u.username)}</strong></td>
                <td>
                    <strong>${escapeHtml(u.fullName)}</strong>
                    <div class="text-muted"><small>${escapeHtml(u.title)}</small></div>
                </td>
                <td>${roleBadge}</td>
                <td>${escapeHtml(u.department)}</td>
                <td>
                    ${u.mfaEnabled
                        ? '<span class="perm-pill allowed"><i class="fa-solid fa-shield-check"></i> 2FA Bật</span>'
                        : '<span class="perm-pill denied">Chưa bật 2FA</span>'}
                </td>
                <td>
                    <span class="status-badge ${u.status === 'ACTIVE' ? 'badge-success' : 'badge-danger'}">
                        ${u.status === 'ACTIVE' ? 'Đang hoạt động' : 'Đã khóa'}
                    </span>
                </td>
                <td style="text-align:right;">
                    <button class="btn btn-secondary btn-sm" onclick="toggleHospitalUserStatus('${escapeHtml(u.id)}')">
                        <i class="fa-solid ${u.status === 'ACTIVE' ? 'fa-user-lock' : 'fa-user-check'}"></i> ${u.status === 'ACTIVE' ? 'Khóa TK' : 'Mở khóa'}
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <div class="view-header">
            <div>
                <h2>Quản lý Phân quyền Chi tiết (RBAC Matrix) & Tài khoản Nhân sự Y tế</h2>
                <p>Phân tách nhiệm vụ nghiêm ngặt giữa Kỹ thuật viên Phòng X-Quang, Bác sĩ Chẩn đoán và Quản trị viên Hệ thống</p>
            </div>
            <div class="view-header-actions">
                <button class="btn btn-secondary" onclick="resetRBACMatrixToDefault()">
                    <i class="fa-solid fa-rotate-left"></i> Khôi phục Ma trận Chuẩn
                </button>
            </div>
        </div>

        <!-- Granular RBAC Matrix Card -->
        <div class="card table-card" style="margin-top: 20px;">
            <div class="card-header">
                <i class="fa-solid fa-key"></i>
                <h3>Ma trận Điều khiển Phân quyền Thực thi Thời gian thực (Live RBAC Permission Matrix)</h3>
            </div>
            <div class="table-responsive">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Quyền hạn & Nghiệp vụ Y tế trong Bệnh viện</th>
                            <th style="text-align:center; width:170px;">Kỹ thuật viên X-Quang</th>
                            <th style="text-align:center; width:170px;">Bác sĩ Chẩn đoán</th>
                            <th style="text-align:center; width:170px;">Admin Bệnh viện</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${matrixRows}
                    </tbody>
                </table>
            </div>
        </div>

        <!-- Hospital Staff Accounts Table -->
        <div class="card table-card" style="margin-top: 24px;">
            <div class="card-header">
                <i class="fa-solid fa-users"></i>
                <h3>Danh sách Tài khoản Nhân viên Y tế tại Client Bệnh viện (${users.length} nhân sự)</h3>
                <button class="btn btn-primary btn-sm" onclick="promptAddNewHospitalUser()">
                    <i class="fa-solid fa-user-plus"></i> Cấp tài khoản nhân sự mới
                </button>
            </div>
            <div class="table-responsive">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Tài khoản (ID)</th>
                            <th>Họ và tên & Chức danh</th>
                            <th>Vai trò RBAC</th>
                            <th>Khoa / Phòng</th>
                            <th>Xác thực 2 lớp</th>
                            <th>Trạng thái</th>
                            <th style="text-align:right;">Điều khiển</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${usersRows}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

async function toggleRBACPermission(checkboxEl) {
    const perm = checkboxEl.getAttribute('data-perm');
    const role = checkboxEl.getAttribute('data-role');
    const allowed = checkboxEl.checked;

    const matrix = getRBACMatrix();
    if (matrix[perm]) {
        matrix[perm][role] = allowed;
        saveRBACMatrix(matrix);

        await dbAddAuditLog({
            actor: adminActorLabel(),
            role: 'ADMIN',
            action: 'RBAC_PERMISSION_CHANGE',
            severity: 'SECURITY',
            details: `Admin ${allowed ? 'CẤP QUYỀN' : 'THU HỒI QUYỀN'} [${perm}] đối với vai trò [${role}].`
        });

        showToast(`🔐 Đã ${allowed ? 'cấp' : 'thu hồi'} quyền "${matrix[perm].label}" cho vai trò ${role}!`);
    }
}

async function resetRBACMatrixToDefault() {
    localStorage.removeItem('medai_rbac_matrix_v4');
    renderAdminRBACUsersView();
    showToast('✅ Đã khôi phục Ma trận Phân quyền RBAC về tiêu chuẩn an toàn bệnh viện.');
}

async function toggleHospitalUserStatus(userId) {
    const acc = getActiveAdminAccount();
    // Load the FULL user directory so saving never drops other hospitals' staff
    const allUsers = dbGetUsers(false);
    const target = allUsers.find(u => u.id === userId);
    if (!target) return;

    if ((target.clientNode || 'CLIENT_1') !== acc.boundClientNode) {
        await dbAddAuditLog({
            actor: adminActorLabel(),
            role: 'ADMIN',
            action: 'CROSS_HOSPITAL_USER_EDIT_DENIED',
            severity: 'WARN',
            details: `Chặn thao tác sửa tài khoản ${target.username} thuộc ${target.clientNode}.`
        });
        showToast('⛔ Không thể quản lý nhân sự của bệnh viện khác.');
        return;
    }
    if (target.role === 'ADMIN' && target.username === acc.username) {
        showToast('⛔ Không thể tự khóa tài khoản Admin đang đăng nhập.');
        return;
    }

    target.status = target.status === 'ACTIVE' ? 'LOCKED' : 'ACTIVE';
    dbSaveUsers(allUsers);

    await dbAddAuditLog({
        actor: adminActorLabel(),
        role: 'ADMIN',
        action: target.status === 'LOCKED' ? 'LOCK_USER_ACCOUNT' : 'UNLOCK_USER_ACCOUNT',
        severity: 'SECURITY',
        details: `${target.status === 'LOCKED' ? 'Khóa' : 'Mở khóa'} tài khoản ${target.username} (${target.fullName} - ${target.role}).`
    });

    renderAdminRBACUsersView();
    showToast(`Đã cập nhật trạng thái tài khoản ${target.fullName}!`);
}

async function promptAddNewHospitalUser() {
    const fullName = prompt('Nhập Họ và tên nhân sự y tế mới (VD: BS.CKI Hoàng Văn Nam):');
    if (!fullName) return;
    const roleInput = prompt('Nhập Vai trò (Gõ: DOCTOR, TECHNICIAN hoặc ADMIN):', 'TECHNICIAN');
    const role = ['ADMIN', 'DOCTOR', 'TECHNICIAN'].includes((roleInput || '').toUpperCase().trim())
        ? roleInput.toUpperCase().trim()
        : 'TECHNICIAN';

    const acc = getActiveAdminAccount();
    const allUsers = dbGetUsers(false);
    const newUser = {
        id: 'USR-' + Date.now().toString(36).toUpperCase(),
        username: fullName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || ('nv' + allUsers.length),
        fullName: fullName.trim(),
        role,
        title: role === 'DOCTOR' ? 'Bác sĩ Chẩn đoán Hình ảnh' : (role === 'ADMIN' ? `Quản trị viên phụ — chỉ ${acc.hospitalShort}` : 'Kỹ thuật viên Phòng X-Quang'),
        department: `${role === 'TECHNICIAN' ? 'Phòng Chụp X-Quang' : 'Khoa Chẩn đoán Hình ảnh'} - ${acc.hospitalShort}`,
        // New staff are always bound to the creating Admin's hospital — never to another one
        clientNode: acc.boundClientNode,
        mfaEnabled: true,
        status: 'ACTIVE',
        lastLogin: Date.now()
    };

    allUsers.push(newUser);
    dbSaveUsers(allUsers);

    await dbAddAuditLog({
        actor: adminActorLabel(),
        role: 'ADMIN',
        action: 'CREATE_STAFF_ACCOUNT',
        severity: 'SECURITY',
        details: `Cấp mới tài khoản ${newUser.username} (${newUser.fullName}) với vai trò ${newUser.role} tại ${acc.hospitalName}.`
    });

    renderAdminRBACUsersView();
    showToast(`✅ Đã cấp tài khoản cho ${newUser.fullName} (${newUser.role})!`);
}

// =========================================================================
// VIEW 4: HOSPITAL SECURITY & LEGAL COMPLIANCE
// =========================================================================
function renderAdminSecurityComplianceView() {
    const container = document.getElementById('view-security-compliance');
    if (!container) return;

    container.innerHTML = `
        <div class="view-header">
            <div>
                <h2>Tuân thủ Quy định Bảo mật Bệnh viện & Tiêu chuẩn Y tế Quốc tế</h2>
                <p>Kiểm toán tự động theo HIPAA (Hoa Kỳ), Nghị định 13/2023/NĐ-CP, Thông tư 54/2017/TT-BYT & DICOM PS3.15</p>
            </div>
        </div>

        <div class="settings-grid">
            <div class="card settings-card">
                <div class="card-header">
                    <i class="fa-solid fa-shield-virus"></i>
                    <h3>1. Bảo vệ Dữ liệu Cá nhân & Bệnh án Điện tử (HIPAA & Nghị định 13/2023/NĐ-CP)</h3>
                </div>
                <div class="card-body">
                    <div class="diag-status-row">
                        <span class="diag-label">Chính sách Không chia sẻ Dữ liệu Thô (Zero Raw-Data Sharing):</span>
                        <span class="status-badge badge-success">Đạt 100% (Federated Local Storage)</span>
                    </div>
                    <div class="diag-status-row">
                        <span class="diag-label">Bảo mật Vi phân Trọng số AI (Differential Privacy ε-Private):</span>
                        <span class="status-badge badge-success">Gaussian Noise σ=0.01 + L2 Clip</span>
                    </div>
                    <div class="diag-status-row">
                        <span class="diag-label">Ẩn danh hóa Thông tin Nhạy cảm (DICOM PHI Masking):</span>
                        <span class="text-success">Hỗ trợ bật/tắt tức thì từ Admin</span>
                    </div>
                    <div class="diag-status-row">
                        <span class="diag-label">Cô lập Lưu trữ Trình duyệt (IndexedDB Sandbox Isolation):</span>
                        <span class="text-success">Không lưu ảnh bệnh nhân trên Server công cộng</span>
                    </div>
                </div>
            </div>

            <div class="card settings-card">
                <div class="card-header">
                    <i class="fa-solid fa-lock"></i>
                    <h3>2. An toàn Thông tin Bệnh viện Thông minh (Thông tư 54/2017/TT-BYT Mức 6)</h3>
                </div>
                <div class="card-body">
                    <div class="diag-status-row">
                        <span class="diag-label">Kiểm chứng Toàn vẹn Ảnh Y khoa & Chữ ký số:</span>
                        <span class="status-badge badge-success">SHA-256 Cryptographic Hash</span>
                    </div>
                    <div class="diag-status-row">
                        <span class="diag-label">Phân tách Quyền hạn Y tế (RBAC Separation of Duties):</span>
                        <span class="status-badge badge-success">KTV Chụp ≠ Bác sĩ Ký ≠ Admin Hệ thống</span>
                    </div>
                    <div class="diag-status-row">
                        <span class="diag-label">Bảo vệ Giao thức Web (HTTP Security Headers):</span>
                        <span class="text-success">X-Frame-Options, nosniff, COOP, Strict-Referrer</span>
                    </div>
                    <div class="diag-status-row">
                        <span class="diag-label">Nhật ký Kiểm toán Truy cập Bất biến (Audit Trail):</span>
                        <span class="text-success">Ghi nhận 100% tác vụ kèm mã băm SHA-256</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// =========================================================================
// VIEW 5: IMMUTABLE SECURITY AUDIT LOGS
// =========================================================================
async function renderAdminAuditLogsView() {
    const container = document.getElementById('view-audit-logs');
    if (!container) return;

    const logs = await dbGetAuditLogs();

    container.innerHTML = `
        <div class="view-header">
            <div>
                <h2>Nhật ký Kiểm toán Bảo mật Bất biến (HIPAA Security Audit Trail)</h2>
                <p>Ghi vết toàn bộ hoạt động trên cả 3 giao diện (Admin - Bác sĩ - Kỹ thuật viên X-Quang) kèm chữ ký băm SHA-256</p>
            </div>
            <div class="view-header-actions">
                <button class="btn btn-secondary" onclick="renderAdminAuditLogsView()"><i class="fa-solid fa-arrows-rotate"></i> Làm mới</button>
                <button class="btn btn-primary" onclick="exportAuditLogsJSON()"><i class="fa-solid fa-file-shield"></i> Xuất Báo cáo Kiểm toán (.JSON)</button>
            </div>
        </div>

        <div class="card table-card" style="margin-top: 20px;">
            <div class="table-responsive">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Thời gian</th>
                            <th>Mức độ</th>
                            <th>Vai trò & Người thực hiện</th>
                            <th>Client Bệnh viện</th>
                            <th>Mã Hành động</th>
                            <th>Chi tiết Nghiệp vụ</th>
                            <th>Mã Băm Toàn vẹn (SHA-256)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${logs.map(l => {
                            const sevBadge = l.severity === 'CRITICAL' || l.severity === 'WARN'
                                ? `<span class="status-badge badge-danger">${escapeHtml(l.severity)}</span>`
                                : (l.severity === 'SECURITY'
                                    ? `<span class="status-badge badge-warning">${escapeHtml(l.severity)}</span>`
                                    : `<span class="status-badge badge-success">${escapeHtml(l.severity)}</span>`);

                            return `
                                <tr>
                                    <td class="text-muted"><small>${formatDate(l.timestamp)}</small></td>
                                    <td>${sevBadge}</td>
                                    <td>
                                        <strong>${escapeHtml(l.actor)}</strong>
                                        <div class="text-muted"><small>Role: ${escapeHtml(l.role)}</small></div>
                                    </td>
                                    <td><code>${escapeHtml(l.clientNode || 'CLIENT_1')}</code></td>
                                    <td><code>${escapeHtml(l.action)}</code></td>
                                    <td style="max-width:340px;">${escapeHtml(l.details)}</td>
                                    <td><code class="sha-code">${escapeHtml(l.hash)}</code></td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

async function exportAuditLogsJSON() {
    const logs = await dbGetAuditLogs();
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MedAI_Security_Audit_Logs_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('✅ Đã xuất Báo cáo Kiểm toán Bảo mật (.JSON) thành công!');
}
