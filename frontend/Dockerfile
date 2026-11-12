# Etap budowania (Build Stage)
FROM node:20-alpine as builder

WORKDIR /app

# Kopiujemy pliki package.json i package-lock.json
COPY package*.json ./

# Instalujemy zależności
RUN npm install

# Kopiujemy resztę kodu aplikacji
COPY . .

# Budujemy aplikację React
RUN npm run build

# Używamy serwera Nginx do serwowania statycznych plików React
FROM nginx:alpine

# Kopiujemy zbudowane pliki z etapu budowania do katalogu Nginx
COPY --from=builder /app/dist /usr/share/nginx/html 

# Kopiujemy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Wystawiamy port, na którym nasłuchuje Nginx
EXPOSE 80

# Domyślna komenda Nginx
CMD ["nginx", "-g", "daemon off;"]