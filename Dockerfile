FROM python:3.12-slim

WORKDIR /app

# git needed for cloning repos
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV HOST=0.0.0.0 PORT=5000 CODY_DB=/data/cody.db CODY_REPO_DIR=/data/cloned_repo CODY_MODEL=qwen2.5-coder:3b
VOLUME ["/data"]
EXPOSE 5000

CMD ["python", "main.py", "--host", "0.0.0.0", "--port", "5000", "--no-browser"]
