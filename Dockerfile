FROM node:20-alpine
WORKDIR /app
COPY discord-bot/package.json ./
RUN npm install
COPY discord-bot/index.mjs ./
CMD ["node", "index.mjs"]
