import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./style.css";

const container = document.getElementById("root");
if (container === null) {
  // Failing loudly beats rendering nothing and leaving a blank page with no clue.
  throw new Error("#root is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
