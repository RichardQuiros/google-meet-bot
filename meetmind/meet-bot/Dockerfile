FROM node:22-bookworm

ARG PIPER_RELEASE=2023.11.14-2
ARG PIPER_ARCHIVE=piper_amd64.tar.gz
ARG PIPER_PHONEMIZE_ARCHIVE=libpiper_phonemize-amd64.tar.gz
ARG PIPER_VOICE_BASE_URL=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium
ARG PIPER_VOICE_MODEL=en_US-lessac-medium.onnx
ARG PIPER_VOICE_CONFIG=en_US-lessac-medium.onnx.json

ENV DEBIAN_FRONTEND=noninteractive
ENV PIPER_HOME=/opt/piper
ENV PIPER_PATH=/opt/piper/piper
ENV LD_LIBRARY_PATH=/opt/piper:${LD_LIBRARY_PATH}
ENV MEET_CHROME_CHANNEL=chrome
ENV DISPLAY=:99

RUN apt-get update && apt-get install -y --no-install-recommends \
  alsa-utils \
  ca-certificates \
  curl \
  ffmpeg \
  fonts-liberation \
  fonts-noto-color-emoji \
  gnupg \
  libatomic1 \
  pipewire \
  pipewire-pulse \
  pulseaudio \
  pulseaudio-utils \
  python3 \
  python3-pip \
  python3-venv \
  xvfb \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /usr/share/keyrings \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
  | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
  > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/piper \
    && curl -fsSL "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz" \
    | tar -xz -C /opt/piper --strip-components=1 \
    && curl -fsSL "https://github.com/rhasspy/piper-phonemize/releases/download/2023.11.14-4/piper-phonemize_linux_x86_64.tar.gz" \
    | tar -xz -C /opt/piper --strip-components=1 \
    && ln -sf /opt/piper/piper /usr/local/bin/piper

RUN mkdir -p /models/piper \
  && curl -fsSL "${PIPER_VOICE_BASE_URL}/${PIPER_VOICE_MODEL}?download=true" \
  -o "/models/piper/${PIPER_VOICE_MODEL}" \
  && curl -fsSL "${PIPER_VOICE_BASE_URL}/${PIPER_VOICE_CONFIG}?download=true" \
  -o "/models/piper/${PIPER_VOICE_CONFIG}"

RUN pip3 install --no-cache-dir faster-whisper --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY docker/runtime-entrypoint.sh /usr/local/bin/meet-bot-entrypoint

RUN sed -i 's/\r$//' /usr/local/bin/meet-bot-entrypoint \
  && chmod +x /usr/local/bin/meet-bot-entrypoint

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/meet-bot-entrypoint"]
CMD ["npm", "run", "start"]
