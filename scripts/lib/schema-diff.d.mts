export function classifyDiff(sql: string): "destructive" | "risky" | "clean" | "unsupported";
export function hasStatements(sql: string): boolean;
export function normalizeDiff(sql: string): string;
