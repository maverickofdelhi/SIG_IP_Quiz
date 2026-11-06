# SIP-IP Quiz

Timed quiz application for SIP-IP.

## Run locally

1. Install Node.js 18 or newer.
2. Create a PostgreSQL database and copy `.env.example` to `.env`.
3. Set `DATABASE_URL` and replace `ADMIN_SECRET` with a long random value.
4. Run `npm ci`.
5. Run `npm start`, then open `http://localhost:5000`.

The server applies `db/schema.sql`, seeds an empty database from `questions.json`,
and serves the quiz page and its assets. The answer key is not served as a public
static directory.
