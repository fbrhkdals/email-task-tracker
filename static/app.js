// ---------- 상태 (서버에서 불러와 메모리에 들고 있다가, 변경 시마다 다시 불러옴) ----------
const STATUSES = ["진행중", "완료", "보류", "취소"];

let state = { settings: { taskFolder: "" }, projects: [], tasks: [] };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = "/login";
    return null;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || "요청 처리 중 오류가 발생했습니다.");
    return null;
  }
  return res.status === 204 ? null : res.json();
}

async function loadState() {
  const data = await api("GET", "/api/data");
  if (!data) return;
  state = data;
  render();
}

// ---------- 유틸 ----------
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

// ---------- 이메일에 파일 첨부 언급이 있는지 감지 (깜빡하고 안 보내는 걸 막기 위한 리마인더용) ----------
function mentionsFileKeyword(text) {
  if (!text) return false;
  return /첨부|파일\s*(첨부|참고|확인|공유)|문서\s*(첨부|참고)|스캔본|사진\s*첨부|자료\s*(첨부|공유)|attach(ed|ment)?|\.pdf|\.docx?|\.xlsx?|\.pptx?|\.zip/i.test(
    text
  );
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

## 관련 파일 (경로만 안내됨 — 내용은 이 프롬프트에 없으니 네가 직접 열어서 확인해야 함)
${files}

## 요청 사항
1. "${folder}" 아래에 이 할일 전용 폴더를 만들고, 아래 3가지를 구분해서 각각 파일로 저장해줘.
   - 이메일 원문 (raw)
   - 핵심 내용 요약 (summary)
   - 네가 지금 바로 처리한 결과물이 있다면 그 산출물
2. 이메일 내용을 한국어로 간단히 요약해줘.
3. 답장 초안 작성처럼 네가 스스로 처리 가능한 간단한 작업이 있다면 지금 바로 처리해줘.
4. 위 "관련 파일" 경로가 있다면 실제로 열어서 내용을 참고하고, 필요한 작업에 활용해줘.`;
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

// ---------- 프로젝트 관리 (추가 / 삭제) ----------
document.getElementById("btn-add-project").addEventListener("click", () => {
  document.getElementById("project-name-input").value = "";
  renderProjectManageList();
  openModal("modal-project");
});
document.getElementById("btn-save-project").addEventListener("click", async () => {
  const name = document.getElementById("project-name-input").value.trim();
  if (!name) return alert("프로젝트 이름을 입력해주세요.");
  const created = await api("POST", "/api/projects", { name });
  if (!created) return;
  await loadState();
  document.getElementById("project-name-input").value = "";
  renderProjectManageList();
});

function renderProjectManageList() {
  const list = document.getElementById("project-manage-list");
  list.innerHTML = "";

  if (state.projects.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.textContent = "아직 만든 프로젝트가 없습니다.";
    list.appendChild(li);
    return;
  }

  state.projects.forEach((p) => {
    const li = document.createElement("li");
    const taskCount = state.tasks.filter((t) => t.projectId === p.id).length;

    const label = document.createElement("span");
    label.textContent = p.name;
    if (taskCount > 0) {
      const count = document.createElement("span");
      count.className = "project-task-count";
      count.textContent = `할일 ${taskCount}개`;
      label.appendChild(count);
    }

    const del = document.createElement("button");
    del.className = "btn btn-danger";
    del.textContent = "삭제";
    del.addEventListener("click", () => deleteProject(p.id, taskCount));

    li.appendChild(label);
    li.appendChild(del);
    list.appendChild(li);
  });
}

async function deleteProject(projectId, taskCount) {
  const msg = taskCount > 0
    ? `이 프로젝트를 삭제하면 소속된 할일 ${taskCount}개는 삭제되지 않고 "프로젝트 없음" 상태로 남습니다. 계속할까요?`
    : "이 프로젝트를 삭제할까요?";
  if (!confirm(msg)) return;

  await api("DELETE", `/api/projects/${projectId}`);
  await loadState();
  renderProjectManageList();
}

// ---------- 빠른 할일 추가 ----------
document.getElementById("btn-add-quick").addEventListener("click", () => {
  document.getElementById("quick-title-input").value = "";
  document.getElementById("quick-project-select").value = "";
  document.getElementById("quick-due-input").value = "";
  populateProjectSelects();
  openModal("modal-quick");
});
document.getElementById("btn-save-quick").addEventListener("click", async () => {
  const title = document.getElementById("quick-title-input").value.trim();
  if (!title) return alert("제목을 입력해주세요.");
  const projectId = document.getElementById("quick-project-select").value || null;
  const dueDate = document.getElementById("quick-due-input").value || null;

  const created = await api("POST", "/api/tasks", {
    title,
    rawEmailContent: "",
    projectId,
    dueDate,
  });
  if (!created) return;
  closeModal("modal-quick");
  await loadState();
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

// 브라우저 보안 정책상 드래그한 파일의 실제 폴더 경로는 알 수 없다 (파일 이름만 얻을 수 있음).
// 그래서 설정에 등록된 할일 폴더를 붙여 경로를 추정해준다 — 파일이 다른 폴더에 있다면 사용자가 직접 고쳐야 한다.
function guessFilePath(filename) {
  const folder = (state.settings.taskFolder || "").trim();
  if (!folder) return filename;
  return folder.replace(/[\\/]+$/, "") + "\\" + filename;
}

const fileDropzone = document.getElementById("email-file-dropzone");
["dragenter", "dragover"].forEach((evt) => {
  fileDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    fileDropzone.classList.add("drag-over");
  });
});
["dragleave", "drop"].forEach((evt) => {
  fileDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    fileDropzone.classList.remove("drag-over");
  });
});
fileDropzone.addEventListener("drop", (e) => {
  const files = Array.from(e.dataTransfer.files || []);
  files.forEach((file) => pendingEmailFiles.push(guessFilePath(file.name)));
  if (files.length) renderFileChips();
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

document.getElementById("btn-save-email").addEventListener("click", async () => {
  const content = document.getElementById("email-content-input").value.trim();
  if (!content) return alert("이메일 내용을 붙여넣어주세요.");
  const projectId = document.getElementById("email-project-select").value || null;

  const dueDate = parseDueDate(content);
  const title = generateTitle(content);

  const created = await api("POST", "/api/tasks", {
    title,
    rawEmailContent: content,
    projectId,
    dueDate,
    relatedFiles: pendingEmailFiles,
  });
  if (!created) return;

  closeModal("modal-email");
  await loadState();

  lastCreatedTaskId = created.id;
  if (!dueDate) {
    document.getElementById("due-date-fill-input").value = "";
    openModal("modal-due-date");
  } else {
    showPrompt(created);
  }
});

document.getElementById("btn-save-due-date").addEventListener("click", async () => {
  const val = document.getElementById("due-date-fill-input").value;
  let task = state.tasks.find((t) => t.id === lastCreatedTaskId);
  if (task && val) {
    const updated = await api("PATCH", `/api/tasks/${task.id}/due_date`, { dueDate: val });
    if (updated) {
      task = updated;
      await loadState();
    }
  }
  closeModal("modal-due-date");
  if (task) showPrompt(task);
});

document.getElementById("btn-skip-due-date").addEventListener("click", () => {
  closeModal("modal-due-date");
  const task = state.tasks.find((t) => t.id === lastCreatedTaskId);
  if (task) showPrompt(task);
});

function needsFileReminder(task) {
  return mentionsFileKeyword(task.rawEmailContent) && (!task.relatedFiles || task.relatedFiles.length === 0);
}

function showPrompt(task) {
  document.getElementById("prompt-output").value = buildPrompt(task);
  document.getElementById("prompt-file-reminder").hidden = !needsFileReminder(task);
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
function openDetail(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;

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
  if (task.automatedAt) {
    metaItems.push(`🤖 자동 처리됨: ${formatDateTime(task.automatedAt)}`);
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
  if (task.rawEmailContent) {
    promptSection.hidden = false;
    document.getElementById("detail-prompt-content").value = buildPrompt(task);
    document.getElementById("detail-file-reminder").hidden = !needsFileReminder(task);
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

async function changeStatus(taskId, newStatus) {
  const updated = await api("PATCH", `/api/tasks/${taskId}/status`, { status: newStatus });
  if (!updated) return;
  await loadState();
  openDetail(taskId);
}

// ---------- 설정 ----------
document.getElementById("btn-settings").addEventListener("click", () => {
  document.getElementById("settings-folder-input").value = state.settings.taskFolder || "";
  openModal("modal-settings");
});
document.getElementById("btn-save-settings").addEventListener("click", async () => {
  const taskFolder = document.getElementById("settings-folder-input").value.trim();
  const res = await api("PATCH", "/api/settings", { taskFolder });
  if (res) {
    state.settings.taskFolder = taskFolder;
  }
  closeModal("modal-settings");
});

// ---------- 초기 렌더 ----------
loadState();
