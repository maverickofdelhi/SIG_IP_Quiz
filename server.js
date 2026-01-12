require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json());

/* ===================== ENV CHECK ===================== */
if (!process.env.SHEET_ID) {
  throw new Error("Missing SHEET_ID");
}
if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
  throw new Error("Missing GOOGLE_SERVICE_ACCOUNT");
}

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

/* ===================== CHECK PREVIOUS ATTEMPTS ===================== */
app.get("/check-roll/:roll", async (req, res) => {
  const rollToCheck = String(req.params.roll).trim(); // Force string

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: "Attempts!A:B" 
    });

    const rows = response.data.values;
    if (!rows || rows.length <= 1) {
      return res.json({ allowed: true });
    }

    const tenHoursInMs = 10 * 60 * 60 * 1000;
    const now = Date.now();

    // Fix: Compare as Strings to handle leading zeros
    const lastAttempt = [...rows].reverse().find(row => String(row[0]).trim() === rollToCheck);

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
    console.error("Check roll error:", err);
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

  // Full results for Sheet1
  const resultRows = details.map((d, i) => [
    timestamp, name, `'${roll}`, score, i + 1, d.question, d.chosen, d.correct, d.status
  ]);

  // Entry for Attempts sheet: Roll (A), Timestamp (B), Time Taken (C)
  // We use '${roll} to force Google Sheets to treat it as Text (preserving leading zeros)
  const attemptRow = [[`'${roll}`, timestamp, timeTaken]];

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
    console.error("Sheet save error:", err);
    res.status(500).json({ error: "Sheet save failed" });
  }
});

/* ===================== START ===================== */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
