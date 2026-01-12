require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const { body, validationResult } = require("express-validator");
const rateLimit = require("express-rate-limit"); // FIXED: Imported rate limiter

const app = express();

/* ===================== SECURITY: CORS ===================== */
// strict origin check: Replace with your actual frontend URL when deploying
app.use(cors({
  origin: "*", // Keep this as is for now per your request
  methods: ["GET", "POST"]
}));

/* ===================== SECURITY: RATE LIMITING ===================== */
// FIXED: Applied Rate Limiter to stop DoS attacks
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: "Too many requests, please try again later." }
});
app.use(limiter);

app.use(express.json());

/* ===================== ENV CHECK ===================== */
if (!process.env.SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT || !process.env.QUES_SHEET_ID) {
  throw new Error("Missing required Environment Variables");
}

/* ===================== GOOGLE SHEETS SETUP ===================== */
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const sheets = google.sheets({ version: "v4", auth });

/* ===================== HELPERS ===================== */
// Convert Sheet Letter (A,B,C,D) to Index (0,1,2,3)
function correctIndex(letter) {
  const map = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };
  return map[letter.toUpperCase()] !== undefined ? map[letter.toUpperCase()] : -1;
}

// FIXED: Sanitization Helper to prevent Formula Injection
function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  // If input starts with =, +, -, or @, prepend a single quote to treat it as text
  const dangerousPrefixes = ['=', '+', '-', '@'];
  if (dangerousPrefixes.some(prefix => input.trim().startsWith(prefix))) {
    return `'${input}`;
  }
  return input;
}

// Cache helper to avoid hitting Google API too often
let cachedQuestions = [];
let lastCacheTime = 0;

async function getMasterQuestions() {
  const now = Date.now();
  // Refresh cache every 10 minutes
  if (cachedQuestions.length > 0 && (now - lastCacheTime < 10 * 60 * 1000)) {
    return cachedQuestions;
  }

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.QUES_SHEET_ID,
    range: "Sheet1!A2:H"
  });
  
  const rows = response.data.values || [];
  
  // Store full data including correct answer (Column H is index 7)
  // We add an 'id' based on original row index to track it
  cachedQuestions = rows.map((row, index) => ({
    id: index, // unique ID based on row position
    question: row[2],
    options: [row[3], row[4], row[5], row[6]],
    correctAnswerIdx: correctIndex(row[7]) 
  }));
  
  lastCacheTime = now;
  return cachedQuestions;
}

async function checkCooldown(roll) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Attempts!A:B"
  });
  const rows = response.data.values || [];
  const tenHoursAgo = Date.now() - (10 * 60 * 60 * 1000);
  
  // Find most recent attempt by this roll
  const lastAttempt = [...rows].reverse().find(row => row[0] === roll);
  
  if (lastAttempt && new Date(lastAttempt[1]).getTime() > tenHoursAgo) {
    return false; // Not allowed
  }
  return true; // Allowed
}

/* ===================== ENDPOINTS ===================== */

// 1. Initial Check (User Experience only - Real security is in /submit)
app.get("/check-roll/:roll", async (req, res) => {
  try {
    const allowed = await checkCooldown(req.params.roll);
    if (!allowed) {
      return res.json({ allowed: false, message: "Cooldown active. Try again later." });
    }
    res.json({ allowed: true });
  } catch (err) {
    res.status(500).json({ error: "Check failed" });
  }
});

// 2. Generate Quiz (Send Questions WITHOUT Answers)
app.get("/generate-quiz", async (req, res) => {
  try {
    const allQuestions = await getMasterQuestions();
    
    // Shuffle and pick 10
    const shuffled = [...allQuestions].sort(() => 0.5 - Math.random()).slice(0, 10);

    // Sanitize: Remove 'correctAnswerIdx' before sending to frontend
    const clientQuiz = shuffled.map(q => ({
      id: q.id, // Keep ID so we can grade it later
      question: q.question,
      options: q.options
    }));

    res.json(clientQuiz);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate quiz" });
  }
});

// 3. Submit & Grade (The Secure Core)
app.post("/submit-quiz", 
  [
    body('name').trim().escape(),
    body('roll').trim().notEmpty(),
    body('answers').isArray(), // Expecting [{id: 1, selected: 0}, ...]
    body('timeTaken').isString()
  ],
  async (req, res) => {
    
    // Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, roll, answers, timeTaken } = req.body;
    const timestamp = new Date().toLocaleString();

    // 1. SECURITY: Re-Check Cooldown
    const isAllowed = await checkCooldown(roll);
    if (!isAllowed) {
      return res.status(403).json({ error: "Cooldown active. Submission rejected." });
    }

    // 2. LOGIC: Calculate Score Server-Side
    const masterQuestions = await getMasterQuestions();
    let score = 0;
    const detailsLog = [];

    answers.forEach(ans => {
      // Find the original question by ID
      const originalQ = masterQuestions.find(mq => mq.id === ans.id);
      
      if (originalQ) {
        const isCorrect = (ans.selected === originalQ.correctAnswerIdx);
        if (isCorrect) score++;

        detailsLog.push({
          q: originalQ.question,
          chosen: originalQ.options[ans.selected] || "Skipped",
          correct: originalQ.options[originalQ.correctAnswerIdx],
          status: isCorrect ? "CORRECT" : "WRONG"
        });
      }
    });

    const finalScore = `${score}/${answers.length}`;

    // 3. STORAGE: Save to Sheets
    
    // FIXED: Sanitize inputs before saving to prevent Formula Injection
    const safeName = sanitizeInput(name);
    const safeRoll = sanitizeInput(roll);
    const safeTime = sanitizeInput(timeTaken);

    // Prepare Rows (Using SAFE variables)
    const resultRows = detailsLog.map((d, i) => [
      timestamp, safeName, safeRoll, finalScore, i + 1, d.q, d.chosen, d.correct, d.status
    ]);
    const attemptRow = [[safeRoll, timestamp, safeTime, finalScore]];

    try {
      // Save Detailed Logs
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SHEET_ID,
        range: "Sheet1!A:I",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: resultRows }
      });
      // Save Attempt Metadata
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SHEET_ID,
        range: "Attempts!A:D",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: attemptRow }
      });

      // Return score to user
      res.json({ success: true, score: finalScore });

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Save failed" });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
