FROM oven/bun:1        # start from Anthropic-adjacent... no wait, this is Bun's official image — Linux + Bun preinstalled
WORKDIR /app            # everything after this runs inside /app in the container
COPY package.json bun.lockb* ./   # copy just the dependency manifest first
RUN bun install --frozen-lockfile # install deps — separated from copying all code so Docker can cache this layer
COPY . .                # now copy the rest of your actual code
ENV PORT=3000            # default port (Railway will override this via its own env var at runtime)
EXPOSE 3000              # documents which port the container listens on
CMD ["bun", "run", "index.ts"]   # the command that runs when the container starts