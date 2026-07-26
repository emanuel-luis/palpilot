# Cloud Run image for the coordinator: serves the built console (static assets +
# SPA fallback) AND the API from one origin, so there is no CORS to configure and
# the bearer-token model is unchanged.
#
# The 1100-line router in main.py is reused verbatim: functions_framework's
# create_app() wraps the same `coordinator(request)` entry point the Cloud
# Function used, so this migration changes the hosting, not the handler.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# index.html + assets/ are produced by `npm run build` in ../frontend and land
# here, so the image carries the console it serves.
COPY . ./

ENV PORT=8080
EXPOSE 8080

# One worker, several threads: the module keeps in-process state (login throttle,
# the 10s GCS document cache), so extra workers would each hold a separate copy.
# timeout 0 because a proxied save activate/restore legitimately runs for minutes;
# Cloud Run's own request timeout is the real ceiling.
CMD exec gunicorn \
    --bind ":${PORT}" \
    --workers 1 \
    --threads 8 \
    --timeout 0 \
    --access-logfile - \
    "functions_framework:create_app('coordinator', 'main.py', 'http')"
