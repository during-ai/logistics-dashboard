FROM python:3.12-slim

# Chromium + chromedriver (Selenium 헤드리스)
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium chromium-driver \
        fonts-nanum ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Seoul \
    CHROME_BIN=/usr/bin/chromium \
    CHROMEDRIVER=/usr/bin/chromedriver \
    DOWNLOAD_DIR=/data/downloads \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 다운로드 저장 볼륨
RUN mkdir -p /data/downloads
VOLUME ["/data/downloads"]

EXPOSE 8510

CMD ["python", "server_downloader.py"]
