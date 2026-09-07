FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
RUN CI=true pnpm install --prod --frozen-lockfile
RUN node scripts/stage-runtime.mjs /runtime

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /runtime/ ./
RUN mkdir -p /data/state && chown node:node /data/state
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 CMD ["node", "-e", "const c=JSON.parse(require('node:fs').readFileSync('/config/ctxalloc-api.json','utf8')); fetch('http://127.0.0.1:'+c.server.port+'/ready',{signal:AbortSignal.timeout(2000)}).then(r=>process.exitCode=r.status===200?0:1).catch(()=>{process.exitCode=1})"]
ENTRYPOINT ["node", "apps/api/dist/bin.js"]
CMD ["--config", "/config/ctxalloc-api.json"]
