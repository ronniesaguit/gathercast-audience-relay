FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV GATHERCAST_RELAY_HOST=0.0.0.0

COPY public/audience-view.html ./public/audience-view.html
COPY public/audience-view.css ./public/audience-view.css
COPY public/audience-view.js ./public/audience-view.js
COPY scripts/gathercast-audience-relay.mjs ./scripts/gathercast-audience-relay.mjs

EXPOSE 10000

CMD ["node", "scripts/gathercast-audience-relay.mjs"]
