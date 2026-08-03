import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@replicantos/ui/tokens.css";
import "./styles.css";
import { App } from "./App.js";
import { LiveApp } from "./LiveApp.js";

const root = document.getElementById("root");
if (!root) throw new Error("ReplicantOS root element is missing");

createRoot(root).render(
  <StrictMode>
    {new URLSearchParams(location.search).get("demo") === "1" ? (
      <App />
    ) : (
      <LiveApp />
    )}
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
