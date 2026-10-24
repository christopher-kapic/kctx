import { createContext, type ReactNode, use } from "react";
import { Uniwind, useUniwind } from "uniwind";

type ThemeName = "light" | "dark";

type AppThemeContextType = {
  currentTheme: string;
  isLight: boolean;
  isDark: boolean;
  setTheme: (theme: ThemeName) => void;
  toggleTheme: () => void;
};

const AppThemeContext = createContext<AppThemeContextType | undefined>(undefined);

// No manual memoization: React Compiler is enabled for this app (app.json →
// experiments.reactCompiler), so the provider value is cached automatically.
export const AppThemeProvider = ({ children }: { children: ReactNode }) => {
  const { theme } = useUniwind();

  const value: AppThemeContextType = {
    currentTheme: theme,
    isLight: theme === "light",
    isDark: theme === "dark",
    setTheme: (newTheme: ThemeName) => {
      Uniwind.setTheme(newTheme);
    },
    toggleTheme: () => {
      Uniwind.setTheme(theme === "light" ? "dark" : "light");
    },
  };

  return <AppThemeContext.Provider value={value}>{children}</AppThemeContext.Provider>;
};

export function useAppTheme() {
  const context = use(AppThemeContext);
  if (!context) {
    throw new Error("useAppTheme must be used within AppThemeProvider");
  }
  return context;
}
