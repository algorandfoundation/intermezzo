FROM node:20-bullseye

# Build/tooling + native deps for node-canvas (QR rendering) and node-datachannel
# Using a Debian-based image (glibc) avoids many native binary issues
# Reference: https://github.com/Automattic/node-canvas#compiling
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    pkg-config \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    libpixman-1-dev \
    libpng-dev \
    libfreetype6-dev \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/app && \
    mkdir -p /data/db && \
    mkdir -p /usr/lib/node_modules

# Copy projects folder into container's app folder
COPY . /opt/app

# Remove vendored external TypeScript sources so the root TypeScript build
# doesn't attempt to compile them (they're packaged as npm tarballs instead).
RUN rm -rf /opt/app/external || true

RUN chown -R node:node /opt/app/

# Change to app directory
WORKDIR /opt/app

# Expose Nest HTTP port (3000) and optional debug port (9200)
EXPOSE 3000 9200

# Dont run as root
USER node

RUN npm install
RUN npm run build

CMD [ "yarn", "start:prod" ]
