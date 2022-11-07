const { MongoClient, MongoClientOptions } = require("mongodb");
const express = require('express');

/*============== VARIABLE DECLARATION ==============*/
// Mongo set-up variables
const mongoCollection = process.env.MONGO_COLLECTION || 'log';
const mongoUri = process.env.MONGODB_HOST || 'mongodb://127.0.0.1:27017/default?replicaSet=rs0';

const historyNumber = parseInt(process.env.HISTORY_AMOUNT) || 50;

// Stream set-up variables
let changeStream;
const pipeline = [];
const PORT = process.env.PORT || 3002;

// Create Mongo client
const mongoOptions = {
  readPreference: 'secondaryPreferred'
}
const mongoClient = new MongoClient(mongoUri, mongoOptions);

/*============== CODE ==============*/
async function run() {

  console.log('server.js has been launched');
  const app = express();

  await mongoClient.connect();
  const collection = mongoClient.db().collection(mongoCollection);

  const filterOptions = [
    'kubernetes.namespace',
    'kubernetes.pod.name',
    'kubernetes.container.name'
  ]

  const writeMessage = (eventStream, blob) => {
    const id = blob._id || null
    const message = `id: ${id}\nevent: message\ndata: ${JSON.stringify(blob)}\n\n`
    eventStream.write(message)
  }

  const writeTimeoutNotify = (eventStream) => {
    const message = `id: 1\nevent: timeout\ndata: ${JSON.stringify({})}\n\n`
    eventStream.write(message)
  }

  const writeFilterOptions = async (eventStream, filterOptions, query) => {
    let response = {}
    if (Object.keys(query).length === 0) {
      response[filterOptions[0]] = {
        parentKey: null,
        parentValue: null,
        options: await collection.distinct(filterOptions[0])
      }
    } else {
      let deepestKey;
      let parentKey;
      for (let index in filterOptions) {
        let key = filterOptions[index]
        if (Object.keys(query).indexOf(key) === -1) {
          // Compare allowed filter options and query until a filter option is found which query doesn't include.
          deepestKey = key
          parentKey = filterOptions[index - 1]
          break
        }
      }
      if (deepestKey !== undefined) {
        response[deepestKey] = {
          parentKey: parentKey,
          parentValue: query[parentKey],
          options: await collection.distinct(deepestKey, query)
        }
      }
    }
    eventStream.write(`id: 1\nevent: filters\ndata: ${JSON.stringify(response)}\n\n`)
  }

  // Triggers on GET at /event route
  app.get('/events', async function (request, eventStream) {
    const header = { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' };
    eventStream.writeHead(200, "OK", header);

    if (Object.keys(request.query).length === 0) {
      // If no params are defined, it's the initial request which will return filters and some initial lines
      await writeFilterOptions(eventStream, filterOptions, {})
      collection.find()
          .sort({$natural:-1})
          .limit(historyNumber).toArray().then((res) => {
            res.reverse().forEach((document) => {
              writeMessage(eventStream, document)
            })
          });
    } else {
      const query = Object.fromEntries(
          Object.entries(request.query).filter(([key, value]) =>  filterOptions.includes(key))
      )
      const queryLength = Object.keys(query).length
      if (queryLength > 0) {
        try {
          await writeFilterOptions(eventStream, filterOptions, query)
          const cursor = collection.find(query, { maxTimeMS: Math.pow(queryLength, queryLength)  });
          await cursor.forEach((d) => {
            writeMessage(eventStream, d)
          });
        } catch (e) {
          // Handle request timing out as it is expected
          if (e.codeName === 'MaxTimeMSExpired') {
              writeTimeoutNotify(eventStream)
          } else {
            throw e
          }
        }
      }
    }
  });

  app.listen(PORT);
  console.log(`Server listening at 127.0.0.1:${PORT}`);
}

run().catch(console.dir);
