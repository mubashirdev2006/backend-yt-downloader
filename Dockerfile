FROM node:18-slim

# Install dependencies
RUN apt-get update && \
    apt-get install -y python3 ffmpeg wget curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Download yt-dlp binary (no pip needed)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Verify installation
RUN yt-dlp --version

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm install

# Copy all files
COPY . .

# Expose port
EXPOSE 10000

# Start server
CMD ["node", "server.js"]