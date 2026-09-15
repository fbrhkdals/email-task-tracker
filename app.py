import os
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

    return f"""[할일 처리 요청]

## 이메일 원문
{task["rawEmailContent"] or "(원문 없음)"}

## 마감일
{task["dueDate"] or "지정되지 않음"}

## 관련 파일 (경로만 안내됨 — 내용은 이 프롬프트에 없으니 네가 직접 열어서 확인해야 함)
{file_lines}

## 요청 사항
1. "{folder}" 아래에 이 할일 전용 폴더를 만들고, 아래 3가지를 구분해서 각각 파일로 저장해줘.
   - 이메일 원문 (raw)
   - 핵심 내용 요약 (summary)
   - 네가 지금 바로 처리한 결과물이 있다면 그 산출물
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
        folder = cur.fetchone()["task_folder"] or ""

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
@api_login_required
def api_task_prompt(task_id):
    db = get_db()
    with db.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT * FROM tasks WHERE id = %s AND user_id = %s", (task_id, session["user_id"])
        )
        row = cur.fetchone()
        if not row:
            return jsonify(error="not found"), 404
        cur.execute("SELECT task_folder FROM users WHERE id = %s", (session["user_id"],))
        folder = cur.fetchone()["task_folder"] or ""

    return jsonify(prompt=build_prompt(serialize_task(row), folder))


@app.route("/api/tasks/pending-automation")
@api_login_required
def api_pending_automation():
    """자동화 스크립트가 폴링하는 엔드포인트: 아직 Claude로 처리하지 않은,
    이메일에서 생성된 진행중 할일 목록을 반환한다."""
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
            (session["user_id"],),
        )
        rows = cur.fetchall()
        cur.execute("SELECT task_folder FROM users WHERE id = %s", (session["user_id"],))
        folder = cur.fetchone()["task_folder"] or ""

    tasks = [serialize_task(r) for r in rows]
    for t in tasks:
        t["prompt"] = build_prompt(t, folder)
    return jsonify(tasks=tasks)


@app.route("/api/tasks/<int:task_id>/automated", methods=["PATCH"])
@api_login_required
def api_mark_automated(task_id):
    db = get_db()
    with db.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "UPDATE tasks SET automated_at = NOW() WHERE id = %s AND user_id = %s RETURNING *",
            (task_id, session["user_id"]),
        )
        row = cur.fetchone()
    db.commit()
    if not row:
        return jsonify(error="not found"), 404
    return jsonify(serialize_task(row))


def _now_iso():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


init_db()

if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=5000)
