FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ pkg-config build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/app && \
    mkdir -p /data/db && \
    mkdir -p /usr/lib/node_modules

# Copy projects folder into container's app folder
COPY . /opt/app

RUN chown -R node:node /opt/app/

# Change to app directory
WORKDIR /opt/app

# Enable debugging port
EXPOSE 9200

# Dont run as root
USER node

RUN yarn --ignore-engines
RUN yarn build

CMD [ "yarn", "start:dev" ]
