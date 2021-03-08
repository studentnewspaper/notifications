FROM node:14

WORKDIR /app

COPY package*.json ./
COPY yarn.lock ./
RUN yarn install --non-interactive --frozen-lockfile

COPY . .

ARG NODE_ENV=${NODE_ENV}
ARG VAPID_PUBLIC=${VAPID_PUBLIC}
ARG VAPID_PRIVATE=${VAPID_PRIVATE}
ARG HASURA_SECRET=${HASURA_SECRET}
ARG PORT=${PORT}

EXPOSE 8001
CMD ["yarn", "start"]