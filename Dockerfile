# Bun's official image: Linux + Bun preinstalled
FROM oven/bun:1

WORKDIR /app

# Copy just the dependency manifests first so Docker can cache the install layer
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Now copy the rest of the code and bundle the browser client into public/main.js
COPY . .
RUN bun run build

# Default port; Railway overrides PORT at runtime
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "src/server/index.ts"]
