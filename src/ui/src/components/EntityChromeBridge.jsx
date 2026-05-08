import { useAppChrome } from "./AppShell.jsx";

export function EntityChromeBridge({ chrome }) {
  useAppChrome(chrome, [chrome]);
  return null;
}
