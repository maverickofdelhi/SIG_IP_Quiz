require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const { body, validationResult } = require("express-validator");
const rateLimit = require("express-rate-limit"); 

const app = express();

/* ===================== SECURITY: CORS ===================== */
// strict origin check: Replace with your actual frontend URL when deploying
app.use(cors({
  origin: "*", 
  methods: ["GET", "POST"]
}));

/* ===================== SECURITY: RATE LIMITING ===================== */
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
function correctIndex(letter) {
  const map = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };
  return map[letter.toUpperCase()] !== undefined ? map[letter.toUpperCase()] : -1;
}

function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
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
  
  cachedQuestions = rows.map((row, index) => ({
    id: index, 
    question: row[2],
    options: [row[3], row[4], row[5], row[6]],
    correctAnswerIdx: correctIndex(row[7]) 
  }));
  
  lastCacheTime = now;
  return cachedQuestions;
}

/* ===================== NEW: MEMORY CACHE SYSTEM (DDoS Protection) ===================== */
let attemptsCache = new Map(); // Stores "Roll Number" -> "Last Attempt Time"
let isCacheLoaded = false;

// Load data from Sheet into RAM once on startup
async function loadAttemptsCache() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: "Attempts!A:B" // Column A=Roll, B=Timestamp
    });
    
    const rows = response.data.values || [];
    attemptsCache.clear(); 
    
    // Populate Map (Key: Roll, Value: Timestamp)
    rows.forEach(row => {
      if (row[0]) { 
        attemptsCache.set(row[0].trim(), new Date(row[1]).getTime());
      }
    });

    isCacheLoaded = true;
    console.log(`✅ Cache Loaded: ${attemptsCache.size} past attempts found.`);
  } catch (err) {
    console.error("❌ Failed to load attempts cache:", err);
  }
}

// New Check Function: Uses RAM instead of Google API
async function checkCooldown(roll) {
  // Failsafe: If cache isn't ready, load it
  if (!isCacheLoaded) await loadAttemptsCache();

  const lastAttemptTime = attemptsCache.get(roll);
  if (!lastAttemptTime) return true; // No record = Allowed

  const tenHoursAgo = Date.now() - (10 * 60 * 60 * 1000);
  
  // If last attempt was recent (< 10 hours), BLOCK THEM
  if (lastAttemptTime > tenHoursAgo) {
    return false; 
  }
  return true; 
}

/* ===================== ENDPOINTS ===================== */

// 1. Initial Check
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

// 2. Generate Quiz
app.get("/generate-quiz", async (req, res) => {
  try {
    const allQuestions = await getMasterQuestions();
    
    const shuffled = [...allQuestions].sort(() => 0.5 - Math.random()).slice(0, 10);

    const clientQuiz = shuffled.map(q => ({
      id: q.id, 
      question: q.question,
      options: q.options
    }));

    res.json(clientQuiz);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate quiz" });
  }
});

// 3. Submit & Grade
app.post("/submit-quiz", 
  [
    body('name').trim().escape(),
    body('roll').trim().notEmpty(),
    body('answers').isArray(), 
    body('timeTaken').isString()
  ],
  async (req, res) => {
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, roll, answers, timeTaken } = req.body;
    const timestamp = new Date().toLocaleString();

    // 1. SECURITY: Re-Check Cooldown (Using RAM Cache)
    const isAllowed = await checkCooldown(roll);
    if (!isAllowed) {
      return res.status(403).json({ error: "Cooldown active. Submission rejected." });
    }

    // 2. LOGIC: Calculate Score
    const masterQuestions = await getMasterQuestions();
    let score = 0;
    const detailsLog = [];

    answers.forEach(ans => {
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

    // 3. STORAGE
    const safeName = sanitizeInput(name);
    const safeRoll = sanitizeInput(roll);
    const safeTime = sanitizeInput(timeTaken);

    const resultRows = detailsLog.map((d, i) => [
      timestamp, safeName, safeRoll, finalScore, i + 1, d.q, d.chosen, d.correct, d.status
    ]);
    const attemptRow = [[safeRoll, timestamp, safeTime, finalScore]];

    // === NEW: UPDATE CACHE IMMEDIATELY ===
    // This prevents double-submission instantly
    attemptsCache.set(safeRoll, Date.now());
    // =====================================

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

      res.json({ success: true, score: finalScore });

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Save failed" });
    }
});

const PORT = process.env.PORT || 5000;
// FIXED: Load cache when server starts
app.listen(PORT, async () => {
  console.log(`Server running on ${PORT}`);
  await loadAttemptsCache(); 
});
