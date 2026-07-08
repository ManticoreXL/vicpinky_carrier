import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { TestBotsProvider } from "./context/testbots";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
root.render(
 <React.StrictMode>
 <TestBotsProvider>
 <App />
 </TestBotsProvider>
 </React.StrictMode>
);
