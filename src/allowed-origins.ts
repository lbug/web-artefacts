// The only external origins an artifact may load from. The raw CSP (src/app.ts)
// is built from these, and publish_artifact checks resources against them
// (mcp/resources.ts), so both always agree.

/** Scripts, styles, fonts, images and fetch() */
export const CDN_ORIGINS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://esm.sh"];

/** Google Fonts: the stylesheet and the font files it points to. */
export const FONT_STYLE_ORIGIN = "https://fonts.googleapis.com";
export const FONT_FILE_ORIGIN = "https://fonts.gstatic.com";
