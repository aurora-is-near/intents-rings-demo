/// <reference types="vite/client" />
declare namespace JSX {
  interface IntrinsicElements {
    'appkit-button': any;
  }
}

/** Injected by vite.config.ts — which cluster the Rings leg runs against. */
declare const __RINGS_NETWORK__: string;
