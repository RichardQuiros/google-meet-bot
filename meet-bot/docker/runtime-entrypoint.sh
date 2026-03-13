#!/usr/bin/env bash
set -euo pipefail

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-meetbot}"
export DISPLAY="${DISPLAY:-:99}"
export PULSE_SERVER="${PULSE_SERVER:-unix:/var/run/pulse/native}"
MEET_AUDIO_SINK_DESCRIPTION_SAFE="${MEET_AUDIO_SINK_DESCRIPTION:-MeetBot_Virtual_Sink}"
MEET_AUDIO_SOURCE_DESCRIPTION_SAFE="${MEET_AUDIO_SOURCE_DESCRIPTION:-MeetBot_Virtual_Microphone}"
MEET_AUDIO_SINK_DESCRIPTION_SAFE="${MEET_AUDIO_SINK_DESCRIPTION_SAFE// /_}"
MEET_AUDIO_SOURCE_DESCRIPTION_SAFE="${MEET_AUDIO_SOURCE_DESCRIPTION_SAFE// /_}"
mkdir -p "${XDG_RUNTIME_DIR}"
chmod 700 "${XDG_RUNTIME_DIR}"
mkdir -p /var/run/pulse /var/lib/pulse

Xvfb "${DISPLAY}" -screen 0 1366x768x24 -ac +extension RANDR > /tmp/xvfb.log 2>&1 &
pulseaudio --system --daemonize=yes --disallow-exit --exit-idle-time=-1 --log-target=stderr -n \
  -L "module-native-protocol-unix auth-anonymous=1 socket=/var/run/pulse/native" \
  -L "module-always-sink" \
  -L "module-null-sink sink_name=${MEET_AUDIO_SINK_NAME:-meetbot_sink} sink_properties=device.description=${MEET_AUDIO_SINK_DESCRIPTION_SAFE}" \
  -L "module-remap-source master=${MEET_AUDIO_SINK_NAME:-meetbot_sink}.monitor source_name=${MEET_AUDIO_SOURCE_NAME:-meetbot_mic} source_properties=device.description=${MEET_AUDIO_SOURCE_DESCRIPTION_SAFE}"

if command -v pactl >/dev/null 2>&1; then
  for attempt in $(seq 1 20); do
    if pactl info >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done

  pactl set-default-sink "${MEET_AUDIO_SINK_NAME:-meetbot_sink}" >/dev/null 2>&1 || true
  pactl set-default-source "${MEET_AUDIO_SOURCE_NAME:-meetbot_mic}" >/dev/null 2>&1 || true
fi

exec "$@"
