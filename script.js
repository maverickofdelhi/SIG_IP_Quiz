/* ===================== CONFIG ===================== */
const BASE_URL = "https://sig-ip-quiz.onrender.com";
const FETCH_TIMEOUT_MS = 15_000;

/* ===================== STATE ===================== */
let studentName = "";
let studentRoll = "";
let quizData = [];
let userAnswers = [];
let currentIdx = 0;
let quizStartTime = null;
let startInFlight = false;
let submitInFlight = false;

/* ===================== TIMER ===================== */
let timer = null;
let timeLeft = 120;

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
  studentRoll = document.getElementById("student-roll").value.trim();

  if (!studentName || !studentRoll) {
    alert("Please fill in all details!");
    startInFlight = false;
    setStartButtonDisabled(false);
    return;
  }

  document.getElementById("registration-screen").classList.add("hidden");
  document.getElementById("setup-screen").classList.remove("hidden");
  document.getElementById("setup-text").innerText = "Checking eligibility...";

  try {
    const checkRes = await fetchWithTimeout(`${BASE_URL}/check-roll/${encodeURIComponent(studentRoll)}`);
    const checkData = await checkRes.json();

    if (!checkData.allowed) {
      alert(checkData.message || "You cannot start the quiz right now.");
      location.reload();
      return;
    }

    document.getElementById("setup-text").innerText = "Loading quiz...";
    await generateQuiz();
  } catch (err) {
    console.error(err);
    alert(err.message || "Connection failed. Please check your internet.");
    location.reload();
  }
}

/* ===================== STEP 2: FETCH QUIZ ===================== */
async function generateQuiz() {
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/generate-quiz`);
    quizData = await response.json();

    if (!response.ok || !quizData || quizData.length === 0 || quizData.error) {
      throw new Error(quizData && quizData.error ? quizData.error : "No data");
    }

    userAnswers = new Array(quizData.length).fill(null);

    quizStartTime = Date.now();
    document.getElementById("setup-screen").classList.add("hidden");
    document.getElementById("quiz-screen").classList.remove("hidden");
    loadQuestion();
  } catch (err) {
    throw new Error(err.message || "Failed to load questions. Please refresh.");
  }
}

/* ===================== STEP 3: LOAD QUESTION ===================== */
function loadQuestion() {
  if (currentIdx >= quizData.length) {
    submitQuiz();
    return;
  }

  const q = quizData[currentIdx];

  document.getElementById("question-text").innerText = `Q${currentIdx + 1}: ${q.question}`;
  document.getElementById("question-counter").innerText = `${currentIdx + 1} / ${quizData.length}`;
  const optionsContainer = document.getElementById("options-container");
  const nextBtn = document.getElementById("next-btn");
  const timerEl = document.getElementById("timer");

  optionsContainer.innerHTML = "";
  nextBtn.style.display = "none";

  clearInterval(timer);
  timeLeft = 120;
  timerEl.innerText = "Time left: 02:00";

  timer = setInterval(() => {
    timeLeft--;
    const m = String(Math.floor(timeLeft / 60)).padStart(2, "0");
    const s = String(timeLeft % 60).padStart(2, "0");
    timerEl.innerText = `Time left: ${m}:${s}`;

    if (timeLeft <= 0) {
      clearInterval(timer);
      recordAnswer(-1);
    }
  }, 1000);

  q.options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.innerText = opt;
    btn.onclick = () => {
      document.querySelectorAll(".option-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      btn.dataset.idx = idx;
      nextBtn.style.display = "block";
    };
    optionsContainer.appendChild(btn);
  });
}

function nextQuestion() {
  const nextBtn = document.getElementById("next-btn");
  if (nextBtn) nextBtn.disabled = true;
  clearInterval(timer);
  const selectedBtn = document.querySelector(".selected");
  if (!selectedBtn) {
    if (nextBtn) nextBtn.disabled = false;
    return;
  }

  const choiceIdx = parseInt(selectedBtn.dataset.idx, 10);
  recordAnswer(choiceIdx);
}

function recordAnswer(choiceIdx) {
  userAnswers[currentIdx] = {
    id: quizData[currentIdx].id,
    selected: choiceIdx,
  };

  currentIdx++;
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
  document.querySelector(".loader").style.display = "block";

  const timeTaken = `${Math.floor((Date.now() - quizStartTime) / 1000)}s`;

  const payload = {
    name: studentName,
    roll: studentRoll,
    answers: userAnswers,
    timeTaken: timeTaken,
  };

  try {
    const response = await fetchWithTimeout(`${BASE_URL}/submit-quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!response.ok || result.error) {
      alert("Error: " + (result.error || "Submission rejected."));
      location.reload();
      return;
    }

    document.getElementById("setup-screen").classList.add("hidden");
    document.getElementById("result-screen").classList.remove("hidden");
  } catch (err) {
    alert(err.message || "Submission failed. Please contact admin.");
    console.error(err);
    submitInFlight = false;
  }
}
