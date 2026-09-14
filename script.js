/* ===================== CONFIG ===================== */
const BASE_URL = "https://sig-ip-quiz.onrender.com";
const FETCH_TIMEOUT_MS = 15_000;
const QUESTION_SECONDS = 120;
const ROLL_TWO_DIGIT_PREFIXES = ["20", "19", "34", "35"];
const ROLL_ONE_DIGIT_PREFIXES = { 6: "06", 7: "07", 8: "08", 9: "09" };

/* ===================== STATE ===================== */
let studentName = "";
let studentRoll = "";
let quizData = [];
let userAnswers = [];
let currentIdx = 0;
let quizStartTime = null;
let quizDeadline = null;
let pendingQuestionSeconds = null;
let startInFlight = false;
let submitInFlight = false;
let answerLocked = false;

/* ===================== TIMER ===================== */
let timer = null;
let timeLeft = QUESTION_SECONDS;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("Request timed out. Please check your connection and try again.");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
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

  for (let i = 0; i < ROLL_TWO_DIGIT_PREFIXES.length; i++) {
    const p = ROLL_TWO_DIGIT_PREFIXES[i];
    if (stripped.indexOf(p) === 0) {
      prefix = p;
      body = stripped.slice(p.length);
      break;
    }
  }

  if (!prefix) {
    const mapped = ROLL_ONE_DIGIT_PREFIXES[stripped.charAt(0)];
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

  return { roll: prefix + body };
}

function setStartButtonDisabled(disabled) {
  const btn = document.getElementById("start-btn");
  if (btn) btn.disabled = disabled;
}

/* ===================== STEP 1: START ===================== */
async function startQuizProcess() {
  if (startInFlight) return;
  startInFlight = true;
  setStartButtonDisabled(true);

  studentName = document.getElementById("student-name").value.trim();
  const parsedRoll = normalizeRoll(document.getElementById("student-roll").value);

  if (!studentName) {
    alert("Please fill in all details!");
    startInFlight = false;
    setStartButtonDisabled(false);
    return;
  }

  if (parsedRoll.error) {
    alert(parsedRoll.error);
    startInFlight = false;
    setStartButtonDisabled(false);
    return;
  }

  studentRoll = parsedRoll.roll;

  document.getElementById("registration-screen").classList.add("hidden");
  document.getElementById("setup-screen").classList.remove("hidden");
  document.getElementById("setup-text").innerText = "Starting quiz...";
  const retryBtn = document.getElementById("retry-submit-btn");
  if (retryBtn) retryBtn.classList.add("hidden");

  try {
    const response = await fetchWithTimeout(`${BASE_URL}/start-quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: studentName, roll: studentRoll }),
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      throw new Error("Could not start the quiz. Please try again.");
    }

    if (!response.ok || payload.error) {
      throw new Error(payload.error || payload.message || "You cannot start the quiz right now.");
    }

    openQuizFromServer(payload);
  } catch (err) {
    console.error(err);
    alert(err.message || "Connection failed. Please check your internet.");
    location.reload();
  }
}

function remainingQuizSeconds() {
  if (!quizDeadline) return QUESTION_SECONDS;
  return Math.max(0, Math.ceil((quizDeadline - Date.now()) / 1000));
}

function openQuizFromServer(payload) {
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  quizData = questions.filter(
    (q) => q && q.id != null && q.question && Array.isArray(q.options) && q.options.length > 0
  );

  if (quizData.length === 0) {
    throw new Error("No data");
  }

  currentIdx = Math.max(0, Number(payload.currentIdx) || 0);
  answerLocked = false;
  submitInFlight = false;
  userAnswers = new Array(quizData.length).fill(null);

  const saved = Array.isArray(payload.answers) ? payload.answers : [];
  saved.forEach((ans, idx) => {
    if (!ans || ans.id == null) return;
    const slot = quizData.findIndex((q) => Number(q.id) === Number(ans.id));
    const dest = slot >= 0 ? slot : idx;
    if (dest >= 0 && dest < userAnswers.length) {
      userAnswers[dest] = { id: quizData[dest].id, selected: Number(ans.selected) };
    }
  });

  quizStartTime = payload.startedAt ? new Date(payload.startedAt).getTime() : Date.now();
  const quizLeft = Number(payload.quizSecondsLeft);
  quizDeadline = Date.now() + (Number.isFinite(quizLeft) ? quizLeft : quizData.length * QUESTION_SECONDS) * 1000;
  pendingQuestionSeconds = Number.isFinite(Number(payload.questionSecondsLeft))
    ? Number(payload.questionSecondsLeft)
    : QUESTION_SECONDS;

  document.getElementById("setup-screen").classList.add("hidden");
  document.getElementById("quiz-screen").classList.remove("hidden");
  loadQuestion();
}

function saveProgress() {
  fetchWithTimeout(`${BASE_URL}/save-progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: studentName,
      roll: studentRoll,
      currentIdx,
      answers: userAnswers.filter((a) => a && a.id != null),
    }),
  }).catch(() => {});
}

/* ===================== STEP 3: LOAD QUESTION ===================== */
function formatTime(seconds) {
  const m = String(Math.floor(Math.max(0, seconds) / 60)).padStart(2, "0");
  const s = String(Math.max(0, seconds) % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function loadQuestion() {
  if (currentIdx >= quizData.length || remainingQuizSeconds() <= 0) {
    submitQuiz();
    return;
  }

  answerLocked = false;
  const q = quizData[currentIdx];
  if (!q || !Array.isArray(q.options) || q.options.length === 0) {
    recordAnswer(-1);
    return;
  }

  document.getElementById("question-text").innerText = `Q${currentIdx + 1}: ${q.question}`;
  document.getElementById("question-counter").innerText = `${currentIdx + 1} / ${quizData.length}`;
  const optionsContainer = document.getElementById("options-container");
  const nextBtn = document.getElementById("next-btn");
  const timerEl = document.getElementById("timer");

  optionsContainer.innerHTML = "";
  nextBtn.disabled = false;
  nextBtn.style.display = "none";
  nextBtn.innerText = currentIdx === quizData.length - 1 ? "Submit Quiz" : "Next Question";

  clearInterval(timer);
  const quizLeft = remainingQuizSeconds();
  if (pendingQuestionSeconds != null) {
    timeLeft = Math.min(Math.max(0, pendingQuestionSeconds), quizLeft);
    pendingQuestionSeconds = null;
  } else {
    timeLeft = Math.min(QUESTION_SECONDS, quizLeft);
  }

  if (timeLeft <= 0) {
    recordAnswer(-1);
    return;
  }

  timerEl.innerText = `Time left: ${formatTime(timeLeft)}`;

  timer = setInterval(() => {
    timeLeft--;
    const cap = remainingQuizSeconds();
    if (cap < timeLeft) timeLeft = cap;
    timerEl.innerText = `Time left: ${formatTime(timeLeft)}`;

    if (timeLeft <= 0) {
      clearInterval(timer);
      recordAnswer(-1);
    }
  }, 1000);

  q.options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "option-btn";
    btn.innerText = opt;
    btn.dataset.idx = String(idx);
    btn.onclick = () => {
      if (answerLocked) return;
      optionsContainer.querySelectorAll(".option-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      nextBtn.disabled = false;
      nextBtn.style.display = "block";
    };
    optionsContainer.appendChild(btn);
  });
}

function nextQuestion() {
  if (answerLocked) return;
  const nextBtn = document.getElementById("next-btn");
  const selectedBtn = document.querySelector("#options-container .option-btn.selected");
  if (!selectedBtn) {
    if (nextBtn) nextBtn.disabled = false;
    return;
  }

  if (nextBtn) nextBtn.disabled = true;
  const choiceIdx = parseInt(selectedBtn.dataset.idx, 10);
  recordAnswer(Number.isNaN(choiceIdx) ? -1 : choiceIdx);
}

function recordAnswer(choiceIdx) {
  if (answerLocked) return;
  if (currentIdx >= quizData.length) {
    submitQuiz();
    return;
  }

  answerLocked = true;
  clearInterval(timer);

  const q = quizData[currentIdx];
  if (q && q.id != null) {
    userAnswers[currentIdx] = {
      id: q.id,
      selected: choiceIdx,
    };
  }

  currentIdx++;
  saveProgress();
  loadQuestion();
}

/* ===================== STEP 4: SUBMIT & GRADE ===================== */
async function submitQuiz() {
  if (submitInFlight) return;
  submitInFlight = true;

  clearInterval(timer);

  document.getElementById("quiz-screen").classList.add("hidden");
  document.getElementById("setup-screen").classList.remove("hidden");
  document.getElementById("setup-text").innerText = "Submitting responses...";
  const loader = document.querySelector(".loader");
  if (loader) loader.style.display = "block";
  const retryBtn = document.getElementById("retry-submit-btn");
  if (retryBtn) retryBtn.classList.add("hidden");

  const started = quizStartTime || Date.now();
  const timeTaken = `${Math.floor((Date.now() - started) / 1000)}s`;

  const payload = {
    name: studentName,
    roll: studentRoll,
    answers: userAnswers.filter((a) => a && a.id != null),
    timeTaken: timeTaken,
  };

  try {
    const response = await fetchWithTimeout(`${BASE_URL}/submit-quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let result = {};
    try {
      result = await response.json();
    } catch {
      throw new Error("Submission failed. Check your internet and tap Retry submit.");
    }

    if (response.ok && (result.success || result.alreadySubmitted)) {
      document.getElementById("setup-screen").classList.add("hidden");
      document.getElementById("result-screen").classList.remove("hidden");
      return;
    }

    if (response.status === 403 && result.error) {
      alert("Error: " + result.error);
      location.reload();
      return;
    }

    throw new Error(result.error || "Submission failed. Check your internet and tap Retry submit.");
  } catch (err) {
    console.error(err);
    if (loader) loader.style.display = "none";
    document.getElementById("setup-text").innerText =
      err.message || "Submission failed. Check your internet and tap Retry submit.";
    if (retryBtn) retryBtn.classList.remove("hidden");
    submitInFlight = false;
  }
}
