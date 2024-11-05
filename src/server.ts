import express, { Request, Response } from 'express';
import sqlite3 from 'sqlite3';
import { Database, open, Statement } from 'sqlite';
import path from 'path';

const app = express();
const PORT = 3000;

// Set EJS as the template engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Setup db for all to share.
let db: Database<sqlite3.Database, sqlite3.Statement>;



// Route to display movies
app.get('/', async (req, res) => {
  const genre = req.query.genre || '';
  const boxOfficeHits = req.query.boxOfficeHits || false;
  const title = req.query.title || '';
  let minRating: number = req.query.minRating !== undefined ? parseFloat(req.query.minRating as string) : 6;
  const watchList = req.query.watchList || false;

  // Build up our whole query now.
  let query = 'SELECT * FROM movies WHERE 1=1 ';
  const params = [];
  if (watchList) {
    query += ' AND seenStatus = "w" ';
  }
  else if (minRating >= 6) {
    query += ' AND rating >= ?';
    params.push(minRating);
  } else if (minRating) {
    query += ' AND rating >= ?';
    params.push(minRating);
  }
  if (genre) {
    query += ' AND genre LIKE LOWER(?)';
    params.push(`%${genre}%`);
  }
  if (boxOfficeHits) {
    query += ' AND boxOffice > 1000000  ';
  }
  if (title) {
    query += ' AND LOWER(title) LIKE LOWER(?)';
    params.push(`%${title}%`);
  } else {
    query += ' AND seenStatus != "s"  AND seenStatus != "d" ';
  }
  // Leave off all short films.
  // query += ' AND (runtime >= 60 ';
  query += ' AND (runtime >= 60 or runtime = 0) ';
  // Add ordering, we want to see highest rated new movies by release date YEAR first.
  query += ' ORDER BY strftime(\'%Y\', releaseDate) DESC, rating DESC';
  query += ' limit 200 ';

  console.log("DEBUG: query = " + query);
  const movies = await db.all(query, params);
  // await db.close();

  res.render('index', { movies, minRating, genre, boxOfficeHits, title });
});


// Route to mark a movie as seen
app.post('/markSeen', async (req, res) => {
  const { imdbID } = req.query;

  await db.run('UPDATE movies SET seenStatus = "s" WHERE imdbID = ?', [imdbID]);

  res.send('Movie marked as seen');
});

// Route to clear a movie's status
app.post('/markClear', async (req, res) => {
  const { imdbID } = req.query;

  await db.run('UPDATE movies SET seenStatus = "" WHERE imdbID = ?', [imdbID]);

  res.send('Movie status cleared');
});

// Route to mark a movie as want to see
app.post('/markWantToSee', async (req, res) => {
  const { imdbID } = req.query;

  await db.run('UPDATE movies SET seenStatus = "w" WHERE imdbID = ?', [imdbID]);

  res.send('Movie marked as want to see');
});

// Route to mark a movie as dont want to see
app.post('/markDontWantToSee', async (req, res) => {
  const { imdbID } = req.query;

  await db.run('UPDATE movies SET seenStatus = "d" WHERE imdbID = ?', [imdbID]);

  res.send('Movie marked as dont want to see');
});

// Start the server.
app.listen(PORT, async() => {
  console.log(`Server is running on http://localhost:${PORT}`);

  db = await open({
    filename: path.join(__dirname, 'movies.db'), // test
    driver: sqlite3.Database
  });
});

