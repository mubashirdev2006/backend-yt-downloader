FROM node:18-slim

# Install dependencies including deno for JavaScript runtime
RUN apt-get update && \
    apt-get install -y python3 ffmpeg wget curl unzip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install deno (JavaScript runtime for yt-dlp)
RUN curl -fsSL https://deno.land/install.sh | sh && \
    cp /root/.deno/bin/deno /usr/local/bin/deno

# Download yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Verify installations
RUN yt-dlp --version && deno --version

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