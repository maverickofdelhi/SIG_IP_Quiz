require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json());

/* ===================== ENV CHECK ===================== */
if (!process.env.GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY");
}
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

/* ===================== GENERATE QUIZ ===================== */
app.post("/generate-quiz", async (req, res) => {
  const prompt = `
You are a JSON generator.
Return ONLY valid JSON.
No markdown.
No explanation.

Format:
[
  {
    "question": "text",
    "options": ["a", "b", "c", "d"],
    "correct": 0
  }
]

Create a 5-question finance quiz make the question diverse from corporate finance, risk management, derivatives, current affairs related to finance also some basic financial maths questions.
`;

  try {
    const geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      },
      {
        params: { key: process.env.GEMINI_API_KEY },
        headers: { "Content-Type": "application/json" },
        timeout: 20000
      }
    );

    const rawText =
      geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      console.error("Empty Gemini response:", geminiRes.data);
      return res.status(500).json({ error: "Empty Gemini response" });
    }

    let quiz;
    try {
      quiz = JSON.parse(rawText);
    } catch (e) {
      console.error("Invalid JSON from Gemini:", rawText);
      return res.status(500).json({ error: "Invalid quiz JSON" });
    }

    res.json(quiz);

  } catch (err) {
    console.error(
      "Generate quiz error:",
      err.response?.data || err.message
    );
    res.status(500).json({ error: "Quiz generation failed" });
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
    console.error("Sheet error:", err);
    res.status(500).json({ error: "Sheet error" });
  }
});

app.get("/hi", (req, res) => {
    res.status(200).json({message: "hi"});
})

/* ===================== START ===================== */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});


