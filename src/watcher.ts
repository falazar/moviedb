import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import * as cheerio from 'cheerio';
import axios from 'axios';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';


let counters = {
  newCount: 0,
  errorCount: 0,
  skippedCount: 0,
  updatedCount: 0
};

/**
 * Reads a webpage and returns its content.
 * @param {string} url - The URL of the webpage to read.
 * @returns {Promise<string>} - The content of the webpage.
 */
async function readWebpage(url: string): Promise<string> {
// Make sure Chrome is started in debug mode to use this script.
// From Console, run this:
// start chrome --remote-debugging-port=9222
  const browser = await puppeteer.connect({
    // browserURL: 'http://localhost:9222' //
    browserURL: 'http://127.0.0.1:9222' // Assumes Chrome is running with remote debugging enabled on port 9222
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2' });
  const content = await page.content();
  await page.close();

  await fs.writeFile('src/data/temp.html', content);
  // console.log('Webpage content saved to temp.html');

  return content;
}

/**
 * Parses movies from the HTML content.
 * @param {string} html - The HTML content to parse.
 * @returns {Promise<{title: string, href: string, imgSrc: string}[]>} - A list of movies with their title, href, and imgSrc.
 */
async function parseMovies(html: string): Promise<{ title: string, href: string, imgSrc: string }[]> {
  const $ = cheerio.load(html);
  const movies: { title: string, href: string, imgSrc: string }[] = [];

  $('.ml-item').each((index, element) => {
    const title = $(element).find('.mli-info h2').text();
    const href = $(element).find('a.ml-mask').attr('href');
    const imgSrc = $(element).find('img.mli-thumb').attr('data-original');
    if (title && href && imgSrc) {
      movies.push({ title, href, imgSrc });
    }
  });

  await fs.writeFile('src/data/movies.json', JSON.stringify(movies, null, 2));
  console.log('Movies list saved to movies.json');

  return movies;
}

/**
 * Checks the movies and updates their information.
 * @param {{title: string, href: string, imgSrc: string}[]} movies - The list of movies to check.
 * @returns {Promise<void>}
 */
async function checkMovies(movies: { title: string, href: string, imgSrc: string }[]): Promise<void> {

  for (const movie of movies) {
    const index = movies.indexOf(movie);
    // DEBUG TESTER
    // if (index > 5) {
    //   break;
    // }

    console.log(" "); // line break.
    console.log(`Movie: ${index}, Title: ${movie.title}, Href: ${movie.href}`);

    // defaulting to this year for this list.
    await lookupMovie(movie.title, 2024, movie.href, false, counters);
  }

  console.log('New movies:', counters.newCount);
  console.log('Errors:', counters.errorCount);
  console.log('Skipped:', counters.skippedCount);
  console.log('Updated:', counters.updatedCount);
}

/**
 * Looks up a movie and updates the database with its information.
 * @param {string} name - The name of the movie.
 * @param {number} year - The year of the movie.
 * @param {string} yesUrl - The URL of the movie on YesMovies.
 * @param {boolean} [forceRecheck=false] - Whether to force recheck the movie.
 * @param {{newCount: number, errorCount: number, skippedCount: number, updatedCount: number}} counters - The counters for tracking the number of new, error, skipped, and updated movies.
 * @returns {Promise<void>}
 */
async function lookupMovie(name: string, year: number, yesUrl: string, forceRecheck: boolean = false, counters: {
  newCount: number,
  errorCount: number,
  skippedCount: number,
  updatedCount: number
}): Promise<void> {
  // Check db first, only redo if its been over 3 days or so.
  // todo make global db connection.
  const db = await open({
    filename: './src/movies.db',
    driver: sqlite3.Database
  });

  // STEP 1: Get days since updatedOn, skip if recently done.
  const daysSinceResponse = await db.get('SELECT julianday("now") - julianday(updatedOn) as daysSince FROM movies WHERE title = ? ', [name]);
  const daysSince = daysSinceResponse ? Math.round(daysSinceResponse.daysSince) : null;
  console.log("  daysSince = ", daysSince);
  db.close();
  if (!forceRecheck && daysSince && daysSince < 3) {
    console.log(`  Skipping ${name} (${year}) as its been updated recently.`);
    counters.skippedCount++;
    return;
  }

  try {
    // STEP 2: Get YesMovies page to get the movie year correctly.
    const yesMoviesData = await parseYesMoviesData(yesUrl);
    if (!yesMoviesData) {
      console.log(`  Skipping ${name} (${year}) as no YesMovies data found.`);
    } else {
      year = yesMoviesData.year;
    }

    // STEP 2: Get all info from OMDB API first.
    const omdbData = await parseOMDBData(name, year);
    if (!omdbData) {
      console.log(`  Skipping ${name} (${year}) as no OMDB data found.`);
      counters.errorCount++;
      return;
    }
    const { releaseDate, genre, imdbID, plot, poster, boxOffice, runtime } = omdbData;


    // STEP 3: Load IMDB to get ratings too.
    const imdbData = await parseIMDBData(name, year, imdbID);
    if (!imdbData) {
      console.log(`  Error ${name} (${year}) has no IMDB data found.`);
    }
    const { rating } = imdbData;


    // TODO skip non movies - short runtimes under an hour.
    // TODO give 0 rating to anything with less than 1k votes, not valuable data.

    // STEP 4: Save to our db now.
    const result = await saveToDB({
      title: name,
      imdbID,
      releaseDate,
      genre,
      rating,
      plot,
      poster,
      yesUrl,
      boxOffice,
      runtime
    });
    if (result === 1) {
      counters.newCount++;
      console.log(`  Adding to new movie count = ${counters.newCount}.`);
    } else {
      counters.updatedCount++;
    }

  } catch (error) {
    // change this color to red in output.
    console.error(`Error looking up movie ${name} (${year}):`, error);
    counters.errorCount++;
    return;
  }
}

/**
 * Parses the YesMovies data to get the movie year.
 * @param {string} yesUrl - The URL of the movie on YesMovies.
 * @returns {Promise<{year: number}>} - The year of the movie.
 */
async function parseYesMoviesData(yesUrl: string) {
  const yesResponse = await readWebpage(yesUrl);
  // console.log("  DEBUG: yesResponse = ", yesResponse);
  // <p> <strong>Release:</strong><a href="https://ww.yesmovies.ag/release/2024.html">2024</a></p>
  const yearMatchTXT = yesResponse.match(/<strong>Release:<\/strong> *?<a href=".*?">(\d+)<\/a>/);
  let year = new Date().getFullYear();
  if (yearMatchTXT) {
    // console.log("  DEBUG: yearMatchTXT[1] = ", yearMatchTXT[1]);
    year = yearMatchTXT ? parseInt(yearMatchTXT[1]) : new Date().getFullYear();
    // console.log("  DEBUG: year found = ", year);
  } else {
    console.log("  ERROR: No year found for this movie.");
  }

  return { year };
}

/**
 * Given a movie name and year, grabs the OMDB data for it.
 * @param {string} name - The name of the movie.
 * @param {number} year - The year of the movie.
 * @returns {Promise<{releaseDate: Date, genre: string, imdbID: string, plot: string, poster: string, boxOffice: number, runtime: number}>} - The OMDB data of the movie.
 */
async function parseOMDBData(name: string, year: number) {
  const apiKey = 'e5a66dda';
  const url = `http://www.omdbapi.com/?t=${encodeURIComponent(name)}&y=${year}&apikey=${apiKey}`;
  let ombResponse = await axios.get(url);
  // TODO year is wrong here, cant default always to 2024....

  if (!ombResponse.data || ombResponse.data.Response !== 'True') {
    console.log("  DEBUG: Second try without year. ")
    // Second try, update year.
    const url = `http://www.omdbapi.com/?t=${encodeURIComponent(name)}&apikey=${apiKey}`;
    ombResponse = await axios.get(url);
    // console.log(`  ombResponse = `, ombResponse.data);
    if (!ombResponse.data || ombResponse.data.Response !== 'True') {
      console.log(`  No OMDB results found for ${name} (${year})`);
      console.log(`  DEBUG: using url = ${url}`);
      return;
    }
  }

  // console.log(`  Found movie ${name} (${year}) data...:`);

  // Grab out values from OMB.
  const releaseDate = new Date(ombResponse.data.Released);
  const genre = ombResponse.data.Genre;
  const imdbID = ombResponse.data.imdbID;
  const plot = ombResponse.data.Plot;
  const poster = ombResponse.data.Poster;
  let boxOffice = 0;
  const boxOfficeTxt = ombResponse.data.BoxOffice?.replace(/[$,]/g, '');
  // console.log(`  DEBUG: boxOfficeTxt = `, boxOfficeTxt);
  if (!boxOfficeTxt || boxOfficeTxt === 'N/A') {
    boxOffice = 0;
  } else {
    boxOffice = parseInt(boxOfficeTxt);
  }
  // console.log(`  DEBUG: data = `, ombResponse.data);
  // console.log(`  DEBUG runtime = `, ombResponse.data.Runtime);
  let runtime = ombResponse.data.Runtime ? parseInt(ombResponse.data.Runtime) : 100;
  if (isNaN(runtime)) {
    runtime = 100;
  }

  // console.log("DEBUG data = ", ombResponse.data);
  console.log(`  OMDB Data: genre: ${genre}, imdbID: ${imdbID}, boxOffice: ${boxOffice}, runtime: ${runtime}`);

  if (!imdbID) {
    console.log(`  Found movie ${name} (${year}):`, ombResponse.data);
    console.log(`  Missing rating or imdbID for ${name} (${year})`);
  }

  return { releaseDate, genre, imdbID, plot, poster, boxOffice, runtime };
}

/**
 * Parses the IMDB data to get the movie rating.
 * @param {string} name - The name of the movie.
 * @param {number} year - The year of the movie.
 * @param {string} imdbID - The IMDB ID of the movie.
 * @returns {Promise<{rating: string}>} - The rating of the movie.
 */
async function parseIMDBData(name: string, year: number, imdbID: string) {
  const imdbUrl = `https://www.imdb.com/title/${imdbID}/`;
  // console.log(`  Loading IMDB URL: ${imdbUrl}`);
  const imdbContent = await readWebpage(imdbUrl);

  // ex: aggregateRating":{"@type":"AggregateRating","ratingCount":83,"bestRating":10,"worstRating":1,"ratingValue":4.6
  // Parse the ratingValue and ratingCount above.
  const ratingsMatch = imdbContent.match(/ratingCount":(\d+),.*?ratingValue":([\d.]+)/);
  let rating = ratingsMatch ? ratingsMatch[2] : '0';
  const ratingVotes = ratingsMatch ? parseInt(ratingsMatch[1]) : 0;
  console.log(`  IMDB Rating: ${rating} from ${ratingVotes} votes`);
  if (rating === '0') {
    console.log(`  Loading IMDB URL: ${imdbUrl}`);
    console.log(`  ERROR: No rating found for ${name} (${year})`);
  }
  if (ratingVotes < 1000) {
    rating = '0';
    console.log(`  Changing ${name} (${year}) rating as it has less than 1k votes.`);
  }

  return { rating };
}

/**
 * Saves the movie information to the database.
 * @param {{title: string, imdbID: string, releaseDate: Date, genre: string, rating: string, plot: string, poster: string, yesUrl: string, boxOffice: number, runtime: number}} movie - The movie information to save.
 * @returns {Promise<number>} - 1 if the movie is new, 0 if the movie is updated.
 */
async function saveToDB(movie: {
  title: string,
  imdbID: string,
  releaseDate: Date,
  genre: string,
  rating: string,
  plot: string,
  poster: string,
  yesUrl: string,
  boxOffice: number,
  runtime: number
}): Promise<number> {
  try {
    const db = await open({
      filename: './src/movies.db',
      driver: sqlite3.Database
    });

    await db.exec(` CREATE TABLE IF NOT EXISTS movies
                    (
                        id
                        INTEGER
                        PRIMARY
                        KEY
                        AUTOINCREMENT,
                        title
                        TEXT,
                        imdbID
                        TEXT
                        UNIQUE,
                        releaseDate
                        TEXT,
                        genre
                        TEXT,
                        rating
                        TEXT,
                        plot
                        TEXT,
                        poster
                        TEXT,
                        yesUrl
                        TEXT,
                        seenStatus
                        TEXT
                        DEFAULT
                        '',
                        boxOffice
                        INTEGER
                        DEFAULT
                        0,
                        runtime
                        INTEGER
                        DEFAULT
                        0,
                        addedOn
                        TEXT
                        DEFAULT
                        CURRENT_DATE,
                        updatedOn
                        TEXT
                        DEFAULT
                        CURRENT_DATE
                    ) `);

    const existingMovie = await db.get('SELECT * FROM movies WHERE title = ? AND imdbID = ?', [movie.title, movie.imdbID]);

    movie.genre = movie.genre.toLowerCase();

    if (existingMovie) {
      await db.run(`
          UPDATE movies
          SET releaseDate = ?,
              genre       = ?,
              rating      = ?,
              plot        = ?,
              poster      = ?,
              yesUrl      = ?,
              boxOffice   = ?,
              runtime     = ?,
              addedOn     = CURRENT_DATE,
              updatedOn   = CURRENT_DATE
          WHERE title = ?
            AND imdbID = ?
      `, [movie.releaseDate.toISOString(), ` ${movie.genre} `, movie.rating, movie.plot, movie.poster, movie.yesUrl, movie.boxOffice, movie.runtime,
        movie.title, movie.imdbID]);
      console.log(`  Updated movie: ${movie.title} (${movie.imdbID})`);
      return 0;
    } else {
      const query = 'INSERT INTO movies (title, imdbID, releaseDate, genre, rating, plot, poster, yesUrl, boxOffice, runtime, addedOn, updatedOn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_DATE, CURRENT_DATE)';
      const formattedQuery = formatQuery(query, [movie.title, movie.imdbID, movie.releaseDate.toISOString(), ` ${movie.genre} `, movie.rating, movie.plot, movie.poster, movie.yesUrl, movie.boxOffice, movie.runtime]);
      console.log("DEBUG: formatted query = " + formattedQuery);

      await db.run(query,
        [movie.title, movie.imdbID, movie.releaseDate.toISOString(), ` ${movie.genre} `, movie.rating, movie.plot, movie.poster, movie.yesUrl, movie.boxOffice, movie.runtime]);
      console.log(`  Inserted new movie: ${movie.title} (${movie.imdbID})`);
      return 1;
    }
    await db.close();

  } catch (error) {
    console.error('Error saving movie to database:', error);
    // rethrow error.
    throw error;
  }
}

function formatQuery(query: string, params: any[]): string {
  return query.replace(/\?/g, () => {
    const param = params.shift();
    return typeof param === 'string' ? `'${param}'` : param;
  });
}

async function main() {
  try {
    // Test a single movie if we get a test param var
    if (process.argv[2]) {
      await lookupMovie("Lee", 2024, "https://ww.yesmovies.ag/movie/lee-1630857643.html", true, counters);
      // await lookupMovie("No More Bets", 2024, "https://ww.yesmovies.ag/movie/no-more-bets-1630857663.html", true, counters);
      // await lookupMovie("His Three Daughters", 2024, "https://ww.yesmovies.ag/movie/his-three-daughters-1630857662.html", true, counters);
      // Force close the script
      process.exit(0);
      return;
    }

    // STEP 1: Parse a random page for a list of yesmovies.
    const page = Math.floor(Math.random() * 5) + 1;
    const url = `https://ww.yesmovies.ag/movie/filter/movies/page/${page}.html`;
    // Check 1 to 5 random pages, 2 daily.
    console.log('Starting to read webpage... ' + url);
    const content = await readWebpage(url);
    const movies = await parseMovies(content);

    await checkMovies(movies);
  } catch (error) {
    console.error('Error reading webpage:', error);
  }

  // Force close the script
  process.exit(0);
}

main();
