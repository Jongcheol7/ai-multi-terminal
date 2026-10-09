# Claude Terminal — 사용 가이드

> **2026-10-04 업데이트:** VS Code 형태의 작업 공간, 프로젝트별 세션 목록, 연결 복구와 로컬 기록 보관을 추가했습니다. 아래의 이전 화면 설명보다 [현재 기능과 적용 방법](docs/workbench-2026-10-04.md)을 우선 참고하세요.

브라우저에서 여러 개의 PowerShell + Claude Code / Codex 터미널을 동시에 띄우고, 활성 터미널에 멀티라인 입력을 보내거나 출력을 깔끔하게 복사하기 위한 로컬 웹 앱.

- **위치**: `D:\claude-terminal\`
- **포트**: `http://localhost:3900`
- **스택**: Express + express-ws + node-pty + xterm.js (5.3)

---

## 0. 설치 (새 PC 첫 셋업)

```bash
git clone https://github.com/Jongcheol7/ai-multi-terminal.git
cd ai-multi-terminal
npm install
```

`node` (>= 18) 와 `npm` 이 설치되어 있어야 합니다. 그리고 사용하려는 도구(`claude`, `codex`)가 PATH 에 잡혀 있어야 자동 실행됩니다 (옵션).

### 프리셋 설정

`config.json` 은 사용자별 데이터라 git 에서 제외되어 있습니다. 두 가지 방법:

- **앱 UI**: 첫 실행 후 헤더의 `Settings` 에서 추가 (자동으로 `config.json` 생성됨)
- **수동**: `config.example.json` 을 `config.json` 으로 복사 후 본인 경로로 편집

`config.json` 이 없어도 빈 프리셋으로 앱은 정상 작동합니다 — `+ Terminal` 로 빈 셸을 띄우거나 Settings 에서 추가하세요.

## 1. 실행

```bash
npm start
# 또는 (Windows)
start-server.bat
```

브라우저에서 `http://localhost:3900` 접속.

서버를 끄려면 그 콘솔창을 직접 닫는다. **`taskkill` / 포트 kill 금지** — 다른 Claude 세션까지 같이 죽음.

---

## 2. 화면 구성

```
┌─ 상단 헤더 ───────────────────────────────────────────┐
│ Logo  [+ Terminal] [Preset ▾] [Settings] [📋 Clipboard]│
├──────────────────────────────────────────────────────┤
│ ┌─ Panel A ─┐│┌─ Panel B ─┐│┌─ Panel C ─┐         │
│ │  ◀ ▶ ─ ✕  │││  ◀ ▶ ─ ✕  │││  ◀ ▶ ─ ✕  │         │
│ │           │││           │││           │         │
│ │  xterm    │││  xterm    │││  xterm    │         │
│ │           │││           │││           │         │
│ └───────────┘└───────────┘└───────────┘           │
├═══════ ↕ 드래그하여 높이 조절 ═══════════════════════┤
│ → <활성패널>            Enter=줄바꿈 Ctrl+Enter=전송 │
│ ┌──────────────────────────────────┬──────────────┐│
│ │ 멀티라인 입력 textarea            │   Send 버튼   ││
│ └──────────────────────────────────┴──────────────┘│
└──────────────────────────────────────────────────────┘
```

---

## 3. 터미널 패널 조작

### 새 터미널

- **+ Terminal** — 빈 PowerShell
- **Preset ▾ → 프로젝트 선택 → 도구 선택 (Claude Code / Codex / Shell)**
- **Ctrl+Shift+T** — 빈 터미널 단축키

### 패널 헤더 버튼

| 버튼 | 의미 |
|---|---|
| `◀` | 한 칸 왼쪽으로 이동 (맨 왼쪽이면 hidden) |
| `▶` | 한 칸 오른쪽으로 이동 (맨 오른쪽이면 hidden) |
| `─` | 최소화 (세로 핸들로 접힘, 클릭하면 복원) |
| `✕` | 종료 |

### 리사이즈 / 활성

- 패널 사이 경계선 드래그 → 좌우 폭 조절
- 패널 클릭 → **활성 패널** (헤더 강조 + 하단 composer 가 이쪽으로 향함)

---

## 4. 하단 입력창 (Composer)

- **Enter** = 줄바꿈
- **Ctrl+Enter** = 활성 터미널로 전송
- **Send 버튼** = Ctrl+Enter 와 동일

내부적으로 **bracketed paste** (`ESC[200~ ... ESC[201~`) 로 보내고, 120ms 후 별도로 `\r` 을 보내 자동 실행. 따라서 Claude Code 가 멀티라인을 단일 paste 로 인식하고 그대로 실행함.

### 컴포저 높이 조절

상단 4px 띠를 위/아래로 드래그. 새로고침 후에도 `localStorage` 에 저장됨.

---

## 5. 터미널 출력 복사

드래그 → **Ctrl+C** 누르면:

- xterm 의 `isWrapped` 플래그를 보고 시각적 wrap 으로 쪼개진 줄을 **하나의 논리 줄로 합쳐서** 클립보드에 넣음
- 줄 끝 trailing space 정리
- Windows 호환을 위해 `\n` → `\r\n` 정규화

### 한계

Claude Code 같은 TUI 앱은 폭에 맞춰 **자기가 직접 줄을 쪼개서** 출력하는 경우가 많다. 이 경우 `isWrapped` 가 false 라서 합쳐지지 않음 → **터미널 폭이 좁으면 한글이 wrap 위치에서 끊겨 깨져 보임**.

**대응**: 아래 §6 클립보드 메모장 워크플로우를 사용한다.

---

## 6. 클립보드 메모장 워크플로우 (핵심)

긴 출력이나 한글이 많은 답변을 깨끗하게 복사하기 위한 패턴.

### 흐름

1. Claude 세션에 다음 트리거 문구 중 하나로 요청:
   - `복붙용 파일에 써줘`
   - `파일로 줘`
   - `복사하기 쉽게 정리해서 파일로`
   - `메모장에 써줘`
   - `MD로 줘`
   - `클립보드에 써줘`
2. Claude 가 `D:\claude-terminal\clipboard\clipboard.md` 에 **전체 덮어쓰기** (이전 내용은 사라짐 — 빈 메모장 효과)
3. 채팅에는 짧은 안내만 (`→ clipboard.md 에 저장 ...`)
4. 웹앱 헤더 **📋 Clipboard** 클릭 → 모달에 내용 표시
5. **Copy All** 버튼으로 깨끗하게 복사 (Windows `\r\n` 정규화)

### 모달 버튼

| 버튼 | 동작 |
|---|---|
| Copy All | textarea 내용 전체를 클립보드로 |
| ↻ Refresh | 파일 다시 읽기 (Claude 가 방금 쓴 내용 반영) |
| Clear | 파일 내용 비우기 (확인 다이얼로그 후) |
| Close | 모달 닫기 |

### 글로벌 룰

`C:\Users\Administrator\.claude\CLAUDE.md` 에 **[필수] 복붙용 임시 메모장** 섹션이 박혀있어, 모든 프로젝트의 Claude 세션이 동일한 트리거에 동일한 동작을 한다. 새 세션부터 적용 — 이미 떠있는 세션은 룰을 모르므로 닫고 새로 띄울 것.

### 특별 케이스

- **이어서 추가하고 싶을 때**: `"이어서 써줘"` / `"추가해줘"` 명시 → Claude 가 Read 후 append
- **누적 보관용 분석 문서**: 이 메모장이 아니라 `D:\개발자료\<시스템>\<프로그램>\` 의 분석 md 에 정리 (별도 룰)

---

## 7. 프리셋 관리

### 프리셋 사용

`Preset ▾` → 항목 클릭 → 도구 선택 모달 → Claude / Codex / Shell

### 프리셋 추가/수정

`Settings` → 모달에서 Name + Working directory 입력 → Save

저장 위치: `D:\claude-terminal\config.json`

```json
{
  "presets": [
    { "name": "KERP", "cwd": "D:\\kccfw\\workspace_kerp\\kerp" },
    { "name": "그룹웨어", "cwd": "D:\\kccfw\\workspace_kerp\\gw-appr" }
    // ...
  ]
}
```

`claude` 필드는 **하위호환용**이며 더 이상 권장하지 않음 — 도구 선택은 매번 모달에서 고른다.

---

## 8. 단축키 정리

| 단축키 | 동작 |
|---|---|
| `Ctrl+Shift+T` | 빈 터미널 추가 |
| `Ctrl+Shift+R` | (브라우저) 강력 새로고침 — 정적파일 캐시 무시 |
| `Ctrl+V` | 활성 터미널에 붙여넣기 |
| `Ctrl+C` | 선택영역 있을 때 → 복사 (논리 줄 합치기 적용) / 없을 때 → SIGINT |
| 우클릭 | 터미널에 붙여넣기 |
| `Ctrl+Enter` (composer) | 활성 터미널로 전송 |
| `Enter` (composer) | 줄바꿈 |

---

## 9. 트러블슈팅

### 포트 충돌 (3900 사용 중)

서버 콘솔이 `EADDRINUSE` 출력하고 죽음. **kill 하지 말고**:
- 다른 서버 창이 떠있으면 그걸 닫는다
- 또는 `server.js` 의 `PORT = 3900` 을 다른 값으로 바꾸고 재시작

### Claude 가 clipboard.md 를 모름

`tempNote.txt` 같은 다른 임시파일에 쓰려고 묻는 경우 → 그 세션은 글로벌 룰 추가 이전에 시작된 세션. **닫고 새로 띄운다**. 룰은 새 세션부터 적용됨.

### 터미널 글자가 스크롤바 뒤로 들어감

브라우저 강력 새로고침(`Ctrl+Shift+R`) 후 창 크기 한 번 조정 → FitAddon 재계산.

### 한글 복사 깨짐

폭이 좁아서 Claude 가 manual wrap 한 경우. §6 클립보드 메모장으로 우회.

### WebSocket 끊김 (`[Disconnected - reconnecting...]`)

서버를 끈 게 아니라면 3초 후 자동 재연결. 다만 **세션 자체는 새로** 시작되므로 그 패널의 진행 상태는 잃음 — 서버 재시작 시 모든 패널이 새 세션으로 들어감.

---

## 10. 폴더 구조

```
D:\claude-terminal\
├── server.js              # Express + WebSocket + PTY + clipboard API
├── package.json
├── config.json            # 프리셋
├── start-server.bat
├── clipboard\             # ↓ 클립보드 메모장
│   └── clipboard.md       #   Claude 가 트리거 시 덮어쓰는 단일 파일
├── public\
│   ├── index.html
│   ├── style.css
│   └── app.js             # 프론트엔드 전체 로직
└── README.md              # 이 문서
```

---

## 11. 변경/확장

- **PTY shell 변경**: `server.js` 의 `'powershell.exe'` → `'pwsh.exe'` (PS7) 등
- **터미널 색/폰트**: `public/app.js` 의 `new Terminal({ theme: ..., fontFamily: ... })`
- **컴포저 기본 높이**: `public/style.css` 의 `--composer-h` (또는 사용자가 드래그하면 localStorage 가 우선)
- **클립보드 경로 변경**: `server.js` 의 `CLIPBOARD_DIR` / `CLIPBOARD_FILE` 와 글로벌 `CLAUDE.md` 의 룰 양쪽 동기화

---

> 문서 최종 업데이트: 2026-05-08
