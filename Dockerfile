FROM node:22-bookworm-slim AS workspace

RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run typecheck

FROM workspace AS api-build
RUN pnpm --filter @workspace/api-server run test
RUN pnpm --filter @workspace/api-server run build

FROM node:22-bookworm-slim AS api

ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-build /app/artifacts/api-server/dist ./dist

EXPOSE 3001
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]

FROM workspace AS web-build

ENV NODE_ENV=production
ENV PORT=8080
ENV BASE_PATH=/
RUN pnpm --filter @workspace/nexora run build

FROM nginx:1.27-alpine AS web

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/artifacts/nexora/dist/public /usr/share/nginx/html

EXPOSE 80

FROM workspace AS migrate

CMD ["pnpm", "--filter", "@workspace/db", "run", "migrate"]

FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim AS agent-test

WORKDIR /src
COPY agent ./agent
RUN dotnet test agent/Nexora.Agent.Tests/Nexora.Agent.Tests.csproj -c Release
RUN dotnet publish agent/Nexora.Agent/Nexora.Agent.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o /out
