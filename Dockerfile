# LeftyDevKit site — builds the SvelteKit app in apps/website.
# Root-level Dockerfile so Coolify auto-detects it (dockerfile_location=/Dockerfile).
FROM node:22-alpine AS builder
WORKDIR /app
COPY apps/website/package*.json ./
RUN npm ci
COPY apps/website ./
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=builder /app/build build/
COPY --from=builder /app/package.json .
COPY --from=builder /app/node_modules node_modules/
EXPOSE 3000
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
CMD ["node", "build"]
