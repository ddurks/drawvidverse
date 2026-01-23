FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json ./
COPY pnpm-lock.yaml ./

# Install pnpm
RUN npm install -g pnpm@8.15.0

# Install dependencies
RUN pnpm install --frozen-lockfile --prod

# Copy built code
COPY dist ./dist

# Copy game configs (needed for config loading)
COPY ../../games ./games

# Expose world server port
EXPOSE 7777

CMD ["node", "dist/index.js"]
