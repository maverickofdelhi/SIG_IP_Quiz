require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const { body, validationResult } = require("express-validator"); // Security: Validator

const app = express();
app.use(cors());
app.use(express.json());

/* ===================== ENV CHECK ===================== */
if (!process.env.SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT || !process.env.API_SECRET_KEY) {
  throw new Error("Missing required Environment Variables");
}

/* ===================== SECURITY MIDDLEWARE ===================== */
const validateSecret = (req, res, next) => {
  const clientSecret = req.headers["x-quiz-secret"];
  if (clientSecret !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: "Unauthorized access" });
  }
  next();
};

/* ===================== GOOGLE SHEETS ===================== */
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const sheets = google.sheets({ version: "v4", auth });

/* ===================== UTILS ===================== */
function shuffleArray(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

function correctIndex(letter) {
  return { A: 0, B: 1, C: 2, D: 3 }[letter];
}

/* ===================== ENDPOINTS ===================== */

// Check previous attempts
app.get("/check-roll/:roll", validateSecret, async (req, res) => {
  const { roll } = req.params;
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: "Attempts!A:B"
    });
    const rows = response.data.values || [];
    const tenHoursAgo = Date.now() - (10 * 60 * 60 * 1000);
    const lastAttempt = [...rows].reverse().find(row => row[0] === roll);

    if (lastAttempt && new Date(lastAttempt[1]).getTime() > tenHoursAgo) {
      return res.json({ allowed: false, message: "Already attempted within 10 hours." });
    }
    res.json({ allowed: true });
  } catch (err) {
    res.status(500).json({ error: "Check failed" });
  }
});

// Generate Quiz
app.post("/generate-quiz", validateSecret, async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.QUES_SHEET_ID,
      range: "Sheet1!A2:H"
    });
    const selected = shuffleArray(response.data.values).slice(0, 10);
    const quiz = selected.map(row => ({
      question: row[2],
      options: [row[3], row[4], row[5], row[6]],
      correct: correctIndex(row[7])
    }));
    res.json(quiz);
  } catch (err) {
    res.status(500).json({ error: "Fetch failed" });
  }
});

// Secure Save with Body Validation
app.post("/save", 
  validateSecret, 
  [
    body('name').trim().notEmpty().isLength({ max: 50 }).escape(),
    body('roll').trim().notEmpty().isAlphanumeric().isLength({ max: 20 }),
    body('score').notEmpty().isString(),
    body('details').isArray({ min: 1 })
  ], 
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, roll, score, details, timeTaken } = req.body;
    const timestamp = new Date().toLocaleString();
    const resultRows = details.map((d, i) => [
      timestamp, name, roll, score, i + 1, d.question, d.chosen, d.correct, d.status
    ]);
    const attemptRow = [[roll, timestamp, timeTaken]];

    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SHEET_ID,
        range: "Sheet1!A:I",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: resultRows }
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SHEET_ID,
        range: "Attempts!A:C",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: attemptRow }
      });
      res.json({ status: "saved" });
    } catch (err) {
      res.status(500).json({ error: "Save failed" });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Secure Server running on ${PORT}`));
