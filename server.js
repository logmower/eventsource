const { MongoClient, MongoClientOptions, ObjectId} = require("mongodb");
const express = require('express');

/*============== VARIABLE DECLARATION ==============*/
// Mongo set-up variables
const mongoCollection = process.env.MONGO_COLLECTION || 'log';
const mongoUri = process.env.MONGODB_HOST || 'mongodb://127.0.0.1:27017/default?replicaSet=rs0';
const historyLimit = parseInt(process.env.HISTORY_AMOUNT) || 50;
const queryLimit = parseInt(process.env.QUERY_LIMIT) || 1000;
const PORT = process.env.PORT || 3002;

// Create Mongo client
const mongoOptions = {
  readPreference: 'secondaryPreferred'
}
const mongoClient = new MongoClient(mongoUri, mongoOptions);

// Define different supported backends.
const backend = process.env.BACKEND || 'logmower';
const backends = {
  logmower: {
    filterOptions: [
      'kubernetes.namespace',
      'kubernetes.pod.name',
      'kubernetes.container.name',
      'from',
      'to',
    ]
  },
  camtiler: {
    filterOptions: [
      'source'
    ],
    broker: process.env.BACKEND_BROKER_URL || 'http://camtiler-event-broker'
  }
}

/*============== CODE ==============*/
async function run() {
  console.log('server.js has been launched');
  const app = express();

  if (!backends[backend]) {
    throw `Backend '${backend}' not supported`
  }

  await mongoClient.connect();
  const collection = mongoClient.db().collection(mongoCollection);

  app.get('/events/backend', function (request, response) {
      response.end(backend)
  });

  app.get('/events/details/:id', async function (request, response) {
    const row = await collection.find(ObjectId(request.params.id)).limit(1).next()
    if (backends[backend].broker) {
      await fetch(backends[backend].broker + '/details/', {
        method: "POST",
        body: JSON.stringify(row),
      }).then((res) => res.text())
          .then((res) => response.end(res));
    } else {
      response.end(row)
    }
  });

  const writeMessage = async (eventStream, blob, type) => {
    const id = blob._id || null
    if (backends[backend].broker) {
      fetch(backends[backend].broker + `/${type}/`, {
        method: "POST",
        body: JSON.stringify(blob),
      }).then((r) => r.text())
          .then((r) => {
            const message = `id: ${id}\nevent: message\ndata: ${r}\n\n`
            eventStream.write(message)
          });
    } else {
      const message = `id: ${id}\nevent: message\ndata: ${JSON.stringify(blob)}\n\n`
      eventStream.write(message)
    }
  }

  const writeTimeoutNotify = (eventStream) => {
    const message = `id: 1\nevent: timeout\ndata: ${JSON.stringify({})}\n\n`
    eventStream.write(message)
  }

  const writeCompletedTimeout = (eventStream) => {
    const message = `id: 1\nevent: completed\ndata: ${JSON.stringify({})}\n\n`
    eventStream.write(message)
  }

  const writeFilterOptions = async (eventStream, filterOptions, query) => {
    let response = {}
    delete query['@timestamp']
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

  const writePing = (eventStream) => {
    const message = `id: 1\nevent: ping\ndata: ${JSON.stringify({})}\n\n`
    return eventStream.write(message)
  }

  const transformQuery = (query, filterOptions, appendFullDocument = false) => {
    query = Object.fromEntries(
        Object.entries(query).filter(([key, value]) =>  filterOptions.includes(key))
    )
    if (appendFullDocument) {
      for (let k in query) {
        query['fullDocument.' + k] = query[k]
        delete query[k]
      }
    } else {
      query['@timestamp'] = {}
      query['from'] && (query['@timestamp']['$gte'] = new Date(Number(query['from']))) && delete query['from']
      query['to'] && (query['@timestamp']['$lt'] = new Date(Number(query['to']))) && delete query['to']
      !(Object.keys(query['@timestamp']).length) && delete query['@timestamp']
    }
    return query
  }

  // Triggers on GET at /event route
  app.get('/events', async function (request, eventStream) {
    const header = { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' };
    eventStream.writeHead(200, "OK", header);
    writePing(eventStream) // Dummy response to make browser report the request not cancelled

    let query = request.query
    let streaming = (query['streaming'] === 'true')
    let initial = (query['initial'] === 'true')
    delete query['streaming']
    delete query['initial']

    const filterOptions = backends[backend].filterOptions

    if (initial) {
      // The initial request will return filters and some initial lines
      await writeFilterOptions(eventStream, filterOptions, {})
      await collection.find()
          .sort({$natural: -1})
          .limit(historyLimit).forEach((document) => {
            writeMessage(eventStream, document, 'initial')
          })
    }

    const queryLength = Object.keys(query).length
    if (queryLength) {
      query = transformQuery(query, filterOptions)
      try {
        await writeFilterOptions(eventStream, filterOptions, query)
        const cursor = collection.find(query, {
          limit: queryLimit
        });
        eventStream.on('close', () => {
          cursor.close()
        })
        for await (const d of cursor) {
          await writeMessage(eventStream, d, 'query')
        }
        if (await collection.find(query).count() > queryLimit && !streaming) {
          writeTimeoutNotify(eventStream)
        } else {
          writeCompletedTimeout(eventStream)
        }
      } catch (e) {
        // Do something with e, for instance get e.codeName
        throw e
      }
    }

    if (streaming) {
      query = transformQuery(query, filterOptions, true)
      let changeStream;
      changeStream = collection.watch([
        {
          $match: query
        }
      ], { fullDocument: "updateLookup" });

      const changeListener = async (change) => {
        // Ignore events without fullDocument, e.g. deletes
        if (change.fullDocument) {
          await writeMessage(eventStream, change.fullDocument, 'streaming')
        }
      }
      changeStream.on("change", changeListener);
      eventStream.on('close', () => {
        changeStream.removeListener("change", changeListener)
      })
    }

    setInterval(() => {
      writePing(eventStream)
    }, 9000)

    // If streaming has been stopped without parameters, send completed as no rows are expected.
    writeCompletedTimeout(eventStream)
  });

  app.listen(PORT);
  console.log(`Server listening at 127.0.0.1:${PORT}`);
}

run().catch(console.dir);
