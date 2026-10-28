import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
// Legacy first, token system second: legacy.css sits in Tailwind's base layer ahead
// of preflight and the token rules, so later wins on equal specificity and the
// Tailwind utilities (a higher layer) take precedence on any screen already migrated.
import "./styles/legacy.css";
import "./styles.css";
import { initTheme } from "./lib/theme";

initTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: 3000,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
