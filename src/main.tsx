import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initAppTheme } from "./lib/appTheme";
import "./styles/theme.css";
import "./styles/app.css";

initAppTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
