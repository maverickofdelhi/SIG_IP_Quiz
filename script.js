/* ===================== STATE ===================== */
let studentName = "";
let studentRoll = "";
let quizData = [];
let currentIdx = 0;
let score = 0;
let quizDetails = [];
let quizStartTime = null; // To track duration

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
    const checkResponse = await fetch(`https://sig-ip-quiz.onrender.com/check-roll/${studentRoll}`);
    const checkData = await checkResponse.json();

    if (!checkData.allowed) {
      alert(checkData.message);
      return;
    }

    document.getElementById("registration-screen").classList.add("hidden");
    document.getElementById("setup-screen").classList.remove("hidden");

    generateQuiz();
  } catch (err) {
    alert("Validation failed. Check your connection.");
  }
}

/* ===================== STEP 2: FETCH QUIZ ===================== */
async function generateQuiz() {
  try {
    const response = await fetch("https://sig-ip-quiz.onrender.com/generate-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
    });

    quizData = await response.json();
    quizStartTime = Date.now(); // Record start time

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
    const m = String(Math.floor(timeLeft / 60)).padStart(2, "0");
    const s = String(timeLeft % 60).padStart(2, "0");
    timerEl.innerText = `Time left: ${m}:${s}`;
    if (timeLeft <= 0) { clearInterval(timer); autoSubmit(); }
  }, 1000);

  q.options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.innerText = opt;
    btn.onclick = () => {
      document.querySelectorAll(".option-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      btn.dataset.choice = idx;
      nextBtn.style.display = "block";
    };
    optionsContainer.appendChild(btn);
  });
}

function autoSubmit() {
  saveStepData("Not Answered", false);
  currentIdx++;
  if (currentIdx < quizData.length) loadQuestion();
  else showResults();
}

function nextQuestion() {
  clearInterval(timer);
  const selected = document.querySelector(".selected");
  const choiceIdx = parseInt(selected.dataset.choice);
  const isCorrect = choiceIdx === quizData[currentIdx].correct;
  if (isCorrect) score++;

  saveStepData(quizData[currentIdx].options[choiceIdx], isCorrect);
  currentIdx++;
  if (currentIdx < quizData.length) loadQuestion();
  else showResults();
}

function saveStepData(chosen, isCorrect) {
  quizDetails.push({
    question: quizData[currentIdx].question,
    chosen: chosen,
    correct: quizData[currentIdx].options[quizData[currentIdx].correct],
    status: isCorrect ? "CORRECT" : "WRONG"
  });
}

/* ===================== STEP 5: RESULTS ===================== */
async function showResults() {
  clearInterval(timer);

  // Calculate Duration
  const diff = Math.floor((Date.now() - quizStartTime) / 1000);
  const timeTakenStr = `${Math.floor(diff / 60)}m ${diff % 60}s`;

  document.getElementById("quiz-screen").classList.add("hidden");
  document.getElementById("result-screen").classList.remove("hidden");

  const payload = {
    name: studentName,
    roll: studentRoll,
    score: `${score}/${quizData.length}`,
    details: quizDetails,
    timeTaken: timeTakenStr
  };

  await fetch("https://sig-ip-quiz.onrender.com/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}
