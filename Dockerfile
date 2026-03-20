FROM rust:1.82-bookworm

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN cargo build -p xroute-api

EXPOSE 8788

CMD ["npm", "run", "serve:api"]
