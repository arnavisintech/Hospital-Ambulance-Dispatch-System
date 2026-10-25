# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
ARG VITE_CITY_CENTER="13.0827,80.2707"
ENV VITE_CITY_CENTER=$VITE_CITY_CENTER
# Production builds load base-map tiles through nginx's caching proxy (see templates/default.conf.template).
ENV VITE_MAP_TILE_URL="/tiles/{z}/{x}/{y}{r}.png"     VITE_MAP_TILE_ATTRIBUTION='&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
RUN npm run build

# ---- runtime stage ----
FROM nginx:1.27-alpine
COPY templates /etc/nginx/templates
COPY nginx /etc/nginx/hads
COPY docker-entrypoint.d/40-hads-tls.sh /docker-entrypoint.d/40-hads-tls.sh
RUN sed -i 's/\r$//' /docker-entrypoint.d/40-hads-tls.sh && chmod +x /docker-entrypoint.d/40-hads-tls.sh && rm -f /etc/nginx/conf.d/default.conf
ENV STADIA_API_KEY=""
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80 443
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]
