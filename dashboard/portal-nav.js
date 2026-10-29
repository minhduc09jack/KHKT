/**
 * MedAI PACS/HIS v4.2 - Unified Multi-Role Portal Switcher, Dataset Importer & Security Bar
 * Mounts synchronously (0ms delay) across:
 *   - /dashboard/index.html      (Diagnostic Doctor Portal)
 *   - /dashboard/technician.html (X-Ray Room Technician Portal)
 *   - /dashboard/admin.html      (Hospital Client Admin & FL/DP Control Center)
 */

(function () {
    function detectCurrentPortal() {
        const path = window.location.pathname.toLowerCase();
        if (path.includes('technician')) return 'TECHNICIAN';
        if (path.includes('admin')) return 'ADMIN';
        return 'DOCTOR';
    }

    function escapeSafe(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function getPendingWorklistCountSync() {
        try {
            const raw = localStorage.getItem('medai_ls_worklist_v43');
            const boundNode = typeof getActiveAdminAccount === 'function'
                ? getActiveAdminAccount().boundClientNode
                : 'CLIENT_1';
            if (!raw) return 3;
            const list = JSON.parse(raw);
            return Array.isArray(list)
                ? list.filter(x => x.status === 'PENDING_DOCTOR' && (x.clientNode || 'CLIENT_1') === boundNode).length
                : 0;
        } catch (e) {
            return 0;
        }
    }

    function buildPortalTopBarHTML(currentRole, policy, pendingCount) {
        const node = typeof getHospitalClientNode === 'function'
            ? getHospitalClientNode(policy.activeClientNode)
            : { id: 'CLIENT_1', shortName: 'Client 1 • BV Phổi TW' };
        const adminAcc = typeof getActiveAdminAccount === 'function'
            ? getActiveAdminAccount()
            : { fullName: 'Admin', username: 'admin', hospitalName: node.name || '' };

        const isTech = currentRole === 'TECHNICIAN';
        const isDoc = currentRole === 'DOCTOR';
        const isAdmin = currentRole === 'ADMIN';

        return `
            <div class="hospital-portal-bar" id="hospital-portal-bar">
                <div class="portal-bar-left">
                    <button type="button" class="mobile-drawer-toggle" id="mobile-drawer-toggle" aria-label="Mở menu điều hướng" onclick="window.toggleMobileSidebar()">
                        <i class="fa-solid fa-bars"></i>
                    </button>
                    <div class="tenant-lock-badge" id="tenant-lock-badge" title="Phiên làm việc bị khóa cố định vào 1 Bệnh viện. Tài khoản Admin ${escapeSafe(adminAcc.username)} chỉ được quản lý ${escapeSafe(adminAcc.hospitalName)}.">
                        <i class="fa-solid fa-lock node-icon"></i>
                        <div class="tenant-lock-text">
                            <strong id="tenant-lock-hospital">${escapeSafe(node.name)}</strong>
                            <small id="tenant-lock-admin">Admin độc quyền: ${escapeSafe(adminAcc.fullName)} (${escapeSafe(adminAcc.username)})</small>
                        </div>
                        <button type="button" class="tenant-switch-btn" onclick="window.openAdminAccountModal()" title="Đăng xuất phiên hiện tại và đăng nhập bằng Tài khoản Admin được cấp riêng cho Bệnh viện khác">
                            <i class="fa-solid fa-key"></i> <span class="hide-sm">Đổi TK Admin BV</span>
                        </button>
                    </div>
                    <div class="security-compliance-pills">
                        <span class="sec-pill green" title="Bảo mật Vi phân Differential Privacy (σ=0.01) & Mã hóa cục bộ">
                            <i class="fa-solid fa-user-shield"></i> HIPAA / TT54-BYT
                        </span>
                        <span class="sec-pill blue" title="Mỗi tài khoản Admin bị ràng buộc cố định vào đúng 1 Bệnh viện, không truy cập chéo dữ liệu">
                            <i class="fa-solid fa-building-shield"></i> 1 Admin = 1 Bệnh viện
                        </span>
                        ${policy.phiMaskingEnabled ? `
                        <span class="sec-pill warning" title="Đang bật chế độ Ẩn danh hóa thông tin bệnh nhân (PHI Masking)">
                            <i class="fa-solid fa-mask"></i> PHI Masked
                        </span>` : ''}
                    </div>
                </div>

                <div class="portal-role-switcher" role="navigation" aria-label="Chuyển đổi giao diện theo vai trò bệnh viện">
                    <a href="technician.html" class="role-switch-tab ${isTech ? 'active tech' : ''}" title="Giao diện Kỹ thuật viên Phòng X-Quang">
                        <i class="fa-solid fa-x-ray"></i>
                        <span>1. Kỹ thuật viên XQ</span>
                    </a>
                    <span class="role-flow-arrow"><i class="fa-solid fa-angles-right"></i></span>
                    <a href="index.html" class="role-switch-tab ${isDoc ? 'active doc' : ''}" title="Giao diện Bác sĩ Chẩn đoán Hình ảnh">
                        <i class="fa-solid fa-user-doctor"></i>
                        <span>2. Bác sĩ Chẩn đoán</span>
                        <span class="role-queue-badge ${pendingCount > 0 ? 'has-items' : ''}" id="global-worklist-badge" title="Số ca chụp từ phòng X-Quang đang chờ Bác sĩ đọc">${pendingCount}</span>
                    </a>
                    <span class="role-flow-divider">|</span>
                    <a href="admin.html" class="role-switch-tab ${isAdmin ? 'active admin' : ''}" title="Giao diện Admin Điều khiển Hệ thống tại Client Bệnh viện">
                        <i class="fa-solid fa-shield-halved"></i>
                        <span>3. Admin Bệnh viện</span>
                    </a>
                </div>

                <div class="portal-bar-right">
                    <button type="button" class="btn-rbac-info dataset-btn" onclick="window.openHospitalDatasetModal()" title="Import Dataset bệnh án & ảnh X-Quang có sẵn của Bệnh viện từ folder federated_data">
                        <i class="fa-solid fa-database"></i> <span class="hide-sm">Import Dataset BV</span>
                    </button>
                    <button type="button" class="btn-rbac-info" onclick="window.openPosterQRModal()" title="Tạo bộ Mã QR cho 3 giao diện để in lên Poster KHKT & Hướng dẫn Deploy 24/7">
                        <i class="fa-solid fa-qrcode"></i> <span class="hide-sm">Mã QR Poster</span>
                    </button>
                    <button type="button" class="btn-rbac-info" onclick="window.openRBACSecurityModal()" title="Xem phân quyền chi tiết & Quy chuẩn bảo mật bệnh viện">
                        <i class="fa-solid fa-key"></i> <span class="hide-sm">Phân quyền RBAC</span>
                    </button>
                </div>
            </div>

            <div class="emergency-lockdown-banner ${policy.emergencyLockdown ? '' : 'hidden'}" id="global-lockdown-banner">
                <div class="lockdown-inner">
                    <i class="fa-solid fa-lock"></i>
                    <div>
                        <strong>CHẾ ĐỘ KHÓA AN NINH KHẨN CẤP (EMERGENCY LOCKDOWN):</strong>
                        <span>Tài khoản Admin Bệnh viện đang tạm khóa chức năng suy luận AI & thay đổi dữ liệu để kiểm toán bảo mật.</span>
                    </div>
                    ${isAdmin ? `<button type="button" class="btn btn-sm btn-secondary" onclick="window.quickDisableLockdown()">Mở khóa ngay</button>` : `<a href="admin.html" class="btn btn-sm btn-secondary">Mở trang Admin</a>`}
                </div>
            </div>
        `;
    }

    // =========================================================================
    // HOSPITAL DATASET IMPORTER MODAL (`federated_data/` & Local Folder Import)
    // =========================================================================
    function buildDatasetImporterModalHTML() {
        const adminAcc = typeof getActiveAdminAccount === 'function' ? getActiveAdminAccount() : { boundClientNode: 'CLIENT_1', hospitalName: '', fullName: '' };
        const boundNode = adminAcc.boundClientNode;
        const nodeInfo = typeof getHospitalClientNode === 'function' ? getHospitalClientNode(boundNode) : { folderName: '' };
        // Only expose dataset records of the hospital bound to the active Admin account
        const presets = (typeof HOSPITAL_DATASET_PRESETS !== 'undefined')
            ? HOSPITAL_DATASET_PRESETS.filter(p => p.clientNode === boundNode)
            : [];

        const presetRows = presets.map(p => {
            const isPn = p.diagnosis === 'PNEUMONIA';
            const badge = isPn
                ? `<span class="status-badge badge-danger"><span class="pulse-dot red"></span> Viêm phổi (${p.probPneumonia}%)</span>`
                : `<span class="status-badge badge-success"><span class="pulse-dot green"></span> Bình thường (${p.probNormal}%)</span>`;

            return `
                <tr>
                    <td>
                        <div class="table-thumb">
                            <img src="${escapeSafe(p.image)}" alt="X-Ray">
                        </div>
                    </td>
                    <td>
                        <strong>${escapeSafe(p.patientId)}</strong><br>
                        <span>${escapeSafe(p.patientName)} (${p.age}t, ${escapeSafe(p.gender)})</span>
                    </td>
                    <td><code>${escapeSafe(p.clientNode)}</code></td>
                    <td><small class="text-muted" style="word-break:break-all;">${escapeSafe(p.sourcePath)}</small></td>
                    <td>${badge}</td>
                </tr>
            `;
        }).join('');

        return `
            <dialog id="hospital-dataset-modal" class="medai-modal">
                <div class="medai-modal-content">
                    <div class="medai-modal-header">
                        <div>
                            <h3><i class="fa-solid fa-database"></i> Import Dataset Bệnh viện — ${escapeSafe(adminAcc.hospitalName)}</h3>
                            <p>Chỉ nạp dữ liệu vào bệnh viện của tài khoản Admin ${escapeSafe(adminAcc.fullName)} (${escapeSafe(adminAcc.username)})</p>
                        </div>
                        <button type="button" class="modal-close-btn" onclick="window.closeHospitalDatasetModal()" aria-label="Đóng">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>

                    <div class="medai-modal-body">
                        <div class="settings-tip" style="margin-top:0; margin-bottom:16px;">
                            <i class="fa-solid fa-building-shield"></i>
                            <span><strong>Nguyên tắc 1 Admin = 1 Bệnh viện:</strong> Dữ liệu chỉ được nạp vào <strong>${escapeSafe(adminAcc.hospitalName)}</strong>. Dữ liệu của các bệnh viện khác do Admin riêng của họ quản lý và bị ẩn hoàn toàn khỏi phiên làm việc này.</span>
                        </div>

                        <!-- Option 1: One-click Import from the bound hospital's federated_data cohort -->
                        <div class="dataset-import-section">
                            <h4><i class="fa-solid fa-hospital-user"></i> 1. Nạp nhanh bộ bệnh án mẫu của bệnh viện</h4>
                            <p class="text-muted" style="font-size:12.5px; margin-bottom:12px;">
                                Nạp các ca bệnh điển hình (ảnh X-Quang thực tế, triệu chứng, kết quả AI và nhận xét Bác sĩ) từ <code>${escapeSafe(nodeInfo.folderName)}</code> vào Hồ sơ bệnh án, Lịch sử chẩn đoán & Hàng đợi PACS:
                            </p>
                            <div class="dataset-cohort-grid">
                                <button type="button" class="cohort-import-card highlight" onclick="window.runPresetDatasetImport()">
                                    <div class="cohort-top">
                                        <i class="fa-solid fa-layer-group"></i>
                                        <span class="cohort-tag">${escapeSafe(boundNode.replace('_', ' '))}</span>
                                    </div>
                                    <strong>Nạp ${presets.length} bệnh án mẫu — ${escapeSafe(nodeInfo.shortName || '')}</strong>
                                    <small><code>${escapeSafe(nodeInfo.folderName)}</code> • Viêm phổi vi khuẩn, virus & bình thường</small>
                                </button>
                            </div>
                        </div>

                        <!-- Option 2: Import Custom Folder / Multiple X-Ray Files from Disk -->
                        <div class="dataset-import-section" style="margin-top: 18px;">
                            <h4><i class="fa-solid fa-folder-open"></i> 2. Import trực tiếp từ thư mục trên máy tính</h4>
                            <p class="text-muted" style="font-size:12.5px; margin-bottom:12px;">
                                Chọn một thư mục con (ví dụ: <code>${escapeSafe(nodeInfo.folderName)}/train/PNEUMONIA</code>) hoặc nhiều file ảnh <code>.jpeg/.png/.dcm</code>. Hệ thống tự nhận nhãn bệnh (Vi khuẩn / Virus / Bình thường) từ tên file và tạo hồ sơ bệnh án:
                            </p>
                            <div class="custom-import-controls">
                                <span class="tenant-target-pill"><i class="fa-solid fa-lock"></i> Gán vào: ${escapeSafe(adminAcc.hospitalName)}</span>

                                <label class="btn btn-primary btn-sm btn-file-upload">
                                    <i class="fa-solid fa-folder-plus"></i> Chọn Thư mục Dataset (Folder)
                                    <input type="file" webkitdirectory directory multiple accept=".jpg,.jpeg,.png,.dcm" onchange="window.handleLocalDatasetFilesImport(event)" hidden>
                                </label>

                                <label class="btn btn-secondary btn-sm btn-file-upload">
                                    <i class="fa-solid fa-images"></i> Chọn Nhiều Ảnh X-Quang (.JPEG/.PNG)
                                    <input type="file" multiple accept=".jpg,.jpeg,.png,.dcm" onchange="window.handleLocalDatasetFilesImport(event)" hidden>
                                </label>
                            </div>
                        </div>

                        <!-- Preview Table of the bound hospital's bundled samples -->
                        <h4 style="margin: 18px 0 8px; font-size: 13.5px; font-weight: 700;">Danh mục ${presets.length} bệnh án mẫu của ${escapeSafe(adminAcc.hospitalName)}:</h4>
                        <div class="table-responsive" style="max-height: 230px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px;">
                            <table class="data-table compact-table">
                                <thead>
                                    <tr>
                                        <th>Ảnh XQ</th>
                                        <th>Mã BN & Họ tên</th>
                                        <th>Client</th>
                                        <th>Đường dẫn gốc trong <code>federated_data/</code></th>
                                        <th>Chẩn đoán Mẫu</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${presetRows}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div class="medai-modal-footer">
                        <span class="text-muted" style="font-size:12px;"><i class="fa-solid fa-circle-info"></i> Dữ liệu sau khi Import sẽ hiển thị ngay lập tức tại mục Lịch sử chẩn đoán, Hồ sơ bệnh án và Hàng đợi PACS.</span>
                        <button type="button" class="btn btn-secondary" onclick="window.closeHospitalDatasetModal()">Đóng</button>
                    </div>
                </div>
            </dialog>
        `;
    }

    function buildRBACModalHTML(currentRole) {
        const matrix = typeof getRBACMatrix === 'function' ? getRBACMatrix() : {};
        const policy = typeof getAdminPolicy === 'function' ? getAdminPolicy() : {};
        const node = typeof getHospitalClientNode === 'function' ? getHospitalClientNode(policy.activeClientNode) : {};

        const rowsHtml = Object.keys(matrix).map(key => {
            const item = matrix[key];
            return `
                <tr>
                    <td>
                        <strong>${escapeSafe(item.label)}</strong>
                        <div class="text-muted" style="font-size:11.5px;">Phân hệ: ${escapeSafe(item.category)}</div>
                    </td>
                    <td style="text-align:center;">
                        ${item.TECHNICIAN
                            ? '<span class="perm-pill allowed"><i class="fa-solid fa-check"></i> Được phép</span>'
                            : '<span class="perm-pill denied"><i class="fa-solid fa-ban"></i> Cấm</span>'}
                    </td>
                    <td style="text-align:center;">
                        ${item.DOCTOR
                            ? '<span class="perm-pill allowed"><i class="fa-solid fa-check"></i> Được phép</span>'
                            : '<span class="perm-pill denied"><i class="fa-solid fa-ban"></i> Cấm</span>'}
                    </td>
                    <td style="text-align:center;">
                        ${item.ADMIN
                            ? '<span class="perm-pill allowed"><i class="fa-solid fa-check"></i> Toàn quyền</span>'
                            : '<span class="perm-pill denied"><i class="fa-solid fa-ban"></i> Cấm (Độc lập Y khoa)</span>'}
                    </td>
                </tr>
            `;
        }).join('');

        return `
            <dialog id="rbac-security-modal" class="medai-modal">
                <div class="medai-modal-content">
                    <div class="medai-modal-header">
                        <div>
                            <h3><i class="fa-solid fa-shield-halved"></i> Kiến trúc Phân quyền RBAC & Bảo mật Y tế (${escapeSafe(node.shortName || 'Client Bệnh viện')})</h3>
                            <p>Tuân thủ tiêu chuẩn HIPAA, Nghị định 13/2023/NĐ-CP & Thông tư 54/2017/TT-BYT Mức 6</p>
                        </div>
                        <button type="button" class="modal-close-btn" onclick="window.closeRBACSecurityModal()" aria-label="Đóng">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                    <div class="medai-modal-body">
                        <div class="role-workflow-cards">
                            <div class="role-wf-card ${currentRole === 'TECHNICIAN' ? 'current' : ''}">
                                <div class="wf-step-badge">BƯỚC 1 • PHÒNG CHỤP X-QUANG</div>
                                <h4><i class="fa-solid fa-x-ray"></i> Kỹ thuật viên X-Quang</h4>
                                <p>Tiếp nhận bệnh nhân, thiết lập thông số tia (kVp, mAs, tư thế PA/AP), cân bằng CLAHE, kiểm định chất lượng 4 tiêu chí QA/QC, chạy AI Pre-Triage phát hiện ca Cấp cứu (STAT) và đẩy vào Hàng đợi PACS.</p>
                                <a href="technician.html" class="btn btn-sm btn-primary full-width">Mở Giao diện Kỹ thuật viên</a>
                            </div>
                            <div class="role-wf-card ${currentRole === 'DOCTOR' ? 'current' : ''}">
                                <div class="wf-step-badge">BƯỚC 2 • PHÒNG ĐỌC KẾT QUẢ PACS</div>
                                <h4><i class="fa-solid fa-user-doctor"></i> Bác sĩ Chẩn đoán</h4>
                                <p>Nhận phim X-Quang thời gian thực từ KTV, phân tích chuyên sâu với mô hình Hybrid Ensemble & bản đồ nhiệt Grad-CAM, nhập kết luận lâm sàng, ký số SHA-256 hoặc yêu cầu KTV chụp lại.</p>
                                <a href="index.html" class="btn btn-sm btn-primary full-width">Mở Giao diện Bác sĩ Chẩn đoán</a>
                            </div>
                            <div class="role-wf-card ${currentRole === 'ADMIN' ? 'current' : ''}">
                                <div class="wf-step-badge">ĐIỀU KHIỂN & BẢO MẬT LIÊN VIỆN</div>
                                <h4><i class="fa-solid fa-shield-halved"></i> Admin Client Bệnh viện</h4>
                                <p>Quản trị duy nhất 1 Client Bệnh viện được gán cho tài khoản: huấn luyện Federated Learning (FedProx) & Bảo mật Vi phân (DP), cấu hình ngưỡng AI, ẩn danh hóa PHI, quản lý RBAC nhân sự và kiểm toán Audit Log của riêng bệnh viện đó.</p>
                                <a href="admin.html" class="btn btn-sm btn-primary full-width">Mở Giao diện Admin Bệnh viện</a>
                            </div>
                        </div>

                        <h4 style="margin: 18px 0 10px; font-size: 14px; font-weight: 700;">Ma trận Phân tách Quyền hạn Chi tiết (Zero-Trust Hospital RBAC Matrix)</h4>
                        <div class="table-responsive">
                            <table class="data-table compact-table">
                                <thead>
                                    <tr>
                                        <th>Chức năng / Nghiệp vụ Y tế</th>
                                        <th style="text-align:center;">Kỹ thuật viên XQ</th>
                                        <th style="text-align:center;">Bác sĩ Chẩn đoán</th>
                                        <th style="text-align:center;">Admin Bệnh viện</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${rowsHtml}
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <div class="medai-modal-footer">
                        <span class="text-muted" style="font-size:12px;"><i class="fa-solid fa-lock"></i> Mọi thao tác trái quyền đều bị chặn và ghi vào Nhật ký Kiểm toán Bất biến (Audit Trail).</span>
                        <button type="button" class="btn btn-secondary" onclick="window.closeRBACSecurityModal()">Đóng cửa sổ</button>
                    </div>
                </div>
            </dialog>
        `;
    }

    // =========================================================================
    // GLOBAL HANDLERS FOR DATASET IMPORTER & MODALS
    // =========================================================================
    window.openHospitalDatasetModal = function () {
        let modal = document.getElementById('hospital-dataset-modal');
        if (modal) modal.remove();
        document.body.insertAdjacentHTML('beforeend', buildDatasetImporterModalHTML());
        modal = document.getElementById('hospital-dataset-modal');
        if (modal && typeof modal.showModal === 'function') {
            modal.showModal();
        } else if (modal) {
            modal.setAttribute('open', 'open');
        }
    };

    window.closeHospitalDatasetModal = function () {
        const modal = document.getElementById('hospital-dataset-modal');
        if (modal && typeof modal.close === 'function') {
            modal.close();
        } else if (modal) {
            modal.removeAttribute('open');
        }
    };

    window.runPresetDatasetImport = async function () {
        if (typeof dbImportHospitalDatasetPreset !== 'function') return;
        try {
            const res = await dbImportHospitalDatasetPreset(null, true);
            window.closeHospitalDatasetModal();
            window.refreshAllActivePortalViews();
            if (typeof showToast === 'function') {
                showToast(`✅ Đã nạp ${res.importedCount} bệnh án vào ${res.boundHospital}. Tổng: ${res.totalCases} ca / ${res.totalPatients} bệnh nhân.`);
            }
        } catch (err) {
            alert(err.message);
        }
    };

    window.handleLocalDatasetFilesImport = async function (event) {
        const files = event.target.files;
        if (!files || files.length === 0) return;

        const adminAcc = typeof getActiveAdminAccount === 'function' ? getActiveAdminAccount() : null;
        try {
            if (typeof showToast === 'function') {
                showToast(`⏳ Đang xử lý và import file ảnh X-Quang từ thư mục dữ liệu...`);
            }
            // Target hospital is always forced to the active Admin's bound hospital inside db.js
            const res = await dbImportLocalImageFilesDataset(files);
            window.closeHospitalDatasetModal();
            window.refreshAllActivePortalViews();
            if (typeof showToast === 'function') {
                showToast(`✅ Đã import ${res.importedCount} ca X-Quang vào ${adminAcc ? adminAcc.hospitalName : 'bệnh viện'}!`);
            }
        } catch (err) {
            alert('Lỗi khi import dataset: ' + err.message);
        } finally {
            event.target.value = '';
        }
    };

    window.refreshAllActivePortalViews = function () {
        window.refreshPortalTopBar();
        if (typeof window.renderDoctorIncomingQueueWidget === 'function') {
            window.renderDoctorIncomingQueueWidget();
        }
        if (typeof renderHistoryView === 'function' && document.getElementById('view-history')?.classList.contains('active')) {
            renderHistoryView();
        }
        if (typeof renderPatientsView === 'function' && document.getElementById('view-patients')?.classList.contains('active')) {
            renderPatientsView();
        }
        if (typeof renderWorklistView === 'function' && document.getElementById('view-worklist')?.classList.contains('active')) {
            renderWorklistView();
        }
        if (typeof renderSettingsView === 'function' && document.getElementById('view-settings')?.classList.contains('active')) {
            renderSettingsView();
        }
        if (typeof window.refreshTechnicianViews === 'function') {
            window.refreshTechnicianViews();
        }
        if (typeof window.onHospitalClientNodeChanged === 'function') {
            window.onHospitalClientNodeChanged();
        }
    };

    window.toggleMobileSidebar = function () {
        const sidebar = document.querySelector('.sidebar');
        let backdrop = document.getElementById('mobile-sidebar-backdrop');
        if (!backdrop) {
            backdrop = document.createElement('div');
            backdrop.id = 'mobile-sidebar-backdrop';
            backdrop.className = 'mobile-sidebar-backdrop';
            backdrop.onclick = () => window.closeMobileSidebar();
            document.body.appendChild(backdrop);
        }
        if (sidebar) {
            const isOpen = sidebar.classList.toggle('mobile-open');
            backdrop.classList.toggle('show', isOpen);
        }
    };

    window.closeMobileSidebar = function () {
        const sidebar = document.querySelector('.sidebar');
        const backdrop = document.getElementById('mobile-sidebar-backdrop');
        if (sidebar) sidebar.classList.remove('mobile-open');
        if (backdrop) backdrop.classList.remove('show');
    };

    // Direct hospital switching is forbidden: 1 Admin account = 1 hospital.
    // The only way to work on another hospital is to sign in with that hospital's own Admin account.
    window.switchHospitalClientNode = async function (newNodeId) {
        const adminAcc = typeof getActiveAdminAccount === 'function' ? getActiveAdminAccount() : null;
        if (!adminAcc || adminAcc.boundClientNode === newNodeId) return;
        if (typeof dbAddAuditLog === 'function') {
            await dbAddAuditLog({
                actor: `${adminAcc.fullName} (${adminAcc.username})`,
                role: detectCurrentPortal(),
                clientNode: adminAcc.boundClientNode,
                action: 'CROSS_HOSPITAL_ACCESS_DENIED',
                severity: 'WARN',
                details: `Chặn yêu cầu chuyển sang ${newNodeId}: tài khoản ${adminAcc.username} chỉ được quản lý ${adminAcc.hospitalName}.`
            });
        }
        if (typeof showToast === 'function') {
            showToast(`⛔ Tài khoản ${adminAcc.fullName} chỉ được quản lý ${adminAcc.hospitalName}. Hãy đăng nhập bằng tài khoản Admin của bệnh viện kia.`);
        }
    };

    // =========================================================================
    // ADMIN ACCOUNT SIGN-IN MODAL (each account is permanently bound to 1 hospital)
    // =========================================================================
    function buildAdminAccountModalHTML() {
        const accounts = typeof HOSPITAL_ADMIN_ACCOUNTS !== 'undefined' ? Object.values(HOSPITAL_ADMIN_ACCOUNTS) : [];
        const current = typeof getActiveAdminAccount === 'function' ? getActiveAdminAccount() : {};

        const cards = accounts.map(acc => {
            const isCurrent = acc.id === current.id;
            return `
                <div class="admin-account-card ${isCurrent ? 'current' : ''}">
                    <div class="admin-acc-top">
                        <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(acc.fullName)}&background=${acc.avatarBg}&color=fff" alt="">
                        <div>
                            <strong>${escapeSafe(acc.fullName)}</strong>
                            <small>${escapeSafe(acc.username)}</small>
                        </div>
                    </div>
                    <div class="admin-acc-bound">
                        <i class="fa-solid fa-lock"></i>
                        <span>Chỉ quản lý: <strong>${escapeSafe(acc.hospitalName)}</strong></span>
                    </div>
                    <small class="text-muted">${escapeSafe(acc.title)} • Chứng thư số: <code>${escapeSafe(acc.certificateId)}</code></small>
                    <div class="admin-acc-staff">
                        <span><i class="fa-solid fa-user-doctor"></i> ${escapeSafe(acc.defaultDoctorName)}</span>
                        <span><i class="fa-solid fa-x-ray"></i> ${escapeSafe(acc.defaultTechName)}</span>
                    </div>
                    ${isCurrent
                        ? '<span class="status-badge badge-success"><span class="pulse-dot green"></span> Đang đăng nhập & Quản lý độc quyền</span>'
                        : `<button type="button" class="btn btn-primary btn-sm full-width" onclick="window.signInAsHospitalAdmin('${escapeSafe(acc.id)}')">
                               <i class="fa-solid fa-right-to-bracket"></i> Đăng xuất & Đăng nhập TK Admin này
                           </button>`}
                </div>
            `;
        }).join('');

        return `
            <dialog id="admin-account-modal" class="medai-modal">
                <div class="medai-modal-content">
                    <div class="medai-modal-header">
                        <div>
                            <h3><i class="fa-solid fa-user-shield"></i> Tài khoản Admin Bệnh viện</h3>
                            <p>Mỗi tài khoản Admin bị ràng buộc cố định vào đúng 1 bệnh viện</p>
                        </div>
                        <button type="button" class="modal-close-btn" onclick="window.closeAdminAccountModal()" aria-label="Đóng">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                    <div class="medai-modal-body">
                        <div class="settings-tip" style="margin-top:0; margin-bottom:16px;">
                            <i class="fa-solid fa-building-shield"></i>
                            <span>Admin <strong>không thể</strong> chuyển sang quản lý bệnh viện khác. Muốn làm việc với bệnh viện khác, phải <strong>đăng xuất</strong> và đăng nhập bằng tài khoản Admin của chính bệnh viện đó (xác thực lại tên đăng nhập). Mọi lần đăng nhập đều được ghi vào Nhật ký Kiểm toán.</span>
                        </div>
                        <div class="admin-account-grid">${cards}</div>
                    </div>
                    <div class="medai-modal-footer">
                        <span class="text-muted" style="font-size:12px;"><i class="fa-solid fa-circle-info"></i> Tài khoản đang dùng: ${escapeSafe(current.username || '')}</span>
                        <button type="button" class="btn btn-secondary" onclick="window.closeAdminAccountModal()">Đóng</button>
                    </div>
                </div>
            </dialog>
        `;
    }

    window.openAdminAccountModal = function () {
        let modal = document.getElementById('admin-account-modal');
        if (modal) modal.remove();
        document.body.insertAdjacentHTML('beforeend', buildAdminAccountModalHTML());
        modal = document.getElementById('admin-account-modal');
        if (modal && typeof modal.showModal === 'function') modal.showModal();
        else if (modal) modal.setAttribute('open', 'open');
    };

    window.closeAdminAccountModal = function () {
        const modal = document.getElementById('admin-account-modal');
        if (modal && typeof modal.close === 'function') modal.close();
        else if (modal) modal.removeAttribute('open');
    };

    window.signInAsHospitalAdmin = async function (adminAccountId) {
        if (typeof loginHospitalAdminAccount !== 'function') return;
        const target = HOSPITAL_ADMIN_ACCOUNTS[adminAccountId];
        if (!target) return;

        await loginHospitalAdminAccount(adminAccountId);
        window.closeAdminAccountModal();
        window.refreshAllActivePortalViews();
        if (typeof showToast === 'function') {
            showToast(`🔐 Đã đăng nhập tài khoản ${target.fullName} (${target.username}) — Chỉ quản lý ${target.hospitalName}!`);
        }
    };

    window.quickDisableLockdown = async function () {
        if (typeof saveAdminPolicy === 'function') {
            await saveAdminPolicy({ emergencyLockdown: false }, 'Admin Mở khóa Khẩn cấp');
            await dbAddAuditLog({
                actor: typeof getActiveAdminAccount === 'function' ? `${getActiveAdminAccount().fullName} (${getActiveAdminAccount().username})` : 'Admin',
                role: 'ADMIN',
                action: 'EMERGENCY_LOCKDOWN_LIFTED',
                severity: 'SECURITY',
                details: 'Admin đã tắt chế độ Khóa Khẩn Cấp (Emergency Lockdown), khôi phục hoạt động bình thường.'
            });
            window.refreshPortalTopBar();
            if (typeof showToast === 'function') {
                showToast('🔓 Đã mở khóa hệ thống thành công!');
            }
        }
    };

    window.openRBACSecurityModal = function () {
        let modal = document.getElementById('rbac-security-modal');
        if (modal) modal.remove();
        document.body.insertAdjacentHTML('beforeend', buildRBACModalHTML(detectCurrentPortal()));
        modal = document.getElementById('rbac-security-modal');
        if (modal && typeof modal.showModal === 'function') {
            modal.showModal();
        } else if (modal) {
            modal.setAttribute('open', 'open');
        }
    };

    window.closeRBACSecurityModal = function () {
        const modal = document.getElementById('rbac-security-modal');
        if (modal && typeof modal.close === 'function') {
            modal.close();
        } else if (modal) {
            modal.removeAttribute('open');
        }
    };

    // =========================================================================
    // KHKT POSTER QR CODE GENERATOR & 24/7 CLOUD DEPLOYMENT MODAL
    // =========================================================================
    function buildPosterQRModalHTML() {
        const currentOrigin = (window.location.origin && !window.location.origin.includes('localhost'))
            ? window.location.origin
            : 'https://aaee48221f8b65.lhr.life';

        const techUrl = `${currentOrigin}/dashboard/technician.html`;
        const docUrl = `${currentOrigin}/dashboard/index.html`;
        const adminUrl = `${currentOrigin}/dashboard/admin.html`;

        const qrApi = (url) => `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(url)}`;

        return `
            <dialog id="poster-qr-modal" class="medai-modal">
                <div class="medai-modal-content">
                    <div class="medai-modal-header">
                        <div>
                            <h3><i class="fa-solid fa-qrcode"></i> Bộ Mã QR In Poster KHKT & Triển khai Cloud 24/7</h3>
                            <p>Ban Giám khảo quét mã QR bằng điện thoại để trải nghiệm trực tiếp cả 3 vai trò: Kỹ thuật viên X-Quang &rarr; Bác sĩ Chẩn đoán &rarr; Admin Bệnh viện</p>
                        </div>
                        <button type="button" class="modal-close-btn" onclick="window.closePosterQRModal()" aria-label="Đóng">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                    <div class="medai-modal-body">
                        <div class="qr-url-bar">
                            <label for="qr-base-domain-input"><strong>Tên miền (Domain) tạo Mã QR:</strong></label>
                            <input type="text" id="qr-base-domain-input" value="${escapeSafe(currentOrigin)}" placeholder="VD: https://biboxu-medai-diagnostic.hf.space hoặc https://minhduc09jack.github.io/KHKT">
                            <button type="button" class="btn btn-primary btn-sm" onclick="window.updatePosterQRCodes()">
                                <i class="fa-solid fa-rotate"></i> Cập nhật Mã QR
                            </button>
                            <button type="button" class="btn btn-secondary btn-sm" onclick="window.print()">
                                <i class="fa-solid fa-print"></i> In Bộ Mã QR Dán Poster
                            </button>
                        </div>

                        <div class="qr-poster-grid">
                            <div class="qr-role-card tech">
                                <span class="wf-step-badge">1. PHÒNG CHỤP X-QUANG</span>
                                <h4><i class="fa-solid fa-x-ray"></i> Kỹ thuật viên X-Quang</h4>
                                <div class="qr-img-box">
                                    <img id="qr-img-tech" src="${qrApi(techUrl)}" alt="QR Kỹ thuật viên">
                                </div>
                                <a id="qr-link-tech" href="${escapeSafe(techUrl)}" target="_blank" class="qr-url-text">${escapeSafe(techUrl)}</a>
                                <small>Thu nhận phim, cân bằng CLAHE, kiểm chuẩn QA/QC & đẩy ca chụp Cấp cứu STAT sang Bác sĩ</small>
                            </div>

                            <div class="qr-role-card doc">
                                <span class="wf-step-badge">2. TRẠM ĐỌC PHIM PACS</span>
                                <h4><i class="fa-solid fa-user-doctor"></i> Bác sĩ Chẩn đoán</h4>
                                <div class="qr-img-box">
                                    <img id="qr-img-doc" src="${qrApi(docUrl)}" alt="QR Bác sĩ Chẩn đoán">
                                </div>
                                <a id="qr-link-doc" href="${escapeSafe(docUrl)}" target="_blank" class="qr-url-text">${escapeSafe(docUrl)}</a>
                                <small>Nhận phim từ KTV, phân tích Hybrid Ensemble + bản đồ nhiệt Grad-CAM & ký số SHA-256</small>
                            </div>

                            <div class="qr-role-card admin">
                                <span class="wf-step-badge">3. TRUNG TÂM ĐIỀU HÀNH</span>
                                <h4><i class="fa-solid fa-shield-halved"></i> Admin Bệnh viện</h4>
                                <div class="qr-img-box">
                                    <img id="qr-img-admin" src="${qrApi(adminUrl)}" alt="QR Admin Bệnh viện">
                                </div>
                                <a id="qr-link-admin" href="${escapeSafe(adminUrl)}" target="_blank" class="qr-url-text">${escapeSafe(adminUrl)}</a>
                                <small>Cô lập 1 Admin = 1 Bệnh viện, điều phối FedProx + DP (σ=0.01) & Mô phỏng chống tấn công DLG</small>
                            </div>
                        </div>

                        <div class="cloud-deploy-guide-box">
                            <h4><i class="fa-solid fa-cloud-arrow-up"></i> Hướng dẫn Kích hoạt Link Cloud Cố định 24/7 (Miễn phí 100%, Không cần PRO / Thẻ Visa)</h4>
                            <div class="cloud-steps-grid">
                                <div class="cloud-step-item">
                                    <strong>Cách 1: Hugging Face Static Space (Miễn phí 100% — Chọn "Static &rarr; Blank")</strong>
                                    <ol>
                                        <li>Tại màn hình <a href="https://huggingface.co/new-space" target="_blank">huggingface.co/new-space</a> của bạn (<code>biboxu</code>), chọn ô <strong>Static</strong> &rarr; mẫu <strong>Blank</strong> (miễn phí hoàn toàn, không cần gói PRO).</li>
                                        <li>Đặt tên Space (VD: <code>medai-diagnostic</code>) và bấm <strong>Create Space</strong>.</li>
                                        <li>Hệ thống đã tích hợp sẵn <strong>In-Browser Edge AI & Grad-CAM Engine</strong> nên toàn bộ tính năng phân tích X-Quang, tạo Heatmap Grad-CAM, DLG Lab và 3 cổng hoạt động 100% trên Static Space!</li>
                                    </ol>
                                </div>
                                <div class="cloud-step-item">
                                    <strong>Cách 2: GitHub Pages (Miễn phí 100% vĩnh viễn ngay trên GitHub)</strong>
                                    <ol>
                                        <li>Đẩy commit hiện tại lên GitHub: <code>git push origin main</code>.</li>
                                        <li>Vào repo <code>minhduc09jack/KHKT</code> &rarr; <strong>Settings</strong> &rarr; <strong>Pages</strong> &rarr; mục Branch chọn <strong>main / (root)</strong> &rarr; <strong>Save</strong>.</li>
                                        <li>Nhận ngay tên miền cố định vĩnh viễn: <code>https://minhduc09jack.github.io/KHKT/dashboard/index.html</code>.</li>
                                    </ol>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="medai-modal-footer">
                        <span class="text-muted" style="font-size:12px;"><i class="fa-solid fa-circle-check text-success"></i> Bạn có thể dán trực tiếp link Hugging Face / Render vào ô trên để cập nhật lại 3 Mã QR bất cứ lúc nào.</span>
                        <button type="button" class="btn btn-secondary" onclick="window.closePosterQRModal()">Đóng</button>
                    </div>
                </div>
            </dialog>
        `;
    }

    window.openPosterQRModal = function () {
        let modal = document.getElementById('poster-qr-modal');
        if (modal) modal.remove();
        document.body.insertAdjacentHTML('beforeend', buildPosterQRModalHTML());
        modal = document.getElementById('poster-qr-modal');
        if (modal && typeof modal.showModal === 'function') modal.showModal();
        else if (modal) modal.setAttribute('open', 'open');
    };

    window.closePosterQRModal = function () {
        const modal = document.getElementById('poster-qr-modal');
        if (modal && typeof modal.close === 'function') modal.close();
        else if (modal) modal.removeAttribute('open');
    };

    window.updatePosterQRCodes = function () {
        const input = document.getElementById('qr-base-domain-input');
        if (!input) return;
        const base = input.value.trim().replace(/\/+$/, '');
        if (!base) return;

        const techUrl = `${base}/dashboard/technician.html`;
        const docUrl = `${base}/dashboard/index.html`;
        const adminUrl = `${base}/dashboard/admin.html`;
        const qrApi = (url) => `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(url)}`;

        const setRole = (suffix, url) => {
            const img = document.getElementById('qr-img-' + suffix);
            const link = document.getElementById('qr-link-' + suffix);
            if (img) img.src = qrApi(url);
            if (link) {
                link.href = url;
                link.textContent = url;
            }
        };
        setRole('tech', techUrl);
        setRole('doc', docUrl);
        setRole('admin', adminUrl);
        if (typeof showToast === 'function') {
            showToast('✅ Đã cập nhật bộ 3 Mã QR theo tên miền mới!');
        }
    };

    window.refreshPortalTopBar = function () {
        const policy = typeof getAdminPolicy === 'function' ? getAdminPolicy() : {};
        const pendingCount = getPendingWorklistCountSync();

        document.querySelectorAll('#global-worklist-badge, #sidebar-worklist-badge').forEach(el => {
            el.textContent = pendingCount;
            el.classList.toggle('has-items', pendingCount > 0);
        });

        const lockdownBanner = document.getElementById('global-lockdown-banner');
        if (lockdownBanner) {
            lockdownBanner.classList.toggle('hidden', !policy.emergencyLockdown);
        }

        const hospEl = document.getElementById('tenant-lock-hospital');
        if (hospEl && typeof getActiveAdminAccount === 'function') {
            const acc = getActiveAdminAccount();
            hospEl.textContent = acc.hospitalName;
            const adminEl = document.getElementById('tenant-lock-admin');
            if (adminEl) adminEl.textContent = `Admin quản lý: ${acc.fullName} • ${acc.username}`;
        }
    };

    // Synchronous 0ms initialization — never waits on async promises before rendering!
    function initPortalTopBarSync() {
        const mainContent = document.querySelector('.main-content');
        if (!mainContent || document.getElementById('portal-topbar-mount')) return;

        const currentRole = detectCurrentPortal();
        const policy = typeof getAdminPolicy === 'function' ? getAdminPolicy() : {};
        const pendingCount = getPendingWorklistCountSync();

        const wrapper = document.createElement('div');
        wrapper.id = 'portal-topbar-mount';
        wrapper.innerHTML = buildPortalTopBarHTML(currentRole, policy, pendingCount);
        mainContent.insertBefore(wrapper, mainContent.firstChild);

        window.refreshPortalTopBar();

        document.querySelectorAll('.sidebar .nav-links a, .sidebar .sidebar-header').forEach(link => {
            link.addEventListener('click', () => {
                if (window.innerWidth <= 1024) {
                    window.closeMobileSidebar();
                }
            });
        });

        if (typeof BroadcastChannel !== 'undefined') {
            const ch = new BroadcastChannel('medai_pacs_sync_channel');
            ch.onmessage = (ev) => {
                const msg = ev.data || {};
                window.refreshPortalTopBar();
                if (msg.type === 'WORKLIST_NEW_CASE' && currentRole === 'DOCTOR') {
                    if (typeof showToast === 'function') {
                        const pName = msg.payload?.patientName || 'Bệnh nhân mới';
                        const pri = msg.payload?.priority === 'STAT' ? '🚨 [CẤP CỨU STAT]' : '🩻';
                        showToast(`${pri} Phòng X-Quang vừa gửi ca chụp mới: ${pName}!`);
                    }
                    if (typeof window.renderDoctorIncomingQueueWidget === 'function') {
                        window.renderDoctorIncomingQueueWidget();
                    }
                } else if (msg.type === 'WORKLIST_UPDATED' && currentRole === 'TECHNICIAN') {
                    if (typeof showToast === 'function') {
                        showToast(`👨‍⚕️ Bác sĩ vừa cập nhật trạng thái ca chụp ${msg.payload?.patientId || ''}!`);
                    }
                    if (typeof window.refreshTechnicianViews === 'function') {
                        window.refreshTechnicianViews();
                    }
                } else if (msg.type === 'DATASET_IMPORTED') {
                    window.refreshAllActivePortalViews();
                } else if (msg.type === 'ADMIN_ACCOUNT_SWITCHED') {
                    // Another tab signed in with a different hospital's Admin account: reload to drop old tenant data
                    window.location.reload();
                }
            };
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPortalTopBarSync);
    } else {
        initPortalTopBarSync();
    }
})();
