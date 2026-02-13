#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";

// Define TypeScript interfaces for Figma responses
interface FigmaResponse {
  id: string;
  result?: any;
  error?: string;
}

// Define interface for command progress updates
interface CommandProgressUpdate {
  type: 'command_progress';
  commandId: string;
  commandType: string;
  status: 'started' | 'in_progress' | 'completed' | 'error';
  progress: number;
  totalItems: number;
  processedItems: number;
  currentChunk?: number;
  totalChunks?: number;
  chunkSize?: number;
  message: string;
  payload?: any;
  timestamp: number;
}

// Update the getInstanceOverridesResult interface to match the plugin implementation
interface getInstanceOverridesResult {
  success: boolean;
  message: string;
  sourceInstanceId: string;
  mainComponentId: string;
  overridesCount: number;
}

interface setInstanceOverridesResult {
  success: boolean;
  message: string;
  totalCount?: number;
  results?: Array<{
    success: boolean;
    instanceId: string;
    instanceName: string;
    appliedCount?: number;
    message?: string;
  }>;
}

// Custom logging functions that write to stderr instead of stdout to avoid being captured
const logger = {
  info: (message: string) => process.stderr.write(`[INFO] ${message}\n`),
  debug: (message: string) => process.stderr.write(`[DEBUG] ${message}\n`),
  warn: (message: string) => process.stderr.write(`[WARN] ${message}\n`),
  error: (message: string) => process.stderr.write(`[ERROR] ${message}\n`),
  log: (message: string) => process.stderr.write(`[LOG] ${message}\n`)
};

// WebSocket connection and request tracking
let ws: WebSocket | null = null;
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  lastActivity: number; // Add timestamp for last activity
}>();

// Track which channel each client is in
let currentChannel: string | null = null;

// Create MCP server
const server = new McpServer({
  name: "TalkToFigmaMCP",
  version: "1.0.0",
});

// Add command line argument parsing
const args = process.argv.slice(2);
const serverArg = args.find(arg => arg.startsWith('--server='));
const serverUrl = serverArg ? serverArg.split('=')[1] : 'localhost';
const WS_URL = serverUrl === 'localhost' ? `ws://${serverUrl}` : `wss://${serverUrl}`;

// Document Info Tool
server.tool(
  "get_document_info",
  "Get detailed information about the current Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_document_info");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting document info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Selection Tool
server.tool(
  "get_selection",
  "Get information about the current selection in Figma",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_selection");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting selection: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Read My Design Tool
server.tool(
  "read_my_design",
  "Get detailed information about the current selection in Figma, including all node details",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("read_my_design", {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Node Info Tool
server.tool(
  "get_node_info",
  "Get detailed information about a specific node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to get information about"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_node_info", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(filterFigmaNode(result))
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

function rgbaToHex(color: any): string {
  // skip if color is already hex
  if (color.startsWith('#')) {
    return color;
  }

  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = Math.round(color.a * 255);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${a === 255 ? '' : a.toString(16).padStart(2, '0')}`;
}

function filterFigmaNode(node: any) {
  // Skip VECTOR type nodes
  if (node.type === "VECTOR") {
    return null;
  }

  const filtered: any = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (node.fills && node.fills.length > 0) {
    filtered.fills = node.fills.map((fill: any) => {
      const processedFill = { ...fill };

      // Remove boundVariables and imageRef
      delete processedFill.boundVariables;
      delete processedFill.imageRef;

      // Process gradientStops if present
      if (processedFill.gradientStops) {
        processedFill.gradientStops = processedFill.gradientStops.map((stop: any) => {
          const processedStop = { ...stop };
          // Convert color to hex if present
          if (processedStop.color) {
            processedStop.color = rgbaToHex(processedStop.color);
          }
          // Remove boundVariables
          delete processedStop.boundVariables;
          return processedStop;
        });
      }

      // Convert solid fill colors to hex
      if (processedFill.color) {
        processedFill.color = rgbaToHex(processedFill.color);
      }

      return processedFill;
    });
  }

  if (node.strokes && node.strokes.length > 0) {
    filtered.strokes = node.strokes.map((stroke: any) => {
      const processedStroke = { ...stroke };
      // Remove boundVariables
      delete processedStroke.boundVariables;
      // Convert color to hex if present
      if (processedStroke.color) {
        processedStroke.color = rgbaToHex(processedStroke.color);
      }
      return processedStroke;
    });
  }

  if (node.cornerRadius !== undefined) {
    filtered.cornerRadius = node.cornerRadius;
  }

  if (node.absoluteBoundingBox) {
    filtered.absoluteBoundingBox = node.absoluteBoundingBox;
  }

  if (node.characters) {
    filtered.characters = node.characters;
  }

  if (node.style) {
    filtered.style = {
      fontFamily: node.style.fontFamily,
      fontStyle: node.style.fontStyle,
      fontWeight: node.style.fontWeight,
      fontSize: node.style.fontSize,
      textAlignHorizontal: node.style.textAlignHorizontal,
      letterSpacing: node.style.letterSpacing,
      lineHeightPx: node.style.lineHeightPx
    };
  }

  if (node.children) {
    filtered.children = node.children
      .map((child: any) => filterFigmaNode(child))
      .filter((child: any) => child !== null); // Remove null children (VECTOR nodes)
  }

  return filtered;
}

// Nodes Info Tool
server.tool(
  "get_nodes_info",
  "Get detailed information about multiple nodes in Figma",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to get information about")
  },
  async ({ nodeIds }: any) => {
    try {
      const results = await Promise.all(
        nodeIds.map(async (nodeId: any) => {
          const result = await sendCommandToFigma('get_node_info', { nodeId });
          return { nodeId, info: result };
        })
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results.map((result) => filterFigmaNode(result.info)))
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting nodes info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);


// Create Rectangle Tool
server.tool(
  "create_rectangle",
  "Create a new rectangle in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the rectangle"),
    height: z.number().describe("Height of the rectangle"),
    name: z.string().optional().describe("Optional name for the rectangle"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the rectangle to"),
  },
  async ({ x, y, width, height, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_rectangle", {
        x,
        y,
        width,
        height,
        name: name || "Rectangle",
        parentId,
      });
      return {
        content: [
          {
            type: "text",
            text: `Created rectangle "${JSON.stringify(result)}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating rectangle: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Frame Tool
server.tool(
  "create_frame",
  "Create a new frame in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the frame"),
    height: z.number().describe("Height of the frame"),
    name: z.string().optional().describe("Optional name for the frame"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the frame to"),
    fillColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Fill color in RGBA format"),
    strokeColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Stroke color in RGBA format"),
    strokeWeight: z.number().positive().optional().describe("Stroke weight"),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional().describe("Auto-layout mode for the frame"),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children"),
    paddingTop: z.number().optional().describe("Top padding for auto-layout frame"),
    paddingRight: z.number().optional().describe("Right padding for auto-layout frame"),
    paddingBottom: z.number().optional().describe("Bottom padding for auto-layout frame"),
    paddingLeft: z.number().optional().describe("Left padding for auto-layout frame"),
    primaryAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"])
      .optional()
      .describe("Primary axis alignment for auto-layout frame. Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
    counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional().describe("Counter axis alignment for auto-layout frame"),
    layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Horizontal sizing mode for auto-layout frame"),
    layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Vertical sizing mode for auto-layout frame"),
    itemSpacing: z
      .number()
      .optional()
      .describe("Distance between children in auto-layout frame. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN.")
  },
  async ({
    x,
    y,
    width,
    height,
    name,
    parentId,
    fillColor,
    strokeColor,
    strokeWeight,
    layoutMode,
    layoutWrap,
    paddingTop,
    paddingRight,
    paddingBottom,
    paddingLeft,
    primaryAxisAlignItems,
    counterAxisAlignItems,
    layoutSizingHorizontal,
    layoutSizingVertical,
    itemSpacing
  }: any) => {
    try {
      const result = await sendCommandToFigma("create_frame", {
        x,
        y,
        width,
        height,
        name: name || "Frame",
        parentId,
        fillColor: fillColor || { r: 1, g: 1, b: 1, a: 1 },
        strokeColor: strokeColor,
        strokeWeight: strokeWeight,
        layoutMode,
        layoutWrap,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
        primaryAxisAlignItems,
        counterAxisAlignItems,
        layoutSizingHorizontal,
        layoutSizingVertical,
        itemSpacing
      });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created frame "${typedResult.name}" with ID: ${typedResult.id}. Use the ID as the parentId to appendChild inside this frame.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating frame: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Text Tool
server.tool(
  "create_text",
  "Create a new text element in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    text: z.string().describe("Text content"),
    fontSize: z.number().optional().describe("Font size (default: 14)"),
    fontWeight: z
      .number()
      .optional()
      .describe("Font weight (e.g., 400 for Regular, 700 for Bold)"),
    fontColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Font color in RGBA format"),
    name: z
      .string()
      .optional()
      .describe("Semantic layer name for the text node"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the text to"),
  },
  async ({ x, y, text, fontSize, fontWeight, fontColor, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_text", {
        x,
        y,
        text,
        fontSize: fontSize || 14,
        fontWeight: fontWeight || 400,
        fontColor: fontColor || { r: 0, g: 0, b: 0, a: 1 },
        name: name || "Text",
        parentId,
      });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created text "${typedResult.name}" with ID: ${typedResult.id}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating text: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Fill Color Tool
server.tool(
  "set_fill_color",
  "Set the fill color of a node in Figma can be TextNode or FrameNode",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
  },
  async ({ nodeId, r, g, b, a }: any) => {
    try {
      const result = await sendCommandToFigma("set_fill_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set fill color of node "${typedResult.name
              }" to RGBA(${r}, ${g}, ${b}, ${a || 1})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting fill color: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Stroke Color Tool
server.tool(
  "set_stroke_color",
  "Set the stroke color of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
    weight: z.number().positive().optional().describe("Stroke weight"),
  },
  async ({ nodeId, r, g, b, a, weight }: any) => {
    try {
      const result = await sendCommandToFigma("set_stroke_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
        weight: weight || 1,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set stroke color of node "${typedResult.name
              }" to RGBA(${r}, ${g}, ${b}, ${a || 1}) with weight ${weight || 1}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting stroke color: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Move Node Tool
server.tool(
  "move_node",
  "Move a node to a new position in Figma",
  {
    nodeId: z.string().describe("The ID of the node to move"),
    x: z.number().describe("New X position"),
    y: z.number().describe("New Y position"),
  },
  async ({ nodeId, x, y }: any) => {
    try {
      const result = await sendCommandToFigma("move_node", { nodeId, x, y });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Moved node "${typedResult.name}" to position (${x}, ${y})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error moving node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Clone Node Tool
server.tool(
  "clone_node",
  "Clone an existing node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to clone"),
    x: z.number().optional().describe("New X position for the clone"),
    y: z.number().optional().describe("New Y position for the clone")
  },
  async ({ nodeId, x, y }: any) => {
    try {
      const result = await sendCommandToFigma('clone_node', { nodeId, x, y });
      const typedResult = result as { name: string, id: string };
      return {
        content: [
          {
            type: "text",
            text: `Cloned node "${typedResult.name}" with new ID: ${typedResult.id}${x !== undefined && y !== undefined ? ` at position (${x}, ${y})` : ''}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error cloning node: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Resize Node Tool
server.tool(
  "resize_node",
  "Resize a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to resize"),
    width: z.number().positive().describe("New width"),
    height: z.number().positive().describe("New height"),
  },
  async ({ nodeId, width, height }: any) => {
    try {
      const result = await sendCommandToFigma("resize_node", {
        nodeId,
        width,
        height,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Resized node "${typedResult.name}" to width ${width} and height ${height}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error resizing node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Delete Node Tool
server.tool(
  "delete_node",
  "Delete a node from Figma",
  {
    nodeId: z.string().describe("The ID of the node to delete"),
  },
  async ({ nodeId }: any) => {
    try {
      await sendCommandToFigma("delete_node", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: `Deleted node with ID: ${nodeId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Delete Multiple Nodes Tool
server.tool(
  "delete_multiple_nodes",
  "Delete multiple nodes from Figma at once",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to delete"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("delete_multiple_nodes", { nodeIds });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting multiple nodes: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Export Node as Image Tool
server.tool(
  "export_node_as_image",
  "Export a node as an image from Figma",
  {
    nodeId: z.string().describe("The ID of the node to export"),
    format: z
      .enum(["PNG", "JPG", "SVG", "PDF"])
      .optional()
      .describe("Export format"),
    scale: z.number().positive().optional().describe("Export scale"),
  },
  async ({ nodeId, format, scale }: any) => {
    try {
      const result = await sendCommandToFigma("export_node_as_image", {
        nodeId,
        format: format || "PNG",
        scale: scale || 1,
      });
      const typedResult = result as { imageData: string; mimeType: string };

      return {
        content: [
          {
            type: "image",
            data: typedResult.imageData,
            mimeType: typedResult.mimeType || "image/png",
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error exporting node as image: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Text Content Tool
server.tool(
  "set_text_content",
  "Set the text content of an existing text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    text: z.string().describe("New text content"),
  },
  async ({ nodeId, text }: any) => {
    try {
      const result = await sendCommandToFigma("set_text_content", {
        nodeId,
        text,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Updated text content of node "${typedResult.name}" to "${text}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting text content: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Styles Tool
server.tool(
  "get_styles",
  "Get all styles from the current Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_styles");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting styles: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Team Library Text Styles Tool
server.tool(
  "get_team_library_text_styles",
  "Get all text styles in the current Figma file (local and imported from team libraries). Use import_text_style_by_key with a known style key to import new styles.",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_team_library_text_styles");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error getting team library text styles: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Import Text Style By Key Tool
server.tool(
  "import_text_style_by_key",
  "Import a text style from a team library by its key, making it available for use in the current file",
  {
    styleKey: z.string().describe("The key of the text style to import from the team library"),
  },
  async ({ styleKey }: any) => {
    try {
      const result = await sendCommandToFigma("import_text_style_by_key", { styleKey });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error importing text style: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Get Local Components Tool
server.tool(
  "get_local_components",
  "Get all local components from the Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_local_components");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting local components: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Team Components Tool
server.tool(
  "get_team_components",
  "Get all components in the current Figma file (local and imported from team libraries).",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_team_components");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting team components: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Get Annotations Tool
server.tool(
  "get_annotations",
  "Get all annotations in the current document or specific node",
  {
    nodeId: z.string().describe("node ID to get annotations for specific node"),
    includeCategories: z.boolean().optional().default(true).describe("Whether to include category information")
  },
  async ({ nodeId, includeCategories }: any) => {
    try {
      const result = await sendCommandToFigma("get_annotations", {
        nodeId,
        includeCategories
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting annotations: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Annotation Tool
server.tool(
  "set_annotation",
  "Create or update an annotation",
  {
    nodeId: z.string().describe("The ID of the node to annotate"),
    annotationId: z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
    labelMarkdown: z.string().describe("The annotation text in markdown format"),
    categoryId: z.string().optional().describe("The ID of the annotation category"),
    properties: z.array(z.object({
      type: z.string()
    })).optional().describe("Additional properties for the annotation")
  },
  async ({ nodeId, annotationId, labelMarkdown, categoryId, properties }: any) => {
    try {
      const result = await sendCommandToFigma("set_annotation", {
        nodeId,
        annotationId,
        labelMarkdown,
        categoryId,
        properties
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting annotation: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

interface SetMultipleAnnotationsParams {
  nodeId: string;
  annotations: Array<{
    nodeId: string;
    labelMarkdown: string;
    categoryId?: string;
    annotationId?: string;
    properties?: Array<{ type: string }>;
  }>;
}

// Set Multiple Annotations Tool
server.tool(
  "set_multiple_annotations",
  "Set multiple annotations parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the elements to annotate"),
    annotations: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the node to annotate"),
          labelMarkdown: z.string().describe("The annotation text in markdown format"),
          categoryId: z.string().optional().describe("The ID of the annotation category"),
          annotationId: z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
          properties: z.array(z.object({
            type: z.string()
          })).optional().describe("Additional properties for the annotation")
        })
      )
      .describe("Array of annotations to apply"),
  },
  async ({ nodeId, annotations }: any) => {
    try {
      if (!annotations || annotations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No annotations provided",
            },
          ],
        };
      }

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting annotation process for ${annotations.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      let totalProcessed = 0;
      const totalToProcess = annotations.length;

      // Use the plugin's set_multiple_annotations function with chunking
      const result = await sendCommandToFigma("set_multiple_annotations", {
        nodeId,
        annotations,
      });

      // Cast the result to a specific type to work with it safely
      interface AnnotationResult {
        success: boolean;
        nodeId: string;
        annotationsApplied?: number;
        annotationsFailed?: number;
        totalAnnotations?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          annotationId?: string;
        }>;
      }

      const typedResult = result as AnnotationResult;

      // Format the results for display
      const success = typedResult.annotationsApplied && typedResult.annotationsApplied > 0;
      const progressText = `
      Annotation process completed:
      - ${typedResult.annotationsApplied || 0} of ${totalToProcess} successfully applied
      - ${typedResult.annotationsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter(item => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults.map(item =>
          `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join('\n')}`;
      }

      return {
        content: [
          initialStatus,
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple annotations: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Component Instance Tool
server.tool(
  "create_component_instance",
  "Create an instance of a component in Figma",
  {
    componentKey: z.string().describe("Key of the component to instantiate"),
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
  },
  async ({ componentKey, x, y }: any) => {
    try {
      const result = await sendCommandToFigma("create_component_instance", {
        componentKey,
        x,
        y,
      });
      const typedResult = result as any;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(typedResult),
          }
        ]
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating component instance: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Copy Instance Overrides Tool
server.tool(
  "get_instance_overrides",
  "Get all override properties from a selected component instance. These overrides can be applied to other instances, which will swap them to match the source component.",
  {
    nodeId: z.string().optional().describe("Optional ID of the component instance to get overrides from. If not provided, currently selected instance will be used."),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_instance_overrides", {
        instanceNodeId: nodeId || null
      });
      const typedResult = result as getInstanceOverridesResult;

      return {
        content: [
          {
            type: "text",
            text: typedResult.success
              ? `Successfully got instance overrides: ${typedResult.message}`
              : `Failed to get instance overrides: ${typedResult.message}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error copying instance overrides: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Instance Overrides Tool
server.tool(
  "set_instance_overrides",
  "Apply previously copied overrides to selected component instances. Target instances will be swapped to the source component and all copied override properties will be applied.",
  {
    sourceInstanceId: z.string().describe("ID of the source component instance"),
    targetNodeIds: z.array(z.string()).describe("Array of target instance IDs. Currently selected instances will be used.")
  },
  async ({ sourceInstanceId, targetNodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_instance_overrides", {
        sourceInstanceId: sourceInstanceId,
        targetNodeIds: targetNodeIds || []
      });
      const typedResult = result as setInstanceOverridesResult;

      if (typedResult.success) {
        const successCount = typedResult.results?.filter(r => r.success).length || 0;
        return {
          content: [
            {
              type: "text",
              text: `Successfully applied ${typedResult.totalCount || 0} overrides to ${successCount} instances.`
            }
          ]
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Failed to set instance overrides: ${typedResult.message}`
            }
          ]
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting instance overrides: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);


// Set Corner Radius Tool
server.tool(
  "set_corner_radius",
  "Set the corner radius of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    radius: z.number().min(0).describe("Corner radius value"),
    corners: z
      .array(z.boolean())
      .length(4)
      .optional()
      .describe(
        "Optional array of 4 booleans to specify which corners to round [topLeft, topRight, bottomRight, bottomLeft]"
      ),
  },
  async ({ nodeId, radius, corners }: any) => {
    try {
      const result = await sendCommandToFigma("set_corner_radius", {
        nodeId,
        radius,
        corners: corners || [true, true, true, true],
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set corner radius of node "${typedResult.name}" to ${radius}px`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting corner radius: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Define design strategy prompt
server.prompt(
  "design_strategy",
  "Best practices for working with Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `When working with Figma designs, follow these best practices:

1. Start with Document Structure:
   - First use get_document_info() to understand the current document
   - Plan your layout hierarchy before creating elements
   - Create a main container frame for each screen/section

2. Naming Conventions:
   - Use descriptive, semantic names for all elements
   - Follow a consistent naming pattern (e.g., "Login Screen", "Logo Container", "Email Input")
   - Group related elements with meaningful names

3. Layout Hierarchy:
   - Create parent frames first, then add child elements
   - For forms/login screens:
     * Start with the main screen container frame
     * Create a logo container at the top
     * Group input fields in their own containers
     * Place action buttons (login, submit) after inputs
     * Add secondary elements (forgot password, signup links) last

4. Input Fields Structure:
   - Create a container frame for each input field
   - Include a label text above or inside the input
   - Group related inputs (e.g., username/password) together

5. Element Creation:
   - Use create_frame() for containers and input fields
   - Use create_text() for labels, buttons text, and links
   - Set appropriate colors and styles:
     * Use fillColor for backgrounds
     * Use strokeColor for borders
     * Set proper fontWeight for different text elements

6. Mofifying existing elements:
  - use set_text_content() to modify text content.

7. Visual Hierarchy:
   - Position elements in logical reading order (top to bottom)
   - Maintain consistent spacing between elements
   - Use appropriate font sizes for different text types:
     * Larger for headings/welcome text
     * Medium for input labels
     * Standard for button text
     * Smaller for helper text/links

8. Best Practices:
   - Verify each creation with get_node_info()
   - Use parentId to maintain proper hierarchy
   - Group related elements together in frames
   - Keep consistent spacing and alignment

Example Login Screen Structure:
- Login Screen (main frame)
  - Logo Container (frame)
    - Logo (image/text)
  - Welcome Text (text)
  - Input Container (frame)
    - Email Input (frame)
      - Email Label (text)
      - Email Field (frame)
    - Password Input (frame)
      - Password Label (text)
      - Password Field (frame)
  - Login Button (frame)
    - Button Text (text)
  - Helper Links (frame)
    - Forgot Password (text)
    - Don't have account (text)`,
          },
        },
      ],
      description: "Best practices for working with Figma designs",
    };
  }
);

server.prompt(
  "read_design_strategy",
  "Best practices for reading Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `When reading Figma designs, follow these best practices:

1. Start with selection:
   - First use read_my_design() to understand the current selection
   - If no selection ask user to select single or multiple nodes
`,
          },
        },
      ],
      description: "Best practices for reading Figma designs",
    };
  }
);

// Text Node Scanning Tool
server.tool(
  "scan_text_nodes",
  "Scan all text nodes in the selected Figma node",
  {
    nodeId: z.string().describe("ID of the node to scan"),
  },
  async ({ nodeId }: any) => {
    try {
      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: "Starting text node scanning. This may take a moment for large designs...",
      };

      // Use the plugin's scan_text_nodes function with chunking flag
      const result = await sendCommandToFigma("scan_text_nodes", {
        nodeId,
        useChunking: true,  // Enable chunking on the plugin side
        chunkSize: 10       // Process 10 nodes at a time
      });

      // If the result indicates chunking was used, format the response accordingly
      if (result && typeof result === 'object' && 'chunks' in result) {
        const typedResult = result as {
          success: boolean,
          totalNodes: number,
          processedNodes: number,
          chunks: number,
          textNodes: Array<any>
        };

        const summaryText = `
        Scan completed:
        - Found ${typedResult.totalNodes} text nodes
        - Processed in ${typedResult.chunks} chunks
        `;

        return {
          content: [
            initialStatus,
            {
              type: "text" as const,
              text: summaryText
            },
            {
              type: "text" as const,
              text: JSON.stringify(typedResult.textNodes, null, 2)
            }
          ],
        };
      }

      // If chunking wasn't used or wasn't reported in the result format, return the result as is
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning text nodes: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Node Type Scanning Tool
server.tool(
  "scan_nodes_by_types",
  "Scan for child nodes with specific types in the selected Figma node",
  {
    nodeId: z.string().describe("ID of the node to scan"),
    types: z.array(z.string()).describe("Array of node types to find in the child nodes (e.g. ['COMPONENT', 'FRAME'])")
  },
  async ({ nodeId, types }: any) => {
    try {
      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting node type scanning for types: ${types.join(', ')}...`,
      };

      // Use the plugin's scan_nodes_by_types function
      const result = await sendCommandToFigma("scan_nodes_by_types", {
        nodeId,
        types
      });

      // Format the response
      if (result && typeof result === 'object' && 'matchingNodes' in result) {
        const typedResult = result as {
          success: boolean,
          count: number,
          matchingNodes: Array<{
            id: string,
            name: string,
            type: string,
            bbox: {
              x: number,
              y: number,
              width: number,
              height: number
            }
          }>,
          searchedTypes: Array<string>
        };

        const summaryText = `Scan completed: Found ${typedResult.count} nodes matching types: ${typedResult.searchedTypes.join(', ')}`;

        return {
          content: [
            initialStatus,
            {
              type: "text" as const,
              text: summaryText
            },
            {
              type: "text" as const,
              text: JSON.stringify(typedResult.matchingNodes, null, 2)
            }
          ],
        };
      }

      // If the result is in an unexpected format, return it as is
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning nodes by types: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Text Replacement Strategy Prompt
server.prompt(
  "text_replacement_strategy",
  "Systematic approach for replacing text in Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Intelligent Text Replacement Strategy

## 1. Analyze Design & Identify Structure
- Scan text nodes to understand the overall structure of the design
- Use AI pattern recognition to identify logical groupings:
  * Tables (rows, columns, headers, cells)
  * Lists (items, headers, nested lists)
  * Card groups (similar cards with recurring text fields)
  * Forms (labels, input fields, validation text)
  * Navigation (menu items, breadcrumbs)
\`\`\`
scan_text_nodes(nodeId: "node-id")
get_node_info(nodeId: "node-id")  // optional
\`\`\`

## 2. Strategic Chunking for Complex Designs
- Divide replacement tasks into logical content chunks based on design structure
- Use one of these chunking strategies that best fits the design:
  * **Structural Chunking**: Table rows/columns, list sections, card groups
  * **Spatial Chunking**: Top-to-bottom, left-to-right in screen areas
  * **Semantic Chunking**: Content related to the same topic or functionality
  * **Component-Based Chunking**: Process similar component instances together

## 3. Progressive Replacement with Verification
- Create a safe copy of the node for text replacement
- Replace text chunk by chunk with continuous progress updates
- After each chunk is processed:
  * Export that section as a small, manageable image
  * Verify text fits properly and maintain design integrity
  * Fix issues before proceeding to the next chunk

\`\`\`
// Clone the node to create a safe copy
clone_node(nodeId: "selected-node-id", x: [new-x], y: [new-y])

// Replace text chunk by chunk
set_multiple_text_contents(
  nodeId: "parent-node-id", 
  text: [
    { nodeId: "node-id-1", text: "New text 1" },
    // More nodes in this chunk...
  ]
)

// Verify chunk with small, targeted image exports
export_node_as_image(nodeId: "chunk-node-id", format: "PNG", scale: 0.5)
\`\`\`

## 4. Intelligent Handling for Table Data
- For tabular content:
  * Process one row or column at a time
  * Maintain alignment and spacing between cells
  * Consider conditional formatting based on cell content
  * Preserve header/data relationships

## 5. Smart Text Adaptation
- Adaptively handle text based on container constraints:
  * Auto-detect space constraints and adjust text length
  * Apply line breaks at appropriate linguistic points
  * Maintain text hierarchy and emphasis
  * Consider font scaling for critical content that must fit

## 6. Progressive Feedback Loop
- Establish a continuous feedback loop during replacement:
  * Real-time progress updates (0-100%)
  * Small image exports after each chunk for verification
  * Issues identified early and resolved incrementally
  * Quick adjustments applied to subsequent chunks

## 7. Final Verification & Context-Aware QA
- After all chunks are processed:
  * Export the entire design at reduced scale for final verification
  * Check for cross-chunk consistency issues
  * Verify proper text flow between different sections
  * Ensure design harmony across the full composition

## 8. Chunk-Specific Export Scale Guidelines
- Scale exports appropriately based on chunk size:
  * Small chunks (1-5 elements): scale 1.0
  * Medium chunks (6-20 elements): scale 0.7
  * Large chunks (21-50 elements): scale 0.5
  * Very large chunks (50+ elements): scale 0.3
  * Full design verification: scale 0.2

## Sample Chunking Strategy for Common Design Types

### Tables
- Process by logical rows (5-10 rows per chunk)
- Alternative: Process by column for columnar analysis
- Tip: Always include header row in first chunk for reference

### Card Lists
- Group 3-5 similar cards per chunk
- Process entire cards to maintain internal consistency
- Verify text-to-image ratio within cards after each chunk

### Forms
- Group related fields (e.g., "Personal Information", "Payment Details")
- Process labels and input fields together
- Ensure validation messages and hints are updated with their fields

### Navigation & Menus
- Process hierarchical levels together (main menu, submenu)
- Respect information architecture relationships
- Verify menu fit and alignment after replacement

## Best Practices
- **Preserve Design Intent**: Always prioritize design integrity
- **Structural Consistency**: Maintain alignment, spacing, and hierarchy
- **Visual Feedback**: Verify each chunk visually before proceeding
- **Incremental Improvement**: Learn from each chunk to improve subsequent ones
- **Balance Automation & Control**: Let AI handle repetitive replacements but maintain oversight
- **Respect Content Relationships**: Keep related content consistent across chunks

Remember that text is never just text—it's a core design element that must work harmoniously with the overall composition. This chunk-based strategy allows you to methodically transform text while maintaining design integrity.`,
          },
        },
      ],
      description: "Systematic approach for replacing text in Figma designs",
    };
  }
);

// Set Multiple Text Contents Tool
server.tool(
  "set_multiple_text_contents",
  "Set multiple text contents parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the text nodes to replace"),
    text: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the text node"),
          text: z.string().describe("The replacement text"),
        })
      )
      .describe("Array of text node IDs and their replacement texts"),
  },
  async ({ nodeId, text }: any) => {
    try {
      if (!text || text.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No text provided",
            },
          ],
        };
      }

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting text replacement for ${text.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      let totalProcessed = 0;
      const totalToProcess = text.length;

      // Use the plugin's set_multiple_text_contents function with chunking
      const result = await sendCommandToFigma("set_multiple_text_contents", {
        nodeId,
        text,
      });

      // Cast the result to a specific type to work with it safely
      interface TextReplaceResult {
        success: boolean;
        nodeId: string;
        replacementsApplied?: number;
        replacementsFailed?: number;
        totalReplacements?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          originalText?: string;
          translatedText?: string;
        }>;
      }

      const typedResult = result as TextReplaceResult;

      // Format the results for display
      const success = typedResult.replacementsApplied && typedResult.replacementsApplied > 0;
      const progressText = `
      Text replacement completed:
      - ${typedResult.replacementsApplied || 0} of ${totalToProcess} successfully updated
      - ${typedResult.replacementsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter(item => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults.map(item =>
          `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join('\n')}`;
      }

      return {
        content: [
          initialStatus,
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple text contents: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Annotation Conversion Strategy Prompt
server.prompt(
  "annotation_conversion_strategy",
  "Strategy for converting manual annotations to Figma's native annotations",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Automatic Annotation Conversion
            
## Process Overview

The process of converting manual annotations (numbered/alphabetical indicators with connected descriptions) to Figma's native annotations:

1. Get selected frame/component information
2. Scan and collect all annotation text nodes
3. Scan target UI elements (components, instances, frames)
4. Match annotations to appropriate UI elements
5. Apply native Figma annotations

## Step 1: Get Selection and Initial Setup

First, get the selected frame or component that contains annotations:

\`\`\`typescript
// Get the selected frame/component
const selection = await get_selection();
const selectedNodeId = selection[0].id

// Get available annotation categories for later use
const annotationData = await get_annotations({
  nodeId: selectedNodeId,
  includeCategories: true
});
const categories = annotationData.categories;
\`\`\`

## Step 2: Scan Annotation Text Nodes

Scan all text nodes to identify annotations and their descriptions:

\`\`\`typescript
// Get all text nodes in the selection
const textNodes = await scan_text_nodes({
  nodeId: selectedNodeId
});

// Filter and group annotation markers and descriptions

// Markers typically have these characteristics:
// - Short text content (usually single digit/letter)
// - Specific font styles (often bold)
// - Located in a container with "Marker" or "Dot" in the name
// - Have a clear naming pattern (e.g., "1", "2", "3" or "A", "B", "C")


// Identify description nodes
// Usually longer text nodes near markers or with matching numbers in path
  
\`\`\`

## Step 3: Scan Target UI Elements

Get all potential target elements that annotations might refer to:

\`\`\`typescript
// Scan for all UI elements that could be annotation targets
const targetNodes = await scan_nodes_by_types({
  nodeId: selectedNodeId,
  types: [
    "COMPONENT",
    "INSTANCE",
    "FRAME"
  ]
});
\`\`\`

## Step 4: Match Annotations to Targets

Match each annotation to its target UI element using these strategies in order of priority:

1. **Path-Based Matching**:
   - Look at the marker's parent container name in the Figma layer hierarchy
   - Remove any "Marker:" or "Annotation:" prefixes from the parent name
   - Find UI elements that share the same parent name or have it in their path
   - This works well when markers are grouped with their target elements

2. **Name-Based Matching**:
   - Extract key terms from the annotation description
   - Look for UI elements whose names contain these key terms
   - Consider both exact matches and semantic similarities
   - Particularly effective for form fields, buttons, and labeled components

3. **Proximity-Based Matching** (fallback):
   - Calculate the center point of the marker
   - Find the closest UI element by measuring distances to element centers
   - Consider the marker's position relative to nearby elements
   - Use this method when other matching strategies fail

Additional Matching Considerations:
- Give higher priority to matches found through path-based matching
- Consider the type of UI element when evaluating matches
- Take into account the annotation's context and content
- Use a combination of strategies for more accurate matching

## Step 5: Apply Native Annotations

Convert matched annotations to Figma's native annotations using batch processing:

\`\`\`typescript
// Prepare annotations array for batch processing
const annotationsToApply = Object.values(annotations).map(({ marker, description }) => {
  // Find target using multiple strategies
  const target = 
    findTargetByPath(marker, targetNodes) ||
    findTargetByName(description, targetNodes) ||
    findTargetByProximity(marker, targetNodes);
  
  if (target) {
    // Determine appropriate category based on content
    const category = determineCategory(description.characters, categories);

    // Determine appropriate additional annotationProperty based on content
    const annotationProperty = determineProperties(description.characters, target.type);
    
    return {
      nodeId: target.id,
      labelMarkdown: description.characters,
      categoryId: category.id,
      properties: annotationProperty
    };
  }
  return null;
}).filter(Boolean); // Remove null entries

// Apply annotations in batches using set_multiple_annotations
if (annotationsToApply.length > 0) {
  await set_multiple_annotations({
    nodeId: selectedNodeId,
    annotations: annotationsToApply
  });
}
\`\`\`


This strategy focuses on practical implementation based on real-world usage patterns, emphasizing the importance of handling various UI elements as annotation targets, not just text nodes.`
          },
        },
      ],
      description: "Strategy for converting manual annotations to Figma's native annotations",
    };
  }
);

// Instance Slot Filling Strategy Prompt
server.prompt(
  "swap_overrides_instances",
  "Guide to swap instance overrides between instances",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Swap Component Instance and Override Strategy

## Overview
This strategy enables transferring content and property overrides from a source instance to one or more target instances in Figma, maintaining design consistency while reducing manual work.

## Step-by-Step Process

### 1. Selection Analysis
- Use \`get_selection()\` to identify the parent component or selected instances
- For parent components, scan for instances with \`scan_nodes_by_types({ nodeId: "parent-id", types: ["INSTANCE"] })\`
- Identify custom slots by name patterns (e.g. "Custom Slot*" or "Instance Slot") or by examining text content
- Determine which is the source instance (with content to copy) and which are targets (where to apply content)

### 2. Extract Source Overrides
- Use \`get_instance_overrides()\` to extract customizations from the source instance
- This captures text content, property values, and style overrides
- Command syntax: \`get_instance_overrides({ nodeId: "source-instance-id" })\`
- Look for successful response like "Got component information from [instance name]"

### 3. Apply Overrides to Targets
- Apply captured overrides using \`set_instance_overrides()\`
- Command syntax:
  \`\`\`
  set_instance_overrides({
    sourceInstanceId: "source-instance-id", 
    targetNodeIds: ["target-id-1", "target-id-2", ...]
  })
  \`\`\`

### 4. Verification
- Verify results with \`get_node_info()\` or \`read_my_design()\`
- Confirm text content and style overrides have transferred successfully

## Key Tips
- Always join the appropriate channel first with \`join_channel()\`
- When working with multiple targets, check the full selection with \`get_selection()\`
- Preserve component relationships by using instance overrides rather than direct text manipulation`,
          },
        },
      ],
      description: "Strategy for transferring overrides between component instances in Figma",
    };
  }
);

// Set Layout Mode Tool
server.tool(
  "set_layout_mode",
  "Set the layout mode and wrap behavior of a frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).describe("Layout mode for the frame"),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children")
  },
  async ({ nodeId, layoutMode, layoutWrap }: any) => {
    try {
      const result = await sendCommandToFigma("set_layout_mode", {
        nodeId,
        layoutMode,
        layoutWrap: layoutWrap || "NO_WRAP"
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set layout mode of frame "${typedResult.name}" to ${layoutMode}${layoutWrap ? ` with ${layoutWrap}` : ''}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layout mode: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Padding Tool
server.tool(
  "set_padding",
  "Set padding values for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    paddingTop: z.number().optional().describe("Top padding value"),
    paddingRight: z.number().optional().describe("Right padding value"),
    paddingBottom: z.number().optional().describe("Bottom padding value"),
    paddingLeft: z.number().optional().describe("Left padding value"),
  },
  async ({ nodeId, paddingTop, paddingRight, paddingBottom, paddingLeft }: any) => {
    try {
      const result = await sendCommandToFigma("set_padding", {
        nodeId,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
      });
      const typedResult = result as { name: string };

      // Create a message about which padding values were set
      const paddingMessages = [];
      if (paddingTop !== undefined) paddingMessages.push(`top: ${paddingTop}`);
      if (paddingRight !== undefined) paddingMessages.push(`right: ${paddingRight}`);
      if (paddingBottom !== undefined) paddingMessages.push(`bottom: ${paddingBottom}`);
      if (paddingLeft !== undefined) paddingMessages.push(`left: ${paddingLeft}`);

      const paddingText = paddingMessages.length > 0
        ? `padding (${paddingMessages.join(', ')})`
        : "padding";

      return {
        content: [
          {
            type: "text",
            text: `Set ${paddingText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting padding: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Axis Align Tool
server.tool(
  "set_axis_align",
  "Set primary and counter axis alignment for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    primaryAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"])
      .optional()
      .describe("Primary axis alignment (MIN/MAX = left/right in horizontal, top/bottom in vertical). Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
    counterAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "BASELINE"])
      .optional()
      .describe("Counter axis alignment (MIN/MAX = top/bottom in horizontal, left/right in vertical)")
  },
  async ({ nodeId, primaryAxisAlignItems, counterAxisAlignItems }: any) => {
    try {
      const result = await sendCommandToFigma("set_axis_align", {
        nodeId,
        primaryAxisAlignItems,
        counterAxisAlignItems
      });
      const typedResult = result as { name: string };

      // Create a message about which alignments were set
      const alignMessages = [];
      if (primaryAxisAlignItems !== undefined) alignMessages.push(`primary: ${primaryAxisAlignItems}`);
      if (counterAxisAlignItems !== undefined) alignMessages.push(`counter: ${counterAxisAlignItems}`);

      const alignText = alignMessages.length > 0
        ? `axis alignment (${alignMessages.join(', ')})`
        : "axis alignment";

      return {
        content: [
          {
            type: "text",
            text: `Set ${alignText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting axis alignment: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Layout Sizing Tool
server.tool(
  "set_layout_sizing",
  "Set horizontal and vertical sizing modes for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    layoutSizingHorizontal: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("Horizontal sizing mode (HUG for frames/text only, FILL for auto-layout children only)"),
    layoutSizingVertical: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("Vertical sizing mode (HUG for frames/text only, FILL for auto-layout children only)")
  },
  async ({ nodeId, layoutSizingHorizontal, layoutSizingVertical }: any) => {
    try {
      const result = await sendCommandToFigma("set_layout_sizing", {
        nodeId,
        layoutSizingHorizontal,
        layoutSizingVertical
      });
      const typedResult = result as { name: string };

      // Create a message about which sizing modes were set
      const sizingMessages = [];
      if (layoutSizingHorizontal !== undefined) sizingMessages.push(`horizontal: ${layoutSizingHorizontal}`);
      if (layoutSizingVertical !== undefined) sizingMessages.push(`vertical: ${layoutSizingVertical}`);

      const sizingText = sizingMessages.length > 0
        ? `layout sizing (${sizingMessages.join(', ')})`
        : "layout sizing";

      return {
        content: [
          {
            type: "text",
            text: `Set ${sizingText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layout sizing: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Item Spacing Tool
server.tool(
  "set_item_spacing",
  "Set distance between children in an auto-layout frame",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    itemSpacing: z.number().optional().describe("Distance between children. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN."),
    counterAxisSpacing: z.number().optional().describe("Distance between wrapped rows/columns. Only works when layoutWrap is set to WRAP.")
  },
  async ({ nodeId, itemSpacing, counterAxisSpacing}: any) => {
    try {
      const params: any = { nodeId };
      if (itemSpacing !== undefined) params.itemSpacing = itemSpacing;
      if (counterAxisSpacing !== undefined) params.counterAxisSpacing = counterAxisSpacing;
      
      const result = await sendCommandToFigma("set_item_spacing", params);
      const typedResult = result as { name: string, itemSpacing?: number, counterAxisSpacing?: number };

      let message = `Updated spacing for frame "${typedResult.name}":`;
      if (itemSpacing !== undefined) message += ` itemSpacing=${itemSpacing}`;
      if (counterAxisSpacing !== undefined) message += ` counterAxisSpacing=${counterAxisSpacing}`;

      return {
        content: [
          {
            type: "text",
            text: message,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting spacing: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// A tool to get Figma Prototyping Reactions from multiple nodes
server.tool(
  "get_reactions",
  "Get Figma Prototyping Reactions from multiple nodes. CRITICAL: The output MUST be processed using the 'reaction_to_connector_strategy' prompt IMMEDIATELY to generate parameters for connector lines via the 'create_connections' tool.",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to get reactions from"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("get_reactions", { nodeIds });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          },
          {
            type: "text",
            text: "IMPORTANT: You MUST now use the reaction data above and follow the `reaction_to_connector_strategy` prompt to prepare the parameters for the `create_connections` tool call. This is a required next step."
          }
        ],
        followUp: {
          type: "prompt",
          prompt: "reaction_to_connector_strategy",
        },
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting reactions: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Connectors Tool
server.tool(
  "set_default_connector",
  "Set a copied connector node as the default connector",
  {
    connectorId: z.string().optional().describe("The ID of the connector node to set as default")
  },
  async ({ connectorId }: any) => {
    try {
      const result = await sendCommandToFigma("set_default_connector", {
        connectorId
      });

      return {
        content: [
          {
            type: "text",
            text: `Default connector set: ${JSON.stringify(result)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting default connector: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Connect Nodes Tool
server.tool(
  "create_connections",
  "Create connections between nodes using the default connector style",
  {
    connections: z.array(z.object({
      startNodeId: z.string().describe("ID of the starting node"),
      endNodeId: z.string().describe("ID of the ending node"),
      text: z.string().optional().describe("Optional text to display on the connector")
    })).describe("Array of node connections to create")
  },
  async ({ connections }: any) => {
    try {
      if (!connections || connections.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No connections provided"
            }
          ]
        };
      }

      const result = await sendCommandToFigma("create_connections", {
        connections
      });

      return {
        content: [
          {
            type: "text",
            text: `Created ${connections.length} connections: ${JSON.stringify(result)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating connections: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Focus Tool
server.tool(
  "set_focus",
  "Set focus on a specific node in Figma by selecting it and scrolling viewport to it",
  {
    nodeId: z.string().describe("The ID of the node to focus on"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("set_focus", { nodeId });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Focused on node "${typedResult.name}" (ID: ${typedResult.id})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting focus: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Selections Tool
server.tool(
  "set_selections",
  "Set selection to multiple nodes in Figma and scroll viewport to show them",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to select"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_selections", { nodeIds });
      const typedResult = result as { selectedNodes: Array<{ name: string; id: string }>; count: number };
      return {
        content: [
          {
            type: "text",
            text: `Selected ${typedResult.count} nodes: ${typedResult.selectedNodes.map(node => `"${node.name}" (${node.id})`).join(', ')}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting selections: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// ============================================
// Phase 1A: Node Management Tools
// ============================================

// Rename Node Tool
server.tool(
  "rename_node",
  "Rename a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to rename"),
    name: z.string().describe("The new name for the node"),
  },
  async ({ nodeId, name }: any) => {
    try {
      const result = await sendCommandToFigma("rename_node", { nodeId, name });
      const typedResult = result as { id: string; name: string; oldName: string };
      return {
        content: [{ type: "text", text: `Renamed node from "${typedResult.oldName}" to "${typedResult.name}"` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error renaming node: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Opacity Tool
server.tool(
  "set_opacity",
  "Set the opacity of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    opacity: z.number().min(0).max(1).describe("Opacity value (0 = fully transparent, 1 = fully opaque)"),
  },
  async ({ nodeId, opacity }: any) => {
    try {
      const result = await sendCommandToFigma("set_opacity", { nodeId, opacity });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Set opacity of "${typedResult.name}" to ${opacity}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting opacity: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Visible Tool
server.tool(
  "set_visible",
  "Set the visibility of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    visible: z.boolean().describe("Whether the node should be visible"),
  },
  async ({ nodeId, visible }: any) => {
    try {
      const result = await sendCommandToFigma("set_visible", { nodeId, visible });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Set visibility of "${typedResult.name}" to ${visible}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting visibility: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Locked Tool
server.tool(
  "set_locked",
  "Set the locked state of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    locked: z.boolean().describe("Whether the node should be locked"),
  },
  async ({ nodeId, locked }: any) => {
    try {
      const result = await sendCommandToFigma("set_locked", { nodeId, locked });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Set locked state of "${typedResult.name}" to ${locked}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting locked state: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Group Nodes Tool
server.tool(
  "group_nodes",
  "Group multiple nodes together in Figma",
  {
    nodeIds: z.array(z.string()).min(2).describe("Array of node IDs to group together (minimum 2)"),
    name: z.string().optional().describe("Optional name for the group"),
  },
  async ({ nodeIds, name }: any) => {
    try {
      const result = await sendCommandToFigma("group_nodes", { nodeIds, name });
      const typedResult = result as { id: string; name: string; childCount: number };
      return {
        content: [{ type: "text", text: `Created group "${typedResult.name}" with ${typedResult.childCount} children (ID: ${typedResult.id})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error grouping nodes: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Ungroup Nodes Tool
server.tool(
  "ungroup_nodes",
  "Ungroup a group node in Figma, moving its children to the parent",
  {
    nodeId: z.string().describe("The ID of the group node to ungroup"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("ungroup_nodes", { nodeId });
      const typedResult = result as { ungroupedCount: number };
      return {
        content: [{ type: "text", text: `Ungrouped ${typedResult.ungroupedCount} children` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error ungrouping nodes: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Insert Child Tool
server.tool(
  "insert_child",
  "Move a node into a new parent at a specific index in Figma",
  {
    nodeId: z.string().describe("The ID of the node to move"),
    parentId: z.string().describe("The ID of the new parent node"),
    index: z.number().optional().describe("The index position to insert at (default: append at end)"),
  },
  async ({ nodeId, parentId, index }: any) => {
    try {
      const result = await sendCommandToFigma("insert_child", { nodeId, parentId, index });
      const typedResult = result as { name: string; parentName: string };
      return {
        content: [{ type: "text", text: `Moved "${typedResult.name}" into "${typedResult.parentName}"` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error inserting child: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ============================================
// Phase 1B: Shape Creation Tools
// ============================================

// Create Ellipse Tool
server.tool(
  "create_ellipse",
  "Create a new ellipse/circle in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the ellipse"),
    height: z.number().describe("Height of the ellipse"),
    name: z.string().optional().describe("Optional name for the ellipse"),
    parentId: z.string().optional().describe("Optional parent node ID to append the ellipse to"),
  },
  async ({ x, y, width, height, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_ellipse", {
        x, y, width, height, name: name || "Ellipse", parentId,
      });
      return {
        content: [{ type: "text", text: `Created ellipse "${JSON.stringify(result)}"` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating ellipse: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Create Line Tool
server.tool(
  "create_line",
  "Create a new line in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    length: z.number().describe("Length of the line"),
    rotation: z.number().optional().describe("Rotation angle in degrees (default: 0, horizontal)"),
    strokeColor: z.object({
      r: z.number().min(0).max(1),
      g: z.number().min(0).max(1),
      b: z.number().min(0).max(1),
      a: z.number().min(0).max(1).optional(),
    }).optional().describe("Stroke color in RGBA format"),
    strokeWeight: z.number().positive().optional().describe("Stroke weight (default: 1)"),
    name: z.string().optional().describe("Optional name for the line"),
    parentId: z.string().optional().describe("Optional parent node ID to append the line to"),
  },
  async ({ x, y, length, rotation, strokeColor, strokeWeight, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_line", {
        x, y, length, rotation, strokeColor, strokeWeight, name: name || "Line", parentId,
      });
      return {
        content: [{ type: "text", text: `Created line "${JSON.stringify(result)}"` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating line: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Create Polygon Tool
server.tool(
  "create_polygon",
  "Create a new polygon in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the polygon"),
    height: z.number().describe("Height of the polygon"),
    pointCount: z.number().optional().describe("Number of sides (default: 3 for triangle)"),
    name: z.string().optional().describe("Optional name for the polygon"),
    parentId: z.string().optional().describe("Optional parent node ID to append the polygon to"),
  },
  async ({ x, y, width, height, pointCount, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_polygon", {
        x, y, width, height, pointCount, name: name || "Polygon", parentId,
      });
      return {
        content: [{ type: "text", text: `Created polygon "${JSON.stringify(result)}"` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating polygon: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Create Star Tool
server.tool(
  "create_star",
  "Create a new star shape in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the star"),
    height: z.number().describe("Height of the star"),
    pointCount: z.number().optional().describe("Number of points (default: 5)"),
    innerRadius: z.number().min(0).max(1).optional().describe("Inner radius ratio 0-1 (default: 0.382)"),
    name: z.string().optional().describe("Optional name for the star"),
    parentId: z.string().optional().describe("Optional parent node ID to append the star to"),
  },
  async ({ x, y, width, height, pointCount, innerRadius, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_star", {
        x, y, width, height, pointCount, innerRadius, name: name || "Star", parentId,
      });
      return {
        content: [{ type: "text", text: `Created star "${JSON.stringify(result)}"` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating star: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ============================================
// Phase 1C: Page Management Tools
// ============================================

// Get Pages Tool
server.tool(
  "get_pages",
  "Get all pages in the current Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_pages");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error getting pages: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Get Current Page Tool
server.tool(
  "get_current_page",
  "Get information about the current page in Figma",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_current_page");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error getting current page: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Current Page Tool
server.tool(
  "set_current_page",
  "Switch to a different page in Figma",
  {
    pageId: z.string().describe("The ID of the page to switch to"),
  },
  async ({ pageId }: any) => {
    try {
      const result = await sendCommandToFigma("set_current_page", { pageId });
      const typedResult = result as { name: string; id: string };
      return {
        content: [{ type: "text", text: `Switched to page "${typedResult.name}" (ID: ${typedResult.id})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error switching page: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Create Page Tool
server.tool(
  "create_page",
  "Create a new page in the Figma document",
  {
    name: z.string().optional().describe("Name for the new page"),
  },
  async ({ name }: any) => {
    try {
      const result = await sendCommandToFigma("create_page", { name });
      const typedResult = result as { name: string; id: string };
      return {
        content: [{ type: "text", text: `Created page "${typedResult.name}" (ID: ${typedResult.id})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating page: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Rename Page Tool
server.tool(
  "rename_page",
  "Rename a page in the Figma document",
  {
    pageId: z.string().describe("The ID of the page to rename"),
    name: z.string().describe("The new name for the page"),
  },
  async ({ pageId, name }: any) => {
    try {
      const result = await sendCommandToFigma("rename_page", { pageId, name });
      const typedResult = result as { oldName: string; name: string };
      return {
        content: [{ type: "text", text: `Renamed page from "${typedResult.oldName}" to "${typedResult.name}"` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error renaming page: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ============================================
// Phase 1D: Text Styling Tools
// ============================================

// Load Font Async Tool
server.tool(
  "load_font_async",
  "Pre-load a font in Figma (required before modifying text properties)",
  {
    fontFamily: z.string().describe("Font family name (e.g., 'Inter', 'Roboto')"),
    fontStyle: z.string().optional().describe("Font style (e.g., 'Regular', 'Bold', 'Italic'). Default: 'Regular'"),
  },
  async ({ fontFamily, fontStyle }: any) => {
    try {
      const result = await sendCommandToFigma("load_font_async", { fontFamily, fontStyle: fontStyle || "Regular" });
      return {
        content: [{ type: "text", text: `Loaded font "${fontFamily}" (${fontStyle || "Regular"})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error loading font: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Font Family Tool
server.tool(
  "set_font_family",
  "Set the font family of a text node in Figma. Font will be auto-loaded.",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    fontFamily: z.string().describe("Font family name (e.g., 'Inter', 'Roboto')"),
    fontStyle: z.string().optional().describe("Font style (e.g., 'Regular', 'Bold'). Default: 'Regular'"),
  },
  async ({ nodeId, fontFamily, fontStyle }: any) => {
    try {
      const result = await sendCommandToFigma("set_font_family", { nodeId, fontFamily, fontStyle: fontStyle || "Regular" });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Set font of "${typedResult.name}" to ${fontFamily} ${fontStyle || "Regular"}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting font family: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Font Size Tool
server.tool(
  "set_font_size",
  "Set the font size of a text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    fontSize: z.number().positive().describe("Font size in pixels"),
  },
  async ({ nodeId, fontSize }: any) => {
    try {
      const result = await sendCommandToFigma("set_font_size", { nodeId, fontSize });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Set font size of "${typedResult.name}" to ${fontSize}px` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting font size: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Font Weight Tool
server.tool(
  "set_font_weight",
  "Set the font weight of a text node in Figma (maps to font style like Regular, Bold, etc.)",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    fontWeight: z.number().describe("Font weight (e.g., 400 for Regular, 700 for Bold)"),
  },
  async ({ nodeId, fontWeight }: any) => {
    try {
      const result = await sendCommandToFigma("set_font_weight", { nodeId, fontWeight });
      const typedResult = result as { name: string; fontStyle: string };
      return {
        content: [{ type: "text", text: `Set font weight of "${typedResult.name}" to ${fontWeight} (${typedResult.fontStyle})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting font weight: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Text Align Tool
server.tool(
  "set_text_align",
  "Set text alignment of a text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    horizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional().describe("Horizontal text alignment"),
    vertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional().describe("Vertical text alignment"),
  },
  async ({ nodeId, horizontal, vertical }: any) => {
    try {
      const result = await sendCommandToFigma("set_text_align", { nodeId, horizontal, vertical });
      const typedResult = result as { name: string };
      const parts = [];
      if (horizontal) parts.push(`horizontal: ${horizontal}`);
      if (vertical) parts.push(`vertical: ${vertical}`);
      return {
        content: [{ type: "text", text: `Set text alignment of "${typedResult.name}" (${parts.join(', ')})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting text alignment: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Line Height Tool
server.tool(
  "set_line_height",
  "Set the line height of a text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    value: z.number().describe("Line height value"),
    unit: z.enum(["PIXELS", "PERCENT", "AUTO"]).optional().describe("Unit type (default: PIXELS). Use AUTO to reset to auto line height."),
  },
  async ({ nodeId, value, unit }: any) => {
    try {
      const result = await sendCommandToFigma("set_line_height", { nodeId, value, unit: unit || "PIXELS" });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Set line height of "${typedResult.name}" to ${value}${(unit || "PIXELS") === "PERCENT" ? "%" : "px"}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting line height: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Letter Spacing Tool
server.tool(
  "set_letter_spacing",
  "Set the letter spacing of a text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    value: z.number().describe("Letter spacing value"),
    unit: z.enum(["PIXELS", "PERCENT"]).optional().describe("Unit type (default: PIXELS)"),
  },
  async ({ nodeId, value, unit }: any) => {
    try {
      const result = await sendCommandToFigma("set_letter_spacing", { nodeId, value, unit: unit || "PIXELS" });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Set letter spacing of "${typedResult.name}" to ${value}${(unit || "PIXELS") === "PERCENT" ? "%" : "px"}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting letter spacing: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Get Styled Text Segments Tool
server.tool(
  "get_styled_text_segments",
  "Get styled text segments from a text node in Figma (font, size, color, etc. per segment)",
  {
    nodeId: z.string().describe("The ID of the text node to inspect"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_styled_text_segments", { nodeId });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error getting styled text segments: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ============================================
// Phase 1E: Effects & Styling Tools
// ============================================

// Set Effects Tool
server.tool(
  "set_effects",
  "Set effects (drop shadow, inner shadow, layer blur, background blur) on a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    effects: z.array(z.object({
      type: z.enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"]).describe("Effect type"),
      color: z.object({
        r: z.number().min(0).max(1),
        g: z.number().min(0).max(1),
        b: z.number().min(0).max(1),
        a: z.number().min(0).max(1).optional(),
      }).optional().describe("Color for shadow effects (RGBA 0-1)"),
      offset: z.object({
        x: z.number(),
        y: z.number(),
      }).optional().describe("Offset for shadow effects"),
      radius: z.number().optional().describe("Blur radius"),
      spread: z.number().optional().describe("Spread for shadow effects"),
      visible: z.boolean().optional().describe("Whether the effect is visible (default: true)"),
    })).describe("Array of effects to apply"),
  },
  async ({ nodeId, effects }: any) => {
    try {
      const result = await sendCommandToFigma("set_effects", { nodeId, effects });
      const typedResult = result as { name: string; effectCount: number };
      return {
        content: [{ type: "text", text: `Applied ${typedResult.effectCount} effect(s) to "${typedResult.name}"` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting effects: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Blend Mode Tool
server.tool(
  "set_blend_mode",
  "Set the blend mode of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    blendMode: z.enum([
      "NORMAL", "DARKEN", "MULTIPLY", "COLOR_BURN", "LINEAR_BURN",
      "LIGHTEN", "SCREEN", "COLOR_DODGE", "LINEAR_DODGE",
      "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT",
      "DIFFERENCE", "EXCLUSION",
      "HUE", "SATURATION", "COLOR", "LUMINOSITY",
    ]).describe("Blend mode"),
  },
  async ({ nodeId, blendMode }: any) => {
    try {
      const result = await sendCommandToFigma("set_blend_mode", { nodeId, blendMode });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Set blend mode of "${typedResult.name}" to ${blendMode}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting blend mode: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Gradient Fill Tool
server.tool(
  "set_gradient_fill",
  "Set a gradient fill on a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    gradientType: z.enum(["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"]).describe("Type of gradient"),
    gradientStops: z.array(z.object({
      position: z.number().min(0).max(1).describe("Stop position (0-1)"),
      color: z.object({
        r: z.number().min(0).max(1),
        g: z.number().min(0).max(1),
        b: z.number().min(0).max(1),
        a: z.number().min(0).max(1).optional(),
      }).describe("Stop color"),
    })).describe("Array of gradient color stops"),
    angle: z.number().optional().describe("Angle in degrees for linear gradients (default: 0)"),
  },
  async ({ nodeId, gradientType, gradientStops, angle }: any) => {
    try {
      const result = await sendCommandToFigma("set_gradient_fill", { nodeId, gradientType, gradientStops, angle });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Applied ${gradientType} fill to "${typedResult.name}" with ${gradientStops.length} stops` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting gradient fill: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ============================================
// Phase 2A: Component & Variant Tools
// ============================================

// Create Component Tool
server.tool(
  "create_component",
  "Convert a frame/group node into a reusable component in Figma",
  {
    nodeId: z.string().describe("The ID of the frame or group node to convert into a component"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("create_component", { nodeId });
      const typedResult = result as { id: string; name: string; key: string };
      return {
        content: [{ type: "text", text: `Created component "${typedResult.name}" (ID: ${typedResult.id}, Key: ${typedResult.key})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating component: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Swap Component Tool
server.tool(
  "swap_component",
  "Swap the main component of an instance in Figma",
  {
    instanceId: z.string().describe("The ID of the component instance to modify"),
    componentKey: z.string().describe("The key of the new component to swap to"),
  },
  async ({ instanceId, componentKey }: any) => {
    try {
      const result = await sendCommandToFigma("swap_component", { instanceId, componentKey });
      const typedResult = result as { id: string; name: string; newComponentName: string };
      return {
        content: [{ type: "text", text: `Swapped instance "${typedResult.name}" to component "${typedResult.newComponentName}"` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error swapping component: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Get Component Properties Tool
server.tool(
  "get_component_properties",
  "Get all component properties from a component instance in Figma",
  {
    nodeId: z.string().describe("The ID of the component instance to inspect"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_component_properties", { nodeId });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error getting component properties: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Component Property Tool
server.tool(
  "set_component_property",
  "Set a component property value on an instance in Figma",
  {
    nodeId: z.string().describe("The ID of the component instance to modify"),
    property: z.string().describe("The property name to set"),
    value: z.union([z.string(), z.boolean()]).describe("The property value (string for text/instance-swap, boolean for boolean props)"),
  },
  async ({ nodeId, property, value }: any) => {
    try {
      const result = await sendCommandToFigma("set_component_property", { nodeId, property, value });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Set property "${property}" to "${value}" on "${typedResult.name}"` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting component property: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ============================================
// Phase 2B: Boolean Operation Tools
// ============================================

// Boolean Union Tool
server.tool(
  "boolean_union",
  "Create a union (add) boolean operation from multiple nodes in Figma",
  {
    nodeIds: z.array(z.string()).min(2).describe("Array of node IDs to union (minimum 2)"),
    name: z.string().optional().describe("Optional name for the result"),
  },
  async ({ nodeIds, name }: any) => {
    try {
      const result = await sendCommandToFigma("boolean_union", { nodeIds, name });
      const typedResult = result as { id: string; name: string };
      return {
        content: [{ type: "text", text: `Created boolean union "${typedResult.name}" (ID: ${typedResult.id})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating boolean union: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Boolean Subtract Tool
server.tool(
  "boolean_subtract",
  "Create a subtract boolean operation from multiple nodes in Figma (first node minus the rest)",
  {
    nodeIds: z.array(z.string()).min(2).describe("Array of node IDs to subtract (first is base, rest are subtracted)"),
    name: z.string().optional().describe("Optional name for the result"),
  },
  async ({ nodeIds, name }: any) => {
    try {
      const result = await sendCommandToFigma("boolean_subtract", { nodeIds, name });
      const typedResult = result as { id: string; name: string };
      return {
        content: [{ type: "text", text: `Created boolean subtract "${typedResult.name}" (ID: ${typedResult.id})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating boolean subtract: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Boolean Intersect Tool
server.tool(
  "boolean_intersect",
  "Create an intersect boolean operation from multiple nodes in Figma",
  {
    nodeIds: z.array(z.string()).min(2).describe("Array of node IDs to intersect (minimum 2)"),
    name: z.string().optional().describe("Optional name for the result"),
  },
  async ({ nodeIds, name }: any) => {
    try {
      const result = await sendCommandToFigma("boolean_intersect", { nodeIds, name });
      const typedResult = result as { id: string; name: string };
      return {
        content: [{ type: "text", text: `Created boolean intersect "${typedResult.name}" (ID: ${typedResult.id})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating boolean intersect: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Boolean Exclude Tool
server.tool(
  "boolean_exclude",
  "Create an exclude (XOR) boolean operation from multiple nodes in Figma",
  {
    nodeIds: z.array(z.string()).min(2).describe("Array of node IDs to exclude (minimum 2)"),
    name: z.string().optional().describe("Optional name for the result"),
  },
  async ({ nodeIds, name }: any) => {
    try {
      const result = await sendCommandToFigma("boolean_exclude", { nodeIds, name });
      const typedResult = result as { id: string; name: string };
      return {
        content: [{ type: "text", text: `Created boolean exclude "${typedResult.name}" (ID: ${typedResult.id})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating boolean exclude: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ============================================
// Phase 2C: Constraints & Transform Tools
// ============================================

// Set Constraints Tool
server.tool(
  "set_constraints",
  "Set layout constraints for a node in Figma (how it behaves when parent is resized)",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    horizontal: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional().describe("Horizontal constraint"),
    vertical: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional().describe("Vertical constraint"),
  },
  async ({ nodeId, horizontal, vertical }: any) => {
    try {
      const result = await sendCommandToFigma("set_constraints", { nodeId, horizontal, vertical });
      const typedResult = result as { name: string };
      const parts = [];
      if (horizontal) parts.push(`horizontal: ${horizontal}`);
      if (vertical) parts.push(`vertical: ${vertical}`);
      return {
        content: [{ type: "text", text: `Set constraints of "${typedResult.name}" (${parts.join(', ')})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting constraints: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Rotation Tool
server.tool(
  "set_rotation",
  "Set the rotation angle of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to rotate"),
    rotation: z.number().describe("Rotation angle in degrees (-180 to 180)"),
  },
  async ({ nodeId, rotation }: any) => {
    try {
      const result = await sendCommandToFigma("set_rotation", { nodeId, rotation });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Set rotation of "${typedResult.name}" to ${rotation} degrees` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting rotation: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Relative Transform Tool
server.tool(
  "set_relative_transform",
  "Set the 2D affine transformation matrix of a node in Figma (position, rotation, scale)",
  {
    nodeId: z.string().describe("The ID of the node to transform"),
    transform: z.array(z.array(z.number()).length(3)).length(2).describe("2x3 affine transform matrix [[a,b,tx],[c,d,ty]]"),
  },
  async ({ nodeId, transform }: any) => {
    try {
      const result = await sendCommandToFigma("set_relative_transform", { nodeId, transform });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Applied transform to "${typedResult.name}"` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting transform: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ============================================
// Phase 2D: Advanced Text Tools
// ============================================

// Set Text Decoration Tool
server.tool(
  "set_text_decoration",
  "Set text decoration (underline, strikethrough) on a text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    decoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).describe("Text decoration type"),
  },
  async ({ nodeId, decoration }: any) => {
    try {
      const result = await sendCommandToFigma("set_text_decoration", { nodeId, decoration });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Set text decoration of "${typedResult.name}" to ${decoration}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting text decoration: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Text Case Tool
server.tool(
  "set_text_case",
  "Set text case transformation on a text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]).describe("Text case transformation"),
  },
  async ({ nodeId, textCase }: any) => {
    try {
      const result = await sendCommandToFigma("set_text_case", { nodeId, textCase });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Set text case of "${typedResult.name}" to ${textCase}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting text case: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Paragraph Spacing Tool
server.tool(
  "set_paragraph_spacing",
  "Set the spacing between paragraphs in a text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    spacing: z.number().min(0).describe("Paragraph spacing in pixels"),
  },
  async ({ nodeId, spacing }: any) => {
    try {
      const result = await sendCommandToFigma("set_paragraph_spacing", { nodeId, spacing });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Set paragraph spacing of "${typedResult.name}" to ${spacing}px` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting paragraph spacing: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Paragraph Indent Tool
server.tool(
  "set_paragraph_indent",
  "Set the first-line indentation of paragraphs in a text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    indent: z.number().min(0).describe("Paragraph indentation in pixels"),
  },
  async ({ nodeId, indent }: any) => {
    try {
      const result = await sendCommandToFigma("set_paragraph_indent", { nodeId, indent });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Set paragraph indent of "${typedResult.name}" to ${indent}px` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting paragraph indent: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// ============================================
// Phase 3: Power Features
// ============================================

// Get Local Variables Tool
server.tool(
  "get_local_variables",
  "Get all local variables (design tokens) from the current Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_local_variables");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error getting local variables: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Get Team Library Variables Tool
server.tool(
  "get_team_library_variables",
  "Get all available variables from team library variable collections linked to the current Figma file.",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_team_library_variables");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error getting team library variables: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Import Variable By Key Tool
server.tool(
  "import_variable_by_key",
  "Import a variable from a team library by its key, making it available for use in the current file",
  {
    variableKey: z.string().describe("The key of the variable to import from the team library"),
  },
  async ({ variableKey }: any) => {
    try {
      const result = await sendCommandToFigma("import_variable_by_key", { variableKey });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error importing variable: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Get Variable By ID Tool
server.tool(
  "get_variable_by_id",
  "Get a specific variable by its ID from the Figma document",
  {
    variableId: z.string().describe("The ID of the variable to retrieve"),
  },
  async ({ variableId }: any) => {
    try {
      const result = await sendCommandToFigma("get_variable_by_id", { variableId });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error getting variable: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Variable Binding Tool
server.tool(
  "set_variable_binding",
  "Bind a variable (design token) to a node property in Figma",
  {
    nodeId: z.string().describe("The ID of the node to bind the variable to"),
    field: z.string().describe("The field to bind (e.g., 'fills/0/color', 'width', 'height', 'itemSpacing', 'paddingTop', etc.)"),
    variableId: z.string().describe("The ID of the variable to bind"),
  },
  async ({ nodeId, field, variableId }: any) => {
    try {
      const result = await sendCommandToFigma("set_variable_binding", { nodeId, field, variableId });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Bound variable to field "${field}" on "${typedResult.name}"` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error binding variable: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Create Image Tool
server.tool(
  "create_image",
  "Create an image node in Figma from base64-encoded image data",
  {
    imageBytes: z.string().describe("Base64-encoded image data (PNG, JPG, GIF, etc.)"),
    x: z.number().optional().describe("X position (default: 0)"),
    y: z.number().optional().describe("Y position (default: 0)"),
    width: z.number().optional().describe("Width (default: auto from image)"),
    height: z.number().optional().describe("Height (default: auto from image)"),
    name: z.string().optional().describe("Optional name for the image node"),
    parentId: z.string().optional().describe("Optional parent node ID"),
  },
  async ({ imageBytes, x, y, width, height, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_image", { imageBytes, x, y, width, height, name, parentId });
      const typedResult = result as { id: string; name: string; width: number; height: number };
      return {
        content: [{ type: "text", text: `Created image "${typedResult.name}" (${typedResult.width}x${typedResult.height}, ID: ${typedResult.id})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating image: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Image Fill Tool
server.tool(
  "set_image_fill",
  "Set an image fill on an existing node in Figma from base64-encoded image data",
  {
    nodeId: z.string().describe("The ID of the node to apply the image fill to"),
    imageBytes: z.string().describe("Base64-encoded image data"),
    scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional().describe("Image scale mode (default: FILL)"),
  },
  async ({ nodeId, imageBytes, scaleMode }: any) => {
    try {
      const result = await sendCommandToFigma("set_image_fill", { nodeId, imageBytes, scaleMode });
      const typedResult = result as { name: string };
      return {
        content: [{ type: "text", text: `Applied image fill to "${typedResult.name}" (mode: ${scaleMode || "FILL"})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting image fill: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Flatten Node Tool
server.tool(
  "flatten_node",
  "Flatten one or more nodes into a single vector node in Figma",
  {
    nodeIds: z.array(z.string()).min(1).describe("Array of node IDs to flatten"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("flatten_node", { nodeIds });
      const typedResult = result as { id: string; name: string };
      return {
        content: [{ type: "text", text: `Flattened into vector "${typedResult.name}" (ID: ${typedResult.id})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error flattening nodes: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Create Vector Tool
server.tool(
  "create_vector",
  "Create a vector node from SVG path data in Figma",
  {
    svgPath: z.string().describe("SVG path data string (e.g., 'M 0 0 L 100 100 L 0 100 Z')"),
    x: z.number().optional().describe("X position (default: 0)"),
    y: z.number().optional().describe("Y position (default: 0)"),
    name: z.string().optional().describe("Optional name for the vector node"),
    parentId: z.string().optional().describe("Optional parent node ID"),
  },
  async ({ svgPath, x, y, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_vector", { svgPath, x, y, name, parentId });
      const typedResult = result as { id: string; name: string };
      return {
        content: [{ type: "text", text: `Created vector "${typedResult.name}" (ID: ${typedResult.id})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating vector: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Create Paint Style Tool
server.tool(
  "create_paint_style",
  "Create a reusable paint (color/fill) style in Figma",
  {
    name: z.string().describe("Name for the paint style"),
    paints: z.array(z.object({
      type: z.enum(["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"]).describe("Paint type"),
      color: z.object({
        r: z.number().min(0).max(1),
        g: z.number().min(0).max(1),
        b: z.number().min(0).max(1),
        a: z.number().min(0).max(1).optional(),
      }).optional().describe("Color for SOLID paints"),
      opacity: z.number().min(0).max(1).optional().describe("Paint opacity"),
    })).describe("Array of paint definitions"),
  },
  async ({ name, paints }: any) => {
    try {
      const result = await sendCommandToFigma("create_paint_style", { name, paints });
      const typedResult = result as { id: string; name: string; key: string };
      return {
        content: [{ type: "text", text: `Created paint style "${typedResult.name}" (ID: ${typedResult.id})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating paint style: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Create Text Style Tool
server.tool(
  "create_text_style",
  "Create a reusable text style in Figma",
  {
    name: z.string().describe("Name for the text style"),
    fontFamily: z.string().describe("Font family name"),
    fontStyle: z.string().optional().describe("Font style (default: 'Regular')"),
    fontSize: z.number().positive().describe("Font size in pixels"),
    lineHeight: z.object({
      value: z.number(),
      unit: z.enum(["PIXELS", "PERCENT", "AUTO"]),
    }).optional().describe("Line height setting"),
    letterSpacing: z.object({
      value: z.number(),
      unit: z.enum(["PIXELS", "PERCENT"]),
    }).optional().describe("Letter spacing setting"),
  },
  async ({ name, fontFamily, fontStyle, fontSize, lineHeight, letterSpacing }: any) => {
    try {
      const result = await sendCommandToFigma("create_text_style", {
        name, fontFamily, fontStyle: fontStyle || "Regular", fontSize, lineHeight, letterSpacing,
      });
      const typedResult = result as { id: string; name: string };
      return {
        content: [{ type: "text", text: `Created text style "${typedResult.name}" (ID: ${typedResult.id})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating text style: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Create Effect Style Tool
server.tool(
  "create_effect_style",
  "Create a reusable effect style (shadows, blurs) in Figma",
  {
    name: z.string().describe("Name for the effect style"),
    effects: z.array(z.object({
      type: z.enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"]).describe("Effect type"),
      color: z.object({
        r: z.number().min(0).max(1),
        g: z.number().min(0).max(1),
        b: z.number().min(0).max(1),
        a: z.number().min(0).max(1).optional(),
      }).optional().describe("Effect color (for shadows)"),
      offset: z.object({ x: z.number(), y: z.number() }).optional().describe("Shadow offset"),
      radius: z.number().optional().describe("Blur radius"),
      spread: z.number().optional().describe("Shadow spread"),
      visible: z.boolean().optional().describe("Whether effect is visible"),
    })).describe("Array of effect definitions"),
  },
  async ({ name, effects }: any) => {
    try {
      const result = await sendCommandToFigma("create_effect_style", { name, effects });
      const typedResult = result as { id: string; name: string };
      return {
        content: [{ type: "text", text: `Created effect style "${typedResult.name}" (ID: ${typedResult.id})` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating effect style: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Apply Style Tool
server.tool(
  "apply_style",
  "Apply an existing style (paint, text, or effect) to a node in Figma. Provide styleId or styleKey (or both). If styleId lookup fails, falls back to importing by styleKey.",
  {
    nodeId: z.string().describe("The ID of the node to apply the style to"),
    styleId: z.string().optional().describe("The ID of the style to apply"),
    styleKey: z.string().optional().describe("The key of the style to import and apply (used as fallback if styleId fails)"),
    styleType: z.enum(["fill", "stroke", "text", "effect"]).describe("Which property to apply the style to"),
  },
  async ({ nodeId, styleId, styleKey, styleType }: any) => {
    try {
      const result = await sendCommandToFigma("apply_style", { nodeId, styleId, styleKey, styleType });
      const typedResult = result as { name: string; styleName: string };
      return {
        content: [{ type: "text", text: `Applied ${styleType} style "${typedResult.styleName}" to "${typedResult.name}"` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error applying style: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Reactions Tool
server.tool(
  "set_reactions",
  "Set prototype reactions (interactions) on a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to set reactions on"),
    reactions: z.array(z.object({
      trigger: z.object({
        type: z.enum(["ON_CLICK", "ON_HOVER", "ON_PRESS", "ON_DRAG", "MOUSE_ENTER", "MOUSE_LEAVE", "MOUSE_UP", "MOUSE_DOWN", "AFTER_TIMEOUT"]).describe("Trigger type"),
      }).describe("Interaction trigger"),
      action: z.object({
        type: z.enum(["NAVIGATE", "SWAP", "OVERLAY", "SCROLL_TO", "CHANGE_TO", "BACK", "CLOSE", "URL", "NODE"]).describe("Action type"),
        destinationId: z.string().optional().describe("Destination node ID for NAVIGATE/SWAP/OVERLAY actions"),
        navigation: z.enum(["NAVIGATE", "SWAP", "OVERLAY", "SCROLL_TO", "CHANGE_TO"]).optional().describe("Navigation type"),
        transition: z.object({
          type: z.enum(["DISSOLVE", "SMART_ANIMATE", "MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"]).describe("Transition type"),
          duration: z.number().describe("Transition duration in milliseconds"),
        }).optional().describe("Transition animation"),
      }).describe("Interaction action"),
    })).describe("Array of reactions to set"),
  },
  async ({ nodeId, reactions }: any) => {
    try {
      const result = await sendCommandToFigma("set_reactions", { nodeId, reactions });
      const typedResult = result as { name: string; reactionCount: number };
      return {
        content: [{ type: "text", text: `Set ${typedResult.reactionCount} reaction(s) on "${typedResult.name}"` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting reactions: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Strategy for converting Figma prototype reactions to connector lines
server.prompt(
  "reaction_to_connector_strategy",
  "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Strategy: Convert Figma Prototype Reactions to Connector Lines

## Goal
Process the JSON output from the \`get_reactions\` tool to generate an array of connection objects suitable for the \`create_connections\` tool. This visually represents prototype flows as connector lines on the Figma canvas.

## Input Data
You will receive JSON data from the \`get_reactions\` tool. This data contains an array of nodes, each with potential reactions. A typical reaction object looks like this:
\`\`\`json
{
  "trigger": { "type": "ON_CLICK" },
  "action": {
    "type": "NAVIGATE",
    "destinationId": "destination-node-id",
    "navigationTransition": { ... },
    "preserveScrollPosition": false
  }
}
\`\`\`

## Step-by-Step Process

### 1. Preparation & Context Gathering
   - **Action:** Call \`read_my_design\` on the relevant node(s) to get context about the nodes involved (names, types, etc.). This helps in generating meaningful connector labels later.
   - **Action:** Call \`set_default_connector\` **without** the \`connectorId\` parameter.
   - **Check Result:** Analyze the response from \`set_default_connector\`.
     - If it confirms a default connector is already set (e.g., "Default connector is already set"), proceed to Step 2.
     - If it indicates no default connector is set (e.g., "No default connector set..."), you **cannot** proceed with \`create_connections\` yet. Inform the user they need to manually copy a connector from FigJam, paste it onto the current page, select it, and then you can run \`set_default_connector({ connectorId: "SELECTED_NODE_ID" })\` before attempting \`create_connections\`. **Do not proceed to Step 2 until a default connector is confirmed.**

### 2. Filter and Transform Reactions from \`get_reactions\` Output
   - **Iterate:** Go through the JSON array provided by \`get_reactions\`. For each node in the array:
     - Iterate through its \`reactions\` array.
   - **Filter:** Keep only reactions where the \`action\` meets these criteria:
     - Has a \`type\` that implies a connection (e.g., \`NAVIGATE\`, \`OPEN_OVERLAY\`, \`SWAP_OVERLAY\`). **Ignore** types like \`CHANGE_TO\`, \`CLOSE_OVERLAY\`, etc.
     - Has a valid \`destinationId\` property.
   - **Extract:** For each valid reaction, extract the following information:
     - \`sourceNodeId\`: The ID of the node the reaction belongs to (from the outer loop).
     - \`destinationNodeId\`: The value of \`action.destinationId\`.
     - \`actionType\`: The value of \`action.type\`.
     - \`triggerType\`: The value of \`trigger.type\`.

### 3. Generate Connector Text Labels
   - **For each extracted connection:** Create a concise, descriptive text label string.
   - **Combine Information:** Use the \`actionType\`, \`triggerType\`, and potentially the names of the source/destination nodes (obtained from Step 1's \`read_my_design\` or by calling \`get_node_info\` if necessary) to generate the label.
   - **Example Labels:**
     - If \`triggerType\` is "ON\_CLICK" and \`actionType\` is "NAVIGATE": "On click, navigate to [Destination Node Name]"
     - If \`triggerType\` is "ON\_DRAG" and \`actionType\` is "OPEN\_OVERLAY": "On drag, open [Destination Node Name] overlay"
   - **Keep it brief and informative.** Let this generated string be \`generatedText\`.

### 4. Prepare the \`connections\` Array for \`create_connections\`
   - **Structure:** Create a JSON array where each element is an object representing a connection.
   - **Format:** Each object in the array must have the following structure:
     \`\`\`json
     {
       "startNodeId": "sourceNodeId_from_step_2",
       "endNodeId": "destinationNodeId_from_step_2",
       "text": "generatedText_from_step_3"
     }
     \`\`\`
   - **Result:** This final array is the value you will pass to the \`connections\` parameter when calling the \`create_connections\` tool.

### 5. Execute Connection Creation
   - **Action:** Call the \`create_connections\` tool, passing the array generated in Step 4 as the \`connections\` argument.
   - **Verify:** Check the response from \`create_connections\` to confirm success or failure.

This detailed process ensures you correctly interpret the reaction data, prepare the necessary information, and use the appropriate tools to create the connector lines.`
          },
        },
      ],
      description: "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
    };
  }
);


// Define command types and parameters
type FigmaCommand =
  | "get_document_info"
  | "get_selection"
  | "get_node_info"
  | "get_nodes_info"
  | "read_my_design"
  | "create_rectangle"
  | "create_frame"
  | "create_text"
  | "set_fill_color"
  | "set_stroke_color"
  | "move_node"
  | "resize_node"
  | "delete_node"
  | "delete_multiple_nodes"
  | "get_styles"
  | "get_team_library_text_styles"
  | "import_text_style_by_key"
  | "get_local_components"
  | "get_team_components"
  | "create_component_instance"
  | "get_instance_overrides"
  | "set_instance_overrides"
  | "export_node_as_image"
  | "join"
  | "set_corner_radius"
  | "clone_node"
  | "set_text_content"
  | "scan_text_nodes"
  | "set_multiple_text_contents"
  | "get_annotations"
  | "set_annotation"
  | "set_multiple_annotations"
  | "scan_nodes_by_types"
  | "set_layout_mode"
  | "set_padding"
  | "set_axis_align"
  | "set_layout_sizing"
  | "set_item_spacing"
  | "get_reactions"
  | "set_default_connector"
  | "create_connections"
  | "set_focus"
  | "set_selections"
  // Phase 1A: Node Management
  | "rename_node"
  | "set_opacity"
  | "set_visible"
  | "set_locked"
  | "group_nodes"
  | "ungroup_nodes"
  | "insert_child"
  // Phase 1B: Shape Creation
  | "create_ellipse"
  | "create_line"
  | "create_polygon"
  | "create_star"
  // Phase 1C: Page Management
  | "get_pages"
  | "get_current_page"
  | "set_current_page"
  | "create_page"
  | "rename_page"
  // Phase 1D: Text Styling
  | "load_font_async"
  | "set_font_family"
  | "set_font_size"
  | "set_font_weight"
  | "set_text_align"
  | "set_line_height"
  | "set_letter_spacing"
  | "get_styled_text_segments"
  // Phase 1E: Effects & Styling
  | "set_effects"
  | "set_blend_mode"
  | "set_gradient_fill"
  // Phase 2A: Component & Variant
  | "create_component"
  | "swap_component"
  | "get_component_properties"
  | "set_component_property"
  // Phase 2B: Boolean Operations
  | "boolean_union"
  | "boolean_subtract"
  | "boolean_intersect"
  | "boolean_exclude"
  // Phase 2C: Constraints & Transform
  | "set_constraints"
  | "set_rotation"
  | "set_relative_transform"
  // Phase 2D: Advanced Text
  | "set_text_decoration"
  | "set_text_case"
  | "set_paragraph_spacing"
  | "set_paragraph_indent"
  // Phase 3: Power Features
  | "get_local_variables"
  | "get_team_library_variables"
  | "import_variable_by_key"
  | "get_variable_by_id"
  | "set_variable_binding"
  | "create_image"
  | "set_image_fill"
  | "flatten_node"
  | "create_vector"
  | "create_paint_style"
  | "create_text_style"
  | "create_effect_style"
  | "apply_style"
  | "set_reactions";

type CommandParams = {
  get_document_info: Record<string, never>;
  get_selection: Record<string, never>;
  get_node_info: { nodeId: string };
  get_nodes_info: { nodeIds: string[] };
  create_rectangle: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
  };
  create_frame: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
    fillColor?: { r: number; g: number; b: number; a?: number };
    strokeColor?: { r: number; g: number; b: number; a?: number };
    strokeWeight?: number;
  };
  create_text: {
    x: number;
    y: number;
    text: string;
    fontSize?: number;
    fontWeight?: number;
    fontColor?: { r: number; g: number; b: number; a?: number };
    name?: string;
    parentId?: string;
  };
  set_fill_color: {
    nodeId: string;
    r: number;
    g: number;
    b: number;
    a?: number;
  };
  set_stroke_color: {
    nodeId: string;
    r: number;
    g: number;
    b: number;
    a?: number;
    weight?: number;
  };
  move_node: {
    nodeId: string;
    x: number;
    y: number;
  };
  resize_node: {
    nodeId: string;
    width: number;
    height: number;
  };
  delete_node: {
    nodeId: string;
  };
  delete_multiple_nodes: {
    nodeIds: string[];
  };
  get_styles: Record<string, never>;
  get_team_library_text_styles: Record<string, never>;
  import_text_style_by_key: { styleKey: string };
  get_local_components: Record<string, never>;
  get_team_components: Record<string, never>;
  create_component_instance: {
    componentKey: string;
    x: number;
    y: number;
  };
  get_instance_overrides: {
    instanceNodeId: string | null;
  };
  set_instance_overrides: {
    targetNodeIds: string[];
    sourceInstanceId: string;
  };
  export_node_as_image: {
    nodeId: string;
    format?: "PNG" | "JPG" | "SVG" | "PDF";
    scale?: number;
  };
  execute_code: {
    code: string;
  };
  join: {
    channel: string;
  };
  set_corner_radius: {
    nodeId: string;
    radius: number;
    corners?: boolean[];
  };
  clone_node: {
    nodeId: string;
    x?: number;
    y?: number;
  };
  set_text_content: {
    nodeId: string;
    text: string;
  };
  scan_text_nodes: {
    nodeId: string;
    useChunking: boolean;
    chunkSize: number;
  };
  set_multiple_text_contents: {
    nodeId: string;
    text: Array<{ nodeId: string; text: string }>;
  };
  get_annotations: {
    nodeId?: string;
    includeCategories?: boolean;
  };
  set_annotation: {
    nodeId: string;
    annotationId?: string;
    labelMarkdown: string;
    categoryId?: string;
    properties?: Array<{ type: string }>;
  };
  set_multiple_annotations: SetMultipleAnnotationsParams;
  scan_nodes_by_types: {
    nodeId: string;
    types: Array<string>;
  };
  get_reactions: { nodeIds: string[] };
  set_default_connector: {
    connectorId?: string | undefined;
  };
  create_connections: {
    connections: Array<{
      startNodeId: string;
      endNodeId: string;
      text?: string;
    }>;
  };
  set_focus: {
    nodeId: string;
  };
  set_selections: {
    nodeIds: string[];
  };
  // Phase 1A: Node Management
  rename_node: { nodeId: string; name: string };
  set_opacity: { nodeId: string; opacity: number };
  set_visible: { nodeId: string; visible: boolean };
  set_locked: { nodeId: string; locked: boolean };
  group_nodes: { nodeIds: string[]; name?: string };
  ungroup_nodes: { nodeId: string };
  insert_child: { nodeId: string; parentId: string; index?: number };
  // Phase 1B: Shape Creation
  create_ellipse: {
    x: number; y: number; width: number; height: number;
    name?: string; parentId?: string;
  };
  create_line: {
    x: number; y: number; length: number; rotation?: number;
    strokeColor?: { r: number; g: number; b: number; a?: number };
    strokeWeight?: number; name?: string; parentId?: string;
  };
  create_polygon: {
    x: number; y: number; width: number; height: number;
    pointCount?: number; name?: string; parentId?: string;
  };
  create_star: {
    x: number; y: number; width: number; height: number;
    pointCount?: number; innerRadius?: number; name?: string; parentId?: string;
  };
  // Phase 1C: Page Management
  get_pages: Record<string, never>;
  get_current_page: Record<string, never>;
  set_current_page: { pageId: string };
  create_page: { name?: string };
  rename_page: { pageId: string; name: string };
  // Phase 1D: Text Styling
  load_font_async: { fontFamily: string; fontStyle?: string };
  set_font_family: { nodeId: string; fontFamily: string; fontStyle?: string };
  set_font_size: { nodeId: string; fontSize: number };
  set_font_weight: { nodeId: string; fontWeight: number };
  set_text_align: { nodeId: string; horizontal?: string; vertical?: string };
  set_line_height: { nodeId: string; value: number; unit?: string };
  set_letter_spacing: { nodeId: string; value: number; unit?: string };
  get_styled_text_segments: { nodeId: string };
  // Phase 1E: Effects & Styling
  set_effects: {
    nodeId: string;
    effects: Array<{
      type: string;
      color?: { r: number; g: number; b: number; a?: number };
      offset?: { x: number; y: number };
      radius?: number;
      spread?: number;
      visible?: boolean;
    }>;
  };
  set_blend_mode: { nodeId: string; blendMode: string };
  set_gradient_fill: {
    nodeId: string;
    gradientType: string;
    gradientStops: Array<{ position: number; color: { r: number; g: number; b: number; a?: number } }>;
    angle?: number;
  };
  // Phase 2A: Component & Variant
  create_component: { nodeId: string; };
  swap_component: { instanceId: string; componentKey: string; };
  get_component_properties: { nodeId: string; };
  set_component_property: { nodeId: string; property: string; value: string | boolean; };
  // Phase 2B: Boolean Operations
  boolean_union: { nodeIds: string[]; name?: string };
  boolean_subtract: { nodeIds: string[]; name?: string };
  boolean_intersect: { nodeIds: string[]; name?: string };
  boolean_exclude: { nodeIds: string[]; name?: string };
  // Phase 2C: Constraints & Transform
  set_constraints: { nodeId: string; horizontal?: string; vertical?: string };
  set_rotation: { nodeId: string; rotation: number };
  set_relative_transform: { nodeId: string; transform: number[][] };
  // Phase 2D: Advanced Text
  set_text_decoration: { nodeId: string; decoration: string };
  set_text_case: { nodeId: string; textCase: string };
  set_paragraph_spacing: { nodeId: string; spacing: number };
  set_paragraph_indent: { nodeId: string; indent: number };
  // Phase 3: Power Features
  get_local_variables: Record<string, never>;
  get_team_library_variables: Record<string, never>;
  import_variable_by_key: { variableKey: string };
  get_variable_by_id: { variableId: string };
  set_variable_binding: { nodeId: string; field: string; variableId: string };
  create_image: { imageBytes: string; x?: number; y?: number; width?: number; height?: number; name?: string; parentId?: string };
  set_image_fill: { nodeId: string; imageBytes: string; scaleMode?: string };
  flatten_node: { nodeIds: string[] };
  create_vector: { svgPath: string; x?: number; y?: number; name?: string; parentId?: string };
  create_paint_style: { name: string; paints: Array<{ type: string; color?: { r: number; g: number; b: number; a?: number }; opacity?: number }> };
  create_text_style: { name: string; fontFamily: string; fontStyle?: string; fontSize: number; lineHeight?: { value: number; unit: string }; letterSpacing?: { value: number; unit: string } };
  create_effect_style: { name: string; effects: Array<{ type: string; color?: { r: number; g: number; b: number; a?: number }; offset?: { x: number; y: number }; radius?: number; spread?: number; visible?: boolean }> };
  apply_style: { nodeId: string; styleId?: string; styleKey?: string; styleType: string };
  set_reactions: { nodeId: string; reactions: Array<{ trigger: { type: string }; action: { type: string; destinationId?: string; navigation?: string; transition?: { type: string; duration: number } } }> };
};


// Helper function to process Figma node responses
function processFigmaNodeResponse(result: unknown): any {
  if (!result || typeof result !== "object") {
    return result;
  }

  // Check if this looks like a node response
  const resultObj = result as Record<string, unknown>;
  if ("id" in resultObj && typeof resultObj.id === "string") {
    // It appears to be a node response, log the details
    console.info(
      `Processed Figma node: ${resultObj.name || "Unknown"} (ID: ${resultObj.id
      })`
    );

    if ("x" in resultObj && "y" in resultObj) {
      console.debug(`Node position: (${resultObj.x}, ${resultObj.y})`);
    }

    if ("width" in resultObj && "height" in resultObj) {
      console.debug(`Node dimensions: ${resultObj.width}×${resultObj.height}`);
    }
  }

  return result;
}

// Update the connectToFigma function
function connectToFigma(port: number = 3055) {
  // If already connected, do nothing
  if (ws && ws.readyState === WebSocket.OPEN) {
    logger.info('Already connected to Figma');
    return;
  }

  const wsUrl = serverUrl === 'localhost' ? `${WS_URL}:${port}` : WS_URL;
  logger.info(`Connecting to Figma socket server at ${wsUrl}...`);
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    logger.info('Connected to Figma socket server');
    // Reset channel on new connection
    currentChannel = null;
  });

  ws.on("message", (data: any) => {
    try {
      // Define a more specific type with an index signature to allow any property access
      interface ProgressMessage {
        message: FigmaResponse | any;
        type?: string;
        id?: string;
        [key: string]: any; // Allow any other properties
      }

      const json = JSON.parse(data) as ProgressMessage;

      // Handle progress updates
      if (json.type === 'progress_update') {
        const progressData = json.message.data as CommandProgressUpdate;
        const requestId = json.id || '';

        if (requestId && pendingRequests.has(requestId)) {
          const request = pendingRequests.get(requestId)!;

          // Update last activity timestamp
          request.lastActivity = Date.now();

          // Reset the timeout to prevent timeouts during long-running operations
          clearTimeout(request.timeout);

          // Create a new timeout
          request.timeout = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
              logger.error(`Request ${requestId} timed out after extended period of inactivity`);
              pendingRequests.delete(requestId);
              request.reject(new Error('Request to Figma timed out'));
            }
          }, 60000); // 60 second timeout for inactivity

          // Log progress
          logger.info(`Progress update for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);

          // For completed updates, we could resolve the request early if desired
          if (progressData.status === 'completed' && progressData.progress === 100) {
            // Optionally resolve early with partial data
            // request.resolve(progressData.payload);
            // pendingRequests.delete(requestId);

            // Instead, just log the completion, wait for final result from Figma
            logger.info(`Operation ${progressData.commandType} completed, waiting for final result`);
          }
        }
        return;
      }

      // Handle regular responses
      const myResponse = json.message;
      logger.debug(`Received message: ${JSON.stringify(myResponse)}`);
      logger.log('myResponse' + JSON.stringify(myResponse));

      // Handle response to a request
      if (
        myResponse.id &&
        pendingRequests.has(myResponse.id) &&
        myResponse.result
      ) {
        const request = pendingRequests.get(myResponse.id)!;
        clearTimeout(request.timeout);

        if (myResponse.error) {
          logger.error(`Error from Figma: ${myResponse.error}`);
          request.reject(new Error(myResponse.error));
        } else {
          if (myResponse.result) {
            request.resolve(myResponse.result);
          }
        }

        pendingRequests.delete(myResponse.id);
      } else {
        // Handle broadcast messages or events
        logger.info(`Received broadcast message: ${JSON.stringify(myResponse)}`);
      }
    } catch (error) {
      logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ws.on('error', (error) => {
    logger.error(`Socket error: ${error}`);
  });

  ws.on('close', () => {
    logger.info('Disconnected from Figma socket server');
    ws = null;

    // Reject all pending requests
    for (const [id, request] of pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Connection closed"));
      pendingRequests.delete(id);
    }

    // Attempt to reconnect
    logger.info('Attempting to reconnect in 2 seconds...');
    setTimeout(() => connectToFigma(port), 2000);
  });
}

// Function to join a channel
async function joinChannel(channelName: string): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to Figma");
  }

  try {
    await sendCommandToFigma("join", { channel: channelName });
    currentChannel = channelName;
    logger.info(`Joined channel: ${channelName}`);
  } catch (error) {
    logger.error(`Failed to join channel: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// Function to send commands to Figma
function sendCommandToFigma(
  command: FigmaCommand,
  params: unknown = {},
  timeoutMs: number = 30000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // If not connected, try to connect first
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectToFigma();
      reject(new Error("Not connected to Figma. Attempting to connect..."));
      return;
    }

    // Check if we need a channel for this command
    const requiresChannel = command !== "join";
    if (requiresChannel && !currentChannel) {
      reject(new Error("Must join a channel before sending commands"));
      return;
    }

    const id = uuidv4();
    const request = {
      id,
      type: command === "join" ? "join" : "message",
      ...(command === "join"
        ? { channel: (params as any).channel }
        : { channel: currentChannel }),
      message: {
        id,
        command,
        params: {
          ...(params as any),
          commandId: id, // Include the command ID in params
        },
      },
    };

    // Set timeout for request
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        logger.error(`Request ${id} to Figma timed out after ${timeoutMs / 1000} seconds`);
        reject(new Error('Request to Figma timed out'));
      }
    }, timeoutMs);

    // Store the promise callbacks to resolve/reject later
    pendingRequests.set(id, {
      resolve,
      reject,
      timeout,
      lastActivity: Date.now()
    });

    // Send the request
    logger.info(`Sending command to Figma: ${command}`);
    logger.debug(`Request details: ${JSON.stringify(request)}`);
    ws.send(JSON.stringify(request));
  });
}

// Update the join_channel tool
server.tool(
  "join_channel",
  "Join a specific channel to communicate with Figma",
  {
    channel: z.string().describe("The name of the channel to join").default(""),
  },
  async ({ channel }: any) => {
    try {
      if (!channel) {
        // If no channel provided, ask the user for input
        return {
          content: [
            {
              type: "text",
              text: "Please provide a channel name to join:",
            },
          ],
          followUp: {
            tool: "join_channel",
            description: "Join the specified channel",
          },
        };
      }

      await joinChannel(channel);
      return {
        content: [
          {
            type: "text",
            text: `Successfully joined channel: ${channel}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error joining channel: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Start the server
async function main() {
  try {
    // Try to connect to Figma socket server
    connectToFigma();
  } catch (error) {
    logger.warn(`Could not connect to Figma initially: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn('Will try to connect when the first command is sent');
  }

  // Start the MCP server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('FigmaMCP server running on stdio');
}

// Run the server
main().catch(error => {
  logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});


