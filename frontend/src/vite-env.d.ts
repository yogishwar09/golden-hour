/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute API origin. Left unset in development, where Vite proxies `/api`. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
