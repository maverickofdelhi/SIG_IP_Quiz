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

/* ===================== CHECK IF ROLL NUMBER ATTEMPTED ===================== */
app.post("/check-attempt", async (req, res) => {
  const { roll } = req.body;

  if (!roll) {
    return res.status(400).json({ error: "Roll number required" });
  }

  try {
    // Fetch all attempts from Attempts sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: "Attempts!A:C" // Columns: Roll, Timestamp, ExpiryTime
    });

    const rows = response.data.values || [];
    
    // Skip header row and check for this roll number
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row[0] === roll) {
        const expiryTime = new Date(row[2]);
        const now = new Date();

        // If attempt is still within 10 hours
        if (now < expiryTime) {
          const hoursLeft = Math.ceil((expiryTime - now) / (1000 * 60 * 60));
          return res.json({ 
            canAttempt: false, 
            message: `You have already attempted this quiz. Please try again after ${hoursLeft} hour(s).`,
            expiryTime: expiryTime.toLocaleString()
          });
        }
      }
    }

    // No active attempt found
    res.json({ canAttempt: true });
  } catch (err) {
    console.error("Check attempt error:", err);
    res.status(500).json({ error: "Failed to check attempt status" });
  }
});

/* ===================== RECORD QUIZ ATTEMPT ===================== */
app.post("/record-attempt", async (req, res) => {
  const { roll } = req.body;

  if (!roll) {
    return res.status(400).json({ error: "Roll number required" });
  }

  try {
    const now = new Date();
    const expiry = new Date(now.getTime() + (10 * 60 * 60 * 1000)); // 10 hours from now

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: "Attempts!A:C",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          roll,
          now.toLocaleString(),
          expiry.toISOString()
        ]]
      }
    });

    res.json({ status: "recorded" });
  } catch (err) {
    console.error("Record attempt error:", err);
    res.status(500).json({ error: "Failed to record attempt" });
  }
});

/* ===================== GENERATE QUIZ FROM SHEET ===================== */
app.post("/generate-quiz", async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.QUES_SHEET_ID,
      range: "Sheet1!A2:H" // skip header row
    });

    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      return res.status(500).json({ error: "No questions found" });
    }

    // Pick random 10 questions
    const selected = shuffleArray(rows).slice(0, 10);

    const quiz = selected.map(row => ({
      question: row[2],
      options: [row[3], row[4], row[5], row[6]],
      correct: correctIndex(row[7])
    }));

    res.json(quiz);

  } catch (err) {
    console.error("Quiz fetch error:", err);
    res.status(500).json({ error: "Failed to load quiz" });
  }
});

/* ===================== SAVE RESULTS ===================== */
app.post("/save", async (req, res) => {
  const { name, roll, score, details } = req.body;

  if (!name || !roll || !score || !Array.isArray(details)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const timestamp = new Date().toLocaleString();

  const rows = details.map((d, i) => [
    timestamp,
    name,
    roll,
    score,
    i + 1,
    d.question,
    d.chosen,
    d.correct,
    d.status
  ]);

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SHEET_ID,
      range: "Sheet1!A:I",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows }
    });

    res.json({ status: "saved" });
  } catch (err) {
    console.error("Sheet save error:", err);
    res.status(500).json({ error: "Sheet save failed" });
  }
});

/* ===================== HEALTH CHECK ===================== */
app.get("/hi", (req, res) => {
  res.json({ message: "hi" });
});

/* ===================== START ===================== */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
