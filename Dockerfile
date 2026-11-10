FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY data ./data
ENV NODE_ENV=production PORT=8000
EXPOSE 8000
USER node
CMD ["node", "src/server.js"]
