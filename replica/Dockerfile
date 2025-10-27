FROM node:18-alpine
WORKDIR /app
COPY package.json package.json
RUN npm install --production
COPY server.js server.js
ENV PORT=4001
CMD ["node", "server.js"]