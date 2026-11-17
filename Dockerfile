FROM node:20-slim

# Install system dependencies (yt-dlp, ffmpeg, curl, ca-certificates)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    ffmpeg \
    curl \
    ca-certificates && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set up user for Hugging Face Spaces (UID 1000)
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PORT=7860

WORKDIR $HOME/app

# Install app dependencies
COPY --chown=user:user package*.json ./
RUN npm install --production

# Copy application source
COPY --chown=user:user . .

# Ensure downloads directory exists with correct permissions
RUN mkdir -p downloads && chmod 777 downloads

EXPOSE 7860

CMD ["node", "server.js"]
