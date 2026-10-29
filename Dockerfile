# =====================================================================
# MedAI Diagnostic PACS/HIS - Production Dockerfile
# Optimized for Google Cloud Run, Hugging Face Spaces & Render
# =====================================================================

FROM python:3.11-slim

# Prevent Python from writing .pyc and enable buffer-less stdout
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

# Install minimal OS dependencies for OpenCV & image processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Upgrade pip and install PyTorch CPU build first (saves ~1.5GB of disk space)
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu

# Install other requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY app_fastapi.py .
COPY demo_weights.pth .
COPY dashboard/ ./dashboard/

# Expose container port
EXPOSE 8000

# Universal command supporting dynamic $PORT
CMD ["sh", "-c", "uvicorn app_fastapi:app --host 0.0.0.0 --port ${PORT:-8000}"]
