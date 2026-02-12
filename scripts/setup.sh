#!/bin/bash
# claude-code-figma-agent setup script
# Installs dependencies, Output Style, and prints instructions

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== claude-code-figma-agent Setup ==="
echo ""

# 1. Install dependencies
echo "[1/3] Installing dependencies..."
cd "$REPO_DIR"
if command -v bun &> /dev/null; then
    bun install
else
    echo "Error: bun is not installed."
    echo "Install it with: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

# 2. Install Output Style
echo ""
echo "[2/3] Installing Output Style..."
STYLES_DIR="$HOME/.claude/output-styles"
mkdir -p "$STYLES_DIR"
cp "$REPO_DIR/output-styles/figma-design-agent.md" "$STYLES_DIR/"
echo "Output Style installed: $STYLES_DIR/figma-design-agent.md"

# 3. Print instructions
echo ""
echo "[3/3] Setup complete!"
echo ""
echo "=== Next Steps ==="
echo ""
echo "1. Start WebSocket server:"
echo "   cd $REPO_DIR && ./start-socket.sh"
echo ""
echo "2. Install Figma plugin:"
echo "   Figma > Plugins > Development > Import plugin from manifest..."
echo "   Select: $REPO_DIR/src/figma_mcp_plugin/manifest.json"
echo ""
echo "3. Set up your project:"
echo "   Copy template files to your project root:"
echo "   cp $REPO_DIR/templates/.mcp.json /path/to/your/project/"
echo "   cp $REPO_DIR/templates/CLAUDE.md /path/to/your/project/"
echo "   mkdir -p /path/to/your/project/.claude"
echo "   cp $REPO_DIR/templates/claude/settings.local.json /path/to/your/project/.claude/"
echo "   mkdir -p /path/to/your/project/figma-context"
echo ""
echo "4. Update .mcp.json placeholder:"
echo "   Replace __FIGMA_PLUGIN_MCP_PATH__ with: $REPO_DIR"
echo ""
echo "5. Run Claude Code in your project:"
echo "   cd /path/to/your/project && claude"
echo ""
