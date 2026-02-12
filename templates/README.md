# Template Files

이 디렉토리의 파일들을 **사용자 프로젝트 루트**에 복사하여 Claude Code를 Figma 디자인 에이전트로 사용할 수 있습니다.

## 파일 목록

| 파일 | 복사 위치 | 역할 |
|------|-----------|------|
| `.mcp.json` | 프로젝트 루트 `/` | MCP 서버 등록. `__FIGMA_PLUGIN_MCP_PATH__`를 실제 경로로 변경 필요 |
| `claude/settings.local.json` | 프로젝트 루트 `/.claude/` | MCP 도구 권한 허용 + Output Style 설정 |
| `CLAUDE.md` | 프로젝트 루트 `/` | 프로젝트별 디자인 컨텍스트 (Figma 파일 URL, 디자인 시스템 등) |
| `figma-context/.gitkeep` | 프로젝트 루트 `/` | Figma 구조 캐시 디렉토리 |

## 사용법

```bash
# 1. 템플릿 파일 복사
cp templates/.mcp.json /path/to/your/project/
cp templates/CLAUDE.md /path/to/your/project/
mkdir -p /path/to/your/project/.claude
cp templates/claude/settings.local.json /path/to/your/project/.claude/
mkdir -p /path/to/your/project/figma-context

# 2. .mcp.json에서 경로 치환
# __FIGMA_PLUGIN_MCP_PATH__ → claude-code-figma-agent의 절대 경로
```

또는 `scripts/setup.sh`를 사용하면 자동으로 처리됩니다.
