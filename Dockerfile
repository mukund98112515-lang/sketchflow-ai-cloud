# SketchFlow AI backend — production image
# Runs the full image-analysis + sketch-generation pipeline in the cloud.
# Nothing durable is stored on this container's disk: metadata lives in
# managed Postgres and images live in S3-compatible object storage.
FROM node:22-slim

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

# Install production dependencies only (cached layer).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source (all paths cross-platform; no local drive letters).
COPY src ./src

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
