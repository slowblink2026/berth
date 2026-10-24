FROM node:22-bookworm-slim

RUN apt-get update -qq && apt-get install -y -qq \
    xvfb \
    fonts-liberation fonts-noto-core \
    ca-certificates \
    # Chromium system deps (installed by playwright below)
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --prefer-offline

ENV PLAYWRIGHT_BROWSERS_PATH=/app/.local/pw-browsers
RUN npx playwright install --with-deps chromium

COPY . .

ENV DISPLAY=:99
ENV NODE_ENV=production
EXPOSE 8080

CMD ["/bin/bash", "-c", \
  "rm -f /tmp/.X99-lock && \
   Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & \
   XVFB_PID=$! && \
   for i in $(seq 1 20); do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep 0.2; done && \
   npm run dev; \
   kill $XVFB_PID 2>/dev/null || true"]
