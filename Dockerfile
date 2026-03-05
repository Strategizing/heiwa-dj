# Use Node 22+ as required
FROM node:22-slim

# Set CI environment variable to avoid TTY issues with pnpm
ENV CI=true

# Install pnpm
RUN npm install -g pnpm

# Set working directory
WORKDIR /app

# Only copy lockfile and workspace config first to leverage Docker cache
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/server/package.json ./packages/server/
COPY packages/ui/package.json ./packages/ui/
COPY packages/desktop/package.json ./packages/desktop/

# Install dependencies (ignoring scripts to avoid postinstall issues in slim image)
RUN pnpm install --frozen-lockfile

# Now copy the rest of the source
COPY . .

# Build the project
RUN pnpm build

# Expose the ports
EXPOSE 3001 4321 5173

# Set environment variables
ENV HEIWA_DJ_SERVE_UI_DIST=1
ENV HEIWA_DJ_NO_AUTO_OPEN=1
ENV HEIWA_DJ_MODEL_CANDIDATES=qwen2.5-coder:7b

# Default command
CMD ["pnpm", "--filter", "server", "start", "--local", "--embedded-engine"]
