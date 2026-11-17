FROM node:20-slim

# Install system dependencies (yt-dlp, ffmpeg, curl, unzip, ca-certificates, deno)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    ffmpeg \
    curl \
    unzip \
    ca-certificates && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    curl -fsSL https://deno.land/install.sh | sh && \
    mv /root/.deno/bin/deno /usr/local/bin/deno && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install --production

# Copy application source
COPY . .

# Ensure downloads directory exists
RUN mkdir -p downloads

EXPOSE 3456

CMD ["node", "server.js"]
