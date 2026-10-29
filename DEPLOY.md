# 🚀 Hướng Dẫn Triển Khai (Deploy) Hệ Thống 3 Phân Hệ MedAI Diagnostic PACS/HIS

Hệ thống MedAI Diagnostic v4.0 bao gồm **3 Giao diện Website Chuyên biệt theo Vai trò Bệnh viện** và **Mô hình AI Suy luận Liên kết (FastAPI + PyTorch Hybrid Ensemble + Grad-CAM + Đồng bộ PACS thời gian thực)**:
1. 🩻 **Giao diện Kỹ thuật viên Phòng X-Quang:** `/dashboard/technician.html` (hoặc `/technician`)
2. 👨‍⚕️ **Giao diện Bác sĩ Chẩn đoán Hình ảnh:** `/dashboard/index.html` (hoặc `/doctor`)
3. 🛡️ **Giao diện Admin tại mỗi Client Bệnh viện:** `/dashboard/admin.html` (hoặc `/admin`)

Dưới đây là các phương án triển khai tối ưu nhất lên Internet, đặc biệt có **phương án 100% miễn phí KHÔNG CẦN THẺ VISA/MASTERCARD**.

---

## 🌟 PHƯƠNG ÁN 1: Hugging Face Spaces (Khuyên dùng số 1 - Miễn phí 100%, KHÔNG CẦN THẺ VISA)

Hugging Face là nền tảng số 1 thế giới về Trí tuệ Nhân tạo. Rất uy tín để nộp link vào báo cáo KHKT cho Ban Giám khảo chấm thi.

* **Cấu hình miễn phí:** Cấp sẵn **2 vCPU + 16GB RAM + 50GB ổ đĩa**.
* **Yêu cầu:** Chỉ cần email hoặc tài khoản GitHub, **tuyệt đối không hỏi thẻ thanh toán**.

### Các bước thực hiện:
1. Đăng ký tài khoản tại [huggingface.co](https://huggingface.co/) (hoặc đăng nhập bằng GitHub).
2. Nhấn vào ảnh đại diện góc trên phải $\rightarrow$ chọn **New Space**.
3. Điền thông tin:
   * **Space name:** `medai-diagnostic`
   * **License:** `mit` (hoặc `apache-2.0`)
   * **Select the Space SDK:** Chọn **Docker** $\rightarrow$ chọn **Blank**.
   * **Space hardware:** Chọn **CPU Basic • 2 vCPU • 16GB RAM • Free**.
   * Nhấn **Create Space**.
4. Đẩy mã nguồn lên Space:
   * Bạn có thể clone repo Space về máy và copy các file sau vào:
     * `Dockerfile`
     * `requirements.txt`
     * `app_fastapi.py`
     * `demo_weights.pth` (file weights ~44.8MB tải lên bình thường)
     * Thư mục `dashboard/`
   * Hoặc dùng git push:
     ```bash
     git remote add space https://huggingface.co/spaces/<username>/medai-diagnostic
     git push space main
     ```
5. Hugging Face sẽ tự động build Docker và cung cấp đường link HTTPS công khai dạng:
   `https://<username>-medai-diagnostic.hf.space/dashboard/`

---

## 🌟 PHƯƠNG ÁN 2: Render.com (Miễn phí, KHÔNG CẦN THẺ VISA)

Tương tự như Vercel nhưng cho phép chạy backend Docker/Python không bị giới hạn 250MB.

### Các bước thực hiện:
1. Đăng ký tài khoản tại [render.com](https://render.com/) bằng tài khoản GitHub của bạn.
2. Nhấn **New +** $\rightarrow$ chọn **Web Service**.
3. Chọn repository GitHub `minhduc09jack/KHKT`.
4. Điền cấu hình:
   * **Name:** `medai-diagnostic`
   * **Language / Environment:** Chọn **Docker**.
   * **Region:** Singapore (`Southeast Asia`) để truy cập từ VN nhanh nhất.
   * **Instance Type:** Chọn gói **Free**.
5. Nhấn **Create Web Service**.
6. Đợi ~3-5 phút Render build xong, bạn sẽ có link: `https://medai-diagnostic.onrender.com/dashboard/`

---

## ⚡ PHƯƠNG ÁN 3: Cloudflare Tunnel (Tuyệt chiêu thuyết trình trực tiếp tại Cuộc thi KHKT)

Nếu tại ngày thi gian hàng có mạng Wifi/4G, bạn có thể chạy server trực tiếp từ chiếc MacBook của mình để tận dụng chip Apple Silicon / GPU (tốc độ chẩn đoán chỉ mất 0.3s):

1. Cài đặt Cloudflared (miễn phí, không cần đăng ký tài khoản):
   ```bash
   brew install cloudflared
   ```
2. Khởi động backend trên máy:
   ```bash
   python3 app_fastapi.py
   ```
3. Mở terminal mới và tạo đường hầm HTTPS ra ngoài Internet:
   ```bash
   cloudflared tunnel --url http://localhost:8000
   ```
4. Terminal sẽ in ra một đường link HTTPS công khai (ví dụ: `https://rapid-quiet-stone.trycloudflare.com`). Bạn dán thêm `/dashboard/` vào đuôi và tạo mã QR để Ban Giám khảo quét điện thoại trải nghiệm trực tiếp!

---

## ☁️ PHƯƠNG ÁN 4: Google Cloud Run (Dành cho sau này khi bạn có thẻ thanh toán)

Nếu sau này bạn có thẻ Visa/Mastercard để kích hoạt tài khoản Google Cloud:
```bash
gcloud run deploy medai-diagnostic \
  --source . \
  --region asia-southeast1 \
  --memory 2Gi --cpu 2 \
  --allow-unauthenticated
```
