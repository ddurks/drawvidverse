FROM node:20-alpine

WORKDIR /app

# Install openssl for certificate generation
RUN apk add --no-cache openssl

# Copy workspace files needed for installation
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/drawvid-worldserver/package.json ./packages/drawvid-worldserver/

# Install pnpm
RUN npm install -g pnpm@8.15.0

# Install dependencies from workspace
RUN pnpm install --frozen-lockfile --prod

# Copy built worldserver code
COPY packages/drawvid-worldserver/dist ./packages/drawvid-worldserver/dist

# Copy game configs (needed for config loading)
COPY games/ /games/

# Note: TLS is handled by the NLB, so world server uses plain WebSocket on port 7777
# No certificate generation needed

# Expose world server port
EXPOSE 7777

# Use explicit sh to avoid entrypoint issues
ENTRYPOINT ["/bin/sh", "-c"]
CMD ["node packages/drawvid-worldserver/dist/index.js"]
