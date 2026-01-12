require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json());

/* ===================== ENV CHECK ===================== */
if (!process.env.SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT) {
  throw new Error("Missing Env Variables");
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
  // 1. Clean the incoming roll number (remove spaces)
  const rollToCheck = String(req.params.roll).trim();

  try {
    // 2. Fetch data from Attempts sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: "Attempts!A:B" // Reading Roll and Timestamp
    });

    const rows = response.data.values;
    
    // If empty sheet, allow
    if (!rows || rows.length <= 1) {
      return res.json({ allowed: true });
    }

    const tenHoursInMs = 10 * 60 * 60 * 1000;
    const now = Date.now();

    // 3. Find the last attempt
    // We reverse to find the most recent one first
    const lastAttempt = [...rows].reverse().find(row => {
      // CLEAN DATA FROM SHEET: Remove single quotes (') and spaces
      const sheetRoll = String(row[0]).replace(/'/g, "").trim(); 
      return sheetRoll === rollToCheck;
    });

    if (lastAttempt) {
      // 4. Parse the ISO Date
      const lastTimeStr = lastAttempt[1]; // Column B
      const attemptTime = new Date(lastTimeStr).getTime();

      console.log(`Checking Roll: ${rollToCheck} | Found: ${lastTimeStr} | Diff: ${(now - attemptTime)/1000/60} mins`);

      if (isNaN(attemptTime)) {
        // If date is invalid, assume safe to prevent locking out valid users, 
        // OR block if you want strict security. currently allowing.
        console.error("Invalid Date found in sheet:", lastTimeStr);
        return res.json({ allowed: true }); 
      }
      
      if (now - attemptTime < tenHoursInMs) {
        return res.json({ 
          allowed: false, 
          message: `You have already attempted the quiz. Please try again after 10 hours.` 
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

  // FIX: Use ISO String for safe machine parsing
  const timestamp = new Date().toISOString(); 

  const resultRows = details.map((d, i) => [
    timestamp, name, `'${roll}`, score, i + 1, d.question, d.chosen, d.correct, d.status
  ]);

  // Attempts Sheet: Roll, Timestamp, TimeTaken
  // We add ' before roll to force it as text in sheets
  const attemptRow = [[`'${roll}`, timestamp, timeTaken]];

  try {
    // 1. Save detailed results
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: "Sheet1!A:I",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: resultRows }
    });

    // 2. Save Attempt Log (For the cooldown check)
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: "Attempts!A:C", // Writes to A (Roll), B (Time), C (Duration)
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
