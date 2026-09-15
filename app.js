// ---------- 상태 저장/불러오기 (브라우저 localStorage 전용) ----------
const STORAGE_KEY = "email_task_tracker_v1";
const STATUSES = ["진행중", "완료", "보류", "취소"];

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { settings: { taskFolder: "" }, projects: [], tasks: [] };
    const parsed = JSON.parse(raw);
    return {
      settings: parsed.settings || { taskFolder: "" },
      projects: parsed.projects || [],
      tasks: parsed.tasks || [],
    };
  } catch (e) {
    console.error("저장된 데이터를 불러오지 못했습니다.", e);
    return { settings: { taskFolder: "" }, projects: [], tasks: [] };
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("데이터 저장에 실패했습니다.", e);
    alert("데이터 저장에 실패했습니다. 브라우저 저장공간이 가득 찼거나 비공개 모드일 수 있어요.");
  }
}

let state = loadState();

// ---------- 유틸 ----------
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function toISODate(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function todayISO() {
  const n = new Date();
  return toISODate(n.getFullYear(), n.getMonth() + 1, n.getDate());
}

function formatDateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function daysBetween(isoA, isoB) {
  const a = new Date(isoA);
  const b = new Date(isoB);
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

// ---------- 이메일 → 마감일 자동 파싱 ----------
function parseDueDate(text) {
  if (!text) return null;
  const now = new Date();

  if (/모레/.test(text)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    return toISODate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  if (/내일/.test(text)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return toISODate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  if (/오늘/.test(text)) {
    return toISODate(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  let m = text.match(/(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?/);
  if (m) return toISODate(+m[1], +m[2], +m[3]);

  m = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (m) {
    let year = now.getFullYear();
    const month = +m[1];
    const day = +m[2];
    const candidate = new Date(year, month - 1, day);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (candidate < startOfToday) year += 1;
    return toISODate(year, month, day);
  }

  m = text.match(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})(?!\d)/);
  if (m) {
    const month = +m[1];
    const day = +m[2];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let year = now.getFullYear();
      const candidate = new Date(year, month - 1, day);
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (candidate < startOfToday) year += 1;
      return toISODate(year, month, day);
    }
  }

  return null;
}

// ---------- 제목 자동 생성 (가벼운 규칙 기반 요약 — 실제 AI 호출 아님) ----------
function generateTitle(emailText) {
  if (!emailText || !emailText.trim()) return "제목 없는 할일";
  const lines = emailText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const skipPattern = /^(안녕하세요|안녕하십니까|hi\b|hello\b|dear\b|to\s|수신\s*[:：]|참조\s*[:：]|from\s*[:：]|보낸사람)/i;
  const candidates = lines.filter((l) => !skipPattern.test(l) && l.length >= 4);
  let base = candidates[0] || lines[0] || emailText.trim();

  base = base.replace(/^(제목|subject)\s*[:：]\s*/i, "");
  base = base.replace(/\s+/g, " ").trim();

  return base.length > 42 ? base.slice(0, 42) + "…" : base;
}

// ---------- AI 실행 프롬프트 생성 ----------
function buildPrompt(task) {
  const folder = state.settings.taskFolder || "(설정에서 데스크탑 할일 폴더 경로를 지정해주세요)";
  const files = task.relatedFiles && task.relatedFiles.length
    ? task.relatedFiles.map((f) => `- ${f}`).join("\n")
    : "없음";

  return `[할일 처리 요청]

## 이메일 원문
${task.rawEmailContent || "(원문 없음)"}

## 마감일
${task.dueDate || "지정되지 않음"}

## 관련 파일
${files}

## 요청 사항
1. "${folder}" 아래에 이 할일 전용 폴더를 만들고, 아래 3가지를 구분해서 각각 파일로 저장해줘.
   - 이메일 원문 (raw)
   - 핵심 내용 요약 (summary)
   - 네가 지금 바로 처리한 결과물이 있다면 그 산출물
2. 이메일 내용을 한국어로 간단히 요약해줘.
3. 답장 초안 작성처럼 네가 스스로 처리 가능한 간단한 작업이 있다면 지금 바로 처리해줘.
4. 관련 파일 경로가 안내되어 있다면 참고해서 활용해줘 (파일 내용 자체는 이 프롬프트에 포함되어 있지 않으니 직접 열어서 확인해야 해).`;
}

// ---------- 모달 열기/닫기 ----------
function openModal(id) {
  document.getElementById(id).hidden = false;
}
function closeModal(id) {
  document.getElementById(id).hidden = true;
}
document.querySelectorAll("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    closeModal(e.target.closest(".modal-overlay").id);
  });
});
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// ---------- 프로젝트 select 채우기 ----------
function populateProjectSelects() {
  const selects = [
    document.getElementById("quick-project-select"),
    document.getElementById("email-project-select"),
    document.getElementById("filter-project"),
  ];
  selects.forEach((sel, idx) => {
    const isFilter = idx === 2;
    const currentValue = sel.value;
    sel.innerHTML = isFilter
      ? '<option value="all">모든 프로젝트</option>'
      : '<option value="">없음</option>';
    state.projects.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
    if ([...sel.options].some((o) => o.value === currentValue)) {
      sel.value = currentValue;
    }
  });
}

// ---------- 필터 상태 ----------
let currentTab = "all";

document.getElementById("status-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  currentTab = btn.dataset.status;
  render();
});

document.getElementById("filter-project").addEventListener("change", render);
document.getElementById("filter-due").addEventListener("change", render);

function isOverdue(task) {
  return task.dueDate && task.status === "진행중" && task.dueDate < todayISO();
}

function matchesDueFilter(task, filter) {
  if (filter === "all") return true;
  if (filter === "none") return !task.dueDate;
  if (!task.dueDate) return false;
  const today = todayISO();
  if (filter === "overdue") return task.dueDate < today;
  if (filter === "today") return task.dueDate === today;
  if (filter === "week") {
    const diff = daysBetween(today, task.dueDate);
    return diff >= 0 && diff <= 7;
  }
  return true;
}

function projectName(id) {
  const p = state.projects.find((p) => p.id === id);
  return p ? p.name : null;
}

// ---------- 렌더링 ----------
function render() {
  populateProjectSelects();

  const projectFilter = document.getElementById("filter-project").value;
  const dueFilter = document.getElementById("filter-due").value;

  let tasks = state.tasks.filter((t) => {
    if (currentTab !== "all" && t.status !== currentTab) return false;
    if (projectFilter !== "all" && (t.projectId || "") !== projectFilter) return false;
    if (!matchesDueFilter(t, dueFilter)) return false;
    return true;
  });

  tasks = tasks.slice().sort((a, b) => {
    const da = a.dueDate || "9999-99-99";
    const db = b.dueDate || "9999-99-99";
    if (da !== db) return da < db ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  const list = document.getElementById("task-list");
  list.innerHTML = "";
  document.getElementById("empty-state").hidden = tasks.length > 0;

  tasks.forEach((task) => list.appendChild(renderTaskCard(task)));
}

function renderTaskCard(task) {
  const card = document.createElement("div");
  card.className = "task-card";
  card.addEventListener("click", () => openDetail(task.id));

  const top = document.createElement("div");
  top.className = "task-card-top";

  const title = document.createElement("p");
  title.className = "task-title";
  title.textContent = task.title;

  const badge = document.createElement("span");
  badge.className = `badge badge-${task.status}`;
  badge.textContent = task.status;

  top.appendChild(title);
  top.appendChild(badge);
  card.appendChild(top);

  const meta = document.createElement("div");
  meta.className = "task-meta";

  const pname = projectName(task.projectId);
  if (pname) {
    const tag = document.createElement("span");
    tag.className = "project-tag";
    tag.textContent = pname;
    meta.appendChild(tag);
  }

  const due = document.createElement("span");
  if (task.dueDate) {
    due.textContent = `마감 ${task.dueDate}`;
    if (isOverdue(task)) {
      due.className = "overdue";
      due.textContent += " (지남)";
    }
  } else {
    due.textContent = "마감일 없음";
  }
  meta.appendChild(due);

  if (task.status === "완료" && task.completedAt) {
    const dur = document.createElement("span");
    dur.textContent = `완료까지 ${daysBetween(task.createdAt, task.completedAt)}일 소요`;
    meta.appendChild(dur);
  }

  card.appendChild(meta);
  return card;
}

// ---------- 프로젝트 추가 ----------
document.getElementById("btn-add-project").addEventListener("click", () => {
  document.getElementById("project-name-input").value = "";
  openModal("modal-project");
});
document.getElementById("btn-save-project").addEventListener("click", () => {
  const name = document.getElementById("project-name-input").value.trim();
  if (!name) return alert("프로젝트 이름을 입력해주세요.");
  state.projects.push({ id: uid(), name, createdAt: new Date().toISOString() });
  saveState();
  closeModal("modal-project");
  render();
});

// ---------- 빠른 할일 추가 ----------
document.getElementById("btn-add-quick").addEventListener("click", () => {
  document.getElementById("quick-title-input").value = "";
  document.getElementById("quick-project-select").value = "";
  document.getElementById("quick-due-input").value = "";
  populateProjectSelects();
  openModal("modal-quick");
});
document.getElementById("btn-save-quick").addEventListener("click", () => {
  const title = document.getElementById("quick-title-input").value.trim();
  if (!title) return alert("제목을 입력해주세요.");
  const projectId = document.getElementById("quick-project-select").value || null;
  const dueDate = document.getElementById("quick-due-input").value || null;
  const now = new Date().toISOString();

  state.tasks.push({
    id: uid(),
    title,
    rawEmailContent: "",
    relatedFiles: [],
    projectId,
    status: "진행중",
    createdAt: now,
    dueDate,
    completedAt: null,
    generatedPrompt: null,
    statusHistory: [{ status: "진행중", changedAt: now }],
  });
  saveState();
  closeModal("modal-quick");
  render();
});

// ---------- 이메일로 추가 ----------
let pendingEmailFiles = [];

document.getElementById("btn-add-email").addEventListener("click", () => {
  document.getElementById("email-content-input").value = "";
  document.getElementById("email-project-select").value = "";
  pendingEmailFiles = [];
  renderFileChips();
  populateProjectSelects();
  openModal("modal-email");
});

document.getElementById("email-file-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const val = e.target.value.trim();
    if (val) {
      pendingEmailFiles.push(val);
      e.target.value = "";
      renderFileChips();
    }
  }
});

function renderFileChips() {
  const box = document.getElementById("email-file-chips");
  box.innerHTML = "";
  pendingEmailFiles.forEach((f, idx) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = f;
    const rm = document.createElement("button");
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      pendingEmailFiles.splice(idx, 1);
      renderFileChips();
    });
    chip.appendChild(rm);
    box.appendChild(chip);
  });
}

let lastCreatedTaskId = null;

document.getElementById("btn-save-email").addEventListener("click", () => {
  const content = document.getElementById("email-content-input").value.trim();
  if (!content) return alert("이메일 내용을 붙여넣어주세요.");
  const projectId = document.getElementById("email-project-select").value || null;

  const dueDate = parseDueDate(content);
  const title = generateTitle(content);
  const now = new Date().toISOString();
  const taskId = uid();

  const task = {
    id: taskId,
    title,
    rawEmailContent: content,
    relatedFiles: pendingEmailFiles.slice(),
    projectId,
    status: "진행중",
    createdAt: now,
    dueDate,
    completedAt: null,
    generatedPrompt: null,
    statusHistory: [{ status: "진행중", changedAt: now }],
  };
  task.generatedPrompt = buildPrompt(task);

  state.tasks.push(task);
  saveState();
  closeModal("modal-email");
  render();

  lastCreatedTaskId = taskId;
  if (!dueDate) {
    document.getElementById("due-date-fill-input").value = "";
    openModal("modal-due-date");
  } else {
    showPrompt(task.generatedPrompt);
  }
});

document.getElementById("btn-save-due-date").addEventListener("click", () => {
  const val = document.getElementById("due-date-fill-input").value;
  const task = state.tasks.find((t) => t.id === lastCreatedTaskId);
  if (task && val) {
    task.dueDate = val;
    task.generatedPrompt = buildPrompt(task);
    saveState();
    render();
  }
  closeModal("modal-due-date");
  if (task) showPrompt(task.generatedPrompt);
});

document.getElementById("btn-skip-due-date").addEventListener("click", () => {
  closeModal("modal-due-date");
  const task = state.tasks.find((t) => t.id === lastCreatedTaskId);
  if (task) showPrompt(task.generatedPrompt);
});

function showPrompt(text) {
  document.getElementById("prompt-output").value = text;
  openModal("modal-prompt");
}

document.getElementById("btn-copy-prompt").addEventListener("click", () => {
  copyText(document.getElementById("prompt-output").value, "prompt-output");
});

function copyText(text, sourceElId) {
  const finish = (ok) => {
    if (!ok) {
      const el = document.getElementById(sourceElId);
      el.select();
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => finish(true)).catch(() => finish(false));
  } else {
    finish(false);
  }
}

// ---------- 할일 상세 / 상태 변경 ----------
let currentDetailTaskId = null;

function openDetail(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  currentDetailTaskId = taskId;

  document.getElementById("detail-title").textContent = task.title;
  const badge = document.getElementById("detail-status-badge");
  badge.textContent = task.status;
  badge.className = `badge badge-${task.status}`;

  const meta = document.getElementById("detail-meta");
  meta.innerHTML = "";
  const metaItems = [
    `생성일: ${formatDateTime(task.createdAt)}`,
    `마감일: ${task.dueDate || "없음"}`,
  ];
  const pname = projectName(task.projectId);
  if (pname) metaItems.push(`프로젝트: ${pname}`);
  if (task.completedAt) {
    metaItems.push(`완료일: ${formatDateTime(task.completedAt)}`);
    metaItems.push(`소요 기간: ${daysBetween(task.createdAt, task.completedAt)}일`);
  }
  metaItems.forEach((txt) => {
    const span = document.createElement("span");
    span.textContent = txt;
    meta.appendChild(span);
  });

  const actions = document.getElementById("detail-status-actions");
  actions.innerHTML = "";
  STATUSES.filter((s) => s !== task.status).forEach((s) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary";
    btn.textContent = `${s}로 변경`;
    btn.addEventListener("click", () => changeStatus(task.id, s));
    actions.appendChild(btn);
  });

  const emailSection = document.getElementById("detail-email-section");
  if (task.rawEmailContent) {
    emailSection.hidden = false;
    document.getElementById("detail-email-content").textContent = task.rawEmailContent;
  } else {
    emailSection.hidden = true;
  }

  const filesSection = document.getElementById("detail-files-section");
  if (task.relatedFiles && task.relatedFiles.length) {
    filesSection.hidden = false;
    const ul = document.getElementById("detail-files-list");
    ul.innerHTML = "";
    task.relatedFiles.forEach((f) => {
      const li = document.createElement("li");
      li.textContent = f;
      ul.appendChild(li);
    });
  } else {
    filesSection.hidden = true;
  }

  const promptSection = document.getElementById("detail-prompt-section");
  if (task.generatedPrompt) {
    promptSection.hidden = false;
    document.getElementById("detail-prompt-content").value = task.generatedPrompt;
  } else {
    promptSection.hidden = true;
  }

  const timeline = document.getElementById("detail-timeline");
  timeline.innerHTML = "";
  task.statusHistory.forEach((h) => {
    const li = document.createElement("li");
    li.textContent = `${h.status} — ${formatDateTime(h.changedAt)}`;
    timeline.appendChild(li);
  });

  openModal("modal-detail");
}

document.getElementById("btn-copy-detail-prompt").addEventListener("click", () => {
  copyText(document.getElementById("detail-prompt-content").value, "detail-prompt-content");
});

function changeStatus(taskId, newStatus) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const now = new Date().toISOString();
  task.status = newStatus;
  task.statusHistory.push({ status: newStatus, changedAt: now });
  task.completedAt = newStatus === "완료" ? now : null;
  saveState();
  openDetail(taskId);
  render();
}

// ---------- 설정 ----------
document.getElementById("btn-settings").addEventListener("click", () => {
  document.getElementById("settings-folder-input").value = state.settings.taskFolder || "";
  openModal("modal-settings");
});
document.getElementById("btn-save-settings").addEventListener("click", () => {
  state.settings.taskFolder = document.getElementById("settings-folder-input").value.trim();
  saveState();
  closeModal("modal-settings");
});

// ---------- 초기 렌더 ----------
render();
