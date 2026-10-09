import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./index.css";

async function start() {
  // In a plain browser (`pnpm dev`), stand in for the Tauri backend with fake data.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    await import("./dev/mock");
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
