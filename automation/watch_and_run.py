"""
새로 등록된 이메일 할일을 찾아 Claude Code(headless: `claude -p`)로 자동 처리한다.

한 번 실행하면 처리 대상 할일을 전부 처리하고 종료한다 (상시 실행 프로세스가 아님).
Windows 작업 스케줄러 등으로 몇 분 간격 반복 실행하도록 등록해서 쓴다.

이 스크립트는 할일의 "상태"는 절대 바꾸지 않는다 — 상태 변경은 항상 사람이
웹사이트에서 직접 하는 것이 원칙이기 때문. 여기서는 프롬프트를 Claude에게
넘겨서 실행시키고, 처리 완료 표시(automated_at)만 남긴다.
"""

import shlex
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import requests
from dotenv import load_dotenv
import os

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env.automation")

SITE_URL = os.environ.get("SITE_URL", "").rstrip("/")
USERNAME = os.environ.get("EMAIL_TASK_USERNAME", "")
PASSWORD = os.environ.get("EMAIL_TASK_PASSWORD", "")
CLAUDE_CMD = os.environ.get("CLAUDE_CMD", "claude")
LOG_FILE = BASE_DIR / "automation.log"


def log(message):
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}"
    print(line)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def login(session):
    session.post(
        f"{SITE_URL}/login",
        data={"username": USERNAME, "password": PASSWORD},
        allow_redirects=True,
    )
    check = session.get(f"{SITE_URL}/api/data")
    if check.status_code != 200:
        raise RuntimeError("로그인에 실패했습니다. .env.automation의 아이디/비밀번호를 확인하세요.")


def run_claude(prompt, cwd):
    result = subprocess.run(
        shlex.split(CLAUDE_CMD, posix=False) + ["-p", prompt],
        cwd=cwd if cwd and Path(cwd).is_dir() else None,
        capture_output=True,
        text=True,
        timeout=600,
    )
    return result


def main():
    if not SITE_URL or not USERNAME or not PASSWORD:
        log("설정이 비어 있습니다. automation/.env.automation 파일을 만들고 값을 채워주세요.")
        sys.exit(1)

    session = requests.Session()
    login(session)

    resp = session.get(f"{SITE_URL}/api/tasks/pending-automation")
    resp.raise_for_status()
    tasks = resp.json().get("tasks", [])

    if not tasks:
        log("처리할 새 할일이 없습니다.")
        return

    data_resp = session.get(f"{SITE_URL}/api/data")
    task_folder = data_resp.json().get("settings", {}).get("taskFolder") or None

    for task in tasks:
        log(f"처리 시작: [{task['id']}] {task['title']}")
        try:
            result = run_claude(task["prompt"], task_folder)
        except Exception as e:
            log(f"  실행 실패 (Claude 호출 중 오류): {e}")
            continue

        if result.returncode != 0:
            log(f"  Claude 실행이 오류로 종료됨 (코드 {result.returncode}). 자동완료 표시하지 않고 다음 실행 때 재시도합니다.")
            log(f"  stderr: {result.stderr[:500]}")
            continue

        log(f"  Claude 처리 완료 (출력 {len(result.stdout)}자)")
        mark_resp = session.patch(f"{SITE_URL}/api/tasks/{task['id']}/automated")
        if mark_resp.status_code == 200:
            log(f"  처리 완료 표시함: [{task['id']}]")
        else:
            log(f"  처리 완료 표시 실패 (status {mark_resp.status_code}) — 다음 실행 때 다시 시도됩니다.")


if __name__ == "__main__":
    main()
