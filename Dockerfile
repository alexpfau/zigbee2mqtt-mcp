# Container image for running the MCP server over stdio.
# Configuration is supplied via environment variables at run time:
#   docker run -i --rm -e Z2M_MQTT_URL=mqtt://192.168.1.10:1883 zigbee2mqtt-mcp

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
ENTRYPOINT ["node", "dist/index.js"]
