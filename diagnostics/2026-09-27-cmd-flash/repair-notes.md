# Codex 콘솔 창 노출 우회 설정 (2026-09-27)

## 확인한 현상

- 사용자 녹화의 약 22.1~22.9초에 별도 Windows Terminal 창들이 나타났다 사라진다.
- 현재 Codex CLI는 0.157.1이며 공유 app-server 데몬을 사용하고 있었다.
- Playwright MCP는 npx와 CMD를 거쳐 실행되고 있었다. 영상의 잘린 창 제목만으로 특정 실행 파일을 확정하지는 못했다.
- 내장 도움말의 `--no-daemon`은 이미 실행 중인 공유 서버가 있어도 사용하지 않는 옵션이다.
- `daemon_auto_start`만 끈 비교 실행은 기존 데몬에 연결했으므로 이 설정만으로 우회할 수 없었다.
- 진단 과정에서 부모 프로세스의 숨김 실행 옵션만으로 하위 콘솔 창까지 숨겨지지는 않는 문제가 확인됐다.

## 적용한 변경

1. `C:\Users\whdcj\OneDrive\문서\WindowsPowerShell\profile.ps1`을 새로 만들어 일반 `codex` 호출에 `--no-daemon`을 전달한다. 명시적인 `--remote`, `agents`, 이미 지정된 `--no-daemon`은 원래 인자를 유지한다.
2. `server.js`의 Codex 자동 실행 명령을 `codex --no-daemon --no-alt-screen`으로 변경했다. 기존 사용자 변경과 줄바꿈은 보존했다.
3. 변경 전 서버 파일은 `repair-backup/server.js.before`에 저장했다.

MCP 설정, 권한 설정, Codex 버전, Windows 기본 터미널 설정은 변경하지 않았다.

## 검증과 적용

- 서버 JavaScript 문법 검사를 통과했다.
- Codex를 실제로 호출하지 않는 대역 함수로 기본 실행, resume, exec, agents, remote, 옵션 중복 방지의 인자 전달을 확인했다.
- 기존 대화와 터미널 서버를 종료하지 않았다. 진단용 PTY 두 개(PID 14040, 13448)는 조회 시 이미 종료되어 있었다. 별도 진단 셸 세션도 종료했다.
- 현재 연결된 데몬 세션에는 적용되지 않는다. 새 터미널 패널에서 실행하거나 현재 Codex만 종료한 뒤 `codex --no-daemon resume`로 기존 대화를 선택하면 된다.
- 새 PowerShell 패널은 프로필을 바로 읽으므로 터미널 서버 전체를 재시작할 필요는 없다. 서버 코드 변경은 나중에 서버를 재시작할 때도 같은 옵션을 보장한다.
- 사용자 화면에서 창 노출이 사라지는지는 재시작 후 확인이 필요하다. 원인과 완전한 해결을 확정한 것으로 기록하지 않는다.

## 되돌리기

- 이번에 새로 만든 PowerShell 프로필의 `codex` 함수 블록을 제거한다.
- 서버의 Codex 실행 명령에서 `--no-daemon`만 제거한다. 다른 사용자 변경을 덮어쓰지 않는다.
