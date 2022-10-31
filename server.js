const { MongoClient, MongoClientOptions } = require("mongodb");
const express = require('express');

/*============== VARIABLE DECLARATION ==============*/
// Mongo set-up variables
const mongoCollection = process.env.MONGO_COLLECTION || 'log';
const mongoUri = process.env.MONGODB_HOST || 'mongodb://127.0.0.1:27017/default?replicaSet=rs0';

const historyNumber = parseInt(process.env.HISTORY_AMOUNT) || 50;

// Stream set-up variables
let changeStream;
const options = { fullDocument: "updateLookup" };
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

  changeStream = collection.watch(pipeline, options);
  console.log("Started watching changes in database");

  const filterOptions = {
    'kubernetes.namespace': await collection.distinct('kubernetes.namespace'),
    'kubernetes.pod.name': await collection.distinct('kubernetes.pod.name'),
    'kubernetes.container.name': await collection.distinct('kubernetes.container.name')
  }

  const writeMessage = (response, blob) => {
    const id = blob._id || null
    const message = `id: ${id}\nevent: message\ndata: ${JSON.stringify(blob)}\n\n`
    response.write(message)
  }

  // Triggers on GET at /event route
  app.get('/events', async function (request, response) {

      // Notify SSE to React
    const header = { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' };
    response.writeHead(200, "OK", header);

    const message = `id: 1\nevent: filters\ndata: ${JSON.stringify(filterOptions)}\n\n`
    response.write(message)

    const historyCursor = collection.find()
        .sort({$natural:-1})
        .limit(historyNumber).toArray().then((res) => {
          res.reverse().forEach((document) => {
            writeMessage(response, document)
          })
        });

    const changeListener = async (change) => {
      // Ignore events without fullDocument, e.g. deletes.
      if (change.fullDocument) {
        writeMessage(response, change.fullDocument)
      }
    }
    changeStream.on("change", changeListener);
    response.on('close', () => {
      changeStream.removeListener("change", changeListener)
    })
  });

  app.listen(PORT);
  console.log(`Server listening at 127.0.0.1:${PORT}`);
}

run().catch(console.dir);
