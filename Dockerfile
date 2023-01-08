# pull official node image
FROM harbor.k-space.ee/docker.io/library/node AS dev

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
ENTRYPOINT node.js server.js
