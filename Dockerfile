# pull official node image
FROM node:lts-alpine AS dev

# define /app as working directory
WORKDIR /app

# copy package.json and package-lock.json to /app
COPY package.json /app
COPY package-lock.json /app

# install node dependencies
RUN npm install
COPY . /app

# launch node server
ENTRYPOINT npm run dev

# production
FROM dev AS prod
ENTRYPOINT node server.js
