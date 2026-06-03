FROM python:3.9-slim

# Install system dependencies needed for PaddleOCR and pdfplumber
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements and install
COPY shreyash/ETL_GRP_1/ETL_GRP/ETL_2/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY shreyash/ETL_GRP_1/ETL_GRP/ETL_2/ .

# Set environment variables for Hugging Face Space port
ENV PORT=7860
EXPOSE 7860

# Run the app
CMD ["python", "app.py"]
