
/* ===================== STATE ===================== */
let studentName = "";
let studentRoll = "";
let quizData = [];
let currentIdx = 0;
let score = 0;
let quizDetails = [];

/* ===================== STEP 1: START ===================== */
function startQuizProcess() {
  studentName = document.getElementById("student-name").value.trim();
  studentRoll = document.getElementById("student-roll").value.trim();

  if (!studentName || !studentRoll) {
    alert("Please fill in all details!");
    return;
  }

  document.getElementById("registration-screen").classList.add("hidden");
  document.getElementById("setup-screen").classList.remove("hidden");

  generateQuiz();
}

/* ===================== STEP 2: GEMINI QUIZ ===================== */
async function generateQuiz() {
  try {
    const response = await fetch("https://sig-ip-quiz.onrender.com/generate-quiz", {
  method: "POST",
  headers: { "Content-Type": "application/json" }
});

    quizData = await response.json();

    document.getElementById("setup-screen").classList.add("hidden");
    document.getElementById("quiz-screen").classList.remove("hidden");

    loadQuestion();
  } catch (err) {
    console.error(err);
    alert("Quiz generation failed");
  }
}

/* ===================== STEP 3: LOAD QUESTION ===================== */
console.log(document.getElementById("options"));

function loadQuestion() {
  const questionText = document.getElementById("question-text");
  const optionsContainer = document.getElementById("options-container");
  const nextBtn = document.getElementById("next-btn");

  if (!questionText || !optionsContainer) {
    console.error("Quiz DOM elements missing");
    return;
  }

  const q = quizData[currentIdx];

  questionText.innerText = q.question;
  optionsContainer.innerHTML = "";
  nextBtn.style.display = "none";

  q.options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.innerText = opt;
    btn.dataset.choice = idx;

    btn.onclick = () => {
      document
        .querySelectorAll(".option-btn")
        .forEach(b => b.classList.remove("selected"));

      btn.classList.add("selected");
      nextBtn.style.display = "block";
    };

    optionsContainer.appendChild(btn);
  });
}


/* ===================== STEP 4: NEXT ===================== */
function nextQuestion() {
  const selected = document.querySelector(".selected");

  if (!selected) {
    alert("Please select an option");
    return;
  }

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

  if (currentIdx < quizData.length) {
    loadQuestion();
  } else {
    showResults();
  }
}

/* ===================== STEP 5: RESULTS ===================== */
async function showResults() {
  document.getElementById("quiz-screen").classList.add("hidden");
  document.getElementById("result-screen").classList.remove("hidden");

  document.getElementById(
    "score-text"
  ).innerText = `Score: ${score} / ${quizData.length}`;

  const payload = {
    name: studentName,
    roll: studentRoll,
    score: `${score}/${quizData.length}`,
    details: quizDetails
  };

  try {
    await fetch("https://sig-ip-quiz.onrender.com/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    console.log("Results saved successfully");
  } catch {
    console.warn("Local server not running");
  }
}


