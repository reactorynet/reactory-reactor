import { Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";

/**
 * Server-side definition for the Image Macro/Tool.
 * Operates client-side (runat: 'client').
 */
export const ImageMacro: Macro<any> = async (args) => {
  return {
    component: 'widgets.ImageWidget',
    props: args,
  };
};

const TOOL_DESCRIPTION = `Display an image or a collection of images inline and/or in the persistent side panel with auto-resizing responsive grid layout, metadata (titles/captions), and interactive selection events.

ACTIONS:
- "add" (default): Mount images in the persistent side panel and display inline.
- "update": Update an existing image gallery in the side panel. Requires "referenceId".
- "remove": Remove an image gallery from the side panel. Requires "referenceId".
- "inline": Display image inline only without mounting in side panel.

SRC & IMAGE FORMATS:
- Single image: "src": "https://example.com/photo.png" or "/images/logo.png" or "data:image/png;base64,..."
- Multiple images: "images": [
    { "src": "https://example.com/1.png", "title": "Dashboard View", "caption": "Monthly metrics", "id": "dash-1" },
    { "src": "https://example.com/2.png", "title": "User Analytics", "caption": "Active cohorts", "id": "user-2" }
  ]

OPTIONS REFERENCE:
- "variant": 'img' (default for 1 image), 'grid' (default for multi-image), 'gallery', 'avatar', 'card-media', 'div'
- "columns": 'auto' (auto-fill responsive grid, default) or numeric column count (e.g. 2, 3, 4)
- "aspectRatio": CSS aspect ratio, e.g. '16/9', '4/3' (default), '1/1'
- "selectable": true to enable click-selection with AMQ event dispatching to the AI agent
- "multiSelect": true to permit selecting multiple images simultaneously
- "showTitles": boolean (default true in grid)
- "showCaptions": boolean (default true in grid)
- "eventChannel": AMQ channel name (default 'reactor')
- "eventId": AMQ eventId published on selection (default 'image.selected')

EVENT BRIDGE:
When a user selects an image, an event is published via Reactory AMQ with payload:
{
  "selected": { "id": "...", "src": "...", "title": "...", "caption": "...", "meta": {...} },
  "selectedImages": [...],
  "index": 0,
  "chatSessionId": "...",
  "timestamp": "..."
}

EXAMPLES:

1) Single image with caption:
   { "src": "https://example.com/arch.png", "alt": "System Architecture", "caption": "Microservices topology" }

2) Multi-image responsive grid with interactive selection:
   {
     "title": "Module Selection",
     "images": [
       { "id": "opt-1", "src": "/images/variantA.png", "title": "Modern Theme", "caption": "Dark mode styling" },
       { "id": "opt-2", "src": "/images/variantB.png", "title": "Classic Theme", "caption": "Light mode styling" }
     ],
     "options": { "variant": "grid", "selectable": true, "columns": "auto" }
   }`;

export const ImageMacroDefinition: MacroComponentDefinition<typeof ImageMacro> = {
  name: "ImageMacro",
  description: "Display images or responsive image galleries inline in the conversation and persistent side panel with auto-resizing grid layout and event bridge support.",
  component: ImageMacro,
  version: "1.0.0",
  nameSpace: "reactor-macros",
  roles: ['USER'],
  alias: 'image',
  icon: "image",
  runat: 'client',
  tools: [
    {
      type: "function",
      function: {
        name: "image",
        icon: "image",
        description: TOOL_DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "The operation to perform: 'add' (default, side panel + inline), 'update', 'remove', or 'inline'.",
              enum: ["add", "update", "remove", "inline"],
            },
            referenceId: {
              type: "string",
              description: "Unique reference ID for side panel item tracking (required for 'update' and 'remove').",
            },
            src: {
              type: "string",
              description: "URL, CDN path, or base64 data URI of a single image.",
            },
            images: {
              type: "array",
              description: "Array of image objects with metadata [{ src, alt, title, caption, id, meta }] or image URL strings.",
              items: {
                type: "object",
                properties: {
                  src: { type: "string", description: "Image URL, CDN path, or base64 data URI." },
                  alt: { type: "string", description: "Accessible description." },
                  title: { type: "string", description: "Image title displayed in card/overlay." },
                  caption: { type: "string", description: "Subtitle or description text." },
                  id: { type: "string", description: "Unique identifier for this image item." },
                  meta: { type: "object", description: "Custom metadata passed back on selection events." },
                },
                required: ["src"],
              },
            },
            alt: {
              type: "string",
              description: "Accessible description of the image. Always provide this.",
            },
            title: {
              type: "string",
              description: "Title displayed in the side panel tab and above the image gallery.",
            },
            caption: {
              type: "string",
              description: "Optional caption text displayed below the image.",
            },
            options: {
              type: "object",
              description: "Display options: variant ('img'|'grid'|'gallery'|'avatar'|'card-media'), columns ('auto'|number), selectable (boolean), multiSelect (boolean), aspectRatio (string), eventChannel (string), eventId (string).",
            },
          },
        },
      },
    },
  ],
};

export default [ImageMacroDefinition];
