import React from "react";
import ReactDOM from "react-dom/client";
import "katex/dist/katex.min.css";

import App from "./App";
import FeedbackHost from "./feedback/FeedbackHost";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    {/* Beta testing: Send feedback and What's new, in every window. */}
    <FeedbackHost />
  </React.StrictMode>,
);
