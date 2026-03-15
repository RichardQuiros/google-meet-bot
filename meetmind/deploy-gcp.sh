#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# MeetMind AI — Google Cloud Run Deployment
# Deploys all 3 services: meet-bot, meet-control-server, meetmind-agent
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-us-central1}"
REPO="meetmind-repo"
GEMINI_KEY="${GOOGLE_API_KEY:?Set GOOGLE_API_KEY}"

echo "═══════════════════════════════════════════"
echo "  MeetMind AI — Cloud Run Deployment"
echo "  Project: ${PROJECT_ID}"
echo "  Region:  ${REGION}"
echo "═══════════════════════════════════════════"

# ── Step 1: Enable APIs ──
echo ""
echo "→ [1/7] Enabling APIs..."
gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    firestore.googleapis.com \
    aiplatform.googleapis.com \
    --project="${PROJECT_ID}" --quiet
echo "  ✓ APIs enabled"

# ── Step 2: Create Artifact Registry repo ──
echo ""
echo "→ [2/7] Creating Artifact Registry..."
gcloud artifacts repositories create "${REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    2>/dev/null || echo "  Repository already exists"
echo "  ✓ Artifact Registry ready"

# Configure Docker auth
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"

# ── Step 3: Build meet-control-server ──
echo ""
echo "→ [3/7] Building meet-control-server..."
docker build -t "${IMAGE_BASE}/meet-control-server:latest" ./meet-control-server
docker push "${IMAGE_BASE}/meet-control-server:latest"
echo "  ✓ meet-control-server image pushed"

# ── Step 4: Deploy meet-control-server ──
echo ""
echo "→ [4/7] Deploying meet-control-server to Cloud Run..."
gcloud run deploy meet-control-server \
    --image="${IMAGE_BASE}/meet-control-server:latest" \
    --region="${REGION}" --project="${PROJECT_ID}" \
    --platform=managed --allow-unauthenticated \
    --memory=512Mi --cpu=1 --timeout=3600 \
    --max-instances=3 --min-instances=0 \
    --port=3001 \
    --set-env-vars="NODE_ENV=production,PORT=3001" \
    --quiet

CONTROL_URL=$(gcloud run services describe meet-control-server \
    --region="${REGION}" --project="${PROJECT_ID}" \
    --format="value(status.url)")
echo "  ✓ Control server: ${CONTROL_URL}"

# ── Step 5: Build meet-bot ──
echo ""
echo "→ [5/7] Building meet-bot..."
docker build -t "${IMAGE_BASE}/meet-bot:latest" ./meet-bot
docker push "${IMAGE_BASE}/meet-bot:latest"
echo "  ✓ meet-bot image pushed"

# ── Step 6: Deploy meet-bot ──
echo ""
echo "→ [6/7] Deploying meet-bot to Cloud Run..."
gcloud run deploy meet-bot \
    --image="${IMAGE_BASE}/meet-bot:latest" \
    --region="${REGION}" --project="${PROJECT_ID}" \
    --platform=managed --allow-unauthenticated \
    --memory=4Gi --cpu=2 --timeout=3600 \
    --max-instances=3 --min-instances=0 \
    --port=3000 \
    --set-env-vars="NODE_ENV=production,PORT=3000,CONTROL_BASE_URL=${CONTROL_URL}" \
    --set-env-vars="ENABLE_AUDIO_INPUT=true,ENABLE_VIDEO_INPUT=true,CAPTURE_VIDEO_FRAMES=true" \
    --set-env-vars="CHAT_POLL_INTERVAL_MS=250,CAPTION_POLL_INTERVAL_MS=250,VIDEO_POLL_INTERVAL_MS=250" \
    --set-env-vars="TTS_BACKEND=piper,SPEECH_DELIVERY_MODE=meeting-microphone" \
    --set-env-vars="MEET_AUDIO_SINK_NAME=meetbot_sink,MEET_AUDIO_OUTPUT_SINK_NAME=meetbot_meeting_sink,MEET_AUDIO_SOURCE_NAME=meetbot_mic" \
    --set-env-vars="MEET_AUDIO_INPUT_DEVICE=meetbot_meeting_sink.monitor,AUDIO_OUTPUT_DEVICE=meetbot_sink" \
    --set-env-vars="MEET_PREFERRED_MICROPHONE_LABEL=MeetBot_Virtual_Microphone" \
    --quiet

BOT_URL=$(gcloud run services describe meet-bot \
    --region="${REGION}" --project="${PROJECT_ID}" \
    --format="value(status.url)")
echo "  ✓ Meet bot: ${BOT_URL}"

# ── Step 7: Build + deploy meetmind-agent ──
echo ""
echo "→ [7/7] Building and deploying meetmind-agent..."
docker build -t "${IMAGE_BASE}/meetmind-agent:latest" ./meetmind-agent
docker push "${IMAGE_BASE}/meetmind-agent:latest"

gcloud run deploy meetmind-agent \
    --image="${IMAGE_BASE}/meetmind-agent:latest" \
    --region="${REGION}" --project="${PROJECT_ID}" \
    --platform=managed --allow-unauthenticated \
    --memory=1Gi --cpu=1 --timeout=3600 \
    --max-instances=3 --min-instances=0 \
    --port=8080 \
    --set-env-vars="GOOGLE_API_KEY=${GEMINI_KEY}" \
    --set-env-vars="GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio" \
    --set-env-vars="CONTROL_BASE_URL=${CONTROL_URL}" \
    --set-env-vars="BOT_ID=bot-01,MEETING_ID=meetmind-session" \
    --set-env-vars="HOST=0.0.0.0,PORT=8080" \
    --quiet

AGENT_URL=$(gcloud run services describe meetmind-agent \
    --region="${REGION}" --project="${PROJECT_ID}" \
    --format="value(status.url)")
echo "  ✓ Agent: ${AGENT_URL}"

# ── Step 8: Create Firestore ──
echo ""
echo "→ Setting up Firestore..."
gcloud firestore databases create \
    --location="${REGION}" --type=firestore-native \
    --project="${PROJECT_ID}" 2>/dev/null || echo "  Firestore already exists"

# ── Done ──
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✓ MeetMind deployed successfully!"
echo ""
echo "  Control Server:  ${CONTROL_URL}"
echo "  Meet Bot:        ${BOT_URL}"
echo "  Agent Dashboard: ${AGENT_URL}"
echo "  API Docs:        ${AGENT_URL}/docs"
echo ""
echo "  To deploy agent into a meeting:"
echo "  curl -X POST ${AGENT_URL}/api/deploy \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"meeting_url\": \"https://meet.google.com/xxx-yyyy-zzz\", \"role_id\": \"technical_reviewer\"}'"
echo "═══════════════════════════════════════════════════════"
