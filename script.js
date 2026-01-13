/* ===================== CONFIG ===================== */
// Your correct backend URL
const BASE_URL = "https://sig-ip-quiz.onrender.com"; 

/* ===================== STATE ===================== */
let studentName = "";
let studentRoll = "";
let quizData = []; 
let userAnswers = []; 
let currentIdx = 0;
let quizStartTime = null;

/* ===================== TIMER ===================== */
let timer = null;
let timeLeft = 120;

/* ===================== STEP 1: START ===================== */
async function startQuizProcess() {
  studentName = document.getElementById("student-name").value.trim();
  studentRoll = document.getElementById("student-roll").value.trim();

  if (!studentName || !studentRoll) {
    alert("Please fill in all details!");
    return;
  }

  // UI Update
  document.getElementById("registration-screen").classList.add("hidden");
  document.getElementById("setup-screen").classList.remove("hidden");
  document.getElementById("setup-text").innerText = "Checking eligibility...";

  try {
    // Check eligibility
    const checkRes = await fetch(`${BASE_URL}/check-roll/${studentRoll}`);
    const checkData = await checkRes.json();

    if (!checkData.allowed) {
      alert(checkData.message);
      location.reload();
      return;
    }

    // UPDATED: Changed text to "Loading quiz..."
    document.getElementById("setup-text").innerText = "Loading quiz...";
    await generateQuiz();
    
  } catch (err) {
    console.error(err);
    alert("Connection failed. Please check your internet.");
    location.reload();
  }
}

/* ===================== STEP 2: FETCH QUIZ ===================== */
async function generateQuiz() {
  try {
    const response = await fetch(`${BASE_URL}/generate-quiz`);
    quizData = await response.json();

    if (!quizData || quizData.length === 0) throw new Error("No data");

    // Initialize answers array
    userAnswers = new Array(quizData.length).fill(null);
    
    quizStartTime = Date.now();
    document.getElementById("setup-screen").classList.add("hidden");
    document.getElementById("quiz-screen").classList.remove("hidden");
    loadQuestion();

  } catch (err) {
    alert("Failed to load questions. Please refresh.");
  }
}

/* ===================== STEP 3: LOAD QUESTION ===================== */
function loadQuestion() {
  // Check if finished
  if (currentIdx >= quizData.length) {
    submitQuiz();
    return;
  }

  const q = quizData[currentIdx];
  
  // UI Elements
  document.getElementById("question-text").innerText = `Q${currentIdx + 1}: ${q.question}`;
  document.getElementById("question-counter").innerText = `${currentIdx + 1} / ${quizData.length}`;
  const optionsContainer = document.getElementById("options-container");
  const nextBtn = document.getElementById("next-btn");
  const timerEl = document.getElementById("timer");

  optionsContainer.innerHTML = "";
  nextBtn.style.display = "none";

  // Reset Timer
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
      recordAnswer(-1); // -1 means skipped/timeout
    }
  }, 1000);

  // Render Options
  q.options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.innerText = opt;
    btn.onclick = () => {
      document.querySelectorAll(".option-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      // Store temporarily selected index
      btn.dataset.idx = idx; 
      nextBtn.style.display = "block";
    };
    optionsContainer.appendChild(btn);
  });
}

function nextQuestion() {
  clearInterval(timer);
  const selectedBtn = document.querySelector(".selected");
  if (!selectedBtn) return; 

  const choiceIdx = parseInt(selectedBtn.dataset.idx, 10);
  recordAnswer(choiceIdx);
}

function recordAnswer(choiceIdx) {
  // Store answer: { id: questionID, selected: index }
  userAnswers[currentIdx] = {
    id: quizData[currentIdx].id,
    selected: choiceIdx
  };

  currentIdx++;
  loadQuestion();
}

/* ===================== STEP 4: SUBMIT & GRADE ===================== */
async function submitQuiz() {
  clearInterval(timer);
  
  // Show Loading Screen
  document.getElementById("quiz-screen").classList.add("hidden");
  document.getElementById("setup-screen").classList.remove("hidden");
  document.getElementById("setup-text").innerText = "Submitting responses..."; // Generic message
  document.querySelector(".loader").style.display = "block";

  const timeTaken = `${Math.floor((Date.now() - quizStartTime) / 1000)}s`;

  const payload = {
    name: studentName, 
    roll: studentRoll, 
    answers: userAnswers, 
    timeTaken: timeTaken
  };

  try {
    const response = await fetch(`${BASE_URL}/submit-quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (result.error) {
      alert("Error: " + result.error);
      location.reload();
      return;
    }

    // Show Final Result (UPDATED: NO SCORE DISPLAY)
    document.getElementById("setup-screen").classList.add("hidden");
    document.getElementById("result-screen").classList.remove("hidden");
    
    // We do NOT update the innerHTML here anymore.
    // It will simply show the default HTML: "Thank You! Your responses have been recorded."

  } catch (err) {
    alert("Submission failed. Please contact admin.");
    console.error(err);
  }
}


