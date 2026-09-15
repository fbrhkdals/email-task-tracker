import hashlib
import os
import secrets
from functools import wraps

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

load_dotenv()

DATABASE_URL = os.environ["DATABASE_URL"]

app = Flask(__name__)
app.secret_key = os.environ["SECRET_KEY"]

_connection = None


def get_db():
    global _connection
    if _connection is None or _connection.closed:
        _connection = psycopg2.connect(DATABASE_URL)
        _connection.autocommit = True
    else:
        try:
            with _connection.cursor() as cur:
                cur.execute("SELECT 1")
        except psycopg2.Error:
            _connection = psycopg2.connect(DATABASE_URL)
            _connection.autocommit = True
    return _connection


def init_db():
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    task_folder TEXT NOT NULL DEFAULT '',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS projects (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS tasks (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                    title TEXT NOT NULL,
                    raw_email_content TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT '진행중',
                    due_date DATE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    completed_at TIMESTAMPTZ,
                    status_history JSONB NOT NULL DEFAULT '[]'
                )
                """
            )
            cur.execute(
                "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS automated_at TIMESTAMPTZ"
            )
            cur.execute(
                "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS related_files JSONB NOT NULL DEFAULT '[]'"
            )
            cur.execute(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS automation_token_hash TEXT"
            )
            cur.execute(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS automation_last_seen TIMESTAMPTZ"
            )
        conn.commit()
    finally:
        conn.close()


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if "user_id" not in session:
            return redirect(url_for("login"))
        return view(*args, **kwargs)

    return wrapped


def api_login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if "user_id" not in session:
            return jsonify(error="로그인이 필요합니다."), 401
        return view(*args, **kwargs)

    return wrapped


def hash_token(raw_token):
    return hashlib.sha256(raw_token.encode()).hexdigest()


def resolve_automation_user_id():
    """Authorization: Bearer <자동화 토큰> 헤더로 사용자를 찾고, 성공하면
    마지막 접속 시각을 갱신한다 (설정 화면의 연결 상태 표시에 쓰임)."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[len("Bearer ") :].strip()
    if not token:
        return None

    db = get_db()
    with db.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT id FROM users WHERE automation_token_hash = %s", (hash_token(token),)
        )
        row = cur.fetchone()
    if not row:
        return None

    with db.cursor() as cur:
        cur.execute(
            "UPDATE users SET automation_last_seen = NOW() WHERE id = %s", (row["id"],)
        )
    return row["id"]


def automation_or_session_required(view):
    """자동화 스크립트(토큰)와 브라우저(세션 쿠키) 양쪽에서 호출 가능한 엔드포인트용."""

    @wraps(view)
    def wrapped(*args, **kwargs):
        user_id = session.get("user_id") or resolve_automation_user_id()
        if user_id is None:
            return jsonify(error="인증이 필요합니다."), 401
        request.resolved_user_id = user_id
        return view(*args, **kwargs)

    return wrapped


def serialize_task(row):
    return {
        "id": str(row["id"]),
        "title": row["title"],
        "rawEmailContent": row["raw_email_content"] or "",
        "projectId": str(row["project_id"]) if row["project_id"] is not None else None,
        "status": row["status"],
        "createdAt": row["created_at"].isoformat(),
        "dueDate": row["due_date"].isoformat() if row["due_date"] else None,
        "completedAt": row["completed_at"].isoformat() if row["completed_at"] else None,
        "statusHistory": row["status_history"],
        "automatedAt": row["automated_at"].isoformat() if row.get("automated_at") else None,
        "relatedFiles": row.get("related_files") or [],
    }


def build_prompt(task, task_folder):
    folder = task_folder or "(설정에서 데스크탑 할일 폴더 경로를 지정해주세요)"
    files = task.get("relatedFiles") or []
    file_lines = "\n".join(f"- {f}" for f in files) if files else "없음"
    due_label = task["dueDate"] or "기한없음"

    return f"""[할일 처리 요청]

## 제목
{task["title"]}

## 이메일 원문
{task["rawEmailContent"] or "(원문 없음)"}

## 마감일
{task["dueDate"] or "지정되지 않음"}

## 관련 파일 (경로만 안내됨 — 내용은 이 프롬프트에 없으니 네가 직접 열어서 확인해야 함)
{file_lines}

## 요청 사항
1. "{folder}" 안에 마감일 폴더("{due_label}")가 이미 있는지 확인해줘 — 있으면 그 폴더를 그대로 쓰고, 없으면 새로 만들어줘. 그 마감일 폴더 안에 이 할일의 주제를 담은 구체적인 이름("{task["title"]}" 같이 — "내용 정리"나 "요약"처럼 두루뭉술한 이름 말고)으로 하위 폴더를 만들고, 그 안에 아래 항목들을 저장해줘.
   - 이메일 원문 (raw) — 별도로 형식을 지정하지 않는 한 텍스트 파일(.txt)로 저장해줘 (마크다운 .md로 저장하지 마).
   - 핵심 내용 요약 (summary) — 관련 파일이 있고 그 파일이 워드/엑셀/파워포인트 같은 특정 형식이면 그 형식에 맞춰 저장하고, 그렇지 않으면 .txt로 저장해줘.
   - 네가 지금 바로 처리한 결과물이 있다면 그 산출물 — 이것도 특별한 지정이 없으면 관련 파일과 같은 형식으로, 관련 파일이 없으면 .txt로 저장해줘.
   - 관련 파일이 있다면, 그 원본 파일도 이 폴더 안에 그대로 복사해서 함께 넣어줘 (경로만 안내하는 게 아니라 실제 사본을 남겨줘).
2. 이메일 내용을 한국어로 간단히 요약해줘.
3. 답장 초안 작성처럼 네가 스스로 처리 가능한 간단한 작업이 있다면 지금 바로 처리해줘.
4. 위 "관련 파일" 경로가 있다면 실제로 열어서 내용을 참고하고, 필요한 작업에 활용해줘."""


# ---------- 인증 ----------
@app.route("/signup", methods=["GET", "POST"])
def signup():
    if request.method == "GET":
        return render_template("signup.html", error=None)

    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")
    if not username or not password:
        return render_template("signup.html", error="아이디와 비밀번호를 모두 입력해주세요.")

    db = get_db()
    with db.cursor() as cur:
        cur.execute("SELECT id FROM users WHERE username = %s", (username,))
        if cur.fetchone():
            return render_template("signup.html", error="이미 사용 중인 아이디입니다.")
        cur.execute(
            "INSERT INTO users (username, password_hash) VALUES (%s, %s) RETURNING id",
            (username, generate_password_hash(password)),
        )
        user_id = cur.fetchone()[0]
    db.commit()

    session["user_id"] = user_id
    session["username"] = username
    return redirect(url_for("index"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        return render_template("login.html", error=None)

    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")

    db = get_db()
    with db.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT id, password_hash FROM users WHERE username = %s", (username,))
        user = cur.fetchone()

    if not user or not check_password_hash(user["password_hash"], password):
        return render_template("login.html", error="아이디 또는 비밀번호가 올바르지 않습니다.")

    session["user_id"] = user["id"]
    session["username"] = username
    return redirect(url_for("index"))


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
@login_required
def index():
    return render_template("index.html", username=session["username"])


# ---------- API ----------
@app.route("/api/data")
@api_login_required
def api_data():
    uid = session["user_id"]
    db = get_db()
    with db.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT id, name, created_at FROM projects WHERE user_id = %s ORDER BY created_at",
            (uid,),
        )
        projects = [
            {"id": str(r["id"]), "name": r["name"], "createdAt": r["created_at"].isoformat()}
            for r in cur.fetchall()
        ]

        cur.execute(
            "SELECT * FROM tasks WHERE user_id = %s ORDER BY created_at DESC", (uid,)
        )
        tasks = [serialize_task(r) for r in cur.fetchall()]

        cur.execute("SELECT task_folder FROM users WHERE id = %s", (uid,))
        folder_row = cur.fetchone()
        folder = (folder_row["task_folder"] if folder_row else "") or ""

    return jsonify({"settings": {"taskFolder": folder}, "projects": projects, "tasks": tasks})


@app.route("/api/settings", methods=["PATCH"])
@api_login_required
def api_settings():
    data = request.get_json(force=True) or {}
    folder = (data.get("taskFolder") or "").strip()
    db = get_db()
    with db.cursor() as cur:
        cur.execute(
            "UPDATE users SET task_folder = %s WHERE id = %s", (folder, session["user_id"])
        )
    db.commit()
    return jsonify(ok=True)


@app.route("/api/projects", methods=["POST"])
@api_login_required
def api_create_project():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify(error="이름이 필요합니다."), 400

    db = get_db()
    with db.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "INSERT INTO projects (user_id, name) VALUES (%s, %s) RETURNING id, name, created_at",
            (session["user_id"], name),
        )
        row = cur.fetchone()
    db.commit()
    return jsonify({"id": str(row["id"]), "name": row["name"], "createdAt": row["created_at"].isoformat()})


@app.route("/api/projects/<int:project_id>", methods=["DELETE"])
@api_login_required
def api_delete_project(project_id):
    db = get_db()
    with db.cursor() as cur:
        cur.execute(
            "DELETE FROM projects WHERE id = %s AND user_id = %s",
            (project_id, session["user_id"]),
        )
    db.commit()
    return jsonify(ok=True)


@app.route("/api/tasks", methods=["POST"])
@api_login_required
def api_create_task():
    data = request.get_json(force=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify(error="제목이 필요합니다."), 400

    raw_email_content = data.get("rawEmailContent") or ""
    project_id = data.get("projectId") or None
    due_date = data.get("dueDate") or None
    related_files = [f.strip() for f in (data.get("relatedFiles") or []) if f.strip()]

    db = get_db()
    with db.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO tasks
                (user_id, project_id, title, raw_email_content, due_date, status_history, related_files)
            VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb)
            RETURNING *
            """,
            (
                session["user_id"],
                project_id,
                title,
                raw_email_content,
                due_date,
                psycopg2.extras.Json([{"status": "진행중", "changedAt": _now_iso()}]),
                psycopg2.extras.Json(related_files),
            ),
        )
        row = cur.fetchone()
    db.commit()
    return jsonify(serialize_task(row))


@app.route("/api/tasks/<int:task_id>/due_date", methods=["PATCH"])
@api_login_required
def api_update_due_date(task_id):
    data = request.get_json(force=True) or {}
    due_date = data.get("dueDate") or None
    db = get_db()
    with db.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "UPDATE tasks SET due_date = %s WHERE id = %s AND user_id = %s RETURNING *",
            (due_date, task_id, session["user_id"]),
        )
        row = cur.fetchone()
    db.commit()
    if not row:
        return jsonify(error="not found"), 404
    return jsonify(serialize_task(row))


@app.route("/api/tasks/<int:task_id>/status", methods=["PATCH"])
@api_login_required
def api_update_status(task_id):
    data = request.get_json(force=True) or {}
    new_status = data.get("status")
    if new_status not in ("진행중", "완료", "보류", "취소"):
        return jsonify(error="invalid status"), 400

    db = get_db()
    with db.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT status_history FROM tasks WHERE id = %s AND user_id = %s",
            (task_id, session["user_id"]),
        )
        row = cur.fetchone()
        if not row:
            return jsonify(error="not found"), 404

        history = row["status_history"] + [{"status": new_status, "changedAt": _now_iso()}]

        cur.execute(
            f"""
            UPDATE tasks
            SET status = %s,
                status_history = %s::jsonb,
                completed_at = {"NOW()" if new_status == "완료" else "NULL"}
            WHERE id = %s AND user_id = %s
            RETURNING *
            """,
            (new_status, psycopg2.extras.Json(history), task_id, session["user_id"]),
        )
        row = cur.fetchone()
    db.commit()
    return jsonify(serialize_task(row))


@app.route("/api/tasks/<int:task_id>/prompt")
@automation_or_session_required
def api_task_prompt(task_id):
    uid = request.resolved_user_id
    db = get_db()
    with db.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT * FROM tasks WHERE id = %s AND user_id = %s", (task_id, uid))
        row = cur.fetchone()
        if not row:
            return jsonify(error="not found"), 404
        cur.execute("SELECT task_folder FROM users WHERE id = %s", (uid,))
        folder_row = cur.fetchone()
        folder = (folder_row["task_folder"] if folder_row else "") or ""

    return jsonify(prompt=build_prompt(serialize_task(row), folder))


@app.route("/api/tasks/pending-automation")
@automation_or_session_required
def api_pending_automation():
    """자동화 스크립트가 폴링하는 엔드포인트: 아직 Claude로 처리하지 않은,
    이메일에서 생성된 진행중 할일 목록을 반환한다."""
    uid = request.resolved_user_id
    db = get_db()
    with db.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT * FROM tasks
            WHERE user_id = %s
              AND status = '진행중'
              AND automated_at IS NULL
              AND raw_email_content <> ''
            ORDER BY created_at
            """,
            (uid,),
        )
        rows = cur.fetchall()
        cur.execute("SELECT task_folder FROM users WHERE id = %s", (uid,))
        folder_row = cur.fetchone()
        folder = (folder_row["task_folder"] if folder_row else "") or ""

    tasks = [serialize_task(r) for r in rows]
    for t in tasks:
        t["prompt"] = build_prompt(t, folder)
    return jsonify(tasks=tasks, taskFolder=folder)


@app.route("/api/tasks/<int:task_id>/automated", methods=["PATCH"])
@automation_or_session_required
def api_mark_automated(task_id):
    uid = request.resolved_user_id
    db = get_db()
    with db.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "UPDATE tasks SET automated_at = NOW() WHERE id = %s AND user_id = %s RETURNING *",
            (task_id, uid),
        )
        row = cur.fetchone()
    db.commit()
    if not row:
        return jsonify(error="not found"), 404
    return jsonify(serialize_task(row))


# ---------- PC 연동 (자동화 토큰) ----------
@app.route("/api/automation/connect", methods=["POST"])
@api_login_required
def api_automation_connect():
    raw_token = secrets.token_urlsafe(32)
    db = get_db()
    with db.cursor() as cur:
        cur.execute(
            "UPDATE users SET automation_token_hash = %s, automation_last_seen = NULL WHERE id = %s",
            (hash_token(raw_token), session["user_id"]),
        )
    return jsonify(token=raw_token)


@app.route("/api/automation/disconnect", methods=["POST"])
@api_login_required
def api_automation_disconnect():
    db = get_db()
    with db.cursor() as cur:
        cur.execute(
            "UPDATE users SET automation_token_hash = NULL, automation_last_seen = NULL WHERE id = %s",
            (session["user_id"],),
        )
    return jsonify(ok=True)


@app.route("/api/automation/status")
@api_login_required
def api_automation_status():
    db = get_db()
    with db.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT automation_token_hash, automation_last_seen FROM users WHERE id = %s",
            (session["user_id"],),
        )
        row = cur.fetchone()
    return jsonify(
        linked=row["automation_token_hash"] is not None,
        lastSeen=row["automation_last_seen"].isoformat() if row["automation_last_seen"] else None,
    )


def _now_iso():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


init_db()

if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=5000)
