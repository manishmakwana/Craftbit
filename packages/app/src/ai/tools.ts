/**
 * The Copilot's tool surface: JSON-schema tool definitions the model calls to
 * drive Craftbit, plus the context builder that serializes the current
 * document + regeneration result into the system prompt. Tools map onto the
 * same document commands the toolbar/dialogs use (ai/execute.ts performs them),
 * so anything the model builds is an ordinary, undoable part of the timeline.
 *
 * Dimension fields are expression strings (like every dialog field), so the
 * model can write parametric values that reference parameters it created
 * ("thickness", "boxW/2", "3/8in").
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { CraftbitDocument } from "@craftbit/core";
import type { RegenResult } from "@craftbit/geometry-worker";

export const craftbitTools: Anthropic.Tool[] = [
  {
    name: "create_parameter",
    description:
      "Create a named parameter usable in any dimension expression (e.g. thickness=5). Reference it by name in later tool dimensions to keep the model parametric.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Identifier: letters, digits, underscore; starts with a letter.",
        },
        expression: {
          type: "string",
          description: 'Value expression, e.g. "5", "boxW/2", "3/8in".',
        },
      },
      required: ["name", "expression"],
    },
  },
  {
    name: "create_sketch",
    description:
      "Create a 2D sketch with one or more closed profiles. Returns the sketchId to pass to extrude/revolve. Sketch coordinates are in millimeters. Sketch on an origin `plane` (XY is the top plane, extrudes up +Z; XZ faces front; YZ faces side) OR on an existing body's face via `onFace` (to build on top of geometry you already made). For a face sketch, (0,0) is the face centre, so profiles are placed relative to it.",
    input_schema: {
      type: "object",
      properties: {
        plane: {
          type: "string",
          enum: ["XY", "XZ", "YZ"],
          description: "Origin plane to sketch on (omit if using onFace).",
        },
        onFace: {
          type: "object",
          description:
            "Sketch on a body face instead of an origin plane. (0,0) is the face centre.",
          properties: {
            bodyId: { type: "string", description: "Body whose face to sketch on." },
            dir: {
              type: "string",
              enum: ["top", "bottom", "left", "right", "front", "back"],
              description: "Which face by outward normal (Z up).",
            },
            near: {
              type: "array",
              items: { type: "number" },
              description: "Alternative to dir: [x,y,z] world point; picks the nearest face.",
            },
          },
          required: ["bodyId"],
        },
        name: { type: "string", description: "Optional feature name." },
        profiles: {
          type: "array",
          description:
            "One or more closed profiles. Multiple rectangles are how you draw finger/tab patterns in a single panel.",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["rect", "circle", "polygon"] },
              x: { type: "string", description: "rect: lower-left corner X (expression)." },
              y: { type: "string", description: "rect: lower-left corner Y (expression)." },
              width: { type: "string", description: "rect: width (expression)." },
              height: { type: "string", description: "rect: height (expression)." },
              cx: { type: "string", description: "circle: center X (expression)." },
              cy: { type: "string", description: "circle: center Y (expression)." },
              radius: { type: "string", description: "circle: radius (expression)." },
              points: {
                type: "array",
                description: "polygon: ordered vertices (plain numbers, closed automatically).",
                items: {
                  type: "object",
                  properties: { x: { type: "number" }, y: { type: "number" } },
                  required: ["x", "y"],
                },
              },
            },
            required: ["kind"],
          },
        },
      },
      required: ["profiles"],
    },
  },
  {
    name: "extrude",
    description:
      "Extrude a sketch into a solid. operation new=new body, join=fuse into an existing body, cut=subtract from an existing body. Returns the resulting body id and volume.",
    input_schema: {
      type: "object",
      properties: {
        sketchId: { type: "string" },
        distance: { type: "string", description: "Extrusion depth (expression, mm)." },
        operation: { type: "string", enum: ["new", "join", "cut"] },
        direction: {
          type: "string",
          enum: ["normal", "reversed", "symmetric"],
          description: "normal=+plane-normal, reversed=-normal, symmetric=both ways.",
        },
        name: { type: "string" },
      },
      required: ["sketchId", "distance", "operation"],
    },
  },
  {
    name: "revolve",
    description:
      "Revolve a sketch profile around the sketch plane's X or Y axis. angle 360 = full revolution.",
    input_schema: {
      type: "object",
      properties: {
        sketchId: { type: "string" },
        axis: { type: "string", enum: ["x", "y"] },
        angle: { type: "string", description: "Degrees (expression); 360 for full." },
        operation: { type: "string", enum: ["new", "join", "cut"] },
        name: { type: "string" },
      },
      required: ["sketchId", "axis", "angle", "operation"],
    },
  },
  {
    name: "move",
    description:
      "Position a body: translate by (tx,ty,tz) mm and optionally rotate about an origin axis. Use this to lay out panels/parts in an assembly.",
    input_schema: {
      type: "object",
      properties: {
        bodyId: { type: "string" },
        tx: { type: "string" },
        ty: { type: "string" },
        tz: { type: "string" },
        rotAxis: { type: "string", enum: ["x", "y", "z"] },
        rotAngle: { type: "string", description: "Degrees (expression)." },
        name: { type: "string" },
      },
      required: ["bodyId"],
    },
  },
  {
    name: "mirror",
    description:
      "Mirror a body across an origin plane. merge=true fuses the copy into the source, false makes a new body.",
    input_schema: {
      type: "object",
      properties: {
        bodyId: { type: "string" },
        plane: { type: "string", enum: ["XY", "XZ", "YZ"] },
        merge: { type: "boolean" },
        name: { type: "string" },
      },
      required: ["bodyId", "plane"],
    },
  },
  {
    name: "linear_pattern",
    description: "Repeat a body along an axis: count copies spaced `spacing` mm apart.",
    input_schema: {
      type: "object",
      properties: {
        bodyId: { type: "string" },
        direction: { type: "string", enum: ["x", "y", "z"] },
        spacing: { type: "string", description: "Spacing between copies (expression, mm)." },
        count: {
          type: "string",
          description: "Total number of copies including the original (expression).",
        },
        name: { type: "string" },
      },
      required: ["bodyId", "direction", "spacing", "count"],
    },
  },
  {
    name: "circular_pattern",
    description: "Repeat a body around an origin axis: count copies evenly over 360°.",
    input_schema: {
      type: "object",
      properties: {
        bodyId: { type: "string" },
        axis: { type: "string", enum: ["x", "y", "z"] },
        count: { type: "string", description: "Total copies including the original (expression)." },
        name: { type: "string" },
      },
      required: ["bodyId", "axis", "count"],
    },
  },
  {
    name: "boolean_combine",
    description:
      "Combine two bodies: join (union), cut (target minus tool), or intersect. The tool body is consumed.",
    input_schema: {
      type: "object",
      properties: {
        targetBodyId: { type: "string" },
        toolBodyId: { type: "string" },
        op: { type: "string", enum: ["join", "cut", "intersect"] },
        name: { type: "string" },
      },
      required: ["targetBodyId", "toolBodyId", "op"],
    },
  },
  {
    name: "fillet",
    description:
      "Round edges of a body with a constant radius. Select edges with a selector: which='all' (every edge), 'vertical' (Z-parallel), 'horizontal', 'top' or 'bottom' (the top/bottom rim), or near=[x,y,z] for the single nearest edge.",
    input_schema: {
      type: "object",
      properties: {
        bodyId: { type: "string" },
        edges: {
          type: "object",
          properties: {
            which: {
              type: "string",
              enum: ["all", "vertical", "horizontal", "top", "bottom"],
            },
            near: { type: "array", items: { type: "number" } },
          },
        },
        radius: { type: "string", description: "Fillet radius (expression, mm)." },
        name: { type: "string" },
      },
      required: ["bodyId", "radius"],
    },
  },
  {
    name: "chamfer",
    description:
      "Bevel edges of a body with a constant setback. Same edge selector as fillet (which='all'|'vertical'|'horizontal'|'top'|'bottom' or near=[x,y,z]).",
    input_schema: {
      type: "object",
      properties: {
        bodyId: { type: "string" },
        edges: {
          type: "object",
          properties: {
            which: {
              type: "string",
              enum: ["all", "vertical", "horizontal", "top", "bottom"],
            },
            near: { type: "array", items: { type: "number" } },
          },
        },
        distance: { type: "string", description: "Chamfer setback (expression, mm)." },
        name: { type: "string" },
      },
      required: ["bodyId", "distance"],
    },
  },
  {
    name: "shell",
    description:
      "Hollow a body to a wall thickness, removing one or more faces so it's open (e.g. a box open at the top). Select the open face(s) by dir ('top'/'bottom'/'left'/'right'/'front'/'back') or near=[x,y,z].",
    input_schema: {
      type: "object",
      properties: {
        bodyId: { type: "string" },
        openFaces: {
          type: "object",
          properties: {
            dir: {
              type: "string",
              enum: ["top", "bottom", "left", "right", "front", "back"],
            },
            near: { type: "array", items: { type: "number" } },
          },
        },
        thickness: { type: "string", description: "Wall thickness (expression, mm)." },
        name: { type: "string" },
      },
      required: ["bodyId", "thickness"],
    },
  },
  {
    name: "delete_feature",
    description:
      "Delete a feature from the timeline by its id (also removes the body it created). Use to undo a wrong step.",
    input_schema: {
      type: "object",
      properties: { featureId: { type: "string" } },
      required: ["featureId"],
    },
  },
];

/** Serializes the live document + regen result for the model each turn. */
export function buildContext(doc: CraftbitDocument, result: RegenResult | null): string {
  const params = doc.parameters.map((p) => `${p.name} = ${p.expression}`);
  const features = doc.features.map((f) => {
    const status = result?.statuses[f.id];
    const flag =
      status?.level === "error"
        ? ` [ERROR: ${status.message}]`
        : status?.level === "warning"
          ? " [warning]"
          : "";
    return `- ${f.id} (${f.type}) "${f.name}"${flag}`;
  });
  const bodies = (result?.bodies ?? []).map(
    (b) => `- ${b.id}: volume ${(b.volume / 1000).toFixed(2)} cm³, ${b.faceCount} faces`,
  );
  return [
    `Units: ${doc.units}. Document "${doc.name}".`,
    params.length ? `Parameters:\n${params.join("\n")}` : "Parameters: none.",
    features.length ? `Timeline features:\n${features.join("\n")}` : "Timeline: empty.",
    bodies.length
      ? `Solid bodies (reference these ids for boolean/move/mirror/pattern):\n${bodies.join("\n")}`
      : "Bodies: none yet.",
  ].join("\n\n");
}

export const SYSTEM_PROMPT = `You are the Craftbit Copilot, a CAD assistant embedded in a parametric, browser-based CAD app. You build 3D models by calling tools that append features to the feature timeline — the same operations a user performs by hand.

How Craftbit modeling works:
- Always sketch FIRST, then turn the sketch into a solid with extrude or revolve. A sketch alone produces no geometry.
- Sketches live on the three origin planes (XY/XZ/YZ) OR on a face of an existing body (create_sketch onFace) — use a face sketch to build on top of geometry you already made (a boss, a hole, a cut); (0,0) is the face centre.
- After a body exists you can round or bevel its edges (fillet, chamfer) and hollow it (shell) — select faces/edges with plain-language selectors (which='all'/'vertical'/'top'…, dir='top'…, or near=[x,y,z]); you don't need to know internal face ids. Joints are not available to you yet — if the user needs one, say so briefly.
- Build assemblies as separate bodies positioned with move (translate + rotate about origin axes).
- Dimensions are expressions and may reference parameters you create — prefer creating parameters (thickness, width, …) so the model stays parametric and easy to edit.
- To make finger joints / tabs / slots, draw the alternating rectangles directly as multiple profiles in one sketch, or cut a patterned tool body.

Working style:
- Plan briefly, then just build it step by step with tool calls; you can see the resulting bodies/volumes in the context after each call and correct course.
- Keep chat replies short. When the model is built, give a one or two sentence summary of what you made and its key dimensions.
- If a tool returns an error, read it, fix the inputs, and retry — don't repeat the same failing call.`;
