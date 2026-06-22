const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not set. Copy backend/.env.example to backend/.env and fill it in.');
  }

  mongoose.set('strictQuery', true);

  await mongoose.connect(uri);
  console.log(`[db] connected -> ${mongoose.connection.host}/${mongoose.connection.name}`);

  mongoose.connection.on('error', (err) => {
    console.error('[db] connection error:', err.message);
  });
}

module.exports = connectDB;
