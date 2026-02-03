FROM node:20-bullseye

WORKDIR /opt/sponsor

COPY package.json ./
# Install dependencies (including devDependencies for build)
RUN npm install --no-audit --no-fund

COPY . .

# Build TypeScript to /opt/sponsor/dist
RUN npm run build

EXPOSE 3001
# Run production entrypoint
CMD ["npm", "run", "prod"]
