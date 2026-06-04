/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_USE_MOCK_API?: string;
  readonly VITE_JOTFORM_FORM_ID_ES?: string;
  readonly VITE_JOTFORM_FORM_ID_EN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
