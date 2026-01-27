FROM node:20-alpine

WORKDIR /app

# Install openssl for certificate generation
RUN apk add --no-cache openssl

# Copy workspace files needed for installation
COPY package.json ./
COPY packages/drawvid-worldserver/package.json ./packages/drawvid-worldserver/

# Install dependencies from workspace (npm workspaces)
RUN npm install --omit=dev --workspace=drawvid-worldserver

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
