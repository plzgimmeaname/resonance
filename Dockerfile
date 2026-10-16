FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "dist/server.js"]
