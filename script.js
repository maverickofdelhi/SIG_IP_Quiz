/* ===================== CONFIG ===================== */
// Ensure this URL matches your deployed backend URL
const BASE_URL = "https://sig-ip-quiz.onrender.com";

/** * SECURITY: This key must be identical to the API_SECRET_KEY 
 * you set in your Render environment variables.
 */
const SECRET_KEY = "YourSecretPassword123"; 

/* ===================== STATE ===================== */
let studentName = "";
let studentRoll = "";
let quizData = []; 
let currentIdx = 0;
let score = 0;
let quizDetails = [];
let quizStartTime = null;

/* ===================== TIMER ===================== */
let timer = null;
let timeLeft = 60; // 1 minute per question

/* ===================== STEP 1: START ===================== */
async function startQuizProcess() {
  studentName = document.getElementById("student-name").value.trim();
  studentRoll = document.getElementById("student-roll").value.trim();

  if (!studentName || !studentRoll) {
    alert("Please fill in all details!");
    return;
  }

  // Visual feedback that we are verifying
  const startBtn = document.getElementById("start-btn");
  if(startBtn) startBtn.disabled = true;

  try {
    // Check for existing attempts with the Secret Key in header
    const response = await fetch(`${BASE_URL}/check-roll/${studentRoll}`, {
        headers: { "x-quiz-secret": SECRET_KEY }
    });
    const checkData = await response.json();

    if (!checkData.allowed) {
      alert(checkData.message);
      if(startBtn) startBtn.disabled = false;
      return;
    }

    // Proceed to setup
    document.getElementById("registration-screen").classList.add("hidden");
    document.getElementById("setup-screen").classList.remove("hidden");

    generateQuiz();
    
  } catch (err) {
    console.error(err);
    alert("Verification failed. Please check your internet connection.");
    if(startBtn) startBtn.disabled = false;
  }
}

/* ===================== STEP 2: FETCH QUIZ ===================== */
async function generateQuiz() {
  try {
    const response = await fetch(`${BASE_URL}/generate-quiz`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "x-quiz-secret": SECRET_KEY 
      }
    });

    quizData = await response.json();
    quizStartTime = Date.now(); // Start tracking session time

    document.getElementById("setup-screen").classList.add("hidden");
    document.getElementById("quiz-screen").classList.remove("hidden");

    loadQuestion();
  } catch (err) {
    console.error(err);
    alert("Quiz generation failed");
  }
}

/* ===================== STEP 3: LOAD QUESTION ===================== */
function loadQuestion() {
  const questionText = document.getElementById("question-text");
  const optionsContainer = document.getElementById("options-container");
  const nextBtn = document.getElementById("next-btn");
  const timerEl = document.getElementById("timer");
  const counterEl = document.getElementById("question-counter");

  const q = quizData[currentIdx];

  // Update UI
  if(counterEl) counterEl.innerText = `Question ${currentIdx + 1} of ${quizData.length}`;
  questionText.innerText = q.question;
  optionsContainer.innerHTML = "";
  nextBtn.style.display = "none";

  // Reset timer
  clearInterval(timer);
  timeLeft = 60;
  timerEl.innerText = "Time left: 01:00";

  timer = setInterval(() => {
    timeLeft--;
    const minutes = String(Math.floor(timeLeft / 60)).padStart(2, "0");
    const seconds = String(timeLeft % 60).padStart(2, "0");
    timerEl.innerText = `Time left: ${minutes}:${seconds}`;

    if (timeLeft <= 0) {
      clearInterval(timer);
      autoSubmit();
    }
  }, 1000);

  // Render options
  q.options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.innerText = opt;
    btn.dataset.choice = idx;

    btn.onclick = () => {
      document.querySelectorAll(".option-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      nextBtn.style.display = "block";
    };

    optionsContainer.appendChild(btn);
  });
}

/* ===================== AUTO SUBMIT (TIMEOUT) ===================== */
function autoSubmit() {
  const currentQ = quizData[currentIdx];

  quizDetails.push({
    question: currentQ.question,
    chosen: "Not Answered",
    correct: currentQ.options[currentQ.correct],
    status: "WRONG"
  });

  currentIdx++;
  if (currentIdx < quizData.length) loadQuestion();
  else showResults();
}

/* ===================== STEP 4: NEXT QUESTION ===================== */
function nextQuestion() {
  clearInterval(timer);

  const selected = document.querySelector(".selected");
  if (!selected) {
    alert("Please select an option");
    return;
  }

  const choice
