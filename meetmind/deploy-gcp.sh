#!/bin/bash

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-us-central1}"
REPO="${GCP_ARTIFACT_REPO:-meetmind-repo}"
SERVICE_NAME="${GCP_SERVICE_NAME:-meetmind}"
SERVICE_ACCOUNT="${GCP_SERVICE_ACCOUNT:-vertex-express@${PROJECT_ID}.iam.gserviceaccount.com}"
IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_PATH="${SCRIPT_DIR}/cloudrun/meetmind-service.yaml.template"
RENDERED_PATH="${SCRIPT_DIR}/cloudrun/meetmind-service.rendered.yaml"

echo "Deploying MeetMind to Cloud Run"
echo "  Project: ${PROJECT_ID}"
echo "  Region: ${REGION}"
echo "  Service: ${SERVICE_NAME}"
echo "  Service account: ${SERVICE_ACCOUNT}"

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  aiplatform.googleapis.com \
  --project="${PROJECT_ID}" \
  --quiet

gcloud artifacts repositories create "${REPO}" \
  --repository-format=docker \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  2>/dev/null || true

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

gcloud iam service-accounts describe "${SERVICE_ACCOUNT}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1 || \
gcloud iam service-accounts create "${SERVICE_ACCOUNT%%@*}" \
  --display-name="MeetMind Cloud Run" \
  --project="${PROJECT_ID}"

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/aiplatform.expressUser" \
  --quiet >/dev/null

pushd "${SCRIPT_DIR}" >/dev/null
docker build -t "${IMAGE_BASE}/meet-control-server:latest" ./meet-control-server
docker push "${IMAGE_BASE}/meet-control-server:latest"
docker build -t "${IMAGE_BASE}/meet-bot:latest" ./meet-bot
docker push "${IMAGE_BASE}/meet-bot:latest"
docker build -t "${IMAGE_BASE}/meetmind-agent:latest" ./meetmind-agent
docker push "${IMAGE_BASE}/meetmind-agent:latest"
popd >/dev/null

sed \
  -e "s|__SERVICE_NAME__|${SERVICE_NAME}|g" \
  -e "s|__REGION__|${REGION}|g" \
  -e "s|__PROJECT_ID__|${PROJECT_ID}|g" \
  -e "s|__IMAGE_BASE__|${IMAGE_BASE}|g" \
  -e "s|__SERVICE_ACCOUNT__|${SERVICE_ACCOUNT}|g" \
  "${TEMPLATE_PATH}" > "${RENDERED_PATH}"

gcloud run services replace "${RENDERED_PATH}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --quiet

gcloud run services add-iam-policy-binding "${SERVICE_NAME}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --member="allUsers" \
  --role="roles/run.invoker" \
  --quiet >/dev/null || true

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --format="value(status.url)")"

echo ""
echo "MeetMind deployed:"
echo "  URL: ${SERVICE_URL}"
echo "  Docs: ${SERVICE_URL}/docs"
