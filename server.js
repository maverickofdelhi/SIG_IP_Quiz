require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json());

/* ===================== ENV CHECK ===================== */
if (!process.env.QUES_SHEET_ID) {
  throw new Error("Missing QUESTIONS_SHEET_ID");
}
if (!process.env.SHEET_ID) {
  throw new Error("Missing RESULTS_SHEET_ID");
}
if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
  throw new Error("Missing GOOGLE_SERVICE_ACCOUNT");
}

/* ===================== GOOGLE AUTH ===================== */
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });

/* ===================== HELPERS ===================== */
const shuffle = arr => arr.sort(() => Math.random() - 0.5);
const correctIndex = l => ({ A: 0, B: 1, C: 2, D: 3 }[l]);

/* ===================== READ FROM QUESTIONS FILE ===================== */
app.post("/generate-quiz", async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.QUES_SHEET_ID,
      range: "ques_sheet!A2:H"
    });

    const rows = response.data.values;

    if (!rows || rows.length < 5) {
      return res.status(500).json({ error: "Not enough questions" });
    }

    const quiz = shuffle(rows)
      .slice(0, 5)
      .map(r => ({
        question: r[2],
        options: [r[3], r[4], r[5], r[6]],
        correct: correctIndex(r[7])
      }));

    res.json(quiz);

  } catch (err) {
    console.error("Question read error:", err);
    res.status(500).json({ error: "Failed to load questions" });
  }
});

/* ===================== WRITE TO RESULTS FILE ===================== */
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
      range: "quiz-res!A:I",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows }
    });

    res.json({ status: "saved" });
  } catch (err) {
    console.error("Result write error:", err);
    res.status(500).json({ error: "Failed to save results" });
  }
});

/* ===================== HEALTH ===================== */
app.get("/hi", (_, res) => res.json({ message: "hi" }));

/* ===================== START ===================== */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
