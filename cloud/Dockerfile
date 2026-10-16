# The Eden Cloud API. Behind a TLS-terminating proxy (Fly, Cloud Run, an ALB) in any real
# deployment; its data folder on a persistent volume.
#   docker build -t eden-cloud-api:dev cloud
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY eden_cloud ./eden_cloud
RUN pip install --no-cache-dir .
RUN useradd --uid 1000 --create-home eden && mkdir -p /data && chown eden /data
USER eden
ENV EDEN_CLOUD_DATA=/data EDEN_CLOUD_HOST=0.0.0.0 EDEN_CLOUD_PORT=8790
EXPOSE 8790
CMD ["python", "-m", "eden_cloud"]
