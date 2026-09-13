# SIG-IP Quiz — implement step by step

The **code is already in this repo**. You are connecting a database, putting secrets on Render, uploading questions, then going live.

- **~2000** students total, **~500** online at once
- **Neon** = Postgres (questions + results)
- **Render** = runs `server.js` (students cannot talk to the database directly)
- **Quiz page** = `index.html` + `script.js` (already points at `https://sig-ip-quiz.onrender.com`)
- Scores are **not** shown to students
- Google Sheets is **not** used

Do the steps in order. Do not skip the dry run.

---

## Step 1 — Install Node packages

On your PC, in this folder:

```bash
npm install
```

You need Node.js installed (`node -v` should print a version). This pulls in `pg` (Postgres driver).

---

## Step 2 — Create the database (Neon)

1. Open [https://neon.tech](https://neon.tech) and create an account/project.
2. Dashboard → **Connection details**.
3. Select **Pooled connection** (host name usually contains `-pooler`).
4. Copy the URI. It must look like:

```text
postgresql://USER:PASSWORD@ep-xxxx-pooler.region.aws.neon.tech/neondb?sslmode=require
```

Use the **pooler** URL, not the “direct” URL.

You do **not** create tables by hand. When the server starts, it runs `db/schema.sql` and creates:

- `questions` — the bank
- `attempts` — one result row per roll number

---

## Step 3 — Local secrets

1. Copy `.env.example` to `.env` (this file is gitignored).
2. Paste:

```env
DATABASE_URL=postgresql://...your-pooled-neon-url...
ADMIN_SECRET=pick-a-long-random-password
PORT=5000
```

`ADMIN_SECRET` is the password for uploading questions and downloading results. Save it somewhere safe. **Never commit `.env`.**

---

## Step 4 — Run the API on your machine

```bash
npm start
```

Look for `Server running on 5000` and `Question cache loaded`.

Open:

```text
http://localhost:5000/health
```

You want `"ok": true`. If the process crashes, `DATABASE_URL` or `ADMIN_SECRET` is missing or the Neon URL is wrong.

Optional local quiz test: temporarily set `BASE_URL` in `script.js` to `http://localhost:5000`, open `index.html`, take the quiz, then **set `BASE_URL` back** to:

```text
https://sig-ip-quiz.onrender.com
```

---

## Step 5 — Build the real question file

Need **at least 10** questions (the quiz randomly picks 10). Export your old Sheet:

- Question text
- Four options
- Correct letter `A`, `B`, `C`, or `D`

**JSON** (`questions-real.json` — keep the real exam off GitHub if you want):

```json
[
  {
    "question": "What is a patent?",
    "A": "A brand name",
    "B": "An exclusive right to an invention",
    "C": "A secret recipe",
    "D": "A domain name",
    "correct": "B"
  }
]
```

**CSV** also works, first row as header:

```text
question,A,B,C,D,correct
What is a patent?,A brand name,An exclusive right to an invention,A secret recipe,A domain name,B
```

`questions.json` in the repo is only placeholders. First boot seeds those if the table is empty. You will replace them in Step 8.

---

## Step 6 — Configure Render (the API host)

Render is not the database. It is the Node process students already call. Keep the existing service `sig-ip-quiz`.

1. Open the service on [render.com](https://render.com).
2. Use a **small paid** instance for the event (free tier sleeps; ~500 people at once will feel that).
3. **Environment** → add:

| Name | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** URI from Step 2 |
| `ADMIN_SECRET` | Same secret as in `.env` |

4. **Delete** if they exist: `SHEET_ID`, `QUES_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT`.
5. Start command: `npm start` (or `node server.js`). Build: `npm install`.

If `DATABASE_URL` or `ADMIN_SECRET` is missing, the new server **will not start**.

---

## Step 7 — Deploy this code

Commit and push `main` (when you are ready):

```bash
git add -A
git status
git commit -m "Replace Google Sheets with Postgres for questions and results."
git push origin main
```

Wait until Render is **Live**. Then open:

```text
https://sig-ip-quiz.onrender.com/health
```

Expect `"ok": true`. If deploy fails, check Render logs (almost always env vars or a non-pooled URL).

---

## Step 8 — Upload the real questions

This **replaces** the whole active bank. Do it before students arrive.

JSON:

```bash
curl -X POST https://sig-ip-quiz.onrender.com/admin/questions \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  --data-binary @questions-real.json
```

CSV:

```bash
curl -X POST https://sig-ip-quiz.onrender.com/admin/questions \
  -H "Content-Type: text/csv" \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  --data-binary @questions-real.csv
```

Success: `{ "success": true, "active": 40 }` (your count).  
`401` = wrong secret. `400` = a row is missing options or `correct` is not A–D.

Refresh `/health`. `questionsCached` should match.

---

## Step 9 — Dry run (required)

1. Open the **student quiz page** (same `index.html` you already use).
2. Confirm `script.js` still has `BASE_URL = "https://sig-ip-quiz.onrender.com"`.
3. Take the quiz as roll `TEST001`. Finish all 10 questions → “Thank You!” (no score).
4. Try `TEST001` again immediately → blocked (cooldown / already submitted).
5. Download results:

```bash
curl -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -o quiz-results.csv \
  https://sig-ip-quiz.onrender.com/admin/results.csv
```

CSV columns: `roll,name,score,total,time_taken,submitted_at,answers`.

6. Remove the test row in Neon → **SQL Editor**:

```sql
DELETE FROM attempts WHERE roll = 'TEST001';
```

---

## Step 10 — Event day

Before the hall fills:

- `/health` is `ok`
- `questionsCached` is the real bank, not 3 placeholders
- Render is paid and awake

During:

- Name + roll → 10 timed questions → one submit
- Same roll cannot submit twice within 10 hours
- Campus Wi‑Fi is fine (limits are by roll, not a tight per-IP cap)

If it breaks:

| Symptom | Likely cause |
|---|---|
| `/health` 503 | Neon or `DATABASE_URL` |
| “No questions available” | Empty bank → repeat Step 8 |
| “Cooldown active” | That roll already submitted |
| Request timed out | Network or Render asleep → retry once |

---

## Step 11 — After the quiz

Download `/admin/results.csv` again (Step 9 command). Marks are `score` / `total`. `answers` is the per-question log.

Scale Render down if you want. Data stays in Neon.

To run another quiz later: upload a new bank (Step 8) and optionally:

```sql
TRUNCATE attempts;
```

That clears results only.

---

## What not to do

- Do not put `DATABASE_URL` or `ADMIN_SECRET` in GitHub
- Do not use Neon’s **direct** (non-pooler) URL on Render
- Do not run the live hall on Render **free**
- Do not put correct answers in `index.html`
- Do not go back to Google Sheets for live submits
