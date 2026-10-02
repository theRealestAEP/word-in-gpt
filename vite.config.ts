import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// The host loads the editor as one HTML document with no network access,
// so every script, style, and font goes inline.
export default defineConfig({
  root: "src/app",
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "../../plugin/dist",
    emptyOutDir: false,
    rollupOptions: { input: "src/app/app.html" },
  },
});
