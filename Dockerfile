FROM node:18-slim

# Install dependencies
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg wget && \
    pip3 install --upgrade yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Verify yt-dlp installation
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