# Installation Guide

## For Humans

AI 에이전트에게 이 문장을 붙여넣으세요:

```
다음 가이드를 따라 Figma MCP를 설치하고 연결해줘:
https://raw.githubusercontent.com/Heon-il/claude-code-figma-agent/main/docs/installation.md
```

또는 직접 설치하려면 아래 [수동 설치](#수동-설치) 섹션을 따르세요.

### 수동 설치

```bash
# 1. Bun 설치 (없다면)
curl -fsSL https://bun.sh/install | bash

# 2. 프로젝트 클론
git clone https://github.com/Heon-il/claude-code-figma-agent.git
cd claude-code-figma-agent
./scripts/setup.sh

# 3. WebSocket 서버 실행
./start-socket.sh

# 4. Figma 플러그인 설치 (Figma > Plugins > Development > Import plugin from manifest...)
#    src/figma_mcp_plugin/manifest.json 선택

# 5. 프로젝트에 MCP 설정 (아래 참고)
```

---

## For LLM Agents

> **IMPORTANT: `WebFetch`가 아닌 `curl`로 이 파일을 가져오세요.** WebFetch는 내용을 요약하여 설치 플래그나 세부 단계가 누락될 수 있습니다.
> ```bash
> curl -fsSL https://raw.githubusercontent.com/Heon-il/claude-code-figma-agent/main/docs/installation.md
> ```

당신은 LLM 에이전트로서 사용자가 Figma MCP를 설정하도록 돕습니다. 이 가이드는 **AI가 Figma를 프로그래밍 방식으로 제어**할 수 있게 하는 MCP 서버를 설치합니다.

**아키텍처 이해:**
```
Claude Code  ←stdio→  MCP Server (server.ts)  ←WebSocket→  Figma Plugin (code.js)  ←API→  Figma
```

3개 구성요소 모두 실행되어야 합니다: WebSocket 서버, Figma 플러그인, MCP 서버.

---

### Step 0: 사전 조건 확인

```bash
# Bun 설치 확인
if command -v bun &> /dev/null; then
    echo "Bun $(bun --version) installed"
else
    echo "Bun not found. Installing..."
    curl -fsSL https://bun.sh/install | bash
fi
```

### Step 1: 프로젝트 설치

사용자에게 프로젝트 경로를 물어보세요. 기본값: `~/claude-code-figma-agent`

```bash
# 프로젝트가 이미 있는지 확인
REPO_PATH="/path/to/claude-code-figma-agent"

if [ -d "$REPO_PATH" ]; then
    echo "Project exists at $REPO_PATH"
    cd "$REPO_PATH" && bun install
else
    git clone https://github.com/Heon-il/claude-code-figma-agent.git "$REPO_PATH"
    cd "$REPO_PATH" && bun install
fi
```

> **IMPORTANT**: `$REPO_PATH`의 절대 경로를 기억하세요. 이후 단계에서 필요합니다.

### Step 2: WebSocket 서버 실행

WebSocket 서버는 MCP 서버와 Figma 플러그인 사이의 중계 역할을 합니다.

```bash
# 포트 3055가 이미 사용 중인지 확인
if lsof -i :3055 &> /dev/null; then
    echo "WebSocket server already running on port 3055"
else
    # 백그라운드에서 실행
    cd "$REPO_PATH" && ./start-socket.sh &
    echo "WebSocket server started on ws://localhost:3055"
fi
```

> **NOTE**: WebSocket 서버는 plain `ws://` 모드로 실행하세요. Figma 플러그인은 `wss://` (TLS)를 지원하지 않습니다. `--ssl` 플래그를 사용하지 마세요.

### Step 3: MCP 서버 등록

사용자의 **프로젝트 루트**에 `.mcp.json` 파일을 생성합니다:

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "bun",
      "args": ["$REPO_PATH/src/talk_to_figma_mcp/server.ts"]
    }
  }
}
```

> **WARNING**: `$REPO_PATH`는 반드시 **절대 경로**로 치환하세요. 상대 경로는 작동하지 않습니다.

**글로벌 설정 충돌 확인:**

Claude Code는 `~/.claude.json`에 글로벌 MCP 설정을 저장합니다. 이전에 npm 패키지로 등록했다면 프로젝트 `.mcp.json`보다 우선 적용되어 40개 도구만 보일 수 있습니다.

```bash
# 글로벌 설정에서 TalkToFigma 확인
grep -n "cursor-talk-to-figma-mcp@latest" ~/.claude.json 2>/dev/null
```

만약 결과가 있다면, `~/.claude.json`의 해당 `args`를 로컬 경로로 변경하고 `command`를 `"bun"`으로 변경하세요.

**검증:**

Claude Code를 재시작하고 `/mcp` 명령으로 확인:
- Status: connected
- Command: `bun` (bunx가 아님)
- Args: 로컬 소스 경로
- Tools: **94 tools**

### Step 4: Claude Code 설정

프로젝트 루트에 `.claude/settings.local.json`을 생성합니다:

```json
{
  "permissions": {
    "allow": ["mcp__TalkToFigma__*"]
  },
  "enabledMcpjsonServers": ["TalkToFigma"],
  "outputStyle": "Figma Design Agent"
}
```

> **NOTE**: Output Style이 설치되어 있어야 합니다. `$REPO_PATH/scripts/setup.sh`를 실행하면 자동 설치됩니다.

### Step 5: Figma 플러그인 설치

사용자에게 다음을 안내하세요:

1. **Figma 데스크탑 앱**을 엽니다 (웹 버전이 아닌 데스크탑)
2. **Plugins > Development > Import plugin from manifest...** 클릭
3. `$REPO_PATH/src/figma_mcp_plugin/manifest.json` 선택
4. **Plugins > Development > Figma MCP Plugin** 실행
5. 플러그인 UI에서 Connect 클릭

### Step 6: 채널 연결

MCP 서버와 Figma 플러그인이 같은 채널로 연결되어야 합니다.

```
# AI 도구에서 실행
join_channel 명령으로 Figma 플러그인에 표시된 채널에 연결해줘
```

> **IMPORTANT**: Figma 플러그인 UI에 표시된 채널 이름과 **정확히 동일**해야 합니다.

### Step 7: 연결 확인

```
# AI 도구에서 실행
get_document_info로 현재 Figma 문서 정보를 확인해줘
```

문서 이름, 페이지 목록 등이 반환되면 설치 완료입니다.

---

### Troubleshooting

에러가 발생하면 아래를 순서대로 확인하세요:

#### "Unknown command: xxx"

Figma 플러그인이 구버전입니다. Figma에서 플러그인을 닫고 다시 실행하세요.

#### Claude Code에서 Tools: 40 tools

`~/.claude.json`에 `bunx cursor-talk-to-figma-mcp@latest`가 등록되어 있습니다. `/mcp` 명령으로 Args를 확인하고, 로컬 소스 경로로 변경하세요.

#### Figma 플러그인 실행 시 에러

Figma에서 **Plugins > Development > Open console** (`Cmd+Option+I`)로 에러 확인:
- `Syntax error: Unexpected token ...` → `code.js`에 오브젝트 spread 문법 문제. Figma 런타임은 오브젝트 spread (`{...obj}`)를 지원하지 않습니다. `Object.assign()`으로 변경하세요.

#### WebSocket 연결 실패

```bash
# 서버 실행 확인
lsof -i :3055

# 서버 재시작
cd "$REPO_PATH" && ./start-socket.sh
```

#### 채널 연결이 안 됨

MCP 서버와 Figma 플러그인이 **동일한 채널 이름**을 사용하는지 확인하세요.

---

### 설치 완료 후

사용자에게 다음을 안내하세요:

1. **94개 도구**를 사용하여 Figma를 자유롭게 조작할 수 있습니다
2. 자연어로 명령하면 됩니다: "프레임 만들어줘", "이 텍스트 폰트를 Inter Bold로 바꿔줘"
3. 전체 도구 목록은 프로젝트의 `README.md`를 참고하세요
4. 매번 사용 전에 WebSocket 서버와 Figma 플러그인이 실행 중인지 확인하세요
