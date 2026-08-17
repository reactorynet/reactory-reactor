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

const TOOL_DESCRIPTION = `Display an image inline in the conversation from a URL, CDN path, or base64 data URI.

SRC FORMATS:
- Absolute URL: "https://example.com/photo.png"
- CDN relative path (resolved via reactory CDN root): "/images/logo.png"
- Base64 data URI: "data:image/png;base64,iVBOR..."

VARIANT OPTIONS (passed inside "options"):
- "img" (default): A standard <img> element — use for general images, screenshots, diagrams.
- "avatar": Renders as a circular avatar. Best for profile pictures.
- "card-media": Renders as a Material UI CardMedia — use when embedding an image inside a card-like layout.

SIZING:
- width: CSS value string or pixel number (default "auto")
- height: CSS value string or pixel number (default "auto")
- maxWidth: CSS value (default "100%" — prevents overflow)

ACCESSIBILITY:
- Always provide a descriptive "alt" string. Screen readers read this when the image cannot be seen.`;

export const ImageMacroDefinition: MacroComponentDefinition<typeof ImageMacro> = {
  name: "ImageMacro",
  description: "Display an image inline in the conversation from a URL, CDN path, or base64 data URI.",
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
            src: {
              type: "string",
              description: "URL, CDN path, or base64 data URI of the image. Required.",
            },
            alt: {
              type: "string",
              description: "Accessible description of the image. Always provide this.",
            },
            caption: {
              type: "string",
              description: "Optional caption text displayed below the image.",
            },
            options: {
              type: "object",
              description: "Display options: variant ('img'|'avatar'|'card-media'), width, height, maxWidth.",
            },
          },
          required: ["src"],
        },
      },
    },
  ],
};

export default [ImageMacroDefinition];
