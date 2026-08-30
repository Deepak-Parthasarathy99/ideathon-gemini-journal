FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Cloud Run supplies PORT. Default is for local runs.
ENV PORT=8080
CMD exec uvicorn app.main:app --host 0.0.0.0 --port $PORT
