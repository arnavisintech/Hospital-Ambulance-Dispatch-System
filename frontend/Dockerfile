# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
# Production builds load base-map tiles through nginx's caching proxy (see templates/default.conf.template).
ENV VITE_MAP_TILE_URL="/tiles/{z}/{x}/{y}{r}.png"     VITE_MAP_TILE_ATTRIBUTION='&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
RUN npm run build

# ---- runtime stage ----
FROM nginx:alpine
COPY templates /etc/nginx/templates
ENV STADIA_API_KEY=""
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
