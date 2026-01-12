require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const rateLimit = require("express-rate-limit"); // NEW

const app = express();
app.use(cors());
app.use(express.json());

/* ===================== SECURITY: RATE LIMITING ===================== */
// Prevents one person from spamming the server
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  message: { error: "Too many requests, please try again later." }
});

// Strict limit for quiz starting/saving (5 times per minute)
const quizLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  message: { error: "Slow down! Too many quiz attempts detected." }
});

app.use("/generate-quiz", quizLimiter);
app.use("/save", quizLimiter);
app.use(globalLimiter);

/* ===================== SIMPLE MEMORY CACHE ===================== */
// Stores the "Attempts" sheet in memory for 2 minutes 
// so we don't hit Google's API limit every time a roll is checked.
let attemptsCache = null;
let lastCacheUpdate = 0;

async function getAttempts() {
  const now = Date.now();
  if (attemptsCache && (now - lastCacheUpdate < 120000)) { // 2 minutes
    return attemptsCache;
  }

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Attempts!A:B"
  });
  
  attemptsCache = response.data.values || [];
  lastCacheUpdate = now;
  return attemptsCache;
}

/* ===================== GOOGLE SHEETS SETUP ===================== */
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

/* ===================== CHECK ROLL (WITH CACHE) ===================== */
app.get("/check-roll/:roll", async (req, res) => {
  const { roll } = req.params;
  try {
    const rows = await getAttempts(); // Uses Cache
    if (rows.length <= 1) return res.json({ allowed: true });

    const tenHoursInMs = 10 * 60 * 60 * 1000;
    const now = Date.now();

    const lastAttempt = [...rows].reverse().find(row => row[0] === roll);

    if (lastAttempt && lastAttempt[1]) {
      const attemptTime = new Date(lastAttempt[1]).getTime();
      if (now - attemptTime < tenHoursInMs) {
        return res.json({ 
          allowed: false, 
          message: "You have already attempted the quiz. Please try again after 10 hours." 
        });
      }
    }
    res.json({ allowed: true });
  } catch (err) {
    res.status(500).json({ error: "Validation failed" });
  }
});

/* ===================== GENERATE QUIZ ===================== */
app.post("/generate-quiz", async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.QUES_SHEET_ID,
      range: "Sheet1!A2:H" 
    });
    const rows = response.data.values;
    if (!rows || rows.length === 0) return res.status(500).json({ error: "No questions found" });

    const selected = shuffleArray(rows).slice(0, 10);
    const quiz = selected.map(row => ({
      question: row[2],
      options: [row[3], row[4], row[5], row[6]],
      correct: correctIndex(row[7])
    }));
    res.json(quiz);
  } catch (err) {
    res.status(500).json({ error: "Failed to load quiz" });
  }
});

/* ===================== SAVE RESULTS ===================== */
app.post("/save", async (req, res) => {
  const { name, roll, score, details, timeTaken } = req.body;
  if (!name || !roll || !score || !Array.isArray(details)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const timestamp = new Date().toLocaleString();
  const resultRows = details.map((d, i) => [
    timestamp, name, roll, score, i + 1, d.question, d.chosen, d.correct, d.status
  ]);
  const attemptRow = [[roll, timestamp, timeTaken]];

  try {
    // Clear cache so the next check-roll is accurate
    attemptsCache = null; 

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
    res.status(500).json({ error: "Sheet save failed" });
  }
});

app.get("/hi", (req, res) => res.json({ message: "hi" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
