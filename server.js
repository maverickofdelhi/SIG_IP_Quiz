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
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const CACHE_REFRESH_MS = 5 * 60 * 1000;
const QUESTION_SECONDS = 120;
const QUIZ_SIZE = 10;
const ALREADY_ATTEMPTED =
  "This roll number has already attempted the quiz. You can try again after 24 hours.";
const ROLL_TWO_DIGIT_PREFIXES = ["20", "19", "34", "35"];
const ROLL_ONE_DIGIT_PREFIXES = { 6: "06", 7: "07", 8: "08", 9: "09" };
const ROLL_CANONICAL_SQL = `regexp_replace(regexp_replace(COALESCE(roll, ''), '[^0-9]', '', 'g'), '^0+', '')`;

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
   Double-submit is blocked by unique roll (084076 and 84076 count as the same). */
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

function normalizeRoll(raw) {
  const digits = String(raw || "").trim().replace(/\D/g, "");
  if (!digits) {
    return { error: "Enter a valid roll number." };
  }

  const stripped = digits.replace(/^0+/, "");
  if (!stripped) {
    return { error: "Enter a valid roll number." };
  }

  let prefix = null;
  let body = null;

  for (const p of ROLL_TWO_DIGIT_PREFIXES) {
    if (stripped.startsWith(p)) {
      prefix = p;
      body = stripped.slice(p.length);
      break;
    }
  }

  if (!prefix) {
    const mapped = ROLL_ONE_DIGIT_PREFIXES[stripped[0]];
    if (mapped) {
      prefix = mapped;
      body = stripped.slice(1);
    }
  }

  if (!prefix || !body) {
    return {
      error: "Roll number must start with 06, 07, 08, 09, 19, 20, 34, or 35.",
    };
  }

  return { roll: prefix + body, digits: stripped };
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

async function findAttemptsByRoll(normalized) {
  const { rows } = await pool.query(
    `SELECT id, roll, name, score, total, time_taken, submitted_at, answers,
            status, started_at, deadline_at, question_ids, progress
     FROM attempts
     WHERE ${ROLL_CANONICAL_SQL} = $1
     ORDER BY submitted_at DESC`,
    [normalized.digits]
  );
  return rows;
}

function parseQuestionIds(raw) {
  if (Array.isArray(raw)) return raw.map((id) => Number(id)).filter((id) => Number.isFinite(id));
  if (typeof raw === "string") {
    try {
      return parseQuestionIds(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

function parseProgress(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ...raw };
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      return { currentIdx: 0, answers: [] };
    }
  }
  return { currentIdx: 0, answers: [] };
}

function pickQuestionIds() {
  const shuffled = [...questionCache];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(QUIZ_SIZE, shuffled.length)).map((q) => q.id);
}

function clientQuestionsForIds(ids) {
  const byId = new Map(questionCache.map((q) => [q.id, q]));
  return ids
    .map((id) => {
      const q = byId.get(id);
      if (!q) return null;
      return { id: q.id, question: q.question, options: q.options };
    })
    .filter(Boolean);
}

function mergeLockedAnswers(existingAnswers, incoming, questionIds) {
  const merged = questionIds.map((_id, idx) => {
    const prev = Array.isArray(existingAnswers) ? existingAnswers[idx] : null;
    if (prev && prev.id != null) return { id: Number(prev.id), selected: Number(prev.selected) };
    return null;
  });

  const incomingList = Array.isArray(incoming) ? incoming : [];
  incomingList.forEach((ans) => {
    if (!ans || ans.id == null) return;
    const slot = questionIds.findIndex((id) => Number(id) === Number(ans.id));
    if (slot < 0 || merged[slot]) return;
    merged[slot] = { id: Number(questionIds[slot]), selected: Number(ans.selected) };
  });
  return merged;
}

function applyAwayTime(progress, questionIds, deadlineAt) {
  const now = Date.now();
  const deadline = deadlineAt ? new Date(deadlineAt).getTime() : now;
  const quizSecondsLeft = Math.max(0, Math.floor((deadline - now) / 1000));
  let currentIdx = Math.max(0, Number(progress.currentIdx) || 0);
  const answers = Array.isArray(progress.answers) ? progress.answers.slice() : [];
  let questionStartedAt = progress.questionStartedAt
    ? new Date(progress.questionStartedAt).getTime()
    : now;

  if (!Number.isFinite(questionStartedAt)) questionStartedAt = now;

  while (currentIdx < questionIds.length && now - questionStartedAt >= QUESTION_SECONDS * 1000) {
    if (!answers[currentIdx] || answers[currentIdx].id == null) {
      answers[currentIdx] = { id: questionIds[currentIdx], selected: -1 };
    }
    currentIdx += 1;
    questionStartedAt += QUESTION_SECONDS * 1000;
  }

  if (currentIdx > questionIds.length) currentIdx = questionIds.length;
  if (questionStartedAt > now) questionStartedAt = now;

  const elapsedOnQuestion = Math.max(0, Math.floor((now - questionStartedAt) / 1000));
  let questionSecondsLeft = Math.max(0, QUESTION_SECONDS - elapsedOnQuestion);
  questionSecondsLeft = Math.min(questionSecondsLeft, quizSecondsLeft);

  return {
    progress: {
      ...progress,
      currentIdx,
      answers,
      questionStartedAt: new Date(questionStartedAt).toISOString(),
    },
    quizSecondsLeft,
    questionSecondsLeft,
    timedOut: now >= deadline || currentIdx >= questionIds.length,
  };
}

function gradeAssignedQuiz(questionIds, answers) {
  const byId = new Map(questionCache.map((q) => [q.id, q]));
  const answerById = new Map();
  (answers || []).forEach((a) => {
    if (a && a.id != null) answerById.set(Number(a.id), a);
  });

  let score = 0;
  const detailsLog = [];
  const submitted = questionIds.map((id) => {
    const ans = answerById.get(Number(id));
    return { id, selected: ans == null ? -1 : Number(ans.selected) };
  });

  submitted.forEach((ans) => {
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

  return { score, total: questionIds.length, submitted, detailsLog };
}

async function finalizeAttempt(row, answers, name) {
  const ids = parseQuestionIds(row.question_ids);
  const progress = parseProgress(row.progress);
  const progressAnswers = answers || progress.answers || [];
  const { score, total, submitted, detailsLog } = gradeAssignedQuiz(ids, progressAnswers);
  const started = row.started_at ? new Date(row.started_at).getTime() : Date.now();
  const elapsedSec = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const safeName = String(name || progress.name || row.name || "").trim();

  await pool.query(
    `UPDATE attempts
     SET status = 'submitted',
         name = $2,
         score = $3,
         total = $4,
         time_taken = $5,
         answers = $6::jsonb,
         submitted_at = NOW(),
         progress = $7::jsonb
     WHERE id = $1`,
    [
      row.id,
      safeName,
      score,
      total,
      `${elapsedSec}s`,
      JSON.stringify({ submitted, details: detailsLog }),
      JSON.stringify({ currentIdx: ids.length, answers: submitted, name: safeName }),
    ]
  );
}

function isSubmittedCooldownActive(row) {
  if (!row || row.status === "in_progress") return false;
  const submittedAt = row.submitted_at ? new Date(row.submitted_at).getTime() : 0;
  return Date.now() - submittedAt < COOLDOWN_MS;
}

function quizPayload(row, extra) {
  const ids = parseQuestionIds(row.question_ids);
  const questions = clientQuestionsForIds(ids);
  const progress = parseProgress(row.progress);
  return {
    allowed: true,
    roll: row.roll,
    questions,
    currentIdx: extra.currentIdx,
    answers: extra.answers,
    questionSecondsLeft: extra.questionSecondsLeft,
    quizSecondsLeft: extra.quizSecondsLeft,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : new Date().toISOString(),
    resumed: extra.resumed,
  };
}

async function persistProgress(rowId, progress) {
  await pool.query("UPDATE attempts SET progress = $2::jsonb WHERE id = $1", [
    rowId,
    JSON.stringify(progress),
  ]);
}

async function ensureCanonicalRollIndex() {
  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS attempts_roll_canonical_uidx
       ON attempts ((${ROLL_CANONICAL_SQL}))`
    );
  } catch (err) {
    console.error(
      "Could not create canonical roll unique index (duplicate equivalent rolls may exist):",
      err.message
    );
  }
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
    const parsed = normalizeRoll(req.params.roll);
    if (parsed.error) {
      return res.status(400).json({ allowed: false, message: parsed.error });
    }
    const rows = await findAttemptsByRoll(parsed);
    const row = rows[0];
    if (!row) {
      return res.json({ allowed: true, roll: parsed.roll });
    }
    if (row.status === "in_progress") {
      const ids = parseQuestionIds(row.question_ids);
      const applied = applyAwayTime(parseProgress(row.progress), ids, row.deadline_at);
      if (applied.timedOut) {
        await finalizeAttempt(
          { ...row, progress: applied.progress },
          applied.progress.answers,
          applied.progress.name
        );
        return res.json({ allowed: false, message: ALREADY_ATTEMPTED });
      }
      return res.json({ allowed: true, roll: parsed.roll, resumable: true });
    }
    if (isSubmittedCooldownActive(row)) {
      return res.json({ allowed: false, message: ALREADY_ATTEMPTED });
    }
    res.json({ allowed: true, roll: parsed.roll });
  } catch (err) {
    console.error(err);
    res.status(500).json({ allowed: false, error: "Check failed" });
  }
});

app.get("/generate-quiz", (_req, res) => {
  res.status(410).json({ error: "Use POST /start-quiz with name and roll." });
});

app.post(
  "/start-quiz",
  [body("name").trim(), body("roll").trim().notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "Name and roll are required." });
    }

    const parsed = normalizeRoll(req.body.roll);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    if (questionCache.length === 0) {
      return res.status(503).json({ error: "No questions available" });
    }

    const safeName = String(req.body.name || "").trim();
    const safeRoll = parsed.roll;

    try {
      const rows = await findAttemptsByRoll(parsed);
      const extras = rows.slice(1).map((r) => r.id);
      if (extras.length > 0) {
        await pool.query("DELETE FROM attempts WHERE id = ANY($1::int[])", [extras]);
      }
      const row = rows[0];

      if (row && row.status === "in_progress") {
        const ids = parseQuestionIds(row.question_ids);
        const applied = applyAwayTime(parseProgress(row.progress), ids, row.deadline_at);
        applied.progress.name = safeName || applied.progress.name || row.name;
        await persistProgress(row.id, applied.progress);

        if (applied.timedOut) {
          await finalizeAttempt(
            { ...row, progress: applied.progress },
            applied.progress.answers,
            applied.progress.name
          );
          return res.status(403).json({ error: ALREADY_ATTEMPTED });
        }

        return res.json(
          quizPayload(
            { ...row, progress: applied.progress, roll: safeRoll },
            {
              currentIdx: applied.progress.currentIdx,
              answers: applied.progress.answers,
              questionSecondsLeft: applied.questionSecondsLeft,
              quizSecondsLeft: applied.quizSecondsLeft,
              resumed: true,
            }
          )
        );
      }

      if (row && isSubmittedCooldownActive(row)) {
        return res.status(403).json({ error: ALREADY_ATTEMPTED });
      }

      const ids = pickQuestionIds();
      if (ids.length === 0) {
        return res.status(503).json({ error: "No questions available" });
      }
      const now = new Date();
      const deadline = new Date(now.getTime() + ids.length * QUESTION_SECONDS * 1000);
      const progress = {
        currentIdx: 0,
        answers: new Array(ids.length).fill(null),
        name: safeName,
        questionStartedAt: now.toISOString(),
      };

      let saved;
      if (row) {
        const updated = await pool.query(
          `UPDATE attempts
           SET roll = $2, name = $3, score = NULL, total = NULL, time_taken = NULL, answers = NULL,
               status = 'in_progress', started_at = $4, deadline_at = $5,
               question_ids = $6::jsonb, progress = $7::jsonb, submitted_at = $4
           WHERE id = $1
           RETURNING id, roll, name, status, started_at, deadline_at, question_ids, progress`,
          [row.id, safeRoll, safeName, now, deadline, JSON.stringify(ids), JSON.stringify(progress)]
        );
        saved = updated.rows[0];
      } else {
        const inserted = await pool.query(
          `INSERT INTO attempts (roll, name, status, started_at, deadline_at, question_ids, progress, submitted_at)
           VALUES ($1, $2, 'in_progress', $3, $4, $5::jsonb, $6::jsonb, $3)
           RETURNING id, roll, name, status, started_at, deadline_at, question_ids, progress`,
          [safeRoll, safeName, now, deadline, JSON.stringify(ids), JSON.stringify(progress)]
        );
        saved = inserted.rows[0];
      }

      return res.json(
        quizPayload(saved, {
          currentIdx: 0,
          answers: progress.answers,
          questionSecondsLeft: QUESTION_SECONDS,
          quizSecondsLeft: ids.length * QUESTION_SECONDS,
          resumed: false,
        })
      );
    } catch (err) {
      if (err && err.code === "23505") {
        return res.status(403).json({ error: ALREADY_ATTEMPTED });
      }
      console.error(err);
      res.status(500).json({ error: "Failed to start quiz" });
    }
  }
);

app.post(
  "/save-progress",
  [body("roll").trim().notEmpty()],
  async (req, res) => {
    const parsed = normalizeRoll(req.body.roll);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    try {
      const rows = await findAttemptsByRoll(parsed);
      const row = rows[0];
      if (!row || row.status !== "in_progress") {
        return res.status(403).json({ error: ALREADY_ATTEMPTED });
      }

      const ids = parseQuestionIds(row.question_ids);
      const existing = parseProgress(row.progress);
      existing.answers = mergeLockedAnswers(existing.answers, req.body.answers, ids);
      const incomingIdx = Number(req.body.currentIdx);
      if (Number.isFinite(incomingIdx) && incomingIdx > (existing.currentIdx || 0)) {
        existing.currentIdx = Math.min(ids.length, incomingIdx);
        existing.questionStartedAt = new Date().toISOString();
      }
      if (req.body.name) existing.name = String(req.body.name).trim();

      const applied = applyAwayTime(existing, ids, row.deadline_at);
      await persistProgress(row.id, applied.progress);

      if (applied.timedOut) {
        await finalizeAttempt(
          { ...row, progress: applied.progress },
          applied.progress.answers,
          applied.progress.name
        );
        return res.json({ success: true, finalized: true });
      }

      res.json({ success: true, currentIdx: applied.progress.currentIdx });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Save failed" });
    }
  }
);

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

    const parsed = normalizeRoll(req.body.roll);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    const safeName = String(req.body.name || "").trim();

    try {
      const rows = await findAttemptsByRoll(parsed);
      const extras = rows.slice(1).map((r) => r.id);
      if (extras.length > 0) {
        await pool.query("DELETE FROM attempts WHERE id = ANY($1::int[])", [extras]);
      }
      const row = rows[0];
      if (!row) {
        return res.status(403).json({ error: "No quiz session. Start the quiz first." });
      }

      if (row.status === "submitted") {
        if (isSubmittedCooldownActive(row)) {
          return res.json({ success: true, alreadySubmitted: true });
        }
        return res.status(403).json({ error: "No quiz session. Start the quiz first." });
      }

      const ids = parseQuestionIds(row.question_ids);
      const existing = parseProgress(row.progress);
      const mergedAnswers = mergeLockedAnswers(existing.answers, req.body.answers, ids);
      await finalizeAttempt(
        { ...row, progress: { ...existing, answers: mergedAnswers, name: safeName } },
        mergedAnswers,
        safeName
      );
      res.json({ success: true });
    } catch (err) {
      if (err && err.code === "23505") {
        return res.status(403).json({ error: ALREADY_ATTEMPTED });
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
       WHERE status = 'submitted' OR status IS NULL
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
  await ensureCanonicalRollIndex();
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
