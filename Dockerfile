FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-alpine
ENV TZ=Asia/Shanghai
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=builder /app/dist/ dist/
COPY config.yml ./

EXPOSE 3321
CMD ["node", "dist/bootstrap.js", "/app/config.yml"]
