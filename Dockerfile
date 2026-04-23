FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 8787
CMD ["sh", "-c", "npm run db:migrate && node --experimental-strip-types src/server.ts"]
