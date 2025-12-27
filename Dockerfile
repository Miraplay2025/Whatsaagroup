FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
  ca-certificates \
  fonts-liberation \
  libatk1.0-0 \
  libgtk-3-0 \
  libnss3 \
  libx11-xcb1 \
  libxss1 \
  wget \
  unzip \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 10000

CMD ["npm", "start"]
