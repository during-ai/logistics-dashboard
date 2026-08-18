FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Seoul \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 파서(09) + BOM 참조 + 파이프라인 (13은 entrypoint에서 GitLab 클론)
COPY 09 /app/09
COPY BOM_Project /app/BOM_Project
COPY pipeline.py /app/pipeline.py
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
