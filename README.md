# claude-code-figma-agent

Claude Code를 **Figma 디자인 에이전트**로 사용하기 위한 MCP(Model Context Protocol) 서버 + Figma 플러그인 패키지.

**94개 MCP 도구**로 Figma의 거의 모든 기능을 AI가 제어할 수 있습니다.

## 아키텍처

```
Claude Code
    ↕ MCP (stdio)
MCP Server (server.ts)
    ↕ WebSocket (ws://localhost:3055)
Figma Plugin (code.js)
    ↕ Figma Plugin API
Figma
```

3개의 구성요소가 필요합니다:

| 구성요소 | 파일 | 역할 |
|---------|------|------|
| **MCP Server** | `src/talk_to_figma_mcp/server.ts` | AI ↔ WebSocket 브릿지 |
| **WebSocket Server** | `src/socket.ts` | MCP Server ↔ Figma Plugin 중계 |
| **Figma Plugin** | `src/figma_mcp_plugin/code.js` | Figma API 실행 |

## Quick Start

> 상세한 설치 가이드: [docs/installation.md](docs/installation.md)

### 1. 사전 준비

```bash
# Bun 설치
curl -fsSL https://bun.sh/install | bash

# 프로젝트 클론 및 셋업
git clone https://github.com/Heon-il/claude-code-figma-agent.git
cd claude-code-figma-agent
./scripts/setup.sh
```

### 2. WebSocket 서버 실행

```bash
./start-socket.sh
```

> WebSocket 서버가 `ws://localhost:3055`에서 실행됩니다.

### 3. Figma 플러그인 설치

1. Figma 데스크탑 앱 열기
2. **Plugins > Development > Import plugin from manifest...** 클릭
3. 이 프로젝트의 `src/figma_mcp_plugin/manifest.json` 선택
4. **Plugins > Development > Figma MCP Plugin** 실행
5. 플러그인 UI에서 Connect 클릭

### 4. 프로젝트에 MCP 설정

사용할 프로젝트 디렉토리에 템플릿 파일을 복사합니다:

```bash
PROJECT_DIR="/path/to/your/project"
AGENT_DIR="/path/to/claude-code-figma-agent"

# .mcp.json 복사 및 경로 치환
cp templates/.mcp.json "$PROJECT_DIR/"
sed -i '' "s|__FIGMA_PLUGIN_MCP_PATH__|$AGENT_DIR|g" "$PROJECT_DIR/.mcp.json"

# Claude Code 설정 복사
mkdir -p "$PROJECT_DIR/.claude"
cp templates/claude/settings.local.json "$PROJECT_DIR/.claude/"

# 디자인 컨텍스트 파일 복사
cp templates/CLAUDE.md "$PROJECT_DIR/"
mkdir -p "$PROJECT_DIR/figma-context"
```

### 5. Claude Code 실행

```bash
cd /path/to/your/project
claude
```

첫 명령:

```
join_channel로 Figma 플러그인의 채널에 연결해줘
```

> Figma 플러그인 UI에 표시된 채널 이름과 동일해야 합니다.

연결 확인:

```
현재 Figma 문서 정보를 알려줘
```

## Template Files

`templates/` 디렉토리에는 사용자 프로젝트에 복사할 파일들이 있습니다:

| 파일 | 역할 |
|------|------|
| `.mcp.json` | MCP 서버 등록 (`__FIGMA_PLUGIN_MCP_PATH__` placeholder) |
| `claude/settings.local.json` | MCP 도구 권한 + Output Style 설정 |
| `CLAUDE.md` | 프로젝트별 디자인 컨텍스트 스타터 |
| `figma-context/.gitkeep` | Figma 구조 캐시 디렉토리 |

자세한 설명: [templates/README.md](templates/README.md)

## Output Style

`output-styles/figma-design-agent.md`는 Claude Code를 Figma 디자인 에이전트로 동작시키는 Output Style입니다. `scripts/setup.sh`를 실행하면 자동으로 `~/.claude/output-styles/`에 설치됩니다.

수동 설치:

```bash
cp output-styles/figma-design-agent.md ~/.claude/output-styles/
```

## 전체 도구 목록 (94개)

### Document & Selection (7)

| 도구 | 설명 |
|------|------|
| `get_document_info` | 현재 문서 정보 조회 |
| `get_selection` | 현재 선택 정보 조회 |
| `read_my_design` | 선택한 요소의 상세 노드 정보 |
| `get_node_info` | 특정 노드 상세 정보 |
| `get_nodes_info` | 여러 노드 일괄 조회 |
| `set_focus` | 특정 노드로 뷰포트 이동 |
| `set_selections` | 여러 노드 선택 및 뷰포트 이동 |

### Creating Elements (7)

| 도구 | 설명 |
|------|------|
| `create_rectangle` | 사각형 생성 |
| `create_frame` | 프레임 생성 (Auto Layout 지원) |
| `create_text` | 텍스트 노드 생성 |
| `create_ellipse` | 원/타원 생성 |
| `create_line` | 선 생성 (회전, 스트로크 설정) |
| `create_polygon` | 다각형 생성 (변 개수 설정) |
| `create_star` | 별 생성 (꼭짓점, 내부 반경 설정) |

### Text Content (3)

| 도구 | 설명 |
|------|------|
| `scan_text_nodes` | 텍스트 노드 일괄 스캔 (청크 지원) |
| `set_text_content` | 단일 텍스트 내용 변경 |
| `set_multiple_text_contents` | 여러 텍스트 일괄 변경 |

### Text Styling (12)

| 도구 | 설명 |
|------|------|
| `load_font_async` | 폰트 미리 로드 |
| `set_font_family` | 폰트 패밀리 변경 (자동 로드) |
| `set_font_size` | 폰트 크기 변경 |
| `set_font_weight` | 폰트 두께 변경 (Regular, Bold 등) |
| `set_text_align` | 텍스트 정렬 (가로/세로) |
| `set_line_height` | 행간 설정 (px, %, auto) |
| `set_letter_spacing` | 자간 설정 (px, %) |
| `set_text_decoration` | 밑줄, 취소선 |
| `set_text_case` | 대소문자 변환 (UPPER, LOWER, TITLE 등) |
| `set_paragraph_spacing` | 단락 간격 |
| `set_paragraph_indent` | 단락 들여쓰기 |
| `get_styled_text_segments` | 스타일별 텍스트 세그먼트 조회 |

### Styling (7)

| 도구 | 설명 |
|------|------|
| `set_fill_color` | 채우기 색상 (RGBA) |
| `set_stroke_color` | 선 색상 및 두께 |
| `set_corner_radius` | 코너 라디우스 (개별 코너 제어) |
| `set_opacity` | 불투명도 (0-1) |
| `set_blend_mode` | 블렌드 모드 (MULTIPLY, SCREEN 등) |
| `set_effects` | 이펙트 (그림자, 블러) |
| `set_gradient_fill` | 그라디언트 (선형, 원형, 각도, 다이아몬드) |

### Auto Layout (5)

| 도구 | 설명 |
|------|------|
| `set_layout_mode` | 레이아웃 모드 (HORIZONTAL, VERTICAL) |
| `set_padding` | 패딩 설정 (상하좌우) |
| `set_axis_align` | 축 정렬 (MIN, CENTER, MAX, SPACE_BETWEEN) |
| `set_layout_sizing` | 크기 모드 (FIXED, HUG, FILL) |
| `set_item_spacing` | 자식 간 간격 |

### Layout & Organization (14)

| 도구 | 설명 |
|------|------|
| `move_node` | 노드 이동 |
| `resize_node` | 노드 크기 변경 |
| `delete_node` | 노드 삭제 |
| `delete_multiple_nodes` | 여러 노드 일괄 삭제 |
| `clone_node` | 노드 복제 |
| `rename_node` | 노드 이름 변경 |
| `set_visible` | 표시/숨기기 |
| `set_locked` | 잠금/잠금 해제 |
| `group_nodes` | 여러 노드 그룹화 |
| `ungroup_nodes` | 그룹 해제 |
| `insert_child` | 노드를 다른 부모로 이동 |
| `set_constraints` | 레이아웃 제약 (MIN, CENTER, STRETCH 등) |
| `set_rotation` | 회전 각도 |
| `set_relative_transform` | 2D 아핀 변환 행렬 |

### Components & Styles (13)

| 도구 | 설명 |
|------|------|
| `get_styles` | 로컬 스타일 조회 |
| `get_local_components` | 로컬 컴포넌트 조회 |
| `create_component_instance` | 컴포넌트 인스턴스 생성 |
| `get_instance_overrides` | 인스턴스 오버라이드 추출 |
| `set_instance_overrides` | 인스턴스에 오버라이드 적용 |
| `create_component` | 프레임/그룹을 컴포넌트로 변환 |
| `swap_component` | 인스턴스의 소스 컴포넌트 교체 |
| `get_component_properties` | 컴포넌트 속성 조회 |
| `set_component_property` | 컴포넌트 속성 설정 |
| `create_paint_style` | 페인트 스타일 생성 |
| `create_text_style` | 텍스트 스타일 생성 |
| `create_effect_style` | 이펙트 스타일 생성 |
| `apply_style` | 노드에 스타일 적용 |

### Page Management (5)

| 도구 | 설명 |
|------|------|
| `get_pages` | 모든 페이지 조회 |
| `get_current_page` | 현재 페이지 정보 |
| `set_current_page` | 페이지 전환 |
| `create_page` | 새 페이지 생성 |
| `rename_page` | 페이지 이름 변경 |

### Boolean Operations (4)

| 도구 | 설명 |
|------|------|
| `boolean_union` | 합집합 (더하기) |
| `boolean_subtract` | 차집합 (빼기) |
| `boolean_intersect` | 교집합 |
| `boolean_exclude` | 배타적 논리합 (XOR) |

### Annotations (4)

| 도구 | 설명 |
|------|------|
| `get_annotations` | 어노테이션 조회 |
| `set_annotation` | 어노테이션 생성/수정 |
| `set_multiple_annotations` | 여러 어노테이션 일괄 생성 |
| `scan_nodes_by_types` | 타입별 노드 스캔 |

### Prototyping & Connections (4)

| 도구 | 설명 |
|------|------|
| `get_reactions` | 프로토타입 인터랙션 조회 |
| `set_reactions` | 프로토타입 인터랙션 설정 |
| `set_default_connector` | 커넥터 기본 스타일 설정 |
| `create_connections` | 커넥터 라인 생성 |

### Variables & Design Tokens (3)

| 도구 | 설명 |
|------|------|
| `get_local_variables` | 로컬 변수 컬렉션 조회 |
| `get_variable_by_id` | 특정 변수 조회 |
| `set_variable_binding` | 노드 속성에 변수 바인딩 |

### Images & Vectors (4)

| 도구 | 설명 |
|------|------|
| `create_image` | Base64 이미지 삽입 |
| `set_image_fill` | 노드에 이미지 채우기 (FILL, FIT, CROP, TILE) |
| `flatten_node` | 벡터로 플래튼 |
| `create_vector` | SVG 패스로 벡터 생성 |

### Export (1)

| 도구 | 설명 |
|------|------|
| `export_node_as_image` | PNG, JPG, SVG, PDF로 내보내기 |

### Connection (1)

| 도구 | 설명 |
|------|------|
| `join_channel` | WebSocket 채널 연결 |

## 사용 예시

### 기본 디자인 작업

```
# 프레임 생성
"800x600 크기의 프레임을 만들어줘. 이름은 'Card'로"

# 요소 배치
"Card 프레임 안에 텍스트 'Hello World'를 추가해줘. 폰트는 Inter Bold 24px"

# 스타일링
"Card에 배경색 #FFFFFF, 코너 라디우스 12px, 드롭 섀도우를 추가해줘"
```

### 디자인 읽기

```
# 선택한 요소 분석
"현재 선택한 요소의 디자인 정보를 읽어줘"

# 텍스트 일괄 스캔
"이 프레임의 모든 텍스트 노드를 스캔해줘"
```

### 컴포넌트 작업

```
# 로컬 컴포넌트 조회
"로컬 컴포넌트 목록을 보여줘"

# 인스턴스 생성
"Button 컴포넌트의 인스턴스를 (100, 200) 위치에 만들어줘"
```

## Troubleshooting

### "Unknown command" 에러

Figma 플러그인이 구버전입니다. Figma에서 플러그인을 닫고 다시 실행하세요:

**Plugins > Development > Figma MCP Plugin**

### WebSocket 연결 실패

```bash
# WebSocket 서버가 실행 중인지 확인
lsof -i :3055

# 서버 재시작
./start-socket.sh
```

### 채널 연결이 안 됨

MCP 서버와 Figma 플러그인이 **같은 채널 이름**을 사용해야 합니다. 양쪽 모두 동일한 채널 이름으로 `join_channel`하세요.

### Figma 플러그인 실행 에러

1. **Plugins > Development > Open console** (`Cmd+Option+I`)로 에러 확인
2. `Syntax error: Unexpected token ...` → `code.js`에 오브젝트 spread 문법이 있으면 `Object.assign()`으로 변경 필요 (Figma 런타임은 오브젝트 spread 미지원)

## 프로젝트 구조

```
claude-code-figma-agent/
├── src/
│   ├── talk_to_figma_mcp/
│   │   └── server.ts          # MCP 서버 (94개 도구 등록)
│   ├── figma_mcp_plugin/
│   │   ├── code.js            # Figma 플러그인 (명령 실행)
│   │   ├── ui.html            # 플러그인 UI
│   │   └── manifest.json      # 플러그인 설정
│   └── socket.ts              # WebSocket 중계 서버
├── templates/                  # 사용자 프로젝트에 복사할 파일들
├── output-styles/              # Claude Code Output Style
├── scripts/setup.sh            # 셋업 스크립트
├── start-socket.sh             # WebSocket 서버 실행 스크립트
└── docs/installation.md        # 상세 설치 가이드
```

## Credits

Based on [cursor-talk-to-figma-mcp](https://github.com/sonnylazuardi/cursor-talk-to-figma-mcp) by [sonnylazuardi](https://github.com/sonnylazuardi). MIT License.

## License

MIT
