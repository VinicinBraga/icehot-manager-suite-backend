# Dockerfile - icehot-api
FROM node:20-alpine
WORKDIR /app

# Instala apenas deps declaradas
COPY package*.json ./
RUN npm ci --omit=dev

# Copia o código
COPY . .

ENV NODE_ENV=production
# Cloud Run injeta PORT; seu index já usa process.env.PORT || 8080
EXPOSE 8080

CMD ["npm", "start"]
