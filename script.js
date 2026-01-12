/* ===================== CONFIG ===================== */
const BASE_URL = "https://sig-ip-quiz.onrender.com";
const SECRET_KEY = "YourSecretPassword123"; // Ensure this matches Render!

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
let timeLeft = 60;

/* ===================== STEP 1: START ===================== */
async function startQuizProcess() {
  studentName = document.getElementById("student-name").value.trim();
  studentRoll = document.getElementById("student-roll").value.trim();

  if (!studentName || !studentRoll) {
    alert("Please fill in all details!");
    return;
  }

  try {
    // Check 10-hour cooldown
    const response = await fetch(`${BASE_URL}/check-roll/${studentRoll}`, {
        headers: { "x-quiz-secret": SECRET_KEY }
    });
    const checkData = await response.json();

    if (!checkData.allowed) {
      alert(checkData.message);
      return;
    }

    document.getElementById("registration-screen").classList.add("hidden");
    document.getElementById("setup-screen").classList.remove("hidden");

    generateQuiz();
    
  } catch (err) {
    console.error(err);
    alert("Verification failed. Please check your connection.");
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
    quizStartTime = Date.now();

    document.getElementById("setup-screen").classList.add("hidden");
    document.getElementById("quiz-screen").classList.remove("hidden");

    loadQuestion();
  } catch (err) {
    alert("Quiz generation failed");
  }
}

/* ===================== STEP 3: LOAD QUESTION ===================== */
function loadQuestion() {
  const questionText = document.getElementById("question-text");
  const optionsContainer = document.getElementById("options-container");
  const nextBtn = document.getElementById("next-btn");
  const timerEl = document.getElementById("timer");

  const q = quizData[currentIdx];
  questionText.innerText = `Question ${currentIdx + 1} of ${quizData.length}\n\n${q.question}`;
  optionsContainer.innerHTML = "";
  nextBtn.style.display = "none";

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

function autoSubmit() {
  const currentQ = quizData[currentIdx];
  quizDetails.push({
    question: currentQ.question, chosen: "Not Answered",
    correct: currentQ.options[currentQ.correct], status: "WRONG"
  });
  currentIdx++;
  if (currentIdx < quizData.length) loadQuestion();
  else showResults();
}

function nextQuestion() {
  clearInterval(timer);
  const selected = document.querySelector(".selected");
  if (!selected) return alert("Please select an option");

  const choiceIdx = parseInt(selected.dataset.choice, 10);
  const currentQ = quizData[currentIdx];
  const isCorrect = choiceIdx === currentQ.correct;
  if (isCorrect) score++;

  quizDetails.push({
    question: currentQ.question,
    chosen: currentQ.options[choiceIdx],
    correct: currentQ.options[currentQ.correct],
    status: isCorrect ? "CORRECT" : "WRONG"
  });

  currentIdx++;
  if (currentIdx < quizData.length) loadQuestion();
  else showResults();
}

async function showResults() {
  const timeTaken = `${Math.floor((Date.now() - quizStartTime) / 1000)}s`;
  const payload = {
    name: studentName, roll: studentRoll, score: `${score}/${quizData.length}`,
    details: quizDetails, timeTaken: timeTaken
  };

  try {
    await fetch(`${BASE_URL}/save`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "x-quiz-secret": SECRET_KEY 
      },
      body: JSON.stringify(payload)
    });
    document.getElementById("quiz-screen").classList.add("hidden");
    document.getElementById("result-screen").classList.remove("hidden");
  } catch (err) {
    console.warn("Failed to save results");
  }
}
