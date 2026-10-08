import type { Tool } from "../../core/engine.ts";

/** Picture tools (handlers: `images.ts`). */
export const imageTools: Tool[] = [
  {
    type: "function",
    display: { label: "View image", icon: "🖼" },
    function: {
      name: "view_image",
      description:
        "Look at an image file (png, jpg, gif or webp, up to 10 MB): the picture is shown to you with this tool's result. Use it to check a design mockup, a diagram or a screenshot saved on disk. 'path' is relative to the working directory, or absolute.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the image file",
          },
        },
        required: ["path"],
      },
    },
  },
];
