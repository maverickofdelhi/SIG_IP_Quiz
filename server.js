require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { body, validationResult } = require("express-validator");
const rateLimit = require("express-rate-limit");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 5000;
const COOLDOWN_MS = 10 * 60 * 60 * 1000;
const CACHE_REFRESH_MS = 5 * 60 * 1000;

if (!process.env.DATABASE_URL) {
  throw new Error("Missing required environment variable: DATABASE_URL");
}
if (!process.env.ADMIN_SECRET) {
  throw new Error("Missing required environment variable: ADMIN_SECRET");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});

/* Campus NAT: many students share one IP. Do not use a tight per-IP cap.
   Double-submit is blocked by UNIQUE(roll) on attempts. */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 100_000),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/health",
  message: { error: "Too many requests, please try again later." },
});

app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
}));
app.use(limiter);
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "2mb" }));

let questionCache = [];
let cacheTimer = null;

function letterToIndex(letter) {
  const map = { A: 0, B: 1, C: 2, D: 3 };
  return map[String(letter || "").trim().toUpperCase()] ?? -1;
}

function rowToCachedQuestion(row) {
  const options = [row.option_a, row.option_b, row.option_c, row.option_d].map((o) =>
    o == null ? "" : String(o)
  );
  if (!row.question || options.some((o) => !o.trim())) return null;
  const correctAnswerIdx = letterToIndex(row.correct);
  if (correctAnswerIdx < 0) return null;
  return {
    id: row.id,
    question: row.question,
    options,
    correctAnswerIdx,
  };
}

function normalizeQuestionPayload(item) {
  const question = String(item.question || "").trim();
  const option_a = String(item.option_a ?? item.A ?? "").trim();
  const option_b = String(item.option_b ?? item.B ?? "").trim();
  const option_c = String(item.option_c ?? item.C ?? "").trim();
  const option_d = String(item.option_d ?? item.D ?? "").trim();
  const correct = String(item.correct || "").trim().toUpperCase();

  if (!question || !option_a || !option_b || !option_c || !option_d) {
    return null;
  }
  if (!["A", "B", "C", "D"].includes(correct)) {
    return null;
  }
  return { question, option_a, option_b, option_c, option_d, correct };
}

function requireAdmin(req, res, next) {
  const secret = req.get("X-Admin-Secret");
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function csvEscape(value) {
  const str = value == null ? "" : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const src = String(text || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

function csvRowsToQuestionItems(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const hasHeader = header.includes("question") && header.includes("correct");
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const col = (names, fallback) => {
    for (const name of names) {
      const i = header.indexOf(name);
      if (hasHeader && i >= 0) return i;
    }
    return fallback;
  };

  const qi = col(["question"], 0);
  const ai = col(["a", "option_a"], 1);
  const bi = col(["b", "option_b"], 2);
  const ci = col(["c", "option_c"], 3);
  const di = col(["d", "option_d"], 4);
  const ki = col(["correct"], 5);

  return dataRows.map((r) => ({
    question: r[qi],
    A: r[ai],
    B: r[bi],
    C: r[ci],
    D: r[di],
    correct: r[ki],
  }));
}

function parseAdminQuestionBody(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.questions)) return body.questions;
  if (typeof body === "string") return csvRowsToQuestionItems(body);
  return null;
}

async function applySchema() {
  const schemaPath = path.join(__dirname, "db", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(sql);
}

async function seedQuestionsIfEmpty() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM questions");
  if (rows[0].n > 0) return;

  const seedPath = path.join(__dirname, "questions.json");
  if (!fs.existsSync(seedPath)) return;

  const raw = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  if (!Array.isArray(raw) || raw.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const item of raw) {
      const q = normalizeQuestionPayload(item);
      if (!q) continue;
      await client.query(
        `INSERT INTO questions (question, option_a, option_b, option_c, option_d, correct, active)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
        [q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.correct]
      );
    }
    await client.query("COMMIT");
    console.log("Seeded questions from questions.json (table was empty).");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function refreshQuestionCache() {
  const { rows } = await pool.query(
    `SELECT id, question, option_a, option_b, option_c, option_d, correct
     FROM questions
     WHERE active = TRUE
     ORDER BY id`
  );
  questionCache = rows.map(rowToCachedQuestion).filter(Boolean);
  console.log(`Question cache loaded: ${questionCache.length} active questions.`);
}

async function checkCooldown(roll) {
  const { rows } = await pool.query(
    "SELECT submitted_at FROM attempts WHERE roll = $1 LIMIT 1",
    [roll]
  );
  if (rows.length === 0) return true;
  const submittedAt = new Date(rows[0].submitted_at).getTime();
  return Date.now() - submittedAt >= COOLDOWN_MS;
}

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      questionsCached: questionCache.length,
    });
  } catch (err) {
    console.error(err);
    res.status(503).json({ ok: false, error: "Database unavailable" });
  }
});

app.get("/check-roll/:roll", async (req, res) => {
  try {
    const roll = String(req.params.roll || "").trim();
    if (!roll) {
      return res.status(400).json({ allowed: false, message: "Roll is required." });
    }
    const allowed = await checkCooldown(roll);
    if (!allowed) {
      return res.json({
        allowed: false,
        message: "Cooldown active. Try again later.",
      });
    }
    res.json({ allowed: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ allowed: false, error: "Check failed" });
  }
});

app.get("/generate-quiz", (_req, res) => {
  try {
    if (questionCache.length === 0) {
      return res.status(503).json({ error: "No questions available" });
    }
    const shuffled = [...questionCache];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const picked = shuffled.slice(0, Math.min(10, shuffled.length));
    const clientQuiz = picked.map((q) => ({
      id: q.id,
      question: q.question,
      options: q.options,
    }));
    res.json(clientQuiz);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate quiz" });
  }
});

app.post(
  "/submit-quiz",
  [
    body("name").trim(),
    body("roll").trim().notEmpty(),
    body("answers").isArray(),
    body("timeTaken").isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, roll, answers, timeTaken } = req.body;
    const safeRoll = String(roll).trim();
    const safeName = String(name || "").trim();
    const safeTime = String(timeTaken || "").trim();

    const allowed = await checkCooldown(safeRoll);
    if (!allowed) {
      return res.status(403).json({ error: "Cooldown active. Submission rejected." });
    }

    let score = 0;
    const detailsLog = [];
    const byId = new Map(questionCache.map((q) => [q.id, q]));

    answers.forEach((ans) => {
      if (!ans || ans.id == null) return;
      const originalQ = byId.get(ans.id);
      if (!originalQ) return;

      const selected = Number(ans.selected);
      const isCorrect = selected === originalQ.correctAnswerIdx;
      if (isCorrect) score++;

      detailsLog.push({
        q: originalQ.question,
        chosen: originalQ.options[selected] || "Skipped",
        correct: originalQ.options[originalQ.correctAnswerIdx],
        status: isCorrect ? "CORRECT" : "WRONG",
      });
    });

    const total = answers.length;
    const payload = {
      submitted: answers,
      details: detailsLog,
    };

    try {
      const existing = await pool.query(
        "SELECT submitted_at FROM attempts WHERE roll = $1 LIMIT 1",
        [safeRoll]
      );

      if (existing.rows.length > 0) {
        const submittedAt = new Date(existing.rows[0].submitted_at).getTime();
        if (Date.now() - submittedAt < COOLDOWN_MS) {
          return res.status(403).json({ error: "Cooldown active. Submission rejected." });
        }

        await pool.query(
          `UPDATE attempts
           SET name = $2, score = $3, total = $4, time_taken = $5, answers = $6::jsonb, submitted_at = NOW()
           WHERE roll = $1`,
          [safeRoll, safeName, score, total, safeTime, JSON.stringify(payload)]
        );
      } else {
        await pool.query(
          `INSERT INTO attempts (roll, name, score, total, time_taken, answers)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [safeRoll, safeName, score, total, safeTime, JSON.stringify(payload)]
        );
      }

      res.json({ success: true });
    } catch (err) {
      if (err && err.code === "23505") {
        return res.status(403).json({ error: "Already submitted or cooldown active." });
      }
      console.error(err);
      res.status(500).json({ error: "Save failed" });
    }
  }
);

app.post("/admin/questions", requireAdmin, async (req, res) => {
  const incoming = parseAdminQuestionBody(req.body);
  if (!incoming || incoming.length === 0) {
    return res.status(400).json({
      error: "Expected a non-empty JSON array of questions, or a CSV body (question,A,B,C,D,correct).",
    });
  }

  const normalized = [];
  for (let i = 0; i < incoming.length; i++) {
    const q = normalizeQuestionPayload(incoming[i]);
    if (!q) {
      return res.status(400).json({
        error: `Invalid question at index ${i}. Need question, A/B/C/D (or option_a-d), and correct A|B|C|D.`,
      });
    }
    normalized.push(q);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE questions SET active = FALSE, updated_at = NOW() WHERE active = TRUE"
    );
    for (const q of normalized) {
      await client.query(
        `INSERT INTO questions (question, option_a, option_b, option_c, option_d, correct, active, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())`,
        [q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.correct]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    return res.status(500).json({ error: "Failed to replace question bank." });
  } finally {
    client.release();
  }

  try {
    await refreshQuestionCache();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Questions saved but cache refresh failed." });
  }

  res.json({ success: true, active: questionCache.length });
});

app.get("/admin/results.csv", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT roll, name, score, total, time_taken, submitted_at, answers
       FROM attempts
       ORDER BY submitted_at ASC`
    );

    const header = ["roll", "name", "score", "total", "time_taken", "submitted_at", "answers"];
    const lines = [header.join(",")];
    for (const row of rows) {
      lines.push(
        [
          csvEscape(row.roll),
          csvEscape(row.name),
          csvEscape(row.score),
          csvEscape(row.total),
          csvEscape(row.time_taken),
          csvEscape(row.submitted_at ? new Date(row.submitted_at).toISOString() : ""),
          csvEscape(JSON.stringify(row.answers)),
        ].join(",")
      );
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=quiz-results.csv");
    res.send(lines.join("\n"));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Export failed" });
  }
});

async function boot() {
  await applySchema();
  await seedQuestionsIfEmpty();
  await refreshQuestionCache();
  cacheTimer = setInterval(() => {
    refreshQuestionCache().catch((err) => console.error("Cache refresh failed:", err));
  }, CACHE_REFRESH_MS);
  if (cacheTimer.unref) cacheTimer.unref();

  app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
  });
}

boot().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
