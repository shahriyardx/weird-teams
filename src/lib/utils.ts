import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Returns the given URL only if it is a safe same-origin relative path,
 * otherwise the fallback. Prevents open-redirect via attacker-controlled
 * callbackURL params (e.g. `https://evil.com`, `//evil.com`, `/\evil.com`).
 */
export function safeCallbackURL(
  url: string | undefined | null,
  fallback = "/",
): string {
  if (!url || !url.startsWith("/")) return fallback
  // Reject protocol-relative ("//host") and backslash tricks ("/\host").
  if (url.startsWith("//") || url.startsWith("/\\")) return fallback
  return url
}
