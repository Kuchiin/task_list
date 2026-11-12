# Etap budowania (Build Stage)
FROM node:18-alpine as builder

WORKDIR /app

# Kopiujemy package.json i package-lock.json
COPY package*.json ./

# Instalujemy zależności
RUN npm install --production

# Etap produkcyjny (Production Stage)
FROM node:18-alpine

# Tworzymy użytkownika nie-root
RUN addgroup --system --gid 1001 appuser && \
    adduser --system --uid 1001 appuser

USER appuser

WORKDIR /app

# Kopiujemy zainstalowane zależności z etapu budowania
COPY --from=builder /app/node_modules ./node_modules

# Kopiujemy kod aplikacji
COPY server.js .

# Ustawiamy zmienne środowiskowe
ENV PORT=5000

# Wystawiamy port, na którym nasłuchuje aplikacja
EXPOSE 5000

# Komenda uruchamiająca aplikację
CMD ["node", "server.js"]