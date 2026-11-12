FROM nginx:alpine

# Kopiujemy konfigurację serwera Nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Wystawiamy port 80 dla serwera HTTP
EXPOSE 80

# Uruchamiamy Nginx w trybie pierwszoplanowym
CMD ["nginx", "-g", "daemon off;"]
